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
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await runReviewAgent({
    provider: "claude",
    transport: fakeTransport,
    tools: fakeTools,
    focus: "review lifecycle changes",
    maxRounds: 4,
  });

  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings.length, 1);
  assert.equal(result.toolUsage.get_diff, 1);
  assert.equal(result.toolUsage.read_file, 1);
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
      return responseWithTool("submit_forced", "submit_review", cleanReview("Forced final review."));
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
    maxRounds: 3,
  });

  assert.equal(result.verdict, "clean");
  assert.equal(seenToolChoices[0], null);
  assert.equal(seenToolChoices[1], null);
  assert.deepEqual(seenToolChoices[2], { type: "tool", name: "submit_review" });
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
      return responseWithTool("submit_1", "submit_review", cleanReview("forced"));
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
    forceAfterRounds: 3,
    maxRounds: 3,
  });

  assert.equal(result.verdict, "clean");
  assert.deepEqual(seenChoices, [
    { type: "tool", name: "get_diff" },
    { type: "tool", name: "search" },
    { type: "tool", name: "submit_review" },
  ]);
});

test("runReviewAgent can preload required inspection tools before first provider call", async () => {
  const executed = [];
  let firstBody;
  const fakeTransport = {
    async messages(body) {
      firstBody = body;
      assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_review" });
      return responseWithTool("submit_1", "submit_review", cleanReview("preloaded"));
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

  const result = await runReviewAgent({
    provider: "antigravity",
    transport: fakeTransport,
    tools: fakeTools,
    preloadTools: ["get_review_context"],
    forceAfterRounds: 1,
    maxRounds: 1,
  });

  assert.equal(result.verdict, "clean");
  assert.deepEqual(executed, ["get_review_context"]);
  assert.equal(result.toolUsage.get_review_context, 1);
  assert.match(JSON.stringify(firstBody.messages), /Codex preloaded/);
});

test("runReviewAgent sends the Claude Code identity as the first Claude system block", async () => {
  let firstBody;
  const fakeTransport = {
    async messages(body) {
      firstBody = body;
      return responseWithTool("submit_1", "submit_review", cleanReview("identity checked"));
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
    forceAfterRounds: 1,
    maxRounds: 1,
  });

  assert.equal(firstBody.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.match(firstBody.system[1].text, /reviewing for Codex/i);
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

function cleanReview(summary) {
  return {
    verdict: "clean",
    summary,
    findings: [],
    assumptions: [],
    verification_gaps: [],
  };
}
