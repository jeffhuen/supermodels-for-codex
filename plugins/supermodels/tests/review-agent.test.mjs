import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunController } from "../scripts/lib/run-control.mjs";
import { runReviewAgent } from "../scripts/lib/review-agent.mjs";
import { createReviewTools, lastNumberedLine } from "../scripts/lib/review-tools.mjs";
import { resolveClaudeReviewPolicy } from "../scripts/providers/claude/adapter.mjs";
import { resolveAntigravityReviewPolicy } from "../scripts/providers/antigravity/adapter.mjs";
import { resolveGrokReviewPolicy } from "../scripts/providers/grok/adapter.mjs";

test("runReviewAgent refuses submit_review before required inspection tools", async () => {
  const calls = [];
  const fakeTransport = {
    async messages(body) {
      calls.push(body);
      if (calls.length === 1) {
        return responseWithTool("submit_early", "submit_review", cleanReview("Looks fine."));
      }
      return responseWithTool("diff_1", "get_diff", {});
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff: "diff --git a/a b/a" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "claude",
      transport: fakeTransport,
      tools: fakeTools,
      brief: "Shared Review Charter\nProvider override",
      focus: "review lifecycle changes",
      maxRounds: 2,
      minInspection: { diff: true, fileOrSearch: false },
    }),
    /review did not complete/i,
  );

  assert.match(JSON.stringify(calls[0].messages[0].content), /Shared Review Charter/);
  assert.match(JSON.stringify(calls[1].messages.at(-1).content), /submit_review refused/i);
});

test("runReviewAgent returns structured review after diff and file inspection", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", {
          path: "plugins/supermodels/scripts/lib/runtime.mjs",
        });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", {
          query: "runReviewAgent",
        });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "A real file was inspected.",
        findings: [{
          severity: "medium",
          title: "Example finding",
          evidence: "runtime.mjs was inspected after reading the diff.",
          impact: "Demonstrates tool-loop viability.",
          recommendation: "Keep this as an eval signal.",
          file: "plugins/supermodels/scripts/lib/runtime.mjs",
          line_start: 1,
          line_end: 1,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff: "diff --git a/a b/a" };
      }
      if (name === "read_file") {
        return { ok: true, path: "plugins/supermodels/scripts/lib/runtime.mjs", content: "1: export {};" };
      }
      if (name === "search") {
        return { ok: true, query: "runReviewAgent", output: "review-agent.mjs:1:export async function runReviewAgent" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    focus: "review lifecycle changes",
    maxRounds: 5,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings.length, 1);
  assert.equal(result.toolUsage.get_diff, 1);
  assert.equal(result.toolUsage.read_file, 1);
  assert.equal(result.toolUsage.search, 1);
});

test("runReviewAgent refuses submit_review until high-risk diff hunks are read", async () => {
  const calls = [];
  const diff = [
    "diff --git a/auth/session.mjs b/auth/session.mjs",
    "--- a/auth/session.mjs",
    "+++ b/auth/session.mjs",
    "@@ -10,2 +10,3 @@ function revoke(session) {",
    "+  delete session.token;",
    " }",
  ].join("\n");
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      calls.push(body);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("search_1", "search", { query: "revoke session" });
      }
      if (this.calls === 3) {
        return responseWithTool("submit_early", "submit_review", {
          verdict: "needs-attention",
          summary: "Finding before hunk read.",
          findings: [{
            severity: "high",
            title: "Token deletion needs review",
            evidence: "The diff deletes a token.",
            impact: "Session revocation can break auth behavior.",
            recommendation: "Inspect the hunk before finalizing.",
            file: "auth/session.mjs",
            line_start: 10,
            line_end: 10,
            confidence: "medium",
          }],
          assumptions: [],
          verification_gaps: [],
        });
      }
      if (this.calls === 4) {
        return responseWithTool("read_1", "read_file", {
          path: "auth/session.mjs",
          start_line: 10,
          end_line: 12,
        });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Hunk was inspected.",
        findings: [{
          severity: "high",
          title: "Token deletion needs review",
          evidence: "The hunk was read directly.",
          impact: "Session revocation can break auth behavior.",
          recommendation: "Keep the high-risk hunk gate.",
          file: "auth/session.mjs",
          line_start: 10,
          line_end: 10,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: "auth/session.mjs:10:function revoke(session) {" };
      }
      if (name === "read_file") {
        return {
          ok: true,
          path: input.path,
          start_line: Number(input.start_line ?? 1),
          end_line: Number(input.end_line ?? input.start_line ?? 1),
          content: "10: function revoke(session) {\n11:   delete session.token;\n12: }",
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 5,
    minInspection: {
      diff: true,
      fileOrSearch: true,
      explicitFileOrSearchToolCalls: 1,
      cleanExplicitFileOrSearchToolCalls: 1,
    },
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.toolUsage.read_file, 1);
  assert.match(JSON.stringify(calls[3].messages), /missingHighRiskHunks|coverage_gaps/);
});

test("runReviewAgent requires complete raw-file coverage and reports non-invertible Git filters", async () => {
  const diff = [
    "diff --git a/generated.mjs b/generated.mjs",
    "--- a/generated.mjs",
    "+++ b/generated.mjs",
    "@@ -1 +1 @@",
    "-canonical old",
    "+canonical new",
  ].join("\n");
  const transport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) return responseWithTool("diff", "get_diff", {});
      if (this.calls === 2) return responseWithTool("read", "read_file", { path: "generated.mjs", start_line: 1, end_line: 3 });
      return responseWithTool("submit", "submit_review", cleanReview("The complete raw file was inspected."));
    },
  };
  const tools = {
    schemas: [],
    reviewDiff: diff,
    reviewFilteredFiles: [{ path: "generated.mjs", status: "M", filter: "generator", lineCount: 3 }],
    async execute(name, input = {}) {
      if (name === "get_diff") return { ok: true, diff, complete: true };
      if (name === "read_file") {
        return {
          ok: true,
          path: input.path,
          start_line: 1,
          end_line: 3,
          content: "1: raw prefix\n2: changed source\n3: raw suffix",
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport,
    tools,
    minInspection: { diff: true, fileOrSearch: true, explicitFileOrSearchToolCalls: 1, cleanExplicitFileOrSearchToolCalls: 1 },
    maxRounds: 3,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.verification_gaps.join("\n"), /generated\.mjs.*clean filter 'generator'.*cannot be losslessly mapped/i);
});

test("runReviewAgent does not require read_file coverage for deleted filtered files", async () => {
  const diff = [
    "diff --git a/deleted.asset b/deleted.asset",
    "deleted file mode 100644",
    "--- a/deleted.asset",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-filtered content",
  ].join("\n");
  const transport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) return responseWithTool("diff", "get_diff", {});
      return responseWithTool("submit", "submit_review", inconclusiveReview("The deleted filtered source is unavailable."));
    },
  };
  const tools = {
    schemas: [],
    reviewDiff: diff,
    reviewFilteredFiles: [{ path: "deleted.asset", status: "D", filter: "lfs", lineCount: 0 }],
    async execute(name) {
      if (name === "get_diff") return { ok: true, diff, complete: true };
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport,
    tools,
    minInspection: {
      diff: true,
      fileOrSearch: false,
      explicitFileOrSearchToolCalls: 0,
      cleanExplicitFileOrSearchToolCalls: 0,
    },
    maxRounds: 2,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(transport.calls, 2, "deleted source must not trigger an impossible read_file round");
  assert.match(result.verification_gaps.join("\n"), /deleted\.asset.*clean filter 'lfs'.*cannot be losslessly mapped/i);
  assert.doesNotMatch(result.verification_gaps.join("\n"), /high-risk hunk|read_file could not deliver/i);
});

test("runReviewAgent requires merged read ranges to cover the full high-risk hunk", async () => {
  const targetPath = "auth/session.mjs";
  const diff = [
    `diff --git a/${targetPath} b/${targetPath}`,
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -10,3 +10,3 @@",
    "+token timeout",
    " context one",
    " context two",
  ].join("\n");
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) return responseWithTool("diff", "get_diff", {});
      if (this.calls === 2) return responseWithTool("read-1", "read_file", { path: targetPath, start_line: 10, end_line: 10 });
      if (this.calls === 3) return responseWithTool("search", "search", { query: "session" });
      if (this.calls === 4) return responseWithTool("submit-early", "submit_review", cleanReview("Only one hunk line was read."));
      if (this.calls === 5) return responseWithTool("read-2", "read_file", { path: targetPath, start_line: 11, end_line: 12 });
      return responseWithTool("submit", "submit_review", cleanReview("The full hunk was read across two pages."));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") return { ok: true, diff };
      if (name === "search") return { ok: true, query: input.query, output: `${targetPath}:10:token timeout` };
      if (name === "read_file") {
        const start = Number(input.start_line);
        const end = Number(input.end_line);
        const result = {
          ok: true,
          path: targetPath,
          start_line: start,
          end_line: end,
          content: Array.from({ length: end - start + 1 }, (_, index) => `${start + index}: line`).join("\n"),
        };
        return result;
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 6,
  });
  assert.equal(result.verdict, "clean");
  assert.equal(result.rounds, 6, "the one-line overlap must not satisfy the hunk gate");
});

test("runReviewAgent does not credit hunk coverage past the visible content of a stale-range read", async () => {
  // High-risk hunk at lines 120-122 (auth path). The model reads a wide range but
  // the tool returns content only through line 100 with a STALE end_line of 130 —
  // exactly what a downstream truncation would leave. Coverage must credit only the
  // visible lines, so the hunk stays uncovered rather than being falsely satisfied.
  const diff = [
    "diff --git a/auth/session.mjs b/auth/session.mjs",
    "--- a/auth/session.mjs",
    "+++ b/auth/session.mjs",
    "@@ -120,2 +120,3 @@",
    " function keep() {",
    "+  const added = 1;",
    " }",
  ].join("\n");
  const visibleContent = Array.from({ length: 100 }, (_, i) => `${i + 1}: line ${i + 1}`).join("\n");
  const calls = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      calls.push(body);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: "auth/session.mjs", start_line: 1, end_line: 130 });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "clean",
        summary: "Nothing found.",
        findings: [],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff };
      }
      if (name === "read_file") {
        return {
          ok: true,
          path: input.path,
          start_line: Number(input.start_line ?? 1),
          end_line: 130, // STALE: past the visible content, as a downstream trim would leave it
          content: visibleContent, // lines 1-100 only
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  // The unsatisfiable coverage gate may force further reads and eventually reject;
  // we assert on what the model was shown, which holds either way.
  await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 6,
    minInspection: { diff: true, fileOrSearch: true, explicitFileOrSearchToolCalls: 1, cleanExplicitFileOrSearchToolCalls: 1 },
  }).catch(() => {});

  // Inspect the coverage_ledger the agent attached to the read_1 result: the hunk
  // at line 120 must remain in missingHighRiskHunks (the stale end_line did NOT
  // credit it). With the bug, the [1,130] range overlaps [120,122] and clears it.
  let readLedger = null;
  for (const body of calls) {
    for (const msg of body.messages ?? []) {
      if (!Array.isArray(msg.content)) {
        continue;
      }
      for (const part of msg.content) {
        if (part?.type === "tool_result" && part.tool_use_id === "read_1") {
          readLedger = JSON.parse(part.content).coverage_ledger;
        }
      }
    }
  }
  assert.ok(readLedger, "the read result carried a coverage ledger");
  assert.ok(
    (readLedger.missingHighRiskHunks ?? []).some((hunk) => hunk.line_start === 120),
    "the hunk beyond the visible content stays uncovered (stale end_line did not credit it)",
  );
});

test("runReviewAgent keeps result+ledger within the cap and does not credit coverage past content trimmed by the final cap", async () => {
  // maxToolBytes IS set on the tools, so executeToolCall's final-cap branch runs.
  // The read returns 200 escaping-heavy numbered lines — far larger than the
  // ledger-reserved budget — so the agent trims the content below the line-200 hunk
  // BEFORE coverage is recorded, and the attached ledger must fit the cap.
  const maxToolBytes = 30_000;
  const diff = [
    "diff --git a/auth/session.mjs b/auth/session.mjs",
    "--- a/auth/session.mjs",
    "+++ b/auth/session.mjs",
    "@@ -200,1 +200,2 @@",
    " function keep() {",
    "+  const added = 1;",
  ].join("\n");
  const content = Array.from({ length: 200 }, (_, i) => `${i + 1}: ${'"'.repeat(120)}`).join("\n");
  const calls = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      calls.push(body);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: "auth/session.mjs", start_line: 1, end_line: 200 });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "clean",
        summary: "Nothing found.",
        findings: [],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = {
    schemas: [],
    maxToolBytes,
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff };
      }
      if (name === "read_file") {
        return { ok: true, path: input.path, start_line: 1, end_line: 200, content };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 6,
    minInspection: { diff: true, fileOrSearch: true, explicitFileOrSearchToolCalls: 1, cleanExplicitFileOrSearchToolCalls: 1 },
  }).catch(() => {});

  let delivered = null;
  for (const body of calls) {
    for (const msg of body.messages ?? []) {
      if (!Array.isArray(msg.content)) {
        continue;
      }
      for (const part of msg.content) {
        if (part?.type === "tool_result" && part.tool_use_id === "read_1") {
          delivered = JSON.parse(part.content);
        }
      }
    }
  }
  assert.ok(delivered, "the read result was delivered to the model");
  // The delivered payload — content PLUS the attached coverage_ledger — fits the cap
  // (the full serialized ledger envelope is budgeted, not just its body).
  const deliveredBytes = Buffer.byteLength(JSON.stringify(delivered), "utf8");
  assert.ok(deliveredBytes <= maxToolBytes, `delivered ${deliveredBytes} exceeded cap ${maxToolBytes}`);
  // Content was trimmed below the requested range, and end_line matches what remains.
  assert.ok(delivered.end_line < 200, "content was trimmed below the requested 200 lines");
  assert.equal(delivered.end_line, lastNumberedLine(delivered.content), "end_line matches the delivered content");
  // Integrity: the line-200 hunk sits past the delivered content, so it stays
  // uncovered — coverage was recorded from the FINAL content, not the pre-trim read.
  assert.ok(
    (delivered.coverage_ledger?.missingHighRiskHunks ?? []).some((hunk) => hunk.line_start === 200),
    "the hunk past the trimmed content stays uncovered (coverage recorded from delivered content)",
  );
});

