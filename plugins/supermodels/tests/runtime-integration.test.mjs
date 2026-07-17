import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runReview } from "../scripts/lib/runtime.mjs";
import { createJob, createState, readJob } from "../scripts/lib/state.mjs";
import { challengeRunId } from "../scripts/providers/registry.mjs";

test("runReview executes two ready providers and stores independent artifacts", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-review-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-workspace-"));
  try {
    const adapters = {
      claude: fakeAdapter("claude", "High: claude finding"),
      antigravity: fakeAdapter("antigravity", "Medium: agy finding"),
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        explicit: false,
        requested: ["claude", "antigravity"],
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "focus on data loss",
      workspaceRoot,
    });

    assert.deepEqual(output.selected, ["claude", "antigravity"]);
    assert.equal(Object.keys(output.job.providerRuns).length, 2);
    assert.match(output.job.providerRuns.claude.rawResultPath, /provider-claude\.raw\.txt/);
    assert.match(output.job.providerRuns.antigravity.rawResultPath, /provider-antigravity\.raw\.txt/);
    assert.match(output.synthesis, /Claude Code/);
    assert.match(output.synthesis, /Antigravity/);
    assert.doesNotMatch(output.synthesis, /Cross-Challenge Results/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runReview adversarial mode cross-challenges usable first-pass provider output", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-adversarial-review-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-workspace-"));
  try {
    const calls = [];
    const adapters = {
      claude: fakeAdapter("claude", "High: claude finding", "focus on data loss", calls),
      antigravity: fakeAdapter("antigravity", "Medium: agy finding", "focus on data loss", calls),
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        explicit: false,
        requested: ["claude", "antigravity"],
      },
      mode: "adversarial-review",
      options: {
        "data-root": dataRoot,
      },
      focus: "focus on data loss",
      contextBrief: "session context: challenge workflow was just committed",
      workspaceRoot,
    });

    const claudeChallenge = challengeRunId("claude", ["antigravity"]);
    const antigravityChallenge = challengeRunId("antigravity", ["claude"]);
    assert.deepEqual(output.selected, ["claude", "antigravity"]);
    assert.deepEqual(Object.keys(output.job.providerRuns).sort(), [
      "antigravity",
      antigravityChallenge,
      "claude",
      claudeChallenge,
    ].sort());
    assert.equal(output.challengeResults.length, 2);
    assert.equal(output.job.providerRuns[claudeChallenge].phase, "cross-challenge");
    assert.equal(output.job.providerRuns[claudeChallenge].sourceProvider, "claude");
    assert.deepEqual(output.job.providerRuns[claudeChallenge].challengeTargets, ["antigravity"]);
    assert.match(output.job.providerRuns[claudeChallenge].rawResultPath, new RegExp(`provider-${claudeChallenge}\\.raw\\.txt`));
    assert.match(output.job.providerRuns[antigravityChallenge].rawResultPath, new RegExp(`provider-${antigravityChallenge}\\.raw\\.txt`));
    assert.match(output.synthesis, /Cross-Challenge Results/);
    assert.match(output.synthesis, /Claude Code challenging Google Antigravity/);
    assert.match(output.synthesis, /Antigravity challenging Claude Code/);
    assert(calls.every((call) => /session context: challenge workflow was just committed/.test(call.prompt)));
    assert(calls.some((call) => /Peer Reviews To Challenge/.test(call.prompt)));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runReview adversarial mode targets both peers when three providers cross-challenge", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-adversarial-three-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-workspace-"));
  try {
    const calls = [];
    const adapters = {
      claude: fakeAdapter("claude", "High: claude finding", "focus on data loss", calls),
      antigravity: fakeAdapter("antigravity", "Medium: agy finding", "focus on data loss", calls),
      grok: fakeAdapter("grok", "Low: grok finding", "focus on data loss", calls),
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        explicit: false,
        requested: ["claude", "antigravity", "grok"],
      },
      mode: "adversarial-review",
      options: {
        "data-root": dataRoot,
      },
      focus: "focus on data loss",
      contextBrief: "session context: challenge workflow was just committed",
      workspaceRoot,
    });

    assert.deepEqual(output.selected, ["claude", "antigravity", "grok"]);
    assert.equal(output.challengeResults.length, 3);
    for (const challenger of ["claude", "antigravity", "grok"]) {
      const peers = ["claude", "antigravity", "grok"].filter((provider) => provider !== challenger);
      const runId = challengeRunId(challenger, peers);
      assert.equal(output.job.providerRuns[runId].challengeTargets.length, 2);
      assert.deepEqual(output.job.providerRuns[runId].challengeTargets.slice().sort(), peers.slice().sort());
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runReview persists and supplies a context packet to providers", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-review-packet-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-workspace-"));
  try {
    const calls = [];
    const adapters = {
      claude: fakeAdapter("claude", "High: claude finding", "review the packet compiler", calls),
    };

    const output = await runReview({
      adapters,
      providerSelection: {
        explicit: true,
        requested: ["claude"],
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
      },
      focus: "review the packet compiler",
      contextBrief: "Codex changed the workflow after a discussion about manual Claude handoffs.",
      workspaceRoot,
    });

    assert.equal(output.job.contextPacket?.summary, "Review the supplied implementation/context for production-relevant bugs, gaps, and verification risks.");
    assert.match(output.job.contextPacket.jsonPath, /context-packet\.json$/);
    assert.match(output.job.contextPacket.markdownPath, /context-packet\.md$/);
    assert.match(await readFile(output.job.contextPacket.markdownPath, "utf8"), /manual Claude handoffs/);
    assert.match(calls[0].prompt, /# Supermodels Context Packet/);
    assert.match(calls[0].prompt, /manual Claude handoffs/);
    assert.match(calls[0].prompt, /Reviewer Task/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function fakeAdapter(provider, rawText, expectedFocus = "focus on data loss", calls = null) {
  return {
    capabilities: () => ({ review: true, adversarialReview: true }),
    check: async () => ({
      provider,
      ready: true,
      installed: true,
      auth: "ok",
      path: `/${provider}/bin`,
    }),
    review: async (input, options) => {
      assert.match(input.prompt, /Shared Review Charter/);
      assert.match(input.prompt, new RegExp(escapeRegExp(expectedFocus)));
      assert.equal(options.bin, `/${provider}/bin`);
      calls?.push({ provider, prompt: input.prompt, mode: input.mode });
      return {
        provider,
        exitCode: 0,
        rawText,
        stderr: "",
        sessionId: `${provider}-session`,
        commandLine: `${provider} fake`,
        structured: structuredReview(rawText),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function structuredReview(rawText) {
  return {
    verdict: "needs-attention",
    summary: rawText,
    findings: [
      {
        severity: "medium",
        title: rawText,
        evidence: "test fixture",
        impact: "test fixture",
        recommendation: "test fixture",
        file: "fixture.mjs",
        line_start: 1,
        line_end: 1,
        confidence: "medium",
      },
    ],
    assumptions: [],
    verification_gaps: [],
  };
}

test("runReview records provider progress before every provider has finished", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-progress-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-workspace-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude", "antigravity"],
      background: false,
      focus: "progress test",
    });
    let releaseSlowProvider;
    const slowProviderReleased = new Promise((resolve) => {
      releaseSlowProvider = resolve;
    });
    const adapters = {
      claude: fakeAdapter("claude", "High: fast claude finding", "progress test"),
      antigravity: {
        capabilities: () => ({ review: true, adversarialReview: true }),
        check: async () => ({
          provider: "antigravity",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/antigravity/bin",
        }),
        review: async () => {
          await slowProviderReleased;
          return {
            provider: "antigravity",
            exitCode: 0,
            rawText: "Medium: slow agy finding",
            stderr: "",
            sessionId: "antigravity-session",
            commandLine: "antigravity fake",
            structured: structuredReview("Medium: slow agy finding"),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    };

    const reviewPromise = runReview({
      adapters,
      providerSelection: {
        explicit: false,
        requested: ["claude", "antigravity"],
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
        "job-id": job.id,
      },
      focus: "progress test",
      workspaceRoot,
    });

    await waitFor(async () => {
      const current = await readJob(state, job.id);
      return current.providerRuns.claude?.status === "completed"
        && current.providerRuns.antigravity?.status === "running";
    });

    const partial = await readJob(state, job.id);
    assert.equal(partial.providerRuns.claude.status, "completed");
    assert.equal(partial.providerRuns.antigravity.status, "running");

    releaseSlowProvider();
    await reviewPromise;
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runReview records provider subprocess pid while provider is running", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-provider-child-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-workspace-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: false,
    });
    let releaseProvider;
    const providerReleased = new Promise((resolve) => {
      releaseProvider = resolve;
    });
    const adapters = {
      claude: {
        capabilities: () => ({ review: true, adversarialReview: true }),
        check: async () => ({
          provider: "claude",
          ready: true,
          installed: true,
          auth: "ok",
          path: "/claude/bin",
        }),
        review: async (_input, options) => {
          options.onStart?.({ pid: 4242 });
          await providerReleased;
          return {
            provider: "claude",
            exitCode: 0,
            rawText: "clean",
            stderr: "",
            sessionId: "",
            commandLine: "claude fake",
            structured: structuredReview("clean"),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    };

    const reviewPromise = runReview({
      adapters,
      providerSelection: {
        explicit: true,
        requested: ["claude"],
      },
      mode: "review",
      options: {
        "data-root": dataRoot,
        "job-id": job.id,
      },
      focus: "",
      workspaceRoot,
    });

    await waitFor(async () => {
      const current = await readJob(state, job.id);
      return current.providerRuns.claude?.pid === 4242;
    });

    releaseProvider();
    await reviewPromise;
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for condition");
}
