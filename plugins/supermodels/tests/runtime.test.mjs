import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkProviders,
  createSerializedWriteQueue,
  getStatus,
  markCancelled,
  normalizeProviderResult,
  providerTimeoutMs,
  renderHumanResult,
  runReview,
  runTask,
  selectProviders,
  setupProviders,
  synthesizeProviderResults,
} from "../scripts/lib/runtime.mjs";
import { createJob, createState, jobPath, listJobs, updateJob } from "../scripts/lib/state.mjs";

const checks = {
  claude: {
    provider: "claude",
    ready: true,
    installed: true,
    auth: "ok",
  },
  antigravity: {
    provider: "antigravity",
    ready: false,
    installed: true,
    auth: "missing",
    error: "not authenticated",
  },
};

test("selectProviders skips unavailable providers for --all", () => {
  const selected = selectProviders({
    requested: ["claude", "antigravity"],
    explicit: false,
    checks,
  });

  assert.deepEqual(selected.selected, ["claude"]);
  assert.deepEqual(selected.skipped.map((item) => item.provider), ["antigravity"]);
});

test("selectProviders preserves concrete provider readiness errors", () => {
  const selected = selectProviders({
    requested: ["claude", "antigravity"],
    explicit: false,
    checks: {
      claude: {
        provider: "claude",
        ready: false,
        installed: false,
        auth: "missing",
        error: "claude binary not found",
      },
      antigravity: {
        provider: "antigravity",
        ready: true,
        installed: true,
        auth: "ok",
      },
    },
  });

  assert.deepEqual(selected.selected, ["antigravity"]);
  assert.equal(selected.skipped[0].reason, "claude binary not found");
});

test("selectProviders fails explicit unavailable provider", () => {
  assert.throws(
    () =>
      selectProviders({
        requested: ["antigravity"],
        explicit: true,
        checks,
      }),
    /not ready/i,
  );
});

test("selectProviders skips unavailable providers for explicit multi-provider requests", () => {
  const selected = selectProviders({
    requested: ["claude", "antigravity"],
    explicit: true,
    checks,
  });

  assert.deepEqual(selected.selected, ["claude"]);
  assert.deepEqual(selected.skipped.map((item) => item.provider), ["antigravity"]);
});

test("selectProviders includes readiness reasons when no providers are ready", () => {
  assert.throws(
    () =>
      selectProviders({
        requested: ["claude", "antigravity"],
        explicit: false,
        checks: {
          claude: {
            provider: "claude",
            ready: false,
            error: "direct OAuth refresh failed",
          },
          antigravity: {
            provider: "antigravity",
            ready: false,
            error: "missing local auth",
          },
        },
      }),
    /No requested providers are ready: claude: direct OAuth refresh failed; antigravity: missing local auth/,
  );
});

test("renderHumanResult includes failed job errors", () => {
  const text = renderHumanResult({
    job: {
      id: "job-20260607000000-deadbe",
      status: "failed",
      error: "No requested providers are ready: claude: direct auth invalid; antigravity: missing local auth.",
      providerRuns: {},
    },
    selected: ["claude", "antigravity"],
    skipped: [],
    results: [],
  });

  assert.match(text, /Supermodels job job-20260607000000-deadbe: failed/);
  assert.match(text, /No requested providers are ready: claude: direct auth invalid; antigravity: missing local auth/);
});

test("checkProviders reports provider capabilities without lifecycle ownership claims", async () => {
  const output = await checkProviders({
    claude: {
      async check() {
        return { provider: "claude", ready: true };
      },
      capabilities() {
        return {
          review: true,
          task: true,
          resume: true,
          nativeInterrupt: false,
          background: "worker",
        };
      },
    },
  });

  assert.deepEqual(output.claude.capabilities, {
    review: true,
    task: true,
    resume: true,
    nativeInterrupt: false,
    background: "worker",
  });
});