test("runReviewAgent does not block low-risk diffs on hunk coverage", async () => {
  const diff = [
    "diff --git a/docs/readme.md b/docs/readme.md",
    "--- a/docs/readme.md",
    "+++ b/docs/readme.md",
    "@@ -1,1 +1,1 @@",
    "-helo",
    "+hello",
  ].join("\n");
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("search_1", "search", { query: "hello" });
      }
      return responseWithTool("submit_1", "submit_review", cleanReview("Only low-risk docs changed."));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: "docs/readme.md:1:hello" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 3,
    minInspection: {
      diff: true,
      fileOrSearch: true,
      explicitFileOrSearchToolCalls: 1,
      cleanExplicitFileOrSearchToolCalls: 1,
    },
  });

  assert.equal(result.verdict, "clean");
  assert.equal(result.toolUsage.read_file, undefined);
});

test("runReviewAgent applies pre-diff file reads to later high-risk hunk coverage", async () => {
  const diff = [
    "diff --git a/auth/session.mjs b/auth/session.mjs",
    "--- a/auth/session.mjs",
    "+++ b/auth/session.mjs",
    "@@ -10,2 +10,3 @@ function revoke(session) {",
    "+  delete session.token;",
    " }",
  ].join("\n");
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("read_1", "read_file", {
          path: "auth/session.mjs",
          start_line: 10,
          end_line: 12,
        });
      }
      if (this.calls === 2) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "revoke session" });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Prior hunk read counted.",
        findings: [{
          severity: "high",
          title: "Token deletion needs review",
          evidence: "The hunk was read before the diff ledger was built.",
          impact: "Session revocation can break auth behavior.",
          recommendation: "Replay read ranges when coverage appears.",
          file: "auth/session.mjs",
          line_start: 10,
          line_end: 10,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff };
      }
      if (name === "read_file") {
        return {
          ok: true,
          path: input.path,
          start_line: Number(input.start_line ?? 1),
          end_line: Number(input.end_line ?? input.start_line ?? 1),
          content: "10: function revoke(session) {\n11:   delete session.token;\n12: }",
        };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: "auth/session.mjs:10:function revoke(session) {" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(fakeTransport.calls, 4);
});

test("runReviewAgent accepts missing_change_findings submitted through the two-array wire", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", {
          path: "plugins/supermodels/scripts/lib/runtime.mjs",
          start_line: 1,
          end_line: 1,
        });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", {
          query: "runLegacyThing",
        });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Missing caller update.",
        findings: [],
        missing_change_findings: [{
          severity: "high",
          title: "Caller still uses the removed symbol",
          evidence: "Search found a caller that still references runLegacyThing.",
          impact: "The changed path will still invoke the removed contract.",
          recommendation: "Update the caller to use runNewThing.",
          anchor_file: "plugins/supermodels/scripts/lib/runtime.mjs",
          anchor_line: 1,
          expected_symbol: "runNewThing",
          searched_for: "runLegacyThing",
          missing_change_reason: "The diff changed the contract but this caller did not move to the replacement.",
          confidence: "high",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 5,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, "missing-change");
  assert.equal(result.findings[0].file, "plugins/supermodels/scripts/lib/runtime.mjs");
  assert.equal(result.findings[0].line_start, 1);
  assert.equal(result.findings[0].expected_symbol, "runNewThing");
});

test("runReviewAgent asks for one correction when finding location is not readable", async () => {
  const calls = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      calls.push(body);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", {
          path: "plugins/supermodels/scripts/lib/review-agent.mjs",
        });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", {
          query: "runReviewAgent",
        });
      }
      if (this.calls === 4) {
        return responseWithTool("bad_submit", "submit_review", {
          verdict: "needs-attention",
          summary: "Bad location.",
          findings: [{
            severity: "medium",
            title: "Bad location",
            evidence: "The model cited a file that cannot be read.",
            impact: "The finding is not actionable.",
            recommendation: "Cite a real file and line.",
            file: "missing-file.mjs",
            line_start: 10,
            line_end: 10,
            confidence: "medium",
          }],
          assumptions: [],
          verification_gaps: [],
        });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Corrected location.",
        findings: [{
          severity: "medium",
          title: "Corrected location",
          evidence: "The corrected finding cites a readable file and line.",
          impact: "The finding is actionable.",
          recommendation: "Keep the location verifier.",
          file: "plugins/supermodels/scripts/lib/review-agent.mjs",
          line_start: 1,
          line_end: 1,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 5,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings[0].file, "plugins/supermodels/scripts/lib/review-agent.mjs");
  const correctionMessage = JSON.stringify(calls[4].messages.at(-1).content);
  assert.match(correctionMessage, /finding location could not be verified/i);
  assert.match(correctionMessage, /missing-file\.mjs/);
});

test("runReviewAgent accepts normalized finding paths returned by read_file", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", {
          path: "plugins/supermodels/scripts/lib/review-agent.mjs",
        });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", {
          query: "verifyFindingLocations",
        });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Path normalization checked.",
        findings: [{
          severity: "medium",
          title: "Normalized path",
          evidence: "The path was copied from search output with a leading dot slash.",
          impact: "Valid findings should not be rejected for path spelling.",
          recommendation: "Normalize compared paths.",
          file: "./plugins/supermodels/scripts/lib/review-agent.mjs",
          line_start: 1,
          line_end: 1,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff: "diff --git a/a b/a" };
      }
      if (name === "read_file") {
        return {
          ok: true,
          path: String(input.path ?? "").replace(/^\.\//, ""),
          start_line: Number(input.start_line ?? 1),
          end_line: Number(input.end_line ?? input.start_line ?? 1),
          content: `${Number(input.start_line ?? 1)}: export {};`,
        };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: "./plugins/supermodels/scripts/lib/review-agent.mjs:1:export {};" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings[0].file, "./plugins/supermodels/scripts/lib/review-agent.mjs");
});

test("runReviewAgent does not spend finding correction budget on inspection gate refusals", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1 || this.calls === 3) {
        return responseWithTool(`early_submit_${this.calls}`, "submit_review", cleanReview("Too early."));
      }
      if (this.calls === 2) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 4) {
        return responseWithTool("read_1", "read_file", {
          path: "plugins/supermodels/scripts/lib/review-agent.mjs",
        });
      }
      if (this.calls === 5) {
        return responseWithTool("search_1", "search", {
          query: "runReviewAgent",
        });
      }
      if (this.calls === 6) {
        return responseWithTool("bad_submit", "submit_review", {
          verdict: "needs-attention",
          summary: "Bad location.",
          findings: [{
            severity: "medium",
            title: "Bad location",
            evidence: "The first real finding submit cites a missing file.",
            impact: "This should get one correction attempt.",
            recommendation: "Correct the location.",
            file: "missing-file.mjs",
            line_start: 10,
            line_end: 10,
            confidence: "medium",
          }],
          assumptions: [],
          verification_gaps: [],
        });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Corrected after early submits.",
        findings: [{
          severity: "medium",
          title: "Corrected",
          evidence: "The corrected finding cites a readable file.",
          impact: "Inspection gate refusals did not consume the correction budget.",
          recommendation: "Keep budgets separate.",
          file: "plugins/supermodels/scripts/lib/review-agent.mjs",
          line_start: 1,
          line_end: 1,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 7,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.summary, "Corrected after early submits.");
});

test("runReviewAgent surfaces concrete schema validation errors for correction", async () => {
  const calls = [];
  const fakeTransport = {
    async messages(body) {
      calls.push(body);
      if (calls.length === 1) {
        return responseWithTool("bad_submit", "submit_review", {
          verdict: "needs-attention",
          summary: "Bad schema.",
          findings: [{
            severity: "medium",
            title: "Bad range",
            evidence: "The line range is impossible.",
            impact: "Provider should see the exact issue.",
            recommendation: "Fix line_end.",
            file: "plugins/supermodels/scripts/lib/review-agent.mjs",
            line_start: 20,
            line_end: 10,
            confidence: "medium",
          }],
          assumptions: [],
          verification_gaps: [],
        });
      }
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("schema error was corrected"));
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    maxRounds: 2,
  });

  const correctionMessage = JSON.stringify(calls[1].messages.at(-1).content);
  assert.equal(result.verdict, "inconclusive");
  assert.match(correctionMessage, /findings\[0\]\.line_end must be greater than or equal to line_start/i);
});

test("runReviewAgent surfaces concrete validation errors for natural structured JSON", async () => {
  const calls = [];
  const invalidReview = {
    verdict: "needs-attention",
    summary: "Bad natural JSON.",
    findings: [{
      severity: "medium",
      title: "Bad natural range",
      evidence: "The line range is impossible.",
      impact: "Provider should see the exact issue.",
      recommendation: "Fix line_end.",
      file: "plugins/supermodels/scripts/lib/review-agent.mjs",
      line_start: 20,
      line_end: 10,
      confidence: "medium",
    }],
    missing_change_findings: [],
    assumptions: [],
    verification_gaps: [],
  };
  const fakeTransport = {
    async messages(body) {
      calls.push(body);
      if (calls.length === 1) {
        return responseWithText(JSON.stringify(invalidReview));
      }
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("natural schema error was corrected"));
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    maxRounds: 2,
  });

  const correctionMessage = JSON.stringify(calls[1].messages.at(-1).content);
  assert.equal(result.verdict, "inconclusive");
  assert.match(correctionMessage, /findings\[0\]\.line_end must be greater than or equal to line_start/i);
});

test("runReviewAgent accepts missing current-line content only when the diff covers a deleted old line", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", {
          path: "plugins/supermodels/scripts/lib/review-agent.mjs",
        });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", {
          query: "deleted validation",
        });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Line absence accepted.",
        findings: [{
          severity: "medium",
          title: "Deleted line",
          evidence: "The finding refers to a deleted or pre-change line.",
          impact: "Valid deletion findings should not be dropped.",
          recommendation: "Accept missing current-line content only with matching diff evidence.",
          file: "plugins/supermodels/scripts/lib/review-agent.mjs",
          line_start: 5,
          line_end: 5,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return {
          ok: true,
          diffSummary: "1 file changed",
          diff: [
            "diff --git a/plugins/supermodels/scripts/lib/review-agent.mjs b/plugins/supermodels/scripts/lib/review-agent.mjs",
            "--- a/plugins/supermodels/scripts/lib/review-agent.mjs",
            "+++ b/plugins/supermodels/scripts/lib/review-agent.mjs",
            "@@ -5,1 +5,0 @@",
            "-deleted validation line",
          ].join("\n"),
        };
      }
      if (name === "read_file") {
        const start = Number(input.start_line ?? 1);
        return {
          ok: true,
          path: input.path,
          start_line: start,
          end_line: start,
          content: start === 5 ? "" : `${start}: export {};`,
        };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: "plugins/supermodels/scripts/lib/review-agent.mjs:1:export {};" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings[0].line_start, 5);
});

test("runReviewAgent keeps deleted-line diff counters aligned for deleted lines starting with dashes", async () => {
  const targetPath = "plugins/supermodels/scripts/lib/review-agent.mjs";
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: targetPath });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "deleted validation" });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Deleted line after dash-prefixed content accepted.",
        findings: [{
          severity: "medium",
          title: "Deleted line after comment",
          evidence: "The finding cites a deleted line after a dash-prefixed deleted line.",
          impact: "The diff parser must keep old-line counters aligned.",
          recommendation: "Treat dash-prefixed code as hunk content.",
          file: targetPath,
          line_start: 6,
          line_end: 6,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = reviewToolsWithDeletedDiff({
    targetPath,
    missingLine: 6,
    diff: [
      `diff --git a/${targetPath} b/${targetPath}`,
      `--- a/${targetPath}`,
      `+++ b/${targetPath}`,
      "@@ -5,2 +5,0 @@",
      "--- markdown separator",
      "-deleted validation line",
    ].join("\n"),
  });

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings[0].line_start, 6);
});

