import test from "node:test";
import assert from "node:assert/strict";

import { createRunController } from "../scripts/lib/run-control.mjs";
import { runReviewAgent } from "../scripts/lib/review-agent.mjs";

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

test("runReviewAgent treats truncated diff coverage as indeterminate for deleted-line findings", async () => {
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
        summary: "Truncated diff does not reject deleted-line finding.",
        findings: [{
          severity: "medium",
          title: "Deleted line beyond truncated diff",
          evidence: "The finding cites deleted code, but the review-tool diff was truncated before that hunk.",
          impact: "Large diffs should not turn valid deleted-line findings into inconclusive reviews.",
          recommendation: "Treat truncated diff coverage as indeterminate, not disproven.",
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
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings[0].line_start, 700);
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

for (const provider of ["claude", "antigravity"]) {
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

test("runReviewAgent uses timeout as an aggregate review budget", async () => {
  const seenTimeouts = [];
  const fakeTransport = {
    async messages(_body, options) {
      seenTimeouts.push(options.timeoutMs);
      await sleep(70);
      return { content: [], tool_calls: [], text: "still thinking" };
    },
  };

  await assert.rejects(
    () => runReviewAgent({
      provider: "antigravity",
      transport: fakeTransport,
      tools: { schemas: [], async execute() {} },
      timeoutMs: 50,
    }),
    /timed out before completion/i,
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

test("runReviewAgent requests adaptive Claude thinking without provider-level effort by default", async () => {
  let firstBody;
  const fakeTransport = {
    async messages(body) {
      firstBody = body;
      return responseWithTool("submit_1", "submit_review", inconclusiveReview("reasoning controls checked"));
    },
  };

  await runReviewAgent({
    provider: "claude",
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
    transport: fakeTransport,
    tools: { schemas: [], async execute() {} },
    mode: "review",
    focus: "",
    minInspection: { diff: false, fileOrSearch: false, explicitFileOrSearchToolCalls: 0, cleanExplicitFileOrSearchToolCalls: 0 },
    forceAfterRounds: 1,
    maxRounds: 1,
    effort: "cli-default",
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

function responseWithTool(id, name, input) {
  return {
    content: [{ type: "tool_use", id, name, input }],
    tool_calls: [{ id, name, input }],
    text: "",
  };
}

function responseWithTools(toolCalls) {
  return {
    content: toolCalls.map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    tool_calls: toolCalls,
    text: "",
  };
}

function responseWithText(text) {
  return {
    content: [{ type: "text", text }],
    tool_calls: [],
    text,
  };
}

function cleanReview(summary) {
  return {
    verdict: "clean",
    summary,
    findings: [],
    assumptions: [],
    verification_gaps: [],
  };
}

function inconclusiveReview(summary) {
  return {
    verdict: "inconclusive",
    summary,
    findings: [],
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

function reviewToolsWithDeletedDiff({ targetPath, missingLine, diff, truncated = false }) {
  return {
    schemas: [],
    async execute(name, input = {}) {
      if (name === "get_diff") {
        return { ok: true, diffSummary: "1 file changed", diff, truncated };
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