test("setupProviders reports the same provider capabilities as readiness checks", async () => {
  const output = await setupProviders({
    antigravity: {
      async setup() {
        return { ready: true, changed: false };
      },
      async check() {
        return { provider: "antigravity", ready: true };
      },
      capabilities() {
        return {
          review: true,
          adversarialReview: true,
          task: true,
          writeTask: true,
          resume: true,
          nativeInterrupt: false,
          background: "worker",
        };
      },
    },
  });

  assert.equal(output.antigravity.setup.ready, true);
  assert.deepEqual(output.antigravity.check.capabilities, {
    review: true,
    adversarialReview: true,
    task: true,
    writeTask: true,
    resume: true,
    nativeInterrupt: false,
    background: "worker",
  });
});

test("setupProviders mirrors readiness for providers without setup hooks", async () => {
  const output = await setupProviders({
    claude: {
      async check() {
        return {
          provider: "claude",
          ready: false,
          error: "direct auth invalid",
        };
      },
      capabilities() {
        return { review: true };
      },
    },
  });

  assert.equal(output.claude.setup.ready, false);
  assert.equal(output.claude.setup.changed, false);
  assert.equal(output.claude.check.ready, false);
});

test("normalizeProviderResult conservatively preserves raw output", () => {
  const normalized = normalizeProviderResult({
    provider: "claude",
    rawText: "High: app.js:12 can lose data",
    sessionId: "s1",
    rawResultPath: "/tmp/raw.txt",
  });

  assert.equal(normalized.provider, "claude");
  assert.equal(normalized.verdict, "needs-attention");
  assert.equal(normalized.provider_session_id, "s1");
  assert.match(normalized.summary, /High: app\.js/);
});

test("normalizeProviderResult prefers schema-validated structured review output", () => {
  const normalized = normalizeProviderResult({
    provider: "antigravity",
    rawText: "raw provider prose",
    structured: {
      verdict: "needs-attention",
      summary: "Structured issue.",
      findings: [
        {
          severity: "high",
          title: "Race condition",
          evidence: "state.mjs:60 direct write",
          impact: "Live reads can fail.",
          recommendation: "Use atomic writes.",
          file: "state.mjs",
          line_start: 60,
          line_end: 60,
          confidence: "high",
        },
      ],
      assumptions: ["Workspace is writable."],
      verification_gaps: ["No live smoke test."],
    },
  });

  assert.equal(normalized.verdict, "needs-attention");
  assert.equal(normalized.output_valid, true);
  assert.equal(normalized.summary, "Structured issue.");
  assert.equal(normalized.findings[0].title, "Race condition");
  assert.equal(normalized.findings[0].file, "state.mjs");
});

test("normalizeProviderResult prefers the last schema-valid JSON object in resumed output", () => {
  const previous = {
    verdict: "clean",
    summary: "Previous conversation output.",
    findings: [],
    assumptions: [],
    verification_gaps: [],
  };
  const current = {
    verdict: "needs-attention",
    summary: "Current review output.",
    findings: [
      {
        severity: "high",
        title: "Current finding",
        evidence: "The last JSON object is the active review.",
        impact: "Using the first object can hide current findings.",
        recommendation: "Parse candidate JSON objects from the end.",
        file: "plugins/supermodels/scripts/lib/review-schema.mjs",
        line_start: 186,
        line_end: 202,
        confidence: "high",
      },
    ],
    assumptions: [],
    verification_gaps: [],
  };

  const normalized = normalizeProviderResult({
    provider: "antigravity",
    rawText: [
      JSON.stringify(previous),
      "resumed conversation continued",
      JSON.stringify(current),
    ].join("\n"),
    requireStructured: true,
  });

  assert.equal(normalized.verdict, "needs-attention");
  assert.equal(normalized.summary, "Current review output.");
  assert.equal(normalized.findings[0].title, "Current finding");
});

test("normalizeProviderResult preserves structured findings with unknown severities", () => {
  const normalized = normalizeProviderResult({
    provider: "antigravity",
    structured: {
      verdict: "needs-attention",
      summary: "Provider used non-schema severity.",
      findings: [
        {
          severity: "blocker",
          title: "Dropped finding",
          evidence: "review-schema.mjs discarded this finding.",
          impact: "Important provider findings can disappear.",
          recommendation: "Map the severity instead of dropping the finding.",
          file: "plugins/supermodels/scripts/lib/review-schema.mjs",
          line_start: 136,
          line_end: 136,
          confidence: "high",
        },
        {
          severity: "surprising",
          title: "Unknown severity",
          evidence: "Provider invented a severity.",
          impact: "The finding should still be visible.",
          recommendation: "Map unknown severities to medium.",
          file: "runtime.mjs",
          line_start: 1,
          line_end: 1,
          confidence: "high",
        },
      ],
      assumptions: [],
      verification_gaps: [],
    },
  });

  assert.equal(normalized.findings.length, 2);
  assert.equal(normalized.findings[0].severity, "high");
  assert.equal(normalized.findings[1].severity, "medium");
});