test("runReviewAgent matches deleted-line diff coverage for quoted paths with spaces", async () => {
  const targetPath = "plugins/supermodels/scripts/lib/file with space.mjs";
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: targetPath });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "file with space" });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Quoted diff path accepted.",
        findings: [{
          severity: "low",
          title: "Deleted line in spaced path",
          evidence: "The finding cites a deleted line in a file path containing spaces.",
          impact: "Quoted git paths should still validate.",
          recommendation: "Parse quoted diff paths.",
          file: targetPath,
          line_start: 3,
          line_end: 3,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = reviewToolsWithDeletedDiff({
    targetPath,
    missingLine: 3,
    diff: [
      `diff --git "a/${targetPath}" "b/${targetPath}"`,
      `--- "a/${targetPath}"`,
      `+++ "b/${targetPath}"`,
      "@@ -3,1 +3,0 @@",
      "-deleted validation line",
    ].join("\n"),
  });

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings[0].file, targetPath);
});

test("runReviewAgent matches deleted-line diff coverage for real unquoted git paths with spaces", async () => {
  const targetPath = "plugins/supermodels/scripts/lib/file with space.mjs";
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: targetPath });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "file with space" });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Unquoted diff path accepted.",
        findings: [{
          severity: "low",
          title: "Deleted line in unquoted spaced path",
          evidence: "The finding cites a deleted line in a file path containing spaces.",
          impact: "Git emits unquoted diff --git paths when paths contain ordinary spaces.",
          recommendation: "Use unambiguous file headers when matching diff hunks.",
          file: targetPath,
          line_start: 3,
          line_end: 3,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = reviewToolsWithDeletedDiff({
    targetPath,
    missingLine: 3,
    diff: [
      `diff --git a/${targetPath} b/${targetPath}`,
      `--- a/${targetPath}\t`,
      `+++ b/${targetPath}\t`,
      "@@ -3,1 +3,0 @@",
      "-deleted validation line",
    ].join("\n"),
  });

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings[0].file, targetPath);
});

test("runReviewAgent matches deleted-line diff coverage for git octal-quoted UTF-8 paths", async () => {
  const targetPath = "plugins/supermodels/scripts/lib/café.mjs";
  const quotedGitPath = "plugins/supermodels/scripts/lib/caf\\303\\251.mjs";
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: targetPath });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "café" });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Octal-quoted UTF-8 diff path accepted.",
        findings: [{
          severity: "low",
          title: "Deleted line in UTF-8 path",
          evidence: "The finding cites a deleted line in a non-ASCII file path.",
          impact: "Git quotePath escapes should still validate.",
          recommendation: "Decode git C-style octal path escapes.",
          file: targetPath,
          line_start: 3,
          line_end: 3,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = reviewToolsWithDeletedDiff({
    targetPath,
    missingLine: 3,
    diff: [
      `diff --git "a/${quotedGitPath}" "b/${quotedGitPath}"`,
      `--- "a/${quotedGitPath}"`,
      `+++ "b/${quotedGitPath}"`,
      "@@ -3,1 +3,0 @@",
      "-deleted validation line",
    ].join("\n"),
  });

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings[0].file, targetPath);
});

test("runReviewAgent rejects deleted-line findings that are not proven by the full immutable diff", async () => {
  const targetPath = "plugins/supermodels/scripts/lib/large-diff.mjs";
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: targetPath });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "large diff" });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "A truncated legacy diff cannot prove this deleted-line finding.",
        findings: [{
          severity: "medium",
          title: "Deleted line beyond truncated diff",
          evidence: "The finding cites deleted code, but the review-tool diff was truncated before that hunk.",
          impact: "A partial diff must not verify evidence it does not contain.",
          recommendation: "Require the full immutable diff to prove deleted lines.",
          file: targetPath,
          line_start: 700,
          line_end: 700,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = reviewToolsWithDeletedDiff({
    targetPath,
    missingLine: 700,
    truncated: true,
    diff: [
      `diff --git a/${targetPath} b/${targetPath}`,
      `--- a/${targetPath}`,
      `+++ b/${targetPath}`,
      "@@ -1,1 +1,1 @@",
      "-early line",
      "+early replacement",
    ].join("\n"),
  });

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
    maxReviewCorrectionAttempts: 0,
    minInspection: {
      diff: false,
      fileOrSearch: true,
      explicitFileOrSearchToolCalls: 2,
      cleanExplicitFileOrSearchToolCalls: 2,
    },
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.findings.length, 0);
  assert.match(result.verification_gaps.join("\n"), /no current content and no matching deleted-line diff/i);
});

test("runReviewAgent surfaces a verification gap when a truncated diff disables coverage", async () => {
  const targetPath = "plugins/supermodels/scripts/lib/large-diff.mjs";
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: targetPath, start_line: 1, end_line: 1 });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "large diff" });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "inconclusive",
        summary: "Finding on a truncated large diff.",
        findings: [{
          severity: "medium",
          title: "Concrete issue on an inspected line",
          evidence: "The cited line has current readable content.",
          impact: "Verifies the coverage-disabled gap is appended without breaking acceptance.",
          recommendation: "Keep the finding, add the coverage gap.",
          file: targetPath,
          line_start: 1,
          line_end: 1,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = reviewToolsWithDeletedDiff({
    targetPath,
    missingLine: 700,
    truncated: true,
    diff: [
      `diff --git a/${targetPath} b/${targetPath}`,
      `--- a/${targetPath}`,
      `+++ b/${targetPath}`,
      "@@ -1,1 +1,1 @@",
      "-early line",
      "+early replacement",
    ].join("\n"),
  });

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.ok(
    result.verification_gaps.some((gap) => /coverage enforcement was disabled/i.test(gap)),
    "expected a verification gap explaining that truncation disabled coverage",
  );
});

test("runReviewAgent keeps coverage enabled (no coverage-disabled gap) when only context is truncated but the diff is complete", async () => {
  const targetPath = "plugins/supermodels/scripts/lib/large-diff.mjs";
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: targetPath, start_line: 1, end_line: 1 });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "complete diff" });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Finding while the diff is complete despite snippet truncation.",
        findings: [{
          severity: "medium",
          title: "Concrete issue on an inspected line",
          evidence: "The cited line has current readable content.",
          impact: "Verifies coverage stays enabled when only context is truncated.",
          recommendation: "Keep the finding; no coverage gap.",
          file: targetPath,
          line_start: 1,
          line_end: 1,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = reviewToolsWithDeletedDiff({
    targetPath,
    missingLine: 700,
    truncated: true,       // context-level truncation (e.g. oversized snippets)
    diffTruncated: false,  // ...but the diff itself is complete
    diff: [
      `diff --git a/${targetPath} b/${targetPath}`,
      `--- a/${targetPath}`,
      `+++ b/${targetPath}`,
      "@@ -1,1 +1,1 @@",
      "-early line",
      "+early replacement",
    ].join("\n"),
  });

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.ok(
    !result.verification_gaps.some((gap) => /coverage enforcement was disabled/i.test(gap)),
    "no coverage-disabled gap when the diff is complete (only context/snippets truncated)",
  );
});

test("runReviewAgent keeps coverage enabled when the PRELOADED get_review_context has truncated:true but diffTruncated:false", async () => {
  const targetPath = "plugins/supermodels/scripts/lib/large-diff.mjs";
  const diff = [
    `diff --git a/${targetPath} b/${targetPath}`,
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -1,1 +1,1 @@",
    "-early line",
    "+early replacement",
  ].join("\n");
  const fakeTools = {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_review_context") {
        // Context-level truncation (e.g. oversized snippets or changedFiles) but
        // the diff itself is complete — the production coverage source.
        return { ok: true, diff, changedFiles: [], fileSnippets: [], truncated: true, diffTruncated: false };
      }
      if (name === "read_file") {
        const start = Number(input.start_line ?? 1);
        return { ok: true, path: input.path, start_line: start, end_line: start, content: `${start}: export {};` };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: `${targetPath}:1:export {};` };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("read_1", "read_file", { path: targetPath, start_line: 1, end_line: 1 });
      }
      if (this.calls === 2) {
        return responseWithTool("search_1", "search", { query: "large diff" });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Finding while the preloaded diff is complete despite context truncation.",
        findings: [{
          severity: "medium",
          title: "Concrete issue on an inspected line",
          evidence: "The cited line has current readable content.",
          impact: "Verifies coverage stays enabled when only preloaded context is truncated.",
          recommendation: "Keep the finding; no coverage gap.",
          file: targetPath,
          line_start: 1,
          line_end: 1,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    preloadTools: ["get_review_context"],
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.ok(
    !result.verification_gaps.some((gap) => /coverage enforcement was disabled/i.test(gap)),
    "no coverage-disabled gap when the preloaded diff is complete (only context truncated)",
  );
});

test("runReviewAgent accepts explicit inconclusive and attributes a legacy truncated-diff gap", async () => {
  const targetPath = "plugins/supermodels/scripts/lib/large-diff.mjs";
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: targetPath, start_line: 1, end_line: 1 });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "large diff" });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "inconclusive",
        summary: "The truncated legacy diff prevents a complete review.",
        findings: [],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = reviewToolsWithDeletedDiff({
    targetPath,
    missingLine: 700,
    truncated: true,
    diff: [
      `diff --git a/${targetPath} b/${targetPath}`,
      `--- a/${targetPath}`,
      `+++ b/${targetPath}`,
      "@@ -1,1 +1,1 @@",
      "-early line",
      "+early replacement",
    ].join("\n"),
  });

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.ok(
    result.verification_gaps.some((gap) => /^Supermodels:/.test(gap) && /coverage enforcement was disabled/i.test(gap)),
    "an inconclusive verdict on a truncated diff must carry the attributed coverage gap",
  );
});

test("runReviewAgent requires every immutable diff page before accepting a clean review", async () => {
  const nextCursor = "opaque-diff-page-2";
  const requestBodies = [];
  const fullDiff = "diff --git a/a.mjs b/a.mjs\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n";
  let diffCalls = 0;
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      requestBodies.push(body);
      this.calls += 1;
      if (this.calls === 1) return responseWithTool("diff_1", "get_diff", {});
      if (this.calls === 2) return responseWithTool("submit_early", "submit_review", cleanReview("Too early."));
      if (this.calls === 3) return responseWithTool("diff_2", "get_diff", { cursor: nextCursor });
      if (this.calls === 4) return responseWithTool("read_1", "read_file", { path: "a.mjs", start_line: 1, end_line: 1 });
      if (this.calls === 5) return responseWithTool("search_1", "search", { query: "export" });
      return responseWithTool("submit_final", "submit_review", cleanReview("All immutable diff pages inspected."));
    },
  };
  const fakeTools = {
    schemas: [],
    reviewDiff: fullDiff,
    async execute(name, input = {}) {
      if (name === "get_diff") {
        diffCalls += 1;
        if (diffCalls === 1) {
          return { ok: true, diff: fullDiff.slice(0, 30), complete: false, next_cursor: nextCursor };
        }
        assert.equal(input.cursor, nextCursor);
        return { ok: true, diff: fullDiff.slice(30), complete: true };
      }
      if (name === "read_file") {
        return { ok: true, path: "a.mjs", start_line: 1, end_line: 1, content: "1: export const a = 2;" };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: "a.mjs:1:export const a = 2;" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 6,
  });

  assert.equal(result.verdict, "clean");
  assert.equal(diffCalls, 2);
  assert.match(JSON.stringify(requestBodies[2].messages), /consume every immutable diff page/i);
});

test("runReviewAgent returns inconclusive when a provider refuses the remaining immutable diff page", async () => {
  const fullDiff = "diff --git a/a.mjs b/a.mjs\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n";
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) return responseWithTool("diff_1", "get_diff", {});
      if (this.calls === 2) return responseWithTool("read_1", "read_file", { path: "a.mjs", start_line: 1, end_line: 1 });
      if (this.calls === 3) return responseWithTool("search_1", "search", { query: "export" });
      return responseWithTool("submit_early", "submit_review", cleanReview("Ignored the remaining page."));
    },
  };
  const fakeTools = {
    schemas: [],
    reviewDiff: fullDiff,
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diff: fullDiff.slice(0, 30), complete: false, next_cursor: "unused-page" };
      }
      if (name === "read_file") {
        return { ok: true, path: "a.mjs", start_line: 1, end_line: 1, content: "1: export const a = 2;" };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: "a.mjs:1:export const a = 2;" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
    maxInspectionRefusals: 1,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.verification_gaps.join("\n"), /complete|required repository inspection|immutable diff/i);
});

test("runReviewAgent attributes a missing continuation after a later diff page precisely", async () => {
  const transport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) return responseWithTool("page_1", "get_diff", {});
      if (this.calls === 2) return responseWithTool("page_2", "get_diff", { cursor: "page-two" });
      return responseWithTool("submit", "submit_review", inconclusiveReview("The server omitted the next cursor."));
    },
  };
  const tools = {
    schemas: [],
    reviewDiff: "diff --git a/a.mjs b/a.mjs\n",
    async execute(name, input = {}) {
      assert.equal(name, "get_diff");
      if (!input.cursor) return { ok: true, diff: "page one", complete: false, next_cursor: "page-two" };
      assert.equal(input.cursor, "page-two");
      return { ok: true, diff: "page two", complete: false };
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport,
    tools,
    minInspection: { diff: true, fileOrSearch: false, explicitFileOrSearchToolCalls: 0 },
    maxRounds: 3,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.verification_gaps.join("\n"), /cursor page-two.*complete:false without a next_cursor/i);
});

test("runReviewAgent accepts explicit inconclusive with precise server gaps for unread diff and high-risk hunks", async () => {
  const fullDiff = [
    "diff --git a/auth/session.mjs b/auth/session.mjs",
    "--- a/auth/session.mjs",
    "+++ b/auth/session.mjs",
    "@@ -10,1 +10,2 @@",
    " const keep = true;",
    "+const token = rotateToken();",
  ].join("\n");
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("diff_2", "get_diff", { cursor: "unreadable-next-page" });
      }
      if (this.calls === 3) {
        return responseWithTool("read_1", "read_file", {
          path: "auth/session.mjs",
          start_line: 10,
          end_line: 11,
        });
      }
      return responseWithTool(
        "submit_1",
        "submit_review",
        inconclusiveReview("The remaining immutable evidence could not be consumed."),
      );
    },
  };
  const fakeTools = {
    schemas: [],
    reviewDiff: fullDiff,
    async execute(name, input = {}) {
      if (name === "get_diff") {
        if (input.cursor === "unreadable-next-page") {
          return { ok: false, error: "immutable snapshot page could not be decoded" };
        }
        return {
          ok: true,
          diff: fullDiff.slice(0, 45),
          complete: false,
          next_cursor: "unreadable-next-page",
        };
      }
      if (name === "read_file") {
        return {
          ok: false,
          error: "source line exceeds the readable line budget",
          path: input.path,
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rounds, 4);
  const gaps = result.verification_gaps.join("\n");
  assert.match(gaps, /immutable diff.*incomplete|not every immutable diff page/i);
  assert.match(gaps, /could not be decoded/i);
  assert.match(gaps, /auth\/session\.mjs:10-11/i);
  assert.match(gaps, /read_file|high-risk hunk|readable line budget/i);
});

test("runReviewAgent does not treat a wrong-cursor failure or unattempted high-risk read as inherently unavailable", async () => {
  const fullDiff = [
    "diff --git a/auth/session.mjs b/auth/session.mjs",
    "--- a/auth/session.mjs",
    "+++ b/auth/session.mjs",
    "@@ -10,1 +10,2 @@",
    " const keep = true;",
    "+const token = rotateToken();",
  ].join("\n");
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("diff_wrong", "get_diff", { cursor: "not-the-returned-cursor" });
      }
      return responseWithTool(
        `submit_${this.calls}`,
        "submit_review",
        inconclusiveReview("Skipped evidence is not unavailable evidence."),
      );
    },
  };
  const fakeTools = {
    schemas: [],
    reviewDiff: fullDiff,
    async execute(name, input = {}) {
      if (name === "get_diff") {
        if (input.cursor) {
          return { ok: false, error: "invalid review cursor" };
        }
        return {
          ok: true,
          diff: fullDiff.slice(0, 45),
          complete: false,
          next_cursor: "still-readable-next-page",
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 3,
    maxInspectionRefusals: 1,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.summary, /repeated inspection requirements/i);
  assert.equal(fakeTransport.calls, 3, "the wrong-cursor failure did not unlock the explicit inconclusive");
});

test("runReviewAgent mirrors read_file range clamping before classifying evidence unavailable", async () => {
  const diff = [
    "diff --git a/auth/session.mjs b/auth/session.mjs",
    "--- a/auth/session.mjs",
    "+++ b/auth/session.mjs",
    "@@ -100,200 +100,200 @@",
    "+const token = rotateToken();",
    ...Array.from({ length: 199 }, () => " context"),
  ].join("\n");
  const transport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) return responseWithTool("diff", "get_diff", {});
      if (this.calls === 2) {
        return responseWithTool("read", "read_file", {
          path: "auth/session.mjs",
          start_line: 100,
          end_line: 1,
        });
      }
      return responseWithTool("submit", "submit_review", inconclusiveReview("The malformed range must not prove the unread tail unavailable."));
    },
  };
  const tools = {
    schemas: [],
    reviewDiff: diff,
    async execute(name, input = {}) {
      if (name === "get_diff") return { ok: true, diff, complete: true };
      if (name === "read_file") {
        return { ok: true, path: input.path, start_line: 100, end_line: 100, content: "100: const token = rotateToken();", truncated: false };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport,
    tools,
    minInspection: { diff: true, fileOrSearch: true, explicitFileOrSearchToolCalls: 1 },
    maxInspectionRefusals: 1,
    maxRounds: 3,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.summary, /repeated inspection requirements/i);
  assert.match(result.verification_gaps.join("\n"), /auth\/session\.mjs:100-299/);
  assert.doesNotMatch(result.verification_gaps.join("\n"), /could not deliver auth\/session\.mjs:101-299/);
});

test("runReviewAgent reconstructs every immutable diff byte when page one is preloaded", async () => {
  const maxToolBytes = 20_000;
  const fullDiff = [
    "diff --git a/docs/large.txt b/docs/large.txt\n",
    "--- a/docs/large.txt\n",
    "+++ b/docs/large.txt\n",
    "@@ -1 +1 @@\n",
    `+${"payload-".repeat(12_000)}\n`,
  ].join("");
  const snapshot = {
    id: "snapshot-preload-pages",
    root: process.cwd(),
    baseOid: "base",
    changedFiles: [],
    context: {
      snapshotId: "snapshot-preload-pages",
      baseOid: "base",
      diffSummary: "1 file changed",
      diff: fullDiff,
      changedFiles: [],
      gitAvailable: true,
    },
  };
  const reviewTools = createReviewTools({
    workspaceRoot: process.cwd(),
    snapshot,
    maxToolBytes,
  });
  const pages = [];
  const requestSizes = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      if (this.calls === 1) {
        const preloadText = body.messages[1].content[0].text;
        requestSizes.push(Buffer.byteLength(preloadText, "utf8"));
        const envelope = JSON.parse(preloadText.slice(preloadText.indexOf('{"preloaded"')));
        const page = envelope.preloaded[0].result;
        assert.equal(page.coverage_ledger?.enabled, true, "the delivered preload retains its server coverage ledger");
        pages.push(page.diff);
        return responseWithTool("diff_next_1", "get_diff", { cursor: page.next_cursor });
      }
      const resultBlock = body.messages.at(-1).content.find((part) => part.type === "tool_result");
      const page = JSON.parse(resultBlock.content);
      pages.push(page.diff);
      if (!page.complete) {
        return responseWithTool(`diff_next_${this.calls}`, "get_diff", { cursor: page.next_cursor });
      }
      return responseWithTool("submit_final", "submit_review", inconclusiveReview("All pages reconstructed."));
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: reviewTools,
    preloadTools: ["get_review_context"],
    minInspection: {
      diff: true,
      fileOrSearch: false,
      explicitFileOrSearchToolCalls: 0,
      cleanExplicitFileOrSearchToolCalls: 0,
    },
    maxRounds: 20,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(pages.join(""), fullDiff, "preload plus cursor pages reconstruct the diff losslessly");
  assert.ok(requestSizes.every((size) => size <= maxToolBytes), "assembled preload stayed inside the cap");
});

test("runReviewAgent discards an oversized custom diff preload instead of advancing its cursor", async () => {
  let contextCalls = 0;
  const fakeTools = {
    schemas: [],
    maxToolBytes: 600,
    async execute(name) {
      if (name !== "get_review_context") {
        throw new Error(`unexpected tool ${name}`);
      }
      contextCalls += 1;
      if (contextCalls === 1) {
        return {
          ok: true,
          diff: "discard-me-".repeat(500),
          complete: false,
          next_cursor: "cursor-past-undelivered-bytes",
        };
      }
      return { ok: true, diff: "complete fresh page", complete: true };
    },
  };
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      if (this.calls === 1) {
        const preloadText = body.messages[1].content[0].text;
        assert.match(preloadText, /discarded|fresh get_review_context/i);
        assert.doesNotMatch(preloadText, /cursor-past-undelivered-bytes/);
        return responseWithTool("fresh_context", "get_review_context", {});
      }
      return responseWithTool("submit", "submit_review", inconclusiveReview("Fresh page consumed."));
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    preloadTools: ["get_review_context"],
    minInspection: { diff: true, fileOrSearch: false, explicitFileOrSearchToolCalls: 0 },
    maxRounds: 2,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(contextCalls, 2, "the discarded preload was restarted from page one");
});

test("runReviewAgent makes provider-declared clean reviews inconclusive when verification gaps remain", async () => {
  const review = cleanReview("No issue proven, but one check remains.");
  review.verification_gaps = ["The integration smoke test was not run."];
  const result = await runReviewAgent({
    provider: "claude",
    transport: { async messages() { return responseWithTool("submit", "submit_review", review); } },
    tools: { schemas: [], async execute() { return { ok: true }; } },
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    maxRounds: 1,
  });
  assert.equal(result.verdict, "inconclusive");
  assert.deepEqual(result.verification_gaps, ["The integration smoke test was not run."]);
});

test("runReviewAgent does not accept a clean submit from an incomplete provider turn", async () => {
  const result = await runReviewAgent({
    provider: "claude",
    transport: {
      async messages() {
        return responseWithTool("submit", "submit_review", cleanReview("Truncated clean."), {
          status: "incomplete",
          reason: "max_tokens",
        });
      },
    },
    tools: { schemas: [], async execute() { return { ok: true }; } },
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    maxRounds: 1,
  });
  assert.equal(result.verdict, "inconclusive");
  assert.match(result.verification_gaps.join("\n"), /max_tokens/);
});

test("runReviewAgent rejects missing current-line content without deleted-line diff evidence", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", {
          path: "plugins/supermodels/scripts/lib/review-agent.mjs",
        });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", {
          query: "deleted validation",
        });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Line absence rejected.",
        findings: [{
          severity: "medium",
          title: "Impossible current line",
          evidence: "The finding cites a line that is not in the current file or deleted diff.",
          impact: "Unanchored findings should be rejected.",
          recommendation: "Require current content or deleted-line diff evidence.",
          file: "plugins/supermodels/scripts/lib/review-agent.mjs",
          line_start: 999999,
          line_end: 999999,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff: "diff --git a/a b/a\n" };
      }
      if (name === "read_file") {
        const start = Number(input.start_line ?? 1);
        return {
          ok: true,
          path: input.path,
          start_line: start,
          end_line: start,
          content: start > 1000 ? "" : `${start}: export {};`,
        };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: "plugins/supermodels/scripts/lib/review-agent.mjs:1:export {};" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    maxRounds: 4,
    maxReviewCorrectionAttempts: 0,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.summary, /could not be accepted/i);
  assert.match(result.verification_gaps.join("\n"), /no current content and no matching deleted-line diff/i);
});

test("runReviewAgent requires every cited current-file line to be delivered", async () => {
  const review = {
    verdict: "needs-attention",
    summary: "A multi-line finding was cited.",
    findings: [{
      severity: "medium",
      title: "Partially visible range",
      evidence: "Only the first cited line is visible.",
      impact: "Partial evidence must not validate a whole range.",
      recommendation: "Deliver every cited line.",
      file: "a.mjs",
      line_start: 10,
      line_end: 20,
      confidence: "high",
    }],
    missing_change_findings: [],
    assumptions: [],
    verification_gaps: [],
  };
  const result = await runReviewAgent({
    provider: "claude",
    transport: { async messages() { return responseWithTool("submit", "submit_review", review); } },
    tools: {
      schemas: [],
      reviewDiff: "diff --git a/a.mjs b/a.mjs\n",
      async execute(name, input) {
        if (name === "read_file") return { ok: true, path: input.path, start_line: 10, end_line: 10, content: "10: only one line" };
        throw new Error(`unexpected tool ${name}`);
      },
    },
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0 },
    maxReviewCorrectionAttempts: 0,
    maxRounds: 1,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.verification_gaps.join("\n"), /no current content and no matching deleted-line diff/i);
});

test("runReviewAgent requires every cited line to exist in deleted-line diff evidence", async () => {
  const review = {
    verdict: "needs-attention",
    summary: "A deleted range was cited.",
    findings: [{
      severity: "medium",
      title: "Partially deleted range",
      evidence: "Only one cited line was deleted.",
      impact: "Partial deletion must not validate a whole range.",
      recommendation: "Cite the exact deleted line.",
      file: "a.mjs",
      line_start: 5,
      line_end: 6,
      confidence: "high",
    }],
    missing_change_findings: [],
    assumptions: [],
    verification_gaps: [],
  };
  const result = await runReviewAgent({
    provider: "claude",
    transport: { async messages() { return responseWithTool("submit", "submit_review", review); } },
    tools: {
      schemas: [],
      reviewDiff: [
        "diff --git a/a.mjs b/a.mjs",
        "--- a/a.mjs",
        "+++ b/a.mjs",
        "@@ -5,2 +5 @@",
        "-deleted line five",
        " unchanged line six",
      ].join("\n"),
      async execute(name, input) {
        if (name === "read_file") return { ok: true, path: input.path, start_line: 5, end_line: 4, content: "" };
        throw new Error(`unexpected tool ${name}`);
      },
    },
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0 },
    maxReviewCorrectionAttempts: 0,
    maxRounds: 1,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.verification_gaps.join("\n"), /no current content and no matching deleted-line diff/i);
});