test("normalizeProviderResult marks required structured reviews invalid when output is irrelevant", () => {
  const normalized = normalizeProviderResult({
    provider: "antigravity",
    rawText: "Usage of agy:\n  --model string",
    requireStructured: true,
  });

  assert.equal(normalized.verdict, "invalid-output");
  assert.equal(normalized.output_valid, false);
  assert.match(normalized.summary, /did not return the required structured review/i);
});

test("normalizeProviderResult marks provider rate limits distinctly from invalid output", () => {
  const normalized = normalizeProviderResult({
    provider: "claude",
    rawText: "Provider claude failed before producing review output.",
    stderr: "Error: Anthropic Messages request failed: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
    requireStructured: true,
  });

  assert.equal(normalized.verdict, "rate-limited");
  assert.equal(normalized.output_valid, false);
  assert.match(normalized.summary, /rate-limited/i);
  assert.match(normalized.verification_gaps.join("\n"), /quota window/i);
});

test("normalizeProviderResult recognizes clean negated review output", () => {
  const normalized = normalizeProviderResult({
    provider: "claude",
    rawText: "No bugs, security issues, or data loss risks found.",
  });

  assert.equal(normalized.verdict, "clean");
  assert.deepEqual(normalized.findings, []);
});

test("normalizeProviderResult does not let an early clean sentence hide later critical findings", () => {
  const normalized = normalizeProviderResult({
    provider: "claude",
    rawText: [
      "No issues were found in the first quick scan.",
      "",
      "### CRITICAL - `runtime.mjs:377` marks provider output clean before parsing later findings.",
    ].join("\n"),
  });

  assert.equal(normalized.verdict, "needs-attention");
  assert.equal(normalized.findings.length, 1);
  assert.equal(normalized.findings[0].severity, "critical");
  assert.equal(normalized.findings[0].file, "runtime.mjs");
  assert.equal(normalized.findings[0].line_start, 377);
});

test("normalizeProviderResult extracts markdown review findings", () => {
  const normalized = normalizeProviderResult({
    provider: "antigravity",
    rawText: [
      "Findings",
      "",
      "- High: `runtime.mjs:50` drops provider findings during normalization.",
      "- Medium: adapter.mjs passes full prompt as argv.",
    ].join("\n"),
  });

  assert.equal(normalized.verdict, "needs-attention");
  assert.equal(normalized.findings.length, 2);
  assert.equal(normalized.findings[0].severity, "high");
  assert.match(normalized.findings[0].body, /drops provider findings/);
});

test("synthesizeProviderResults preserves longer unstructured provider output", () => {
  const raw = [
    "The provider returned a long unstructured review.",
    "a".repeat(700),
    "unique-tail-finding",
  ].join(" ");
  const normalized = normalizeProviderResult({
    provider: "antigravity",
    rawText: raw,
  });
  const text = synthesizeProviderResults([normalized]);

  assert(normalized.summary.length > 500);
  assert.match(text, /unique-tail-finding/);
});

test("synthesizeProviderResults groups provider output without cross-examining", () => {
  const text = synthesizeProviderResults([
    {
      provider: "claude",
      verdict: "needs-attention",
      summary: "Claude found a bug",
      findings: [],
    },
    {
      provider: "antigravity",
      verdict: "inconclusive",
      summary: "Antigravity found no concrete issue",
      findings: [],
    },
  ]);

  assert.match(text, /Provider Results/);
  assert.match(text, /Claude Code/);
  assert.match(text, /Antigravity/);
  assert.doesNotMatch(text, /cross-exam/i);
});