test("runReviewAgent rejects finding ranges that are too large to verify", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", {
          path: "plugins/supermodels/scripts/lib/review-agent.mjs",
        });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", {
          query: "verifyFindingLocations",
        });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Oversized finding range.",
        findings: [{
          severity: "low",
          title: "Huge range",
          evidence: "The finding cites a huge range.",
          impact: "The verifier cannot prove the whole span.",
          recommendation: "Return a tighter location.",
          file: "plugins/supermodels/scripts/lib/review-agent.mjs",
          line_start: 1,
          line_end: 250,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 4,
    maxReviewCorrectionAttempts: 0,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.verification_gaps.join("\n"), /finding range spans more than 200 lines/i);
});

test("runReviewAgent uses generic correction-attempt wording for configurable budgets", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", {
          path: "plugins/supermodels/scripts/lib/review-agent.mjs",
        });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", {
          query: "verifyFindingLocations",
        });
      }
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Bad finding.",
        findings: [{
          severity: "low",
          title: "Missing file",
          evidence: "The file does not exist.",
          impact: "The verifier rejects it.",
          recommendation: "Use a real file.",
          file: "missing-file.mjs",
          line_start: 1,
          line_end: 1,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 4,
    maxReviewCorrectionAttempts: 0,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.verification_gaps[0], /allowed correction attempts/i);
  assert.doesNotMatch(result.verification_gaps[0], /one correction attempt/i);
});

test("runReviewAgent stops after one repeated finding verification failure", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", {
          path: "plugins/supermodels/scripts/lib/review-agent.mjs",
        });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", {
          query: "runReviewAgent",
        });
      }
      return responseWithTool(`bad_submit_${this.calls}`, "submit_review", {
        verdict: "needs-attention",
        summary: "Still bad.",
        findings: [{
          severity: "medium",
          title: "Still bad",
          evidence: "The model still cites a missing file.",
          impact: "The finding remains unactionable.",
          recommendation: "Return a valid location.",
          file: "missing-file.mjs",
          line_start: 10,
          line_end: 10,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 6,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.summary, /could not be accepted/i);
  assert.equal(fakeTransport.calls, 5);
});

test("runReviewAgent sends Anthropic-compatible tool_result blocks without names", async () => {
  const calls = [];
  const fakeTransport = {
    async messages(body) {
      calls.push(body);
      if (calls.length === 1) {
        return responseWithTool("read_1", "read_file", { path: "runtime.mjs" });
      }
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("tool result shape checked"));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      if (name === "read_file") {
        return { ok: true, path: "runtime.mjs", content: "1: export {};" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    minInspection: { diff: false, fileOrSearch: true, explicitFileOrSearchToolCalls: 1 },
    maxRounds: 2,
  });

  const toolResult = calls[1].messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block.type === "tool_result");
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "read_1");
  assert.equal(Object.hasOwn(toolResult, "name"), false);
});

test("runReviewAgent forces submit_review only after required inspection is satisfied", async () => {
  const seenToolChoices = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      seenToolChoices.push(body.tool_choice ?? null);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("search_1", "search", { query: "cancelJob" });
      }
      assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_review" });
      return responseWithTool("submit_forced", "submit_review", inconclusiveReview("Forced final review."));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff: "diff --git a/a b/a" };
      }
      if (name === "search") {
        return { ok: true, query: "cancelJob", output: "cancellation.mjs:1:export function cancelJob" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: fakeTools,
    focus: "review lifecycle changes",
    minInspection: { explicitFileOrSearchToolCalls: 1 },
    forceAfterRounds: 3,
    maxRounds: 3,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(seenToolChoices[0], null);
  assert.equal(seenToolChoices[1], null);
  assert.deepEqual(seenToolChoices[2], { type: "tool", name: "submit_review" });
});

test("runReviewAgent preserves trailing-space paths through high-risk coverage and finding verification", async () => {
  const seenToolChoices = [];
  const targetPath = "auth/session.mjs ";
  const diff = [
    `diff --git a/${targetPath} b/${targetPath}`,
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -10,2 +10,3 @@ function revoke(session) {",
    "+  delete session.token;",
    " }",
  ].join("\n");
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      seenToolChoices.push(body.tool_choice ?? null);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("search_1", "search", { query: "revoke session" });
      }
      if (this.calls === 3) {
        assert.equal(body.tool_choice, undefined);
        return responseWithTool("read_1", "read_file", {
          path: targetPath,
          start_line: 10,
          end_line: 12,
        });
      }
      assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_review" });
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Coverage was satisfied before forced submit.",
        findings: [{
          severity: "medium",
          title: "Token deletion needs review",
          evidence: "The hunk was read directly before final submission.",
          impact: "Session revocation behavior can change.",
          recommendation: "Keep the coverage gate ahead of forced submit.",
          file: targetPath,
          line_start: 10,
          line_end: 10,
          confidence: "medium",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: `${targetPath}:10:function revoke(session) {` };
      }
      if (name === "read_file") {
        return {
          ok: true,
          path: input.path,
          start_line: Number(input.start_line ?? 1),
          end_line: Number(input.end_line ?? input.start_line ?? 1),
          content: "10: function revoke(session) {\n11:   delete session.token;\n12: }",
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: fakeTools,
    minInspection: { explicitFileOrSearchToolCalls: 1 },
    forceAfterRounds: 3,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings[0].file, targetPath);
  assert.deepEqual(seenToolChoices, [
    null,
    null,
    null,
    { type: "tool", name: "submit_review" },
  ]);
});

test("runReviewAgent keeps POSIX slash and backslash paths distinct for reads, coverage, and finding verification", {
  skip: path.sep === "\\",
}, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "supermodels-backslash-path-"));
  const targetPath = String.raw`auth\policy.mjs`;
  const decoyPath = "auth/policy.mjs";
  try {
    await mkdir(path.join(workspaceRoot, "auth"));
    const source = (label) => Array.from(
      { length: 12 },
      (_, index) => index === 9 ? `const permission = "${label}";` : `// ${label} ${index + 1}`,
    ).join("\n");
    await writeFile(path.join(workspaceRoot, decoyPath), source("slash-decoy"), "utf8");
    await writeFile(path.join(workspaceRoot, targetPath), source("backslash-target"), "utf8");

    const diff = [
      String.raw`diff --git "a/auth\\policy.mjs" "b/auth\\policy.mjs"`,
      String.raw`--- "a/auth\\policy.mjs"`,
      String.raw`+++ "b/auth\\policy.mjs"`,
      "@@ -10,3 +10,3 @@",
      '-const permission = "old";',
      '+const permission = "backslash-target";',
      " // backslash-target 11",
      " // backslash-target 12",
    ].join("\n");
    const submittedReview = {
      verdict: "needs-attention",
      summary: "The literal-backslash policy was reviewed.",
      findings: [{
        severity: "medium",
        title: "Policy change needs verification",
        evidence: "The exact literal-backslash file changes permission behavior.",
        impact: "Authorization behavior can change.",
        recommendation: "Keep the exact path identity when validating it.",
        file: targetPath,
        line_start: 10,
        line_end: 10,
        confidence: "high",
      }],
      assumptions: [],
      verification_gaps: [],
    };
    const calls = [];
    let verificationRedirect = "";
    const transport = {
      calls: 0,
      async messages(body) {
        this.calls += 1;
        calls.push(body);
        if (this.calls === 1) return responseWithTool("diff", "get_diff", {});
        if (this.calls === 2) {
          return responseWithTool("read-decoy", "read_file", {
            path: decoyPath,
            start_line: 10,
            end_line: 12,
          });
        }
        if (this.calls === 3) return responseWithTool("submit-before-target", "submit_review", submittedReview);
        if (this.calls === 4) {
          return responseWithTool("read-target", "read_file", {
            path: targetPath,
            start_line: 10,
            end_line: 12,
          });
        }
        if (this.calls === 5) {
          verificationRedirect = decoyPath;
          return responseWithTool("submit-wrong-verification", "submit_review", submittedReview);
        }
        verificationRedirect = "";
        return responseWithTool("submit-exact-verification", "submit_review", submittedReview);
      },
    };
    const baseTools = createReviewTools({ workspaceRoot });
    const readEvents = [];
    const tools = {
      schemas: baseTools.schemas,
      reviewDiff: diff,
      async execute(name, input = {}, options = {}) {
        if (name === "get_diff") {
          return { ok: true, diffSummary: "1 file changed", diff, complete: true };
        }
        if (name === "read_file") {
          const servedPath = verificationRedirect || input.path;
          const result = await baseTools.execute(name, { ...input, path: servedPath }, options);
          readEvents.push({ requested: input.path, served: result.path, content: result.content });
          return result;
        }
        throw new Error(`unexpected tool ${name}`);
      },
    };

    const result = await runReviewAgent({
      provider: "claude",
      transport,
      tools,
      maxRounds: 6,
      minInspection: {
        diff: true,
        fileOrSearch: true,
        explicitFileOrSearchToolCalls: 1,
        cleanExplicitFileOrSearchToolCalls: 1,
      },
    });

    assert.equal(result.verdict, "needs-attention");
    assert.equal(result.findings[0].file, targetPath);
    assert.deepEqual(readEvents.map(({ requested, served }) => ({ requested, served })), [
      { requested: decoyPath, served: decoyPath },
      { requested: targetPath, served: targetPath },
      { requested: targetPath, served: decoyPath },
      { requested: targetPath, served: targetPath },
    ]);
    assert.match(readEvents[0].content, /slash-decoy/);
    assert.match(readEvents[1].content, /backslash-target/);
    assert.equal(transport.calls, 6, "the mismatched verification path forced a correction round");
    assert.match(
      JSON.stringify(calls[5].messages.at(-1).content),
      /finding location could not be verified/i,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runReviewAgent leaves a retry round after malformed forced submit_review", async () => {
  const seenToolChoices = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      seenToolChoices.push(body.tool_choice ?? null);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: "runtime.mjs" });
      }
      if (this.calls === 3) {
        assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_review" });
        return responseWithTool("bad_submit", "submit_review", { verdict: "clean" });
      }
      assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_review" });
      return responseWithTool("submit_1", "submit_review", {
        verdict: "needs-attention",
        summary: "Recovered after malformed submit.",
        findings: [{
          severity: "low",
          title: "Retry worked",
          evidence: "The review loop gave the provider another submit round.",
          impact: "Structured review output is not lost after one malformed submit.",
          recommendation: "Keep a forced-submit retry margin.",
          file: "plugins/supermodels/scripts/lib/review-agent.mjs",
          line_start: 1,
          line_end: 1,
          confidence: "high",
        }],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };
  const fakeTools = reviewToolsForDiffAndFiles();

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: fakeTools,
    minInspection: { explicitFileOrSearchToolCalls: 1 },
    forceAfterRounds: 3,
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.deepEqual(seenToolChoices, [
    null,
    null,
    { type: "tool", name: "submit_review" },
    { type: "tool", name: "submit_review" },
  ]);
});

test("runReviewAgent default review loop is not capped at eight rounds", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls < 10) {
        return responseWithTool(`read_${this.calls}`, "read_file", { path: `runtime-${this.calls}.mjs` });
      }
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("long review completed"));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input) {
      if (name === "read_file") {
        return { ok: true, path: input.path, content: "1: export {};" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    minInspection: { diff: false, fileOrSearch: true },
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rounds, 10);
  assert.equal(result.toolUsage.read_file, 9);
});

test("runReviewAgent lets normal Antigravity reviews submit when the model is done", async () => {
  const seenToolChoices = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      seenToolChoices.push(body.tool_choice ?? null);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: "a.mjs" });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "runReviewAgent" });
      }
      if (this.calls < 10) {
        return responseWithTool(`read_${this.calls}`, "read_file", { path: `extra-${this.calls}.mjs` });
      }
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("forced synthesis"));
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 10,
    forceAfterSatisfiedRounds: Number.POSITIVE_INFINITY,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rounds, 10);
  assert.deepEqual(seenToolChoices, Array.from({ length: 10 }, () => null));
});

test("runReviewAgent forces Antigravity submission after post-evidence backstop", async () => {
  const seenToolChoices = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      seenToolChoices.push(body.tool_choice ?? null);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: "a.mjs" });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "runReviewAgent" });
      }
      if (body.tool_choice?.name === "submit_review") {
        return responseWithTool("submit_1", "submit_review", inconclusiveReview("post-evidence backstop"));
      }
      return responseWithTool(`read_${this.calls}`, "read_file", { path: `extra-${this.calls}.mjs` });
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    reviewPolicy: resolveAntigravityReviewPolicy({ mode: "review" }),
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 10,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rounds, 8);
  assert.deepEqual(seenToolChoices.slice(0, 7), Array.from({ length: 7 }, () => null));
  assert.deepEqual(seenToolChoices[7], { type: "tool", name: "submit_review" });
});

test("runReviewAgent keeps adversarial Antigravity reviews model-led by default", async () => {
  const seenToolChoices = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      seenToolChoices.push(body.tool_choice ?? null);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: "a.mjs" });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "runReviewAgent" });
      }
      if (this.calls < 12) {
        return responseWithTool(`read_${this.calls}`, "read_file", { path: `extra-${this.calls}.mjs` });
      }
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("adversarial forced synthesis"));
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    mode: "adversarial-review",
    maxRounds: 12,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rounds, 12);
  assert.deepEqual(seenToolChoices, Array.from({ length: 12 }, () => null));
});

function grokBackstopTransport() {
  return {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      this.seenToolChoices ??= [];
      this.seenToolChoices.push(body.tool_choice ?? null);
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: "a.mjs" });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "runReviewAgent" });
      }
      if (body.tool_choice?.name === "submit_review") {
        return responseWithTool("submit_1", "submit_review", inconclusiveReview("grok post-evidence backstop"));
      }
      return responseWithTool(`read_${this.calls}`, "read_file", { path: `extra-${this.calls}.mjs` });
    },
  };
}

test("runReviewAgent forces Grok submission after the post-evidence backstop", async () => {
  const fakeTransport = grokBackstopTransport();

  const result = await runReviewAgent({
    provider: "grok",
    reviewPolicy: resolveGrokReviewPolicy(),
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 30,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rounds, 8);
  assert.deepEqual(fakeTransport.seenToolChoices[7], { type: "tool", name: "submit_review" });
});

test("runReviewAgent bounds adversarial Grok challenges with the same backstop", async () => {
  const fakeTransport = grokBackstopTransport();

  const result = await runReviewAgent({
    provider: "grok",
    reviewPolicy: resolveGrokReviewPolicy(),
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    mode: "adversarial-review",
    maxRounds: 30,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rounds, 8);
  assert.deepEqual(fakeTransport.seenToolChoices[7], { type: "tool", name: "submit_review" });
});

test("runReviewAgent aggregates usage across every model turn", async () => {
  const events = [];
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return {
          ...responseWithTool("read_1", "read_file", { path: "a.mjs" }),
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        };
      }
      if (this.calls === 2) {
        return {
          ...responseWithTool("search_1", "search", { query: "runReviewAgent" }),
          usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
        };
      }
      return {
        ...responseWithTool("submit_1", "submit_review", inconclusiveReview("usage checked")),
        usage: { input_tokens: 30, output_tokens: 4, total_tokens: 34 },
      };
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    minInspection: { diff: false, fileOrSearch: true, explicitFileOrSearchToolCalls: 2 },
    maxRounds: 3,
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result.usage, {
    input_tokens: 60,
    output_tokens: 9,
    total_tokens: 69,
  });
  assert.deepEqual(
    events
      .filter((event) => event.type === "usage")
      .map((event) => ({ message: event.message, usage: event.usage })),
    [
      {
        message: "antigravity review usage input=10 output=2 total=12",
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
      {
        message: "antigravity review usage input=30 output=5 total=35",
        usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
      },
      {
        message: "antigravity review usage input=60 output=9 total=69",
        usage: { input_tokens: 60, output_tokens: 9, total_tokens: 69 },
      },
    ],
  );
});

test("runReviewAgent passes event sink to provider transports", async () => {
  let seenOnEvent = null;
  const events = [];
  const fakeTransport = {
    async messages(_body, options) {
      seenOnEvent = options.onEvent;
      options.onEvent?.({ type: "progress", message: "transport progress" });
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("event sink checked"));
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: { schemas: [], async execute() {} },
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    forceAfterRounds: 1,
    maxRounds: 1,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(typeof seenOnEvent, "function");
  assert(events.some((event) => event.message === "transport progress"));
});

for (const provider of ["claude", "antigravity", "grok"]) {
  test(`runReviewAgent accepts no-tool structured final text for ${provider}`, async () => {
    const fakeTransport = {
      calls: 0,
      async messages() {
        this.calls += 1;
        if (this.calls === 1) {
          return responseWithTool("diff_1", "get_diff", {});
        }
        if (this.calls === 2) {
          return responseWithTool("read_1", "read_file", { path: "a.mjs" });
        }
        if (this.calls === 3) {
          return responseWithTool("search_1", "search", { query: "runReviewAgent" });
        }
        return responseWithText(JSON.stringify(inconclusiveReview(`${provider} final text accepted`)));
      },
    };

    const result = await runReviewAgent({
      provider,
      transport: fakeTransport,
      tools: reviewToolsForDiffAndFiles(),
      maxRounds: 4,
    });

    assert.equal(result.verdict, "inconclusive");
    assert.equal(result.summary, `${provider} final text accepted`);
    assert.equal(result.rounds, 4);
  });
}

test("runReviewAgent asks for structured conversion instead of more tools after no-tool final text", async () => {
  const calls = [];
  const fakeTransport = {
    async messages(body) {
      calls.push(body);
      if (calls.length === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (calls.length === 2) {
        return responseWithTool("read_1", "read_file", { path: "a.mjs" });
      }
      if (calls.length === 3) {
        return responseWithTool("search_1", "search", { query: "runReviewAgent" });
      }
      if (calls.length === 4) {
        return responseWithText("I am done. No concrete bugs found after reviewing the relevant files.");
      }
      return responseWithText(JSON.stringify(inconclusiveReview("converted final answer")));
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 5,
  });

  const conversionPrompt = JSON.stringify(calls[4].messages.at(-1).content);
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.summary, "converted final answer");
  assert.match(conversionPrompt, /convert/i);
  assert.match(conversionPrompt, /structured/i);
  assert.doesNotMatch(conversionPrompt, /Continue the review with repository tools/i);
});

test("runReviewAgent stops after one failed structured conversion turn", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: "a.mjs" });
      }
      if (this.calls === 3) {
        return responseWithTool("search_1", "search", { query: "runReviewAgent" });
      }
      return responseWithText("I am done, but I did not format the result.");
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    maxRounds: 5,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rounds, 5);
  assert.match(result.summary, /ended without structured review/i);
  assert.equal(fakeTransport.calls, 5);
});

test("runReviewAgent fails no-tool churn as no progress instead of looping indefinitely", async () => {
  const prompts = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      prompts.push(JSON.stringify(body.messages.at(-1).content));
      return responseWithText("I am still considering the review.");
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "antigravity",
      transport: fakeTransport,
      tools: { schemas: [], async execute() {} },
      maxNoToolContinuationRounds: 2,
      maxRounds: 10,
    }),
    /no repository-inspection progress/i,
  );

  assert.equal(fakeTransport.calls, 2);
  assert.match(prompts[1], /Continue the review with repository tools/i);
});

test("runReviewAgent uses timeout as an aggregate review budget", { timeout: 10_000 }, async () => {
  const seenTimeouts = [];
  const fakeTransport = {
    async messages(_body, options) {
      seenTimeouts.push(options.timeoutMs);
      // Returns a clean result only after 1000ms — far past the 50ms budget. If the
      // budget did NOT fire, the review would accept this clean result and the
      // assert.rejects below would fail. So the rejection proves the abort won,
      // with no brittle wall-clock stopwatch; the { timeout } guards a real hang.
      await sleep(1_000);
      return responseWithTool("submit", "submit_review", cleanReview("Late clean result."));
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "antigravity",
      transport: fakeTransport,
      tools: { schemas: [], async execute() {} },
      timeoutMs: 50,
    }),
    /timed out (?:before completion|after 50ms)/i,
  );

  assert.equal(seenTimeouts.length, 1);
  assert(seenTimeouts[0] > 0 && seenTimeouts[0] <= 50);
});

test("runReviewAgent requires distinct meaningful file or search inspection", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("read_1", "read_file", { path: "same.mjs" });
      }
      if (this.calls === 3) {
        return responseWithTool("read_2", "read_file", { path: "same.mjs" });
      }
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("duplicate reads"));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff: "diff --git a/a b/a" };
      }
      if (name === "read_file") {
        return { ok: true, path: input.path, start_line: 1, end_line: 1, content: "1: export {};" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "claude",
      transport: fakeTransport,
      tools: fakeTools,
      maxRounds: 4,
      forceAfterRounds: Number.POSITIVE_INFINITY,
    }),
    /review did not complete/i,
  );
});

test("runReviewAgent does not count no-match searches as meaningful inspection", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        return responseWithTool("search_1", "search", { query: "definitelyAbsentSymbol" });
      }
      if (this.calls === 3) {
        return responseWithTool("read_1", "read_file", { path: "a.mjs" });
      }
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("one no-match search and one read"));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name, input) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff: "diff --git a/a b/a" };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: "(no matches)" };
      }
      if (name === "read_file") {
        return { ok: true, path: input.path, content: "1: export {};" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "claude",
      transport: fakeTransport,
      tools: fakeTools,
      maxRounds: 4,
      forceAfterRounds: Number.POSITIVE_INFINITY,
    }),
    /review did not complete/i,
  );
});

test("runReviewAgent refuses shallow clean verdicts until multiple files or searches are inspected", async () => {
  const calls = [];
  const fakeTransport = {
    async messages(body) {
      calls.push(body);
      if (calls.length === 1) {
        return responseWithTool("read_1", "read_file", { path: "runtime.mjs" });
      }
      return responseWithTool("submit_clean", "submit_review", cleanReview("Only one file was read."));
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "antigravity",
      transport: fakeTransport,
      tools: reviewToolsForDiffAndFiles(),
      minInspection: { diff: false, fileOrSearch: true },
      forceAfterRounds: 2,
      maxRounds: 3,
    }),
    /review did not complete/i,
  );

  assert.match(JSON.stringify(calls[2].messages), /at least 2 relevant files/i);
});

test("runReviewAgent stops repeated inspection-gate refusals before aggregate timeout", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      return responseWithTool(`submit_early_${this.calls}`, "submit_review", cleanReview("Still too early."));
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    minInspection: { diff: true, fileOrSearch: true, explicitFileOrSearchToolCalls: 2 },
    maxInspectionRefusals: 2,
    maxRounds: 10,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.summary, /repeated inspection requirements/i);
  assert.equal(fakeTransport.calls, 2);
});

test("runReviewAgent does not reset inspection refusals for non-advancing tool calls", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      return responseWithTools([
        { id: `diff_${this.calls}`, name: "get_diff", input: {} },
        { id: `submit_${this.calls}`, name: "submit_review", input: cleanReview("Still too early.") },
      ]);
    },
  };

  const tools = reviewToolsForDiffAndFiles();
  tools.execute = async (name, input = {}) => {
    if (name === "get_diff") {
      assert.equal(input.cursor, undefined, "the provider is replaying page one instead of advancing");
      return { ok: true, diff: "page one", complete: false, next_cursor: "required-next-page" };
    }
    throw new Error(`unexpected tool ${name}`);
  };
  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools,
    minInspection: { diff: true, fileOrSearch: true, explicitFileOrSearchToolCalls: 2 },
    maxInspectionRefusals: 2,
    maxRounds: 10,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.summary, /repeated inspection requirements/i);
  assert.equal(fakeTransport.calls, 3, "the first same-turn tool result must be delivered before refusals can terminate the review");
  assert.match(result.verification_gaps.join("\n"), /"diffPages":1/);
  assert.match(result.verification_gaps.join("\n"), /required-next-page/);
});

test("runReviewAgent preserves exact server evidence in terminal inspection-refusal output", async () => {
  const diff = [
    "diff --git a/auth/session.mjs b/auth/session.mjs",
    "--- a/auth/session.mjs",
    "+++ b/auth/session.mjs",
    "@@ -50,1 +50,2 @@",
    " const keep = true;",
    "+const token = rotateToken();",
  ].join("\n");
  const result = await runReviewAgent({
    provider: "claude",
    transport: { async messages() { return responseWithTool("submit", "submit_review", inconclusiveReview("I did not inspect it.")); } },
    tools: { schemas: [], reviewDiff: diff, async execute() { throw new Error("no tool expected"); } },
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0 },
    maxInspectionRefusals: 1,
    maxRounds: 1,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.match(result.verification_gaps.join("\n"), /auth\/session\.mjs:50-51/);
});

test("runReviewAgent allows clean verdicts after two explicit file or search inspections", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("read_1", "read_file", { path: "runtime.mjs" });
      }
      if (this.calls === 2) {
        return responseWithTool("search_1", "search", { query: "runReviewAgent" });
      }
      return responseWithTool("submit_clean", "submit_review", cleanReview("Two evidence tools were used."));
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: reviewToolsForDiffAndFiles(),
    minInspection: { diff: false, fileOrSearch: true },
    forceAfterRounds: 3,
    maxRounds: 3,
  });

  assert.equal(result.verdict, "clean");
  assert.equal(result.toolUsage.read_file, 1);
  assert.equal(result.toolUsage.search, 1);
});