test("synthesizeProviderResults preserves provider attribution and full finding details", () => {
  const text = synthesizeProviderResults([
    {
      provider: "claude",
      verdict: "needs-attention",
      summary: "Claude found a race.",
      findings: [
        {
          severity: "high",
          confidence: "high",
          title: "State update race",
          evidence: "state.mjs writes without a lock.",
          impact: "Concurrent live reads can fail.",
          recommendation: "Serialize writes through the job lock.",
          file: "plugins/supermodels/scripts/lib/state.mjs",
          line_start: 60,
          line_end: 64,
        },
      ],
      assumptions: ["Concurrent readers exist."],
      verification_gaps: ["No live race smoke test."],
    },
    {
      provider: "antigravity",
      verdict: "clean",
      summary: "Antigravity found no material issues.",
      findings: [],
    },
  ]);

  assert.match(text, /# Supermodels Review/);
  assert.match(text, /## Claude Code/);
  assert.match(text, /\[high\]\[high confidence\] State update race/);
  assert.match(text, /plugins\/supermodels\/scripts\/lib\/state\.mjs:60-64/);
  assert.match(text, /Evidence: state\.mjs writes without a lock\./);
  assert.match(text, /Impact: Concurrent live reads can fail\./);
  assert.match(text, /Recommendation: Serialize writes through the job lock\./);
  assert.match(text, /## Antigravity/);
  assert.match(text, /No material findings reported by Antigravity\./);
  assert.doesNotMatch(text, /Codex should synthesize/i);
});

test("serialized write queue attaches rejection handlers immediately while propagating errors", async () => {
  const unhandled = [];
  const handler = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", handler);
  try {
    const queue = createSerializedWriteQueue();
    queue.enqueue(async () => {
      throw new Error("state write failed");
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    await assert.rejects(() => queue.drain(), /state write failed/);
  } finally {
    process.off("unhandledRejection", handler);
  }
});

test("serialized write queue ignores non-critical progress write failures", async () => {
  const queue = createSerializedWriteQueue();
  queue.enqueue(async () => {
    throw new Error("progress lock timeout");
  }, { critical: false });
  queue.enqueue(async () => "artifact persisted");

  await queue.drain();

  const failingQueue = createSerializedWriteQueue();
  failingQueue.enqueue(async () => {
    throw new Error("artifact write failed");
  });
  await assert.rejects(() => failingQueue.drain(), /artifact write failed/);
});

test("providerTimeoutMs treats timeout option as seconds", () => {
  assert.equal(providerTimeoutMs("60"), 60_000);
  assert.equal(providerTimeoutMs(1.5), 1_500);
  assert.equal(providerTimeoutMs(undefined), undefined);
  assert.throws(() => providerTimeoutMs("abc"), /positive number of seconds/i);
  assert.throws(() => providerTimeoutMs("0"), /positive number of seconds/i);
});

test("runTask stores provider progress events from adapters", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-events-"));
  try {
    const adapters = {
      antigravity: {
        check: async () => ({
          provider: "antigravity",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/agy",
        }),
        task: async (input, options) => {
          options.onEvent?.({
            type: "text",
            message: "streamed first token",
            at: "2026-06-05T00:00:00.000Z",
          });
          return {
            exitCode: 0,
            rawText: "No bugs found.",
            stderr: "",
            sessionId: "",
            commandLine: "agy -p",
            events: [
              {
                type: "finish",
                message: "structured finish",
                at: "2026-06-05T00:00:01.000Z",
              },
            ],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    };

    const output = await runTask({
      adapters,
      providerSelection: {
        requested: ["antigravity"],
        explicit: true,
      },
      options: {
        "data-root": dataRoot,
      },
      task: "inspect only",
      workspaceRoot: "/tmp/workspace",
    });

    const run = output.job.providerRuns.antigravity;
    assert.equal(run.lastEvent, "structured finish");
    assert.deepEqual(run.events.map((event) => event.message), [
      "streamed first token",
      "structured finish",
    ]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runReview records orchestrator pid so concurrent status does not fail live jobs", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-live-status-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-live-status-workspace-"));
  try {
    let observedStatus;
    let observedPid;
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/claude",
        }),
        review: async (input, options) => {
          const status = await getStatus({
            workspaceRoot,
            dataRoot,
            jobId: path.basename(options.promptDir),
          });
          observedStatus = status.status;
          observedPid = status.pid;
          return {
            exitCode: 0,
            rawText: JSON.stringify({
              verdict: "clean",
              summary: "No findings.",
              findings: [],
              assumptions: [],
              verification_gaps: [],
            }),
            stderr: "",
            sessionId: "claude-session",
            commandLine: "claude -p",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    };

    await runReview({
      adapters,
      providerSelection: {
        requested: ["claude"],
        explicit: true,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "",
      workspaceRoot,
    });

    assert.equal(observedStatus, "running");
    assert.equal(observedPid, process.pid);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runReview checks only requested providers", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-requested-review-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-requested-review-workspace-"));
  try {
    let antigravityChecked = false;
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/claude",
        }),
        review: async () => ({
          exitCode: 0,
          rawText: JSON.stringify({
            verdict: "clean",
            summary: "No findings.",
            findings: [],
            assumptions: [],
            verification_gaps: [],
          }),
          stderr: "",
          sessionId: "claude-session",
          commandLine: "claude oauth messages",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      },
      antigravity: {
        check: async () => {
          antigravityChecked = true;
          throw new Error("unrequested provider should not be checked");
        },
      },
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        requested: ["claude"],
        explicit: true,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "",
      workspaceRoot,
    });

    assert.equal(output.job.status, "completed");
    assert.equal(antigravityChecked, false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runTask checks only requested providers", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-requested-task-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-requested-task-workspace-"));
  try {
    let antigravityChecked = false;
    const adapters = {
      claude: {
        capabilities: () => ({ writeTask: true }),
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/claude",
        }),
        task: async () => ({
          exitCode: 0,
          rawText: "done",
          stderr: "",
          sessionId: "claude-session",
          commandLine: "claude -p",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      },
      antigravity: {
        capabilities: () => ({ writeTask: true }),
        check: async () => {
          antigravityChecked = true;
          throw new Error("unrequested provider should not be checked");
        },
      },
    };

    const output = await runTask({
      adapters,
      providerSelection: {
        requested: ["claude"],
        explicit: true,
      },
      options: {
        "data-root": dataRoot,
      },
      task: "do the thing",
      workspaceRoot,
    });

    assert.equal(output.job.status, "completed");
    assert.equal(antigravityChecked, false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runReview does not start providers for jobs already cancelled", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-cancelled-before-start-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-cancelled-before-start-workspace-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: false,
    });
    await markCancelled({ workspaceRoot, dataRoot, jobId: job.id });
    let providerCalled = false;
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/claude",
        }),
        review: async () => {
          providerCalled = true;
          throw new Error("provider should not run");
        },
      },
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        requested: ["claude"],
        explicit: true,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
        "job-id": job.id,
      },
      focus: "",
      workspaceRoot,
    });

    assert.equal(output.job.status, "cancelled");
    assert.equal(providerCalled, false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runReview marks schema-invalid provider output as invalid-output even when provider exits nonzero", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-invalid-review-"));
  try {
    const adapters = {
      antigravity: {
        check: async () => ({
          provider: "antigravity",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/agy",
        }),
        review: async () => ({
          exitCode: 1,
          rawText: "Usage of agy:\n  --model string",
          stderr: "schema invalid",
          sessionId: "",
          commandLine: "agy -p",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      },
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        requested: ["antigravity"],
        explicit: true,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "",
      workspaceRoot: "/tmp/workspace",
    });

    assert.equal(output.job.status, "failed");
    assert.equal(output.job.providerRuns.antigravity.status, "invalid-output");
    assert.equal(output.job.providerRuns.antigravity.normalized.verdict, "invalid-output");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runReview records partial status when at least one provider returns usable output", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-partial-review-"));
  try {
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
        }),
        review: async () => ({
          exitCode: 0,
          rawText: JSON.stringify({
            verdict: "clean",
            summary: "No blocking issues.",
            findings: [],
            assumptions: [],
            verification_gaps: [],
          }),
          stderr: "",
          sessionId: "claude-session",
          commandLine: "claude -p",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      },
      antigravity: {
        check: async () => ({
          provider: "antigravity",
          ready: true,
          installed: true,
          auth: "ok",
        }),
        review: async () => {
          throw new Error("transport crashed before provider output");
        },
      },
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        requested: ["claude", "antigravity"],
        explicit: false,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "",
      workspaceRoot: "/tmp/workspace",
    });

    assert.equal(output.job.status, "partial");
    assert.equal(output.job.providerRuns.claude.status, "completed");
    assert.equal(output.job.providerRuns.antigravity.status, "failed");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runReview records provider rate limits as rate-limited partial results", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-rate-limited-review-"));
  try {
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
        }),
        review: async () => {
          throw new Error("Anthropic Messages request failed: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Error\"}}");
        },
      },
      antigravity: {
        check: async () => ({
          provider: "antigravity",
          ready: true,
          installed: true,
          auth: "ok",
        }),
        review: async () => ({
          exitCode: 0,
          rawText: JSON.stringify({
            verdict: "clean",
            summary: "No blocking issues.",
            findings: [],
            assumptions: [],
            verification_gaps: [],
          }),
          stderr: "",
          sessionId: "",
          commandLine: "agy code-assist messages",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      },
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        requested: ["claude", "antigravity"],
        explicit: false,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "",
      workspaceRoot: "/tmp/workspace",
    });

    assert.equal(output.job.status, "partial");
    assert.equal(output.job.providerRuns.claude.status, "rate-limited");
    assert.equal(output.job.providerRuns.claude.normalized.verdict, "rate-limited");
    assert.match(output.synthesis, /rate-limited/i);
    assert.equal(output.job.providerRuns.antigravity.status, "completed");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runReview marks provider crashes as failed, not invalid-output", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-crash-review-"));
  try {
    const adapters = {
      antigravity: {
        check: async () => ({
          provider: "antigravity",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/agy",
        }),
        review: async () => {
          throw new Error("transport crashed before provider output");
        },
      },
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        requested: ["antigravity"],
        explicit: true,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "",
      workspaceRoot: "/tmp/workspace",
    });

    assert.equal(output.job.status, "failed");
    assert.equal(output.job.providerRuns.antigravity.status, "failed");
    assert.equal(output.job.providerRuns.antigravity.normalized.verdict, "invalid-output");
    assert.match(output.job.providerRuns.antigravity.normalized.summary, /transport crashed before provider output/);
    assert.match(output.synthesis, /transport crashed before provider output/);
    assert.equal(output.job.providerRuns.antigravity.exitCode, 1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runReview marks bare provider signal exits as failed when the run was not cancelled", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-signal-failed-"));
  try {
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/claude",
        }),
        review: async () => ({
          exitCode: null,
          signal: "SIGTERM",
          rawText: JSON.stringify({
            verdict: "clean",
            summary: "Provider exited by signal.",
            findings: [],
            assumptions: [],
            verification_gaps: [],
          }),
          stderr: "",
          sessionId: "claude-session",
          commandLine: "claude -p",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      },
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        requested: ["claude"],
        explicit: true,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "",
      workspaceRoot: "/tmp/workspace",
    });

    assert.equal(output.job.status, "failed");
    assert.equal(output.job.providerRuns.claude.status, "failed");
    assert.equal(output.job.providerRuns.claude.signal, "SIGTERM");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runReview lets cancellation dominate provider timeout status", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-cancel-timeout-"));
  try {
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/claude",
        }),
        review: async (input, options) => {
          options.controller.cancel("SIGINT");
          return {
            exitCode: null,
            signal: "SIGKILL",
            timedOut: true,
            rawText: JSON.stringify({
              verdict: "clean",
              summary: "Provider was interrupted during timeout cleanup.",
              findings: [],
              assumptions: [],
              verification_gaps: [],
            }),
            stderr: "",
            sessionId: "claude-session",
            commandLine: "claude -p",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        requested: ["claude"],
        explicit: true,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "",
      workspaceRoot: "/tmp/workspace",
    });

    assert.equal(output.job.status, "cancelled");
    assert.equal(output.job.providerRuns.claude.status, "cancelled");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runReview does not overwrite a cancelled job when providers finish", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-review-cancel-"));
  try {
    const workspaceRoot = "/tmp/workspace";
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/claude",
        }),
        review: async (input, options) => {
          await markCancelled({
            workspaceRoot,
            dataRoot,
            jobId: path.basename(options.promptDir),
          });
          return {
            exitCode: 0,
            rawText: JSON.stringify({
              verdict: "clean",
              summary: "No findings.",
              findings: [],
              assumptions: [],
              verification_gaps: [],
            }),
            stderr: "",
            sessionId: "claude-session",
            commandLine: "claude -p",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        requested: ["claude"],
        explicit: true,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "",
      workspaceRoot,
    });

    assert.equal(output.job.status, "cancelled");
    assert.equal(output.job.providerRuns.claude.status, "completed");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runReview does not let signal cancellation overwrite terminal completed jobs", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-terminal-signal-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-terminal-signal-workspace-"));
  try {
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/claude",
        }),
        review: async (input, options) => {
          const state = createState({ workspaceRoot, dataRoot });
          const jobId = path.basename(options.promptDir);
          await updateJob(state, jobId, (current) => ({
            ...current,
            status: "completed",
            stage: "synthesis-ready",
            completedAt: "2026-06-06T00:00:00.000Z",
            synthesis: "existing synthesis",
          }));
          options.controller.cancel("SIGINT");
          return {
            exitCode: 0,
            rawText: JSON.stringify({
              verdict: "clean",
              summary: "Provider finished cleanly.",
              findings: [],
              assumptions: [],
              verification_gaps: [],
            }),
            stderr: "",
            sessionId: "claude-session",
            commandLine: "claude -p",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        requested: ["claude"],
        explicit: true,
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "",
      workspaceRoot,
    });

    assert.equal(output.job.status, "completed");
    assert.equal(output.job.stage, "synthesis-ready");
    assert.equal(output.job.synthesis, "existing synthesis");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runTask passes task mode into provider adapters", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-task-"));
  try {
    let receivedInput;
    let receivedOptions;
    const adapters = {
      antigravity: {
        check: async () => ({
          provider: "antigravity",
          ready: true,
          installed: true,
          auth: "ok",
          path: "fake-agy",
        }),
        task: async (input, options) => {
          receivedInput = input;
          receivedOptions = options;
          return {
            exitCode: 0,
            rawText: "No bugs found.",
            stderr: "",
            sessionId: "",
            commandLine: "fake-agy",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    };

    await runTask({
      adapters,
      providerSelection: {
        requested: ["antigravity"],
        explicit: true,
      },
      options: {
        "data-root": dataRoot,
        timeout: "60",
      },
      task: "inspect only",
      workspaceRoot: "/tmp/workspace",
    });

    assert.equal(receivedInput.mode, "task");
    assert.equal(receivedOptions.write, false);
    assert.equal(receivedOptions.timeoutMs, 60_000);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("markCancelled does not overwrite terminal jobs", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-cancel-terminal-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-cancel-terminal-workspace-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: false,
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "completed",
      stage: "synthesis-ready",
      completedAt: "2026-06-06T00:00:00.000Z",
      synthesis: "existing synthesis",
    }));

    const cancelled = await markCancelled({ workspaceRoot, dataRoot, jobId: job.id });

    assert.equal(cancelled.status, "completed");
    assert.equal(cancelled.stage, "synthesis-ready");
    assert.equal(cancelled.synthesis, "existing synthesis");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("getStatus marks running jobs failed when stored worker pid is dead", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-dead-pid-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-dead-pid-workspace-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: true,
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "running",
      stage: "calling-providers",
      pid: 99_999_999,
    }));

    const status = await getStatus({ workspaceRoot, dataRoot, jobId: job.id });

    assert.equal(status.status, "failed");
    assert.equal(status.stage, "failed");
    assert.match(status.error, /no longer running/i);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("getStatus does not trust a live reused pid with a mismatched start signature", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-reused-pid-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-reused-pid-workspace-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: true,
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "running",
      stage: "calling-providers",
      pid: process.pid,
      pidStartedAt: "Mon Jan 1 00:00:00 1970",
    }));

    const status = await getStatus({ workspaceRoot, dataRoot, jobId: job.id });

    assert.equal(status.status, "failed");
    assert.match(status.error, /no longer running/i);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("getStatus does not fail live jobs when ps lookup is temporarily unavailable", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-ps-unavailable-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-ps-unavailable-workspace-"));
  const oldPath = process.env.PATH;
  const emptyPath = await mkdtemp(path.join(tmpdir(), "supermodels-empty-path-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: true,
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "running",
      stage: "calling-providers",
      pid: process.pid,
      pidStartedAt: "Mon Jan 1 00:00:00 1970",
    }));
    process.env.PATH = emptyPath;

    const status = await getStatus({ workspaceRoot, dataRoot, jobId: job.id });

    assert.equal(status.status, "running");
  } finally {
    process.env.PATH = oldPath;
    await rm(emptyPath, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("getStatus ignores provider metadata pids when no worker pid is recorded", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-provider-metadata-ignored-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-provider-metadata-ignored-workspace-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: true,
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "running",
      stage: "calling-providers",
      pid: null,
      providerRuns: {
        claude: {
          provider: "claude",
          status: "running",
          pid: process.pid,
          pidStartedAt: "Mon Jan 1 00:00:00 1970",
        },
      },
    }));

    const status = await getStatus({ workspaceRoot, dataRoot, jobId: job.id });

    assert.equal(status.status, "running");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("getStatus marks stale running jobs failed when no process pid was recorded", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-stale-no-pid-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-stale-no-pid-workspace-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: true,
    });
    const staleJob = {
      ...job,
      status: "running",
      stage: "calling-providers",
      pid: null,
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    };
    await writeFile(jobPath(state, job.id), `${JSON.stringify(staleJob, null, 2)}\n`);

    const status = await getStatus({ workspaceRoot, dataRoot, jobId: job.id });

    assert.equal(status.status, "failed");
    assert.equal(status.stage, "failed");
    assert.match(status.error, /no recorded worker process/i);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runTask rejects invalid timeout before creating a job", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-timeout-before-job-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-timeout-before-job-workspace-"));
  try {
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/claude",
        }),
        task: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };

    await assert.rejects(
      () => runTask({
        adapters,
        providerSelection: {
          requested: ["claude"],
          explicit: true,
        },
        options: {
          "data-root": dataRoot,
          timeout: "abc",
        },
        task: "inspect only",
        workspaceRoot,
      }),
      /positive number of seconds/i,
    );

    const jobs = await listJobs(createState({ workspaceRoot, dataRoot }));
    assert.deepEqual(jobs, []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runTask does not overwrite a cancelled job when providers finish", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-task-cancel-"));
  try {
    const workspaceRoot = "/tmp/workspace";
    const adapters = {
      antigravity: {
        check: async () => ({
          provider: "antigravity",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/agy",
        }),
        task: async (input, options) => {
          await markCancelled({
            workspaceRoot,
            dataRoot,
            jobId: path.basename(options.promptDir),
          });
          return {
            exitCode: 0,
            rawText: "Task completed.",
            stderr: "",
            sessionId: "agy-session",
            commandLine: "agy -p",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    };

    const output = await runTask({
      adapters,
      providerSelection: {
        requested: ["antigravity"],
        explicit: true,
      },
      options: {
        "data-root": dataRoot,
      },
      task: "inspect only",
      workspaceRoot,
    });

    assert.equal(output.job.status, "cancelled");
    assert.equal(output.job.providerRuns.antigravity.status, "completed");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runTask marks foreground jobs failed when an internal state write fails", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-foreground-fail-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-runtime-foreground-workspace-"));
  const state = createState({ workspaceRoot, dataRoot });
  try {
    const adapters = {
      claude: {
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/tmp/claude",
        }),
        task: async () => {
          const [job] = await listJobs(state);
          await mkdir(`${jobPath(state, job.id)}.lock`);
          return {
            exitCode: 0,
            rawText: "Task completed.",
            stderr: "",
            sessionId: "claude-session",
            commandLine: "claude -p",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    };

    await assert.rejects(
      () => runTask({
        adapters,
        providerSelection: {
          requested: ["claude"],
          explicit: true,
        },
        options: {
          "data-root": dataRoot,
        },
        task: "trigger state write failure",
        workspaceRoot,
      }),
      /EPERM|EISDIR|illegal operation/i,
    );

    const [job] = await listJobs(state);
    assert.equal(job.status, "failed");
    assert.equal(job.stage, "failed");
    assert.match(job.error, /EPERM|EISDIR|illegal operation/i);
  } finally {
    await chmod(state.jobsDir, 0o700).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