test("runReviewAgent executes repository tools from mixed invalid submit turns", async () => {
  const executed = [];
  let secondRequest;
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      if (this.calls === 1) {
        return {
          content: [
            { type: "tool_use", id: "submit_bad", name: "submit_review", input: { verdict: "clean" } },
            { type: "tool_use", id: "read_1", name: "read_file", input: { path: "runtime.mjs" } },
          ],
          tool_calls: [
            { id: "submit_bad", name: "submit_review", input: { verdict: "clean" } },
            { id: "read_1", name: "read_file", input: { path: "runtime.mjs" } },
          ],
          text: "",
          completion: { status: "complete", reason: "tool_use" },
        };
      }
      secondRequest = body;
      return responseWithTool("submit_ok", "submit_review", {
        verdict: "inconclusive",
        summary: "Retried after mixed submit.",
        findings: [],
        assumptions: [],
        verification_gaps: ["The previous submit_review was malformed."],
      });
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      executed.push(name);
      return { ok: true, path: "runtime.mjs", content: "1: export {};" };
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 1 },
    forceAfterRounds: 2,
    maxRounds: 2,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.deepEqual(executed, ["read_file"]);
  const toolResults = secondRequest.messages
    .flatMap((message) => message.content ?? [])
    .filter((block) => block.type === "tool_result");
  assert.equal(toolResults.length, 2);
  assert.match(toolResults[0].content, /did not match the review schema/i);
  assert.match(toolResults[1].content, /runtime\.mjs/i);
});

test("runReviewAgent never credits sibling tool results to a submit_review from the same turn", async () => {
  const diff = [
    "diff --git a/auth/session.mjs b/auth/session.mjs",
    "--- a/auth/session.mjs",
    "+++ b/auth/session.mjs",
    "@@ -1 +1 @@",
    "-const token = oldToken;",
    "+const token = newToken;",
  ].join("\n");
  let secondRequest;
  const transport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTools([
          { id: "diff", name: "get_diff", input: {} },
          { id: "read", name: "read_file", input: { path: "auth/session.mjs", start_line: 1, end_line: 1 } },
          { id: "search", name: "search", input: { query: "newToken" } },
          { id: "submit", name: "submit_review", input: cleanReview("Sibling evidence should not count yet.") },
        ]);
      }
      secondRequest = body;
      return responseWithTool("submit_after_evidence", "submit_review", cleanReview("Evidence was delivered in the prior turn."));
    },
  };
  const tools = {
    schemas: [],
    reviewDiff: diff,
    async execute(name, input = {}) {
      if (name === "get_diff") return { ok: true, diff, complete: true };
      if (name === "read_file") return { ok: true, path: input.path, start_line: 1, end_line: 1, content: "1: const token = newToken;" };
      if (name === "search") return { ok: true, query: input.query, output: "auth/session.mjs:1:const token = newToken;" };
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport,
    tools,
    minInspection: { diff: true, fileOrSearch: true, explicitFileOrSearchToolCalls: 2, cleanExplicitFileOrSearchToolCalls: 2 },
    maxInspectionRefusals: 1,
    maxRounds: 2,
  });

  assert.equal(result.verdict, "clean");
  assert.equal(result.rounds, 2);
  assert.match(JSON.stringify(secondRequest.messages), /submit_review refused/i);
  assert.match(JSON.stringify(secondRequest.messages), /const token = newToken/);
});

test("runReviewAgent does not let empty review context erase prior file inspection", async () => {
  const fakeTransport = {
    calls: 0,
    async messages() {
      this.calls += 1;
      if (this.calls === 1) {
        return responseWithTool("read_1", "read_file", { path: "runtime.mjs" });
      }
      if (this.calls === 2) {
        return responseWithTool("context_1", "get_review_context", {});
      }
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("prior inspection preserved"));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      if (name === "read_file") {
        return { ok: true, path: "runtime.mjs", content: "1: export {};" };
      }
      if (name === "get_review_context") {
        return { ok: true, diff: "", diffSummary: "", changedFiles: [], fileSnippets: [] };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    minInspection: { diff: false, fileOrSearch: true, explicitFileOrSearchToolCalls: 1 },
    maxRounds: 3,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rounds, 3);
  assert.equal(result.toolUsage.read_file, 1);
  assert.equal(result.toolUsage.get_review_context, 1);
});

test("runReviewAgent passes cancellation signals to provider transports and tools", async () => {
  const controller = createRunController();
  const seen = {
    transportSignal: null,
    toolCancelled: false,
  };
  const fakeTransport = {
    async messages(_body, options) {
      seen.transportSignal = options.signal;
      return responseWithTool("diff_1", "get_diff", {});
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(_name, _input, options) {
      controller.cancel("SIGTERM");
      seen.toolCancelled = options.controller.cancelled;
      return { ok: false, error: "cancelled" };
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "claude",
      transport: fakeTransport,
      tools: fakeTools,
      controller,
      maxRounds: 2,
    }),
    /cancelled/i,
  );

  assert(seen.transportSignal instanceof AbortSignal);
  assert.equal(seen.toolCancelled, true);
  assert.equal(seen.transportSignal.aborted, true);
});

test("runReviewAgent can force required inspection tools before final review", async () => {
  const seenChoices = [];
  const fakeTransport = {
    calls: 0,
    async messages(body) {
      this.calls += 1;
      seenChoices.push(body.tool_choice);
      if (this.calls === 1) {
        assert.deepEqual(body.tool_choice, { type: "tool", name: "get_diff" });
        return responseWithTool("diff_1", "get_diff", {});
      }
      if (this.calls === 2) {
        assert.deepEqual(body.tool_choice, { type: "tool", name: "search" });
        return responseWithTool("search_1", "search", { query: "runtime" });
      }
      assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_review" });
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("forced"));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      if (name === "get_diff") {
        return { ok: true, diff: "diff", diffSummary: "1 file changed" };
      }
      if (name === "search") {
        return { ok: true, query: "runtime", output: "runtime.mjs:1:export {}" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: fakeTools,
    forceInspectionTools: true,
    minInspection: { explicitFileOrSearchToolCalls: 1 },
    forceAfterRounds: 3,
    maxRounds: 3,
  });

  assert.equal(result.verdict, "inconclusive");
  assert.deepEqual(seenChoices, [
    { type: "tool", name: "get_diff" },
    { type: "tool", name: "search" },
    { type: "tool", name: "submit_review" },
  ]);
});

test("runReviewAgent does not force Claude tool_choice while thinking is enabled", async () => {
  let firstBody;
  const fakeTransport = {
    async messages(body) {
      firstBody = body;
      return responseWithTool("diff_1", "get_diff", {});
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      if (name === "get_diff") {
        return { ok: true, diff: "diff", diffSummary: "1 file changed" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "claude",
      reviewPolicy: resolveClaudeReviewPolicy({ effort: "cli-default" }),
      transport: fakeTransport,
      tools: fakeTools,
      forceInspectionTools: true,
      maxRounds: 1,
    }),
    /review did not complete/i,
  );

  assert.equal(Object.hasOwn(firstBody, "tool_choice"), false);
  assert.match(JSON.stringify(firstBody.messages), /Call the get_diff tool now/);
  assert.deepEqual(firstBody.thinking, { type: "adaptive", display: "summarized" });
});

test("runReviewAgent preloaded context does not satisfy explicit inspection by itself", async () => {
  const executed = [];
  const calls = [];
  const fakeTransport = {
    async messages(body) {
      calls.push(body);
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("preloaded"));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      executed.push(name);
      if (name === "get_review_context") {
        return {
          ok: true,
          diff: "diff",
          diffSummary: "1 file changed",
          changedFiles: [{ status: "M", path: "runtime.mjs" }],
          fileSnippets: [{ path: "runtime.mjs", content: "1: export {};" }],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "antigravity",
      transport: fakeTransport,
      tools: fakeTools,
      preloadTools: ["get_review_context"],
      maxRounds: 1,
    }),
    /review did not complete/i,
  );

  assert.deepEqual(executed, ["get_review_context"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool_choice, undefined);
  assert.match(JSON.stringify(calls[0].messages), /Codex preloaded/);
});

test("runReviewAgent bounds the preloaded-evidence message to the model-visible cap", async () => {
  const maxToolBytes = 40_000;
  // Structure-heavy evidence: many small array entries pretty-print far larger than
  // compact. The message the model actually receives must still fit the cap — the
  // bug pretty-serialized a capped result into a payload well over the cap.
  const changedFiles = Array.from({ length: 1500 }, (_, i) => ({ status: "M", path: `src/pkg/deep/module-${i}.mjs` }));
  const fileSnippets = Array.from({ length: 200 }, (_, i) => ({ path: `src/module-${i}.mjs`, content: `1: short line ${i}`, truncated: false }));
  const calls = [];
  const fakeTransport = {
    async messages(body) {
      calls.push(body);
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("preloaded"));
    },
  };
  const fakeTools = {
    schemas: [],
    maxToolBytes,
    async execute(name) {
      if (name === "get_review_context") {
        return {
          ok: true,
          diff: "diff --git a/x b/x\n@@ -1 +1 @@\n+small\n",
          diffSummary: "many files changed",
          changedFiles,
          fileSnippets,
          truncated: true,
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: fakeTools,
    preloadTools: ["get_review_context"],
    maxRounds: 1,
  }).catch(() => {});

  const preloadText = (calls[0]?.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part?.type === "text" && String(part.text).includes("Codex preloaded"))
    .map((part) => part.text)
    .join("");
  assert.ok(preloadText, "the preloaded-evidence message was sent");
  const size = Buffer.byteLength(preloadText, "utf8");
  assert.ok(size <= maxToolBytes, `preloaded-evidence message ${size} exceeded the cap ${maxToolBytes}`);
});

test("runReviewAgent sends the Claude Code identity as the first Claude system block", async () => {
  let firstBody;
  const fakeTransport = {
    async messages(body) {
      firstBody = body;
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("identity checked"));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      if (name === "get_review_context") {
        return {
          ok: true,
          diff: "diff",
          diffSummary: "1 file changed",
          changedFiles: [{ status: "M", path: "runtime.mjs" }],
          fileSnippets: [{ path: "runtime.mjs", content: "1: export {};" }],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await runReviewAgent({
    provider: "claude",
    reviewPolicy: resolveClaudeReviewPolicy({ effort: "cli-default" }),
    transport: fakeTransport,
    tools: fakeTools,
    preloadTools: ["get_review_context"],
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    forceAfterRounds: 1,
    maxRounds: 1,
  });

  assert.equal(firstBody.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.match(firstBody.system[1].text, /reviewing for Codex/i);
});

test("runReviewAgent does not duplicate focus when rendered brief already contains it", async () => {
  let firstBody;
  const fakeTransport = {
    async messages(body) {
      firstBody = body;
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("focus checked"));
    },
  };
  const focus = "review this exact context";

  await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: { schemas: [], async execute() {} },
    brief: `# User Focus\n${focus}\n\n# Diff\n(no diff)`,
    focus,
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    forceAfterRounds: 1,
    maxRounds: 1,
  });

  const text = firstBody.messages[0].content[0].text;
  assert.equal(text.match(new RegExp(focus, "g"))?.length, 1);
});

test("runReviewAgent applies resolved adaptive Claude thinking without provider-level effort", async () => {
  let firstBody;
  const fakeTransport = {
    async messages(body) {
      firstBody = body;
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("reasoning controls checked"));
    },
  };

  await runReviewAgent({
    provider: "claude",
    reviewPolicy: resolveClaudeReviewPolicy({ effort: "cli-default" }),
    transport: fakeTransport,
    tools: { schemas: [], async execute() {} },
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    forceAfterRounds: 1,
    maxRounds: 1,
  });

  assert.equal(firstBody.max_tokens, 128_000);
  assert.deepEqual(firstBody.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(Object.hasOwn(firstBody, "tool_choice"), false);
  assert.equal(Object.hasOwn(firstBody, "output_config"), false);
});

test("runReviewAgent omits CLI default effort sentinel for Claude direct reviews", async () => {
  let firstBody;
  const fakeTransport = {
    async messages(body) {
      firstBody = body;
      return responseWithTool("submit_1", "submit_review", {
        verdict: "inconclusive",
        summary: "checked effort sentinel",
        findings: [],
        assumptions: [],
        verification_gaps: [],
      });
    },
  };

  await runReviewAgent({
    provider: "claude",
    reviewPolicy: resolveClaudeReviewPolicy({ effort: "cli-default" }),
    transport: fakeTransport,
    tools: { schemas: [], async execute() {} },
    mode: "review",
    focus: "",
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    forceAfterRounds: 1,
    maxRounds: 1,
  });

  assert.equal(Object.hasOwn(firstBody, "output_config"), false);
});

test("runReviewAgent requests dynamic Antigravity thinking budget by default", async () => {
  let firstBody;
  const fakeTransport = {
    async messages(body) {
      firstBody = body;
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("thinking budget checked"));
    },
  };

  await runReviewAgent({
    provider: "antigravity",
    reviewPolicy: resolveAntigravityReviewPolicy({ mode: "review" }),
    transport: fakeTransport,
    tools: { schemas: [], async execute() {} },
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    forceAfterRounds: 1,
    maxRounds: 1,
  });

  assert.equal(firstBody.max_tokens, 64_000);
  assert.equal(firstBody.thinkingBudget, -1);
});

test("runReviewAgent does not treat changed-file lists as file inspection", async () => {
  const fakeTransport = {
    async messages() {
      return responseWithTool("submit_1", "submit_review", cleanReview("status only"));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      if (name === "get_diff") {
        return { ok: true, diff: "diff", diffSummary: "1 file changed" };
      }
      if (name === "list_changed_files") {
        return { ok: true, output: "M plugins/supermodels/scripts/lib/runtime.mjs" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "antigravity",
      transport: fakeTransport,
      tools: fakeTools,
      preloadTools: ["get_diff", "list_changed_files"],
      maxRounds: 1,
    }),
    /review did not complete/i,
  );
});

test("runReviewAgent does not treat unreadable preloaded snippets as file inspection", async () => {
  const fakeTransport = {
    async messages() {
      return responseWithTool("submit_1", "submit_review", cleanReview("unreadable snippets only"));
    },
  };
  const fakeTools = {
    schemas: [],
    async execute(name) {
      if (name === "get_review_context") {
        return {
          ok: true,
          diff: "diff",
          diffSummary: "1 file changed",
          changedFiles: [{ status: "D", path: "deleted.mjs" }],
          fileSnippets: [{ path: "deleted.mjs", error: "Path is not a regular file." }],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "antigravity",
      transport: fakeTransport,
      tools: fakeTools,
      preloadTools: ["get_review_context"],
      maxRounds: 1,
    }),
    /review did not complete/i,
  );
});

test("runReviewAgent grok provider sets reasoning effort, max tokens, and persona", async () => {
  const bodies = [];
  const transport = {
    messages: async (body) => {
      bodies.push(body);
      return {
        content: [{
          type: "tool_use",
          id: "t1",
          name: "submit_review",
          input: {
            verdict: "inconclusive",
            summary: "grok review test",
            findings: [],
            assumptions: [],
            verification_gaps: [],
          },
        }],
        tool_calls: [{
          id: "t1",
          name: "submit_review",
          input: {
            verdict: "inconclusive",
            summary: "grok review test",
            findings: [],
            assumptions: [],
            verification_gaps: [],
          },
        }],
        text: "",
      };
    },
  };
  await runReviewAgent({
    provider: "grok",
    reviewPolicy: resolveGrokReviewPolicy(),
    transport,
    tools: {
      schemas: [],
      async execute() {
        return { ok: true };
      },
    },
    model: "grok-4.5",
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    preloadTools: [],
  });
  assert.equal(bodies[0].max_tokens, 64_000);
  assert.equal(bodies[0].reasoning_effort, "high");
  assert.match(bodies[0].system[0].text, /Grok Build reviewing for Codex/);
});

test("runReviewAgent sends a strict submit_review tool for claude", async () => {
  const bodies = [];
  const transport = {
    messages: async (body) => {
      bodies.push(body);
      return responseWithTool("submit_1", "submit_review", cleanReview("No issues found."));
    },
  };
  await runReviewAgent({
    provider: "claude",
    reviewPolicy: resolveClaudeReviewPolicy(),
    transport,
    tools: { schemas: [], async execute() { return { ok: true }; } },
    model: "claude-opus-4-8",
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    preloadTools: [],
  });
  const submit = bodies[0].tools.find((t) => t.name === "submit_review");
  assert.equal(submit.strict, true);
});

test("runReviewAgent does not send strict submit_review for antigravity", async () => {
  const bodies = [];
  const transport = {
    messages: async (body) => {
      bodies.push(body);
      return responseWithTool("submit_1", "submit_review", cleanReview("No issues found."));
    },
  };
  await runReviewAgent({
    provider: "antigravity",
    transport,
    tools: { schemas: [], async execute() { return { ok: true }; } },
    model: "gemini-3-flash-preview",
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    preloadTools: [],
  });
  const submit = bodies[0].tools.find((t) => t.name === "submit_review");
  assert.equal(submit.strict, undefined);
});

const countCacheControl = (arr) => (arr ?? []).filter((b) => b && b.cache_control).length;
const totalCacheBreakpoints = (body) =>
  countCacheControl(body.system)
  + body.messages.reduce((n, m) => n + (Array.isArray(m.content) ? countCacheControl(m.content) : 0), 0);

test("claude review caching: system + stable evidence anchor + rolling breakpoint, ≤4, no cross-round mutation", async () => {
  const bodies = [];
  let round = 0;
  const transport = {
    messages: async (body) => {
      bodies.push(JSON.parse(JSON.stringify(body))); // deep snapshot of what was SENT
      round += 1;
      // Preloaded evidence is messages[1]; then two model-led inspection rounds, then submit.
      if (round === 1) return responseWithTool("r1", "read_file", { path: "a.mjs" });
      if (round === 2) return responseWithTool("s1", "search", { query: "runReviewAgent" });
      return responseWithTool("submit_1", "submit_review", cleanReview("No issues found."));
    },
  };
  await runReviewAgent({
    provider: "claude", reviewPolicy: resolveClaudeReviewPolicy(), transport, tools: reviewToolsForDiffAndFiles(),
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    // Non-empty preloadTools makes messages[1] the preloaded-evidence turn, so the
    // stable prefix ends at index 1 (stablePrefixEnd === 2).
    preloadTools: ["get_diff"],
  });
  assert.equal(bodies.length, 3, "expected exactly three model rounds (read_file, search, submit)");

  for (const body of bodies) {
    // Identity block system[0] must never be cached; the last system block caches tools+system.
    assert.equal(body.system[0].cache_control, undefined, "system[0] identity block must stay uncached");
    assert.deepEqual(body.system[body.system.length - 1].cache_control, { type: "ephemeral" });
    // STABLE ANCHOR (Fix 3): the preloaded-evidence turn (messages[1]) carries a
    // breakpoint EVERY round so a long round appending >20 blocks cannot push the
    // evidence prefix outside the API lookback window from the rolling breakpoint.
    assert.deepEqual(
      body.messages[1].content.at(-1).cache_control,
      { type: "ephemeral" },
      "preloaded-evidence anchor must be cached every round",
    );
    // The prompt (messages[0]) is never the anchor and never the latest turn, so it stays clean.
    assert.equal(body.messages[0].content.at(-1).cache_control, undefined);
    // Rolling breakpoint sits on the last content block of the latest turn.
    const lastMsg = body.messages[body.messages.length - 1];
    assert.deepEqual(lastMsg.content[lastMsg.content.length - 1].cache_control, { type: "ephemeral" });
    // Never exceed the API's four-breakpoint budget.
    const total = totalCacheBreakpoints(body);
    assert.ok(total >= 2 && total <= 4, `breakpoint count out of range: ${total}`);
  }

  // DEDUP: round 1's latest turn IS the evidence anchor (messages[1]), so anchor and
  // rolling coincide → exactly two breakpoints (system + the shared message block).
  assert.equal(totalCacheBreakpoints(bodies[0]), 2, "round 1 must dedup the coincident anchor/rolling breakpoint");
  assert.equal(bodies[0].messages.length, 2);

  // NO CROSS-ROUND MUTATION: the round-2 rolling breakpoint on the first tool-result
  // turn (messages[3]) must have rolled OFF by round 3 — proving each round annotates
  // a per-request copy, never the loop's stored `messages` accumulator.
  assert.deepEqual(bodies[1].messages[3].content.at(-1).cache_control, { type: "ephemeral" });
  assert.equal(
    bodies[2].messages[3].content.at(-1).cache_control,
    undefined,
    "round 3: the round-2 rolling breakpoint must have rolled off (no cross-round mutation)",
  );
});

test("claude review caching: no-preload round 1 dedups stable+rolling to one message breakpoint", async () => {
  const bodies = [];
  const transport = {
    messages: async (body) => {
      bodies.push(JSON.parse(JSON.stringify(body)));
      return responseWithTool("submit_1", "submit_review", cleanReview("No issues found."));
    },
  };
  await runReviewAgent({
    provider: "claude", reviewPolicy: resolveClaudeReviewPolicy(), transport, tools: reviewToolsForDiffAndFiles(),
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    preloadTools: [],
  });
  const body = bodies[0];
  // With no preload the stable prefix is just the prompt (stablePrefixEnd === 1), so
  // in round 1 the anchor and rolling breakpoint both land on messages[0] and dedup.
  assert.equal(body.system[0].cache_control, undefined, "system[0] identity block must stay uncached");
  assert.deepEqual(body.system[body.system.length - 1].cache_control, { type: "ephemeral" });
  assert.equal(countCacheControl(body.messages[0].content), 1, "coincident anchor/rolling must mark the block once");
  assert.equal(totalCacheBreakpoints(body), 2);
});

test("antigravity review requests do not carry cache_control", async () => {
  const bodies = [];
  const transport = {
    messages: async (body) => {
      bodies.push(body);
      return responseWithTool("submit_1", "submit_review", cleanReview("No issues found."));
    },
  };
  await runReviewAgent({
    provider: "antigravity", reviewPolicy: resolveAntigravityReviewPolicy({ mode: "review" }), transport, tools: { schemas: [], async execute() { return { ok: true }; } }, model: "gemini-3-flash-preview",
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    preloadTools: [],
  });
  const sys = bodies[0].system;
  const last = Array.isArray(sys) ? sys[sys.length - 1] : null;
  assert.equal(last?.cache_control, undefined);
});

test("runReviewAgent keeps generic defaults for unknown fake providers", async () => {
  let body;
  const result = await runReviewAgent({
    provider: "future-test-provider",
    transport: {
      async messages(request) {
        body = request;
        return responseWithTool("submit_1", "submit_review", inconclusiveReview("generic policy"));
      },
    },
    tools: { schemas: [], async execute() { return { ok: true }; } },
    minInspection: {
      diff: false,
      fileOrSearch: false,
      explicitFileOrSearchToolCalls: 0,
      cleanExplicitFileOrSearchToolCalls: 0,
    },
    forceAfterRounds: 1,
    maxRounds: 1,
  });

  assert.equal(body.max_tokens, 64_000);
  assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_review" });
  assert.match(body.system[0].text, /future-test-provider reviewing for Codex/);
  assert.equal(body.tools.find((tool) => tool.name === "submit_review").strict, undefined);
  assert.equal(totalCacheBreakpoints(body), 0);
  assert.deepEqual(result.reviewConfig, {
    provider: "future-test-provider",
    model: "",
    maxTokens: 64_000,
    rounds: 1,
    toolUsage: {},
  });
});

function responseWithTool(id, name, input, completion = { status: "complete", reason: "tool_use" }) {
  const normalizedInput = name === "submit_review" && input && !("missing_change_findings" in input)
    ? { ...input, missing_change_findings: [] }
    : input;
  return {
    content: [{ type: "tool_use", id, name, input: normalizedInput }],
    tool_calls: [{ id, name, input: normalizedInput }],
    text: "",
    completion,
  };
}

function responseWithTools(toolCalls) {
  const normalizedCalls = toolCalls.map((call) => call.name === "submit_review" && call.input && !("missing_change_findings" in call.input)
    ? { ...call, input: { ...call.input, missing_change_findings: [] } }
    : call);
  return {
    content: normalizedCalls.map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    tool_calls: normalizedCalls,
    text: "",
    completion: { status: "complete", reason: "tool_use" },
  };
}

function responseWithText(text, completion = { status: "complete", reason: "end_turn" }) {
  return {
    content: [{ type: "text", text }],
    tool_calls: [],
    text,
    completion,
  };
}

function cleanReview(summary) {
  return {
    verdict: "clean",
    summary,
    findings: [],
    missing_change_findings: [],
    assumptions: [],
    verification_gaps: [],
  };
}

function inconclusiveReview(summary) {
  return {
    verdict: "inconclusive",
    summary,
    findings: [],
    missing_change_findings: [],
    assumptions: [],
    verification_gaps: [],
  };
}

function reviewToolsForDiffAndFiles() {
  const readableFiles = new Set([
    "a.mjs",
    "runtime.mjs",
    "plugins/supermodels/scripts/lib/runtime.mjs",
    "plugins/supermodels/scripts/lib/review-agent.mjs",
  ]);
  return {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff: "diff --git a/a b/a" };
      }
      if (name === "read_file") {
        const filePath = String(input.path ?? "runtime.mjs");
        if (!readableFiles.has(filePath) && !/^extra-\d+\.mjs$/.test(filePath) && !/^runtime-\d+\.mjs$/.test(filePath)) {
          return { ok: false, path: filePath, error: "Path resolves outside workspace." };
        }
        const start = Number(input.start_line ?? 1);
        const end = Number(input.end_line ?? start);
        return {
          ok: true,
          path: filePath,
          start_line: Number.isFinite(start) ? start : 1,
          end_line: Number.isFinite(end) ? end : start,
          content: `${Number.isFinite(start) ? start : 1}: export {};`,
        };
      }
      if (name === "search") {
        return { ok: true, query: "runReviewAgent", output: "review-agent.mjs:1:export async function runReviewAgent" };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

function reviewToolsWithDeletedDiff({ targetPath, missingLine, diff, truncated = false, diffTruncated }) {
  return {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return {
          ok: true,
          diffSummary: "1 file changed",
          diff,
          truncated,
          ...(diffTruncated !== undefined ? { diffTruncated } : {}),
        };
      }
      if (name === "read_file") {
        const start = Number(input.start_line ?? 1);
        if (String(input.path ?? "") !== targetPath) {
          return { ok: false, path: input.path, error: "Path resolves outside workspace." };
        }
        return {
          ok: true,
          path: input.path,
          start_line: start,
          end_line: start,
          content: start === missingLine ? "" : `${start}: export {};`,
        };
      }
      if (name === "search") {
        return { ok: true, query: input.query, output: `${targetPath}:1:export {};` };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
