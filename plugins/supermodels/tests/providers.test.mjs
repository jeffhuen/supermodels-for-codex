import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildClaudeCommand,
  createClaudeAdapter,
  parseClaudeOutput,
  resolveClaudeReviewPolicy,
} from "../scripts/providers/claude/adapter.mjs";
import {
  claudeTaskPermissionDecision,
  writeClaudeTaskHook,
  READ_TASK_TOOL_NAMES,
  EDIT_TASK_TOOL_NAMES,
} from "../scripts/providers/claude/task-permissions.mjs";
import {
  createAntigravityAdapter,
  buildAntigravityCommand,
  parseAntigravitySessionMetadata,
  resolveAntigravityReviewPolicy,
  resolveAntigravityModelAlias,
} from "../scripts/providers/antigravity/adapter.mjs";
import {
  grokAcpPermissionDecision,
  readWorkspaceTextFile,
  runGrokAcpTask,
} from "../scripts/providers/grok/acp-client.mjs";
import {
  buildGrokHeadlessCommand,
  createGrokAdapter,
  parseGrokHeadlessOutput,
  resolveGrokReviewPolicy,
} from "../scripts/providers/grok/adapter.mjs";

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-grok-acp.mjs", import.meta.url));
const nodeSpawnFakeAgent = (mode) => (bin, args, opts) =>
  spawn(process.execPath, [FAKE_ACP], { ...opts, env: { ...opts.env, FAKE_ACP_MODE: mode } });

test("provider adapters resolve their own flat review policies", () => {
  const claude = resolveClaudeReviewPolicy({ effort: "cli-default" });
  assert.equal(claude.maxTokens, 128_000);
  assert.equal(claude.strictSubmit, true);
  assert.equal(claude.cacheControl, true);
  assert.equal(claude.allowForcedToolChoice, false, "adaptive thinking disables forced tool choice");
  assert.deepEqual(claude.reasoningOptions.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(claude.reasoningOptions.output_config, undefined);
  assert.equal(claude.auditMetadata.effort, "");
  assert.match(claude.systemInstructions[0].text, /Claude Code, Anthropic/);

  const claudeWithoutThinking = resolveClaudeReviewPolicy({ thinking: null, maxTokens: 12_345 });
  assert.equal(claudeWithoutThinking.allowForcedToolChoice, true);
  assert.equal(claudeWithoutThinking.maxTokens, 12_345);

  const antigravity = resolveAntigravityReviewPolicy({ mode: "review" });
  assert.equal(antigravity.maxTokens, 64_000);
  assert.equal(antigravity.reasoningOptions.thinkingBudget, -1);
  assert.equal(antigravity.forceAfterSatisfiedRounds, 4);
  assert.equal(antigravity.auditMetadata.thinkingBudget, -1);
  assert.equal(
    resolveAntigravityReviewPolicy({ mode: "adversarial-review" }).forceAfterSatisfiedRounds,
    Number.POSITIVE_INFINITY,
  );

  const grok = resolveGrokReviewPolicy();
  assert.equal(grok.maxTokens, 64_000);
  assert.equal(grok.reasoningOptions.reasoning_effort, "high");
  assert.equal(grok.forceAfterSatisfiedRounds, 4);
  assert.equal(grok.auditMetadata.effort, "high");
  assert.equal(resolveGrokReviewPolicy({ forceAfterSatisfiedRounds: 9 }).forceAfterSatisfiedRounds, 9);
});

test("provider readiness rejects regular but non-runnable CLI files", { skip: process.platform === "win32" }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-broken-provider-bins-"));
  try {
    for (const name of ["claude", "agy", "grok"]) {
      await writeFile(path.join(tempDir, name), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
    }
    const env = { PATH: tempDir, HOME: tempDir };
    const checks = await Promise.all([
      createClaudeAdapter().check({ env }),
      createAntigravityAdapter().check({ env }),
      createGrokAdapter().check({ env }),
    ]);

    for (const check of checks) {
      assert.equal(check.installed, true);
      assert.equal(check.ready, false);
      assert.match(check.error, /--version.*failed/i);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseClaudeOutput extracts stream-json text and session id", () => {
  const output = [
    JSON.stringify({ type: "system", session_id: "claude-session-1" }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Finding one" }] },
    }),
    JSON.stringify({ type: "result", result: "Final review" }),
  ].join("\n");

  const parsed = parseClaudeOutput(output);

  assert.equal(parsed.sessionId, "claude-session-1");
  assert.match(parsed.text, /Finding one/);
  assert.match(parsed.text, /Final review/);
});

test("parseClaudeOutput does not duplicate identical assistant and result text", () => {
  const output = [
    JSON.stringify({ type: "system", session_id: "claude-session-1" }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "High: duplicate finding" }] },
    }),
    JSON.stringify({ type: "result", result: "High: duplicate finding" }),
  ].join("\n");

  const parsed = parseClaudeOutput(output);

  assert.equal(parsed.text, "High: duplicate finding");
});

test("parseClaudeOutput extracts Claude CLI structured_output from result event", () => {
  const structured = {
    verdict: "clean",
    summary: "No findings.",
    findings: [],
    assumptions: [],
    verification_gaps: [],
  };
  const output = [
    JSON.stringify({ type: "system", session_id: "claude-session-1" }),
    JSON.stringify({
      type: "result",
      result: "```json\n{}\n```",
      structured_output: structured,
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
  ].join("\n");

  const parsed = parseClaudeOutput(output);

  assert.deepEqual(parsed.structured, structured);
  assert.deepEqual(parsed.usage, { input_tokens: 1, output_tokens: 2 });
});

test("parseClaudeOutput falls back to plain stdout", () => {
  const parsed = parseClaudeOutput("plain review text");
  assert.equal(parsed.sessionId, "");
  assert.equal(parsed.text, "plain review text");
});

test("buildClaudeCommand uses print mode and passes review prompt through stdin", () => {
  const command = buildClaudeCommand({ mode: "review", model: "claude-opus-4-8" });
  assert.equal(command.bin, "claude");
  assert.deepEqual(command.args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.equal(command.stdin, true);
  assert(command.args.includes("claude-opus-4-8"));
});

test("buildClaudeCommand asks Claude CLI for schema-validated review output", () => {
  const command = buildClaudeCommand({ mode: "review" });
  const schemaIndex = command.args.indexOf("--json-schema");

  assert(schemaIndex >= 0);
  const schema = JSON.parse(command.args[schemaIndex + 1]);
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, [
    "verdict",
    "summary",
    "findings",
    "missing_change_findings",
    "assumptions",
    "verification_gaps",
  ]);
});

test("buildClaudeCommand constrains read-only reviews and isolates task sessions", () => {
  const command = buildClaudeCommand({ mode: "review" });
  assert(command.args.includes("--allowedTools"));
  assert(command.args.includes("Read,Grep,Glob,LS"));
  assert.deepEqual(
    command.args.slice(command.args.indexOf("--permission-mode"), command.args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "plan"],
  );
  assert(!command.args.includes("--no-session-persistence"));

  // Tasks run under the broker's isolated, fail-closed PreToolUse hook (isolation
  // triple, verified in B0) AND a coarse `--tools` availability allowlist. The
  // allowlist is what closes the broken-hook Bash fail-open: `dontAsk`
  // auto-allows read-only shell, so a missing/crashing hook would otherwise let
  // Bash execute. `--tools` bounds availability without pre-approving (unlike the
  // banned `--allowedTools`), so per-call path-scoping in the hook is preserved.
  const task = buildClaudeCommand({ mode: "task", settingsPath: "/tmp/s.json" });
  assert(!task.args.includes("--allowedTools"));
  assert(!task.args.includes("bypassPermissions"));
  assert(task.args.includes("--tools"));
  assert(!task.args.includes("Bash"));
  assert(task.args.includes("--setting-sources"));
  assert.equal(task.args[task.args.indexOf("--setting-sources") + 1], "");
  assert.deepEqual(
    task.args.slice(task.args.indexOf("--settings"), task.args.indexOf("--settings") + 2),
    ["--settings", "/tmp/s.json"],
  );
  assert.deepEqual(
    task.args.slice(task.args.indexOf("--permission-mode"), task.args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "dontAsk"],
  );
});

test("buildClaudeCommand keeps write tasks under the same isolated hook gating", () => {
  // Per-call write authority (path-scoping) lives in the hook script's embedded
  // policy, not in argv: no `--allowedTools` pre-approval leaks. Write tasks
  // widen the `--tools` availability allowlist to include the edit tools, but
  // still never expose Bash (shell voids path-gating with no OS sandbox).
  const command = buildClaudeCommand({ mode: "task", write: true, settingsPath: "/tmp/s.json" });
  assert(!command.args.includes("--allowedTools"));
  assert(!command.args.includes("Read,Grep,Glob,LS,Edit,MultiEdit,Write"));
  assert(!command.args.includes("bypassPermissions"));
  assert(command.args.includes("--tools"));
  assert(!command.args.includes("Bash"));
  assert(command.args.includes("Write"));
  assert(command.args.includes("Edit"));
  assert.deepEqual(
    command.args.slice(command.args.indexOf("--settings"), command.args.indexOf("--settings") + 2),
    ["--settings", "/tmp/s.json"],
  );
  assert.deepEqual(
    command.args.slice(command.args.indexOf("--permission-mode"), command.args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "dontAsk"],
  );
});

test("buildClaudeCommand allowlists read-only task tools and never exposes Bash", () => {
  // FAIL-OPEN CLOSURE: under `--permission-mode dontAsk` a missing/crashing/
  // malformed/timed-out hook lets read-only Bash EXECUTE (dontAsk auto-allows
  // read-only shell; the hook's Bash-deny only applies when the hook runs). The
  // `--tools` allowlist makes Bash unavailable regardless of hook health while
  // still composing with the hook's per-call path-scoping (verified live).
  const readOnly = buildClaudeCommand({ mode: "task", write: false, settingsPath: "/tmp/s.json" });
  assert(readOnly.args.includes("--tools"));
  for (const name of READ_TASK_TOOL_NAMES) {
    assert(readOnly.args.includes(name), `read-only task --tools must include ${name}`);
  }
  for (const forbidden of ["Bash", ...EDIT_TASK_TOOL_NAMES]) {
    assert(!readOnly.args.includes(forbidden), `read-only task must not expose ${forbidden}`);
  }
  assert(!readOnly.args.includes("--allowedTools"));

  const write = buildClaudeCommand({ mode: "task", write: true, settingsPath: "/tmp/s.json" });
  assert(write.args.includes("--tools"));
  for (const name of [...READ_TASK_TOOL_NAMES, ...EDIT_TASK_TOOL_NAMES]) {
    assert(write.args.includes(name), `write task --tools must include ${name}`);
  }
  assert(!write.args.includes("--allowedTools"));

  // Bash is unavailable in BOTH modes: no OS sandbox on Claude tasks, so shell
  // would void the hook's path-gating.
  assert(!readOnly.args.includes("Bash"));
  assert(!write.args.includes("Bash"));
});

test("runClaudePrompt forces task-mode gating even when input.mode is missing/misspelled", async () => {
  // FAIL-OPEN CLOSURE (mode boundary): runClaudePrompt is exclusively the task
  // implementation, so it must force mode:"task" at the buildClaudeCommand
  // boundary. If it forwarded a caller's missing/misspelled mode, isTaskMode
  // would be false and NO gating (isolation triple, --tools) would be emitted —
  // the task would run wide open. This drives the real runClaudePrompt through a
  // fake claude binary that records the argv it was actually invoked with.
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-claude-force-task-"));
  try {
    const recordPath = path.join(tempDir, "argv.json");
    const fakeClaude = path.join(tempDir, "claude");
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => { stdin += c; });",
      "process.stdin.on('end', () => {",
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)));`,
      "  console.log(JSON.stringify({ type: 'system', session_id: 'fake-task-session' }));",
      "  console.log(JSON.stringify({ type: 'result', result: 'ok' }));",
      "});",
      "",
    ].join("\n"), { mode: 0o755 });

    const adapter = createClaudeAdapter();
    await adapter.task({ mode: "definitely-not-a-real-mode", prompt: "look around" }, {
      bin: fakeClaude,
      cwd: tempDir,
      write: false,
      timeoutMs: 10_000,
    });

    const argv = JSON.parse(await readFile(recordPath, "utf8"));
    // Isolation triple emitted despite the bogus input.mode.
    assert(argv.includes("--settings"));
    assert(argv.includes("--setting-sources"));
    assert.equal(argv[argv.indexOf("--setting-sources") + 1], "");
    assert.deepEqual(
      argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2),
      ["--permission-mode", "dontAsk"],
    );
    // --tools allowlist emitted; Bash closed; no pre-approval / bypass leak.
    assert(argv.includes("--tools"));
    for (const name of READ_TASK_TOOL_NAMES) {
      assert(argv.includes(name), `forced task --tools must include ${name}`);
    }
    assert(!argv.includes("Bash"));
    assert(!argv.includes("--allowedTools"));
    assert(!argv.includes("bypassPermissions"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildClaudeCommand supports opus alias and explicit max effort", () => {
  const command = buildClaudeCommand({ model: "opus", effort: "max" });
  assert(command.args.includes("claude-opus-4-8"));
  assert.deepEqual(command.args.slice(-4), ["--model", "claude-opus-4-8", "--effort", "max"]);
});

test("buildClaudeCommand defaults review effort to xhigh", () => {
  const command = buildClaudeCommand({ model: "opus" });
  assert.deepEqual(command.args.slice(-4), ["--model", "claude-opus-4-8", "--effort", "xhigh"]);
});

test("Claude adapter runs reviews through the direct tool-loop transport", async () => {
  const adapter = createClaudeAdapter(fakeDirectReviewFactory("claude"));

  const result = await adapter.review({
    mode: "review",
    focus: "inspect cancellation",
    context: {},
    prompt: "legacy prompt should not be sent to claude -p",
  }, {
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(result.provider, "claude");
  assert.equal(result.commandLine, "claude oauth messages");
  assert.equal(result.structured.verdict, "clean");
});

test("Claude direct reviews preload repository context before the first model turn", async () => {
  const executed = [];
  let firstRequest;
  const adapter = createClaudeAdapter({
    reviewTransport: {
      calls: 0,
      async messages(body) {
        firstRequest ??= body;
        this.calls += 1;
        if (this.calls === 1) {
          return directToolResponse("read_1", "read_file", { path: "plugins/supermodels/scripts/lib/review-agent.mjs" });
        }
        if (this.calls === 2) {
          return directToolResponse("search_1", "search", { query: "runReviewAgent" });
        }
        return directToolResponse("submit_1", "submit_review", {
          verdict: "inconclusive",
          summary: "preloaded context was enough",
          findings: [],
          assumptions: [],
          verification_gaps: [],
        });
      },
    },
    reviewTools: {
      schemas: [],
      async execute(name) {
        executed.push(name);
        if (name === "get_review_context") {
          return {
            ok: true,
            diffSummary: "1 file changed",
            diff: "diff --git a/plugins/supermodels/scripts/lib/review-agent.mjs b/plugins/supermodels/scripts/lib/review-agent.mjs",
            changedFiles: [{ status: "M", path: "plugins/supermodels/scripts/lib/review-agent.mjs" }],
            fileSnippets: [{
              path: "plugins/supermodels/scripts/lib/review-agent.mjs",
              content: "1: export async function runReviewAgent() {}",
            }],
          };
        }
        if (name === "read_file") {
          return {
            ok: true,
            path: "plugins/supermodels/scripts/lib/review-agent.mjs",
            content: "1: export async function runReviewAgent() {}",
          };
        }
        if (name === "search") {
          return {
            ok: true,
            query: "runReviewAgent",
            output: "plugins/supermodels/scripts/lib/review-agent.mjs:1:export async function runReviewAgent",
          };
        }
        throw new Error(`unexpected tool ${name}`);
      },
    },
  });

  const result = await adapter.review({
    mode: "review",
    focus: "inspect direct transport",
    context: {},
    prompt: "brief",
  }, {
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(result.structured.verdict, "inconclusive");
  assert.deepEqual(executed, ["get_review_context", "read_file", "search"]);
  assert.match(JSON.stringify(firstRequest.messages), /Codex preloaded/);
});

test("Claude direct reviews pass explicit effort overrides to the Messages request", async () => {
  let firstRequest;
  const adapter = createClaudeAdapter({
    reviewTransport: {
      calls: 0,
      async messages(body) {
        firstRequest ??= body;
        this.calls += 1;
        if (this.calls === 1) {
          return directToolResponse("read_1", "read_file", { path: "a" });
        }
        if (this.calls === 2) {
          return directToolResponse("search_1", "search", { query: "a" });
        }
        return directToolResponse("submit_1", "submit_review", {
          verdict: "inconclusive",
          summary: "effort override checked",
          findings: [],
          assumptions: [],
          verification_gaps: [],
        });
      },
    },
    reviewTools: {
      schemas: [],
      async execute(name) {
        if (name === "get_review_context") {
          return {
            ok: true,
            diffSummary: "1 file changed",
            diff: "diff --git a/a b/a",
            changedFiles: [{ status: "M", path: "a" }],
            fileSnippets: [{ path: "a", content: "1: export {};" }],
          };
        }
        if (name === "read_file") {
          return { ok: true, path: "a", content: "1: export {};" };
        }
        if (name === "search") {
          return { ok: true, query: "a", output: "a:1:export {}" };
        }
        throw new Error(`unexpected tool ${name}`);
      },
    },
  });

  await adapter.review({
    mode: "review",
    focus: "inspect direct transport",
    context: {},
    prompt: "brief",
  }, {
    cwd: process.cwd(),
    timeoutMs: 5000,
    effort: "max",
  });

  assert.deepEqual(firstRequest.output_config, { effort: "max" });
});

test("Claude direct reviews default to configured Opus xhigh-effort review settings and expose audit metadata", async () => {
  let firstRequest;
  const adapter = createClaudeAdapter({
    reviewTransport: {
      calls: 0,
      async messages(body) {
        firstRequest ??= body;
        this.calls += 1;
        if (this.calls === 1) {
          return directToolResponse("read_1", "read_file", { path: "a" });
        }
        if (this.calls === 2) {
          return directToolResponse("search_1", "search", { query: "a" });
        }
        return directToolResponse("submit_1", "submit_review", {
          verdict: "inconclusive",
          summary: "default review config checked",
          findings: [],
          assumptions: [],
          verification_gaps: [],
        });
      },
    },
    reviewTools: {
      schemas: [],
      async execute(name) {
        if (name === "get_review_context") {
          return {
            ok: true,
            diffSummary: "1 file changed",
            diff: "diff --git a/a b/a",
            changedFiles: [{ status: "M", path: "a" }],
            fileSnippets: [{ path: "a", content: "1: export {};" }],
          };
        }
        if (name === "read_file") {
          return { ok: true, path: "a", content: "1: export {};" };
        }
        if (name === "search") {
          return { ok: true, query: "a", output: "a:1:export {}" };
        }
        throw new Error(`unexpected tool ${name}`);
      },
    },
  });

  const result = await adapter.review({
    mode: "review",
    focus: "inspect direct transport",
    context: {},
    prompt: "brief",
  }, {
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(firstRequest.model, "claude-opus-4-8");
  assert.deepEqual(firstRequest.output_config, { effort: "xhigh" });
  assert.deepEqual(firstRequest.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(firstRequest.max_tokens, 128_000);
  assert.equal(result.reviewConfig.model, "claude-opus-4-8");
  assert.equal(result.reviewConfig.effort, "xhigh");
  assert.equal(result.reviewConfig.maxTokens, 128_000);
  assert.deepEqual(result.reviewConfig.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(result.reviewConfig.rounds, 3);
  assert.deepEqual(result.reviewConfig.toolUsage, {
    get_review_context: 1,
    read_file: 1,
    search: 1,
  });
});

test("Claude check validates direct OAuth credentials used by reviews", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-claude-direct-ready-"));
  try {
    const fakeClaude = path.join(tempDir, "claude");
    const credentialsPath = path.join(tempDir, "claude-credentials.json");
    await writeFakeClaudeStatus(fakeClaude);
    await writeFile(credentialsPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference"],
      },
    }), "utf8");

    const adapter = createClaudeAdapter({
      credentialsOptions: { credentialsPath },
    });
    const check = await adapter.check({
      env: {
        PATH: tempDir,
      },
    });

    assert.equal(check.ready, true);
    assert.equal(check.auth, "claude.ai");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Claude check fails when direct OAuth refresh fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-claude-direct-invalid-"));
  try {
    const fakeClaude = path.join(tempDir, "claude");
    const credentialsPath = path.join(tempDir, "claude-credentials.json");
    await writeFakeClaudeStatus(fakeClaude);
    await writeFile(credentialsPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: "expired-access",
        refreshToken: "invalid-refresh",
        expiresAt: 1,
        scopes: ["user:inference"],
      },
    }), "utf8");

    const adapter = createClaudeAdapter({
      credentialsOptions: {
        credentialsPath,
        fetchImpl: async () => new Response(JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token not found or invalid",
        }), { status: 400, headers: { "content-type": "application/json" } }),
      },
    });
    const check = await adapter.check({
      env: {
        PATH: tempDir,
      },
    });

    assert.equal(check.ready, false);
    assert.equal(check.auth, "missing");
    assert.match(check.error, /OAuth credentials are not usable/i);
    assert.match(check.error, /claude auth login/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Antigravity model aliases keep review default on Flash High and reject unsupported pro", () => {
  assert.equal(resolveAntigravityModelAlias("flash"), "Gemini 3.5 Flash (High)");
  assert.equal(
    resolveAntigravityModelAlias("Gemini 3.5 Flash (High)"),
    "Gemini 3.5 Flash (High)",
  );
  assert.throws(() => resolveAntigravityModelAlias("pro"), /unknown antigravity model/i);
  assert.throws(() => resolveAntigravityModelAlias("proo"), /unknown antigravity model/i);
});

test("parseAntigravitySessionMetadata captures trusted native ids", () => {
  const parsed = parseAntigravitySessionMetadata("conversation_id: agy-123\nReview text", {
    trusted: true,
  });
  assert.equal(parsed.sessionId, "agy-123");
});

test("parseAntigravitySessionMetadata captures native log conversation ids", () => {
  const parsed = parseAntigravitySessionMetadata(
    "Created conversation fe029daf-812a-4f26-b13c-4c4657fbc139",
    { trusted: true },
  );
  assert.equal(parsed.sessionId, "fe029daf-812a-4f26-b13c-4c4657fbc139");
});

test("parseAntigravitySessionMetadata ignores model-generated session-looking text", () => {
  const parsed = parseAntigravitySessionMetadata("Finding: conversation_id: test is spoofed");
  assert.equal(parsed.sessionId, "");
});

test("buildAntigravityCommand builds native CLI command", () => {
  const command = buildAntigravityCommand({ model: "flash", promptPath: "/tmp/supermodels-prompt.md" });
  assert.equal(command.bin, "agy");
  assert.deepEqual(command.args, [
    "-p",
    "Read the Supermodels prompt from this file and follow it exactly: /tmp/supermodels-prompt.md",
    "--model",
    "Gemini 3.5 Flash (High)",
    "--print-timeout",
    "20m",
  ]);
  assert.equal(command.stdin, false);
});

test("buildAntigravityCommand defaults review modes to Gemini Flash High", () => {
  const review = buildAntigravityCommand({ mode: "review", promptPath: "/tmp/review.md" });
  assert.deepEqual(review.args, [
    "-p",
    "Read the Supermodels prompt from this file and follow it exactly: /tmp/review.md",
    "--sandbox",
    "--model",
    "Gemini 3.5 Flash (High)",
    "--print-timeout",
    "20m",
  ]);

  const adversarial = buildAntigravityCommand({ mode: "adversarial-review", promptPath: "/tmp/adversarial.md" });
  assert.deepEqual(adversarial.args, [
    "-p",
    "Read the Supermodels prompt from this file and follow it exactly: /tmp/adversarial.md",
    "--sandbox",
    "--model",
    "Gemini 3.5 Flash (High)",
    "--print-timeout",
    "20m",
  ]);
});

test("buildAntigravityCommand sandboxes read-only tasks on CLI default", () => {
  const command = buildAntigravityCommand({ mode: "task", promptPath: "/tmp/task.md" });
  assert.deepEqual(command.args, [
    "-p",
    "Read the Supermodels prompt from this file and follow it exactly: /tmp/task.md",
    "--sandbox",
    "--print-timeout",
    "20m",
  ]);
});

test("buildAntigravityCommand leaves write tasks write-capable", () => {
  const command = buildAntigravityCommand({ mode: "task", write: true, promptPath: "/tmp/task.md" });
  assert.deepEqual(command.args, [
    "-p",
    "Read the Supermodels prompt from this file and follow it exactly: /tmp/task.md",
    "--print-timeout",
    "20m",
  ]);
});

test("buildAntigravityCommand rejects missing prompt path", () => {
  assert.throws(
    () => buildAntigravityCommand({ mode: "review" }),
    /prompt path/i,
  );
});

test("parseAntigravitySessionMetadata ignores CLI help text", () => {
  const parsed = parseAntigravitySessionMetadata("  --conversation                  Resume a previous conversation by ID", {
    trusted: true,
  });
  assert.equal(parsed.sessionId, "");
});

test("buildAntigravityCommand uses prompt file instead of full prompt argv", () => {
  const command = buildAntigravityCommand({ mode: "review", promptPath: "/tmp/supermodels-prompt.md" });
  assert.equal(command.stdin, false);
  assert.equal(command.args[0], "-p");
  assert.match(command.args[1], /\/tmp\/supermodels-prompt\.md/);
  assert(command.args.includes("--sandbox"));
  assert(!command.args.some((arg) => /SENTINEL_SUPERMODELS_PROMPT/.test(arg)));
});

test("buildAntigravityCommand records native CLI logs outside the reviewed workspace", () => {
  const command = buildAntigravityCommand({
    mode: "review",
    promptPath: "/tmp/supermodels-prompt.md",
    logFile: "/tmp/supermodels-run/provider-antigravity.log",
  });

  const logIndex = command.args.indexOf("--log-file");
  assert(logIndex >= 0);
  assert.equal(command.args[logIndex + 1], "/tmp/supermodels-run/provider-antigravity.log");
});

test("Antigravity check detects native CLI when local CLI config exists", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-agy-cli-check-"));
  try {
    const fakeAgy = path.join(tempDir, "agy");
    const configDir = path.join(tempDir, ".gemini", "antigravity-cli");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "antigravity-oauth-token"), JSON.stringify({
      token: {
        access_token: "access",
        refresh_token: "refresh",
        expiry: "2099-01-01T00:00:00.000Z",
      },
      auth_method: "consumer",
    }));
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) console.log('1.2.3-test');",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const adapter = createAntigravityAdapter();
    const check = await adapter.check({
      env: {
        PATH: tempDir,
        HOME: tempDir,
      },
    });

    assert.equal(check.ready, true);
    assert.equal(check.path, fakeAgy);
    assert.equal(check.auth, "local-oauth");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Antigravity readiness uses the adapter's injected credential source", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-agy-injected-auth-"));
  try {
    const fakeAgy = path.join(tempDir, "agy");
    await writeFile(fakeAgy, "#!/bin/sh\necho 1.2.3-test\n", { mode: 0o755 });
    const adapter = createAntigravityAdapter({
      credentials: { accessToken: async () => "injected-token" },
    });
    const check = await adapter.check({ env: { PATH: tempDir, HOME: tempDir } });

    assert.equal(check.ready, true);
    assert.equal(check.auth, "local-oauth");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Antigravity check does not treat an empty config directory as ready", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-agy-empty-config-"));
  try {
    const fakeAgy = path.join(tempDir, "agy");
    await mkdir(path.join(tempDir, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) console.log('1.2.3-test');",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const adapter = createAntigravityAdapter();
    const check = await adapter.check({
      env: {
        PATH: tempDir,
        HOME: tempDir,
      },
    });

    assert.equal(check.ready, false);
    assert.equal(check.auth, "missing");
    assert.match(check.error, /no local auth\/config/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Antigravity check treats malformed local credentials as missing", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-agy-malformed-config-"));
  try {
    const fakeAgy = path.join(tempDir, "agy");
    const configDir = path.join(tempDir, ".gemini", "antigravity-cli");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "antigravity-oauth-token"), "{}\n");
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) console.log('1.2.3-test');",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const adapter = createAntigravityAdapter();
    const check = await adapter.check({
      env: {
        PATH: tempDir,
        HOME: tempDir,
      },
    });

    assert.equal(check.ready, false);
    assert.equal(check.auth, "missing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Antigravity check treats expired credentials without refresh metadata as missing", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-agy-expired-config-"));
  try {
    const fakeAgy = path.join(tempDir, "agy");
    const configDir = path.join(tempDir, ".gemini", "antigravity-cli");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "antigravity-oauth-token"), JSON.stringify({
      token: {
        access_token: "access",
        refresh_token: "refresh",
        expiry: "2000-01-01T00:00:00.000Z",
      },
      auth_method: "consumer",
    }));
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) console.log('1.2.3-test');",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const adapter = createAntigravityAdapter();
    const check = await adapter.check({
      env: {
        PATH: tempDir,
        HOME: tempDir,
      },
    });

    assert.equal(check.ready, false);
    assert.equal(check.auth, "missing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Antigravity check refreshes expired credentials directly", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-agy-direct-refresh-"));
  try {
    const fakeAgy = path.join(tempDir, "agy");
    const tokenPath = path.join(tempDir, "antigravity-oauth-token");
    await writeFile(tokenPath, JSON.stringify({
      token: {
        access_token: "old-access",
        refresh_token: "refresh",
        expiry: "2000-01-01T00:00:00.000Z",
      },
      auth_method: "consumer",
    }));
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) { console.log('1.2.3-test'); process.exit(0); }",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const adapter = createAntigravityAdapter({
      credentialsOptions: {
        fetchImpl: async () => new Response(JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } }),
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      },
    });
    const check = await adapter.check({
      env: {
        PATH: tempDir,
        HOME: tempDir,
        ANTIGRAVITY_OAUTH_CREDS_PATH: tokenPath,
      },
    });

    assert.equal(check.ready, true);
    assert.equal(check.auth, "local-oauth");
    const refreshed = JSON.parse(await readFile(tokenPath, "utf8"));
    assert.equal(refreshed.token.access_token, "new-access");
    assert.equal(refreshed.token.refresh_token, "refresh");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Antigravity adapter runs reviews through the direct Code Assist tool-loop transport", async () => {
  const adapter = createAntigravityAdapter(fakeDirectReviewFactory("antigravity"));

  const result = await adapter.review({
    mode: "review",
    focus: "inspect cancellation",
    context: {},
    prompt: "legacy prompt should not be sent to agy -p",
  }, {
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(result.provider, "antigravity");
  assert.equal(result.commandLine, "agy code-assist messages");
  assert.equal(result.structured.verdict, "clean");
});

test("Antigravity direct reviews default to Flash High Code Assist model", async () => {
  let seenModel = "";
  const adapter = createAntigravityAdapter({
    ...fakeDirectReviewFactory("antigravity"),
    reviewTransport: {
      calls: 0,
      async messages(body) {
        seenModel ||= body.model;
        this.calls += 1;
        if (this.calls === 1) {
          return directToolResponse("diff_1", "get_diff", {});
        }
        if (this.calls === 2) {
          return directToolResponse("read_1", "read_file", { path: "plugins/supermodels/scripts/lib/runtime.mjs" });
        }
        if (this.calls === 3) {
          return directToolResponse("search_1", "search", { query: "runReviewAgent" });
        }
        return directToolResponse("submit_1", "submit_review", {
          verdict: "clean",
          summary: "done",
          findings: [],
          assumptions: [],
          verification_gaps: [],
        });
      },
    },
  });

  await adapter.review({
    mode: "review",
    focus: "inspect cancellation",
    context: {},
    prompt: "brief",
  }, {
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(seenModel, "gemini-3-flash-preview");
});

test("Antigravity direct reviews reject unsupported pro aliases", async () => {
  const adapter = createAntigravityAdapter({
    ...fakeDirectReviewFactory("antigravity"),
    reviewTransport: {
      calls: 0,
      async messages(body) {
        this.calls += 1;
        if (this.calls === 1) {
          return directToolResponse("diff_1", "get_diff", {});
        }
        if (this.calls === 2) {
          return directToolResponse("read_1", "read_file", { path: "plugins/supermodels/scripts/lib/runtime.mjs" });
        }
        if (this.calls === 3) {
          return directToolResponse("search_1", "search", { query: "runReviewAgent" });
        }
        return directToolResponse("submit_1", "submit_review", {
          verdict: "clean",
          summary: "ok",
          findings: [],
          verification_gaps: [],
          assumptions: [],
        });
      },
    },
  });

  await assert.rejects(
    () => adapter.review({
      mode: "review",
      focus: "inspect aliases",
      context: {},
      prompt: "brief",
    }, {
      cwd: process.cwd(),
      timeoutMs: 5000,
      model: "pro",
    }),
    /unknown antigravity model/i,
  );
});

test("runAntigravityPrompt keeps task delegation on native CLI and writes prompt file", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-agy-prompt-file-"));
  try {
    const recordPath = path.join(tempDir, "record.json");
    const fakeAgy = path.join(tempDir, "agy");
    const conversationId = "fe029daf-812a-4f26-b13c-4c4657fbc139";
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  const argv = process.argv.slice(2);",
      "  const logIndex = argv.indexOf('--log-file');",
      "  if (logIndex >= 0) {",
      `    writeFileSync(argv[logIndex + 1], 'Created conversation ${conversationId}\\n', { mode: 0o644 });`,
      "  }",
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv, stdin }));`,
      "  console.log('FAKE_ANTIGRAVITY_OK');",
      "});",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const adapter = createAntigravityAdapter();
    const result = await adapter.task({
      mode: "task",
      prompt: "SENTINEL_SUPERMODELS_PROMPT",
    }, {
      bin: fakeAgy,
      cwd: tempDir,
      promptDir: tempDir,
      timeoutMs: 5000,
    });

    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(result.rawText, "FAKE_ANTIGRAVITY_OK");
    assert.equal(result.sessionId, conversationId);
    assert.equal(record.stdin, "");
    assert.equal(record.argv[0], "-p");
    assert(record.argv.includes("--log-file"));
    const logPath = record.argv[record.argv.indexOf("--log-file") + 1];
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    const promptPath = record.argv[1].match(/exactly: (.+)$/)?.[1];
    assert(promptPath);
    assert.equal(await readFile(promptPath, "utf8"), "SENTINEL_SUPERMODELS_PROMPT");
    assert.equal((await stat(tempDir)).mode & 0o777, 0o700);
    assert.equal((await stat(promptPath)).mode & 0o777, 0o600);
    assert(!record.argv.includes("SENTINEL_SUPERMODELS_PROMPT"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("grokAcpPermissionDecision picks reject for read-only and allow-once first for write", () => {
  const params = {
    options: [
      { optionId: "allow-edits-session", kind: "allow_always" },
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  };
  assert.equal(grokAcpPermissionDecision(params, { write: false }), "reject-once");
  assert.equal(grokAcpPermissionDecision(params, { write: true }), "allow-once");
});

test("grokAcpPermissionDecision falls back to allow_always when allow_once is absent", () => {
  const params = {
    options: [
      { optionId: "allow-edits-session", kind: "allow_always" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  };
  assert.equal(grokAcpPermissionDecision(params, { write: true }), "allow-edits-session");
});

test("grokAcpPermissionDecision returns null (empty) when no acceptable option exists", () => {
  const params = { options: [{ optionId: "mystery", kind: "custom_manual_review" }] };
  assert.equal(grokAcpPermissionDecision(params, { write: false }), "");
  assert.equal(grokAcpPermissionDecision(params, { write: true }), "");
  assert.equal(grokAcpPermissionDecision({ options: [] }, { write: false }), "");
});

test("grokAcpPermissionDecision honors reject_always for read-only tasks", () => {
  const params = {
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-forever", kind: "reject_always" },
    ],
  };
  assert.equal(grokAcpPermissionDecision(params, { write: false }), "reject-forever");
});

test("runGrokAcpTask streams a read-only task and returns the result shape", async () => {
  const events = [];
  const result = await runGrokAcpTask({ mode: "task", prompt: "look around" }, {
    cwd: process.cwd(),
    spawnImpl: nodeSpawnFakeAgent("read"),
    onEvent: (event) => events.push(event),
    timeoutMs: 10_000,
  });
  assert.equal(result.provider, "grok");
  assert.equal(result.rawText, "read done");
  assert.equal(result.sessionId, "fake-session-1");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.usage.total_tokens, 15);
  assert.ok(events.some((event) => event.type === "tool_call" && /read_file/.test(event.message)));
});

test("runGrokAcpTask denies writes on read-only tasks and reports the cancelled stop", async () => {
  const result = await runGrokAcpTask({ mode: "task", prompt: "write something" }, {
    cwd: process.cwd(),
    spawnImpl: nodeSpawnFakeAgent("write"),
    timeoutMs: 10_000,
  });
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.exitCode, 0);
  assert.equal(result.rawText, "");
});

test("runGrokAcpTask approves writes on write tasks", async () => {
  const result = await runGrokAcpTask({ mode: "task", prompt: "write something" }, {
    cwd: process.cwd(),
    write: true,
    spawnImpl: nodeSpawnFakeAgent("write"),
    timeoutMs: 10_000,
  });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.rawText, "wrote file");
  assert.equal(result.usage.total_tokens, 25);
});

test("runGrokAcpTask redirects once after a read-only policy denial and completes", async () => {
  const events = [];
  const result = await runGrokAcpTask({ mode: "task", prompt: "explore the repo" }, {
    cwd: process.cwd(),
    spawnImpl: nodeSpawnFakeAgent("redirect"),
    onEvent: (event) => events.push(event),
    timeoutMs: 10_000,
  });
  assert.equal(result.stopReason, "end_turn");
  assert.match(result.rawText, /redirected answer/);
  assert.equal(result.exitCode, 0);
  assert.equal(result.usage.total_tokens, 22 + 34);
  assert.ok(events.some((event) => /redirected/.test(event.message)));
});

test("runGrokAcpTask reports success even when the agent ignores stdin EOF and must be killed", async () => {
  const result = await runGrokAcpTask({ mode: "task", prompt: "look around" }, {
    cwd: process.cwd(),
    spawnImpl: nodeSpawnFakeAgent("linger"),
    timeoutMs: 10_000,
  });
  assert.equal(result.rawText, "read done");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
});

test("runGrokAcpTask places model and effort flags before the stdio subcommand", async () => {
  let capturedArgs = null;
  const result = await runGrokAcpTask({ mode: "task", prompt: "look around" }, {
    cwd: process.cwd(),
    model: "grok-4.5",
    effort: "high",
    spawnImpl: (bin, args, opts) => {
      capturedArgs = args;
      return spawn(process.execPath, [FAKE_ACP], { ...opts, env: { ...opts.env, FAKE_ACP_MODE: "read" } });
    },
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(capturedArgs, ["agent", "-m", "grok-4.5", "--reasoning-effort", "high", "stdio"]);
});

test("runGrokAcpTask survives an agent that dies mid-permission-exchange", async () => {
  const result = await runGrokAcpTask({ mode: "task", prompt: "crash please" }, {
    cwd: process.cwd(),
    spawnImpl: nodeSpawnFakeAgent("crash"),
    timeoutMs: 10_000,
  });
  assert.equal(result.provider, "grok");
  assert.equal(result.timedOut, false);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stopReason, "");
});

test("runGrokAcpTask fails closed (cancelled outcome) when only unrecognized permission option kinds are offered", async () => {
  const result = await runGrokAcpTask({ mode: "task", prompt: "look around" }, {
    cwd: process.cwd(),
    spawnImpl: nodeSpawnFakeAgent("unknown-kind"),
    timeoutMs: 10_000,
  });
  assert.match(result.rawText, /permission-cancelled/);
});

test("runGrokAcpTask honors reject_always on read-only tasks", async () => {
  const result = await runGrokAcpTask({ mode: "task", prompt: "look around" }, {
    cwd: process.cwd(),
    spawnImpl: nodeSpawnFakeAgent("reject-always"),
    timeoutMs: 10_000,
  });
  assert.match(result.rawText, /reject-always-honored/);
});

test("runGrokAcpTask does not redirect when our own cancellation races a permission-denial stop", async () => {
  let cancelNow = null;
  const controller = {
    cancelled: false,
    onCancel(fn) {
      cancelNow = fn;
      return () => { cancelNow = null; };
    },
  };
  const events = [];
  const result = await runGrokAcpTask({ mode: "task", prompt: "write something" }, {
    cwd: process.cwd(),
    controller,
    spawnImpl: nodeSpawnFakeAgent("write"),
    onEvent: (event) => {
      events.push(event);
      // Fire our own cancellation the instant the permission decision is
      // emitted (before the fixture's denial reply comes back), simulating a
      // controller-cancel/timeout racing a read-only permission denial.
      if (event.type === "progress" && /grok permission/.test(event.message) && cancelNow) {
        cancelNow();
      }
    },
    timeoutMs: 10_000,
  });
  assert.equal(result.stopReason, "cancelled");
  assert.ok(!events.some((event) => /redirected/.test(event.message)));
});

test("runGrokAcpTask rejects a relative fs/read_text_file escape outside the workspace", async () => {
  const result = await runGrokAcpTask({ mode: "task", prompt: "look around" }, {
    cwd: process.cwd(),
    spawnImpl: nodeSpawnFakeAgent("escape"),
    timeoutMs: 10_000,
  });
  assert.match(result.rawText, /fs-denied/);
});

// Mirrors the existing "Claude check" tests in this file (see the
// PATH: tempDir pattern around the writeFakeClaudeStatus tests): a fake
// executable in tempDir takes PATH precedence over any real install.
test("grok check is ready with a fake binary, version file, and valid credentials", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-grok-check-"));
  try {
    const fakeGrok = path.join(tempDir, "grok");
    await writeFile(fakeGrok, "#!/bin/sh\necho grok 0.2.101 [stable]\n", { mode: 0o755 });
    const authPath = path.join(tempDir, "auth.json");
    await writeFile(authPath, JSON.stringify({
      "https://auth.x.ai::client-1": {
        key: "token", refresh_token: "refresh",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        oidc_issuer: "https://auth.x.ai", oidc_client_id: "client-1",
      },
    }), "utf8");
    const versionPath = path.join(tempDir, "version.json");
    await writeFile(versionPath, JSON.stringify({ version: "0.2.101" }), "utf8");

    const adapter = createGrokAdapter({
      credentialsOptions: { authPath },
      versionOptions: { versionPath },
    });
    const check = await adapter.check({ env: { PATH: tempDir } });
    assert.equal(check.provider, "grok");
    assert.equal(check.label, "Grok Build");
    assert.equal(check.ready, true);
    assert.equal(check.installed, true);
    assert.equal(check.version, "0.2.101");
    assert.equal(check.auth, "oauth");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("grok check fails with grok login guidance when credentials are unusable", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-grok-check-auth-"));
  try {
    const fakeGrok = path.join(tempDir, "grok");
    await writeFile(fakeGrok, "#!/bin/sh\necho grok 0.2.101 [stable]\n", { mode: 0o755 });
    const adapter = createGrokAdapter({
      credentialsOptions: { authPath: path.join(tempDir, "missing-auth.json") },
      versionOptions: { versionPath: path.join(tempDir, "version.json") },
    });
    const check = await adapter.check({ env: { PATH: tempDir } });
    assert.equal(check.ready, false);
    assert.equal(check.installed, true);
    assert.equal(check.auth, "missing");
    assert.match(check.error, /grok login/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("grok readiness refuses a FIFO version cache and falls back within its bound", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-grok-version-fifo-check-"));
  try {
    const fakeGrok = path.join(tempDir, "grok");
    const versionPath = path.join(tempDir, "version.json");
    await writeFile(fakeGrok, "#!/bin/sh\necho grok 0.2.101 [stable]\n", { mode: 0o755 });
    const fifo = spawnSync("mkfifo", [versionPath]);
    assert.equal(fifo.status, 0, fifo.stderr?.toString() || "mkfifo failed");
    const adapter = createGrokAdapter({
      credentials: { accessToken: async () => "token" },
      versionOptions: { versionPath },
    });

    const check = await adapter.check({ env: { PATH: tempDir }, versionTimeoutMs: 40 });
    assert.equal(check.ready, true);
    assert.equal(check.version, "0.2.101");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("grok readiness bounds a hanging credential refresh", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-grok-check-timeout-"));
  try {
    const fakeGrok = path.join(tempDir, "grok");
    await writeFile(fakeGrok, "#!/bin/sh\necho grok 0.2.101 [stable]\n", { mode: 0o755 });
    const adapter = createGrokAdapter({
      credentials: { accessToken: async () => await new Promise(() => {}) },
      versionOptions: { versionPath: path.join(tempDir, "version.json") },
    });

    const check = await adapter.check({ env: { PATH: tempDir }, credentialTimeoutMs: 30 });

    assert.equal(check.ready, false);
    // Pin the CONFIGURED deadline: withAbortTimeout echoes the exact timeout it
    // used, so "timed out after 30ms" causally proves the 30ms option was honored
    // (an ignored option would use the 10_000ms default and read "10000ms"). The
    // { timeout } guards a genuine hang; no wall-clock stopwatch.
    assert.match(check.error, /timed out after 30ms/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("grok readiness requires the subscription OAuth session, not an API key", async () => {
  // Supermodels intentionally exposes a narrower subscription-only contract:
  // even though xAI supports XAI_API_KEY / external auth for the CLI, Supermodels
  // reuses the `grok login` OAuth session and rejects API-key-only setups.
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-grok-apikey-"));
  try {
    const fakeGrok = path.join(tempDir, "grok");
    await writeFile(fakeGrok, "#!/bin/sh\necho grok 0.2.101 [stable]\n", { mode: 0o755 });
    const adapter = createGrokAdapter({
      credentialsOptions: { authPath: path.join(tempDir, "missing-auth.json") },
      versionOptions: { versionPath: path.join(tempDir, "version.json") },
    });
    // An API key present in the environment must NOT satisfy readiness.
    const check = await adapter.check({ env: { PATH: tempDir, XAI_API_KEY: "xai-not-accepted" } });
    assert.equal(check.ready, false);
    assert.equal(check.auth, "missing");
    assert.match(check.error, /grok login/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("a bare --worktree task routes to the headless runner, not ACP", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-grok-worktree-"));
  try {
    const recordPath = path.join(tempDir, "record.json");
    const fakeGrok = path.join(tempDir, "grok");
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)));`,
      "console.log(JSON.stringify({ type: 'text', data: 'worktree headless output' }));",
      "console.log(JSON.stringify({ type: 'end', stopReason: 'EndTurn', sessionId: 'headless-session', usage: { input_tokens: 1, output_tokens: 1 } }));",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);

    const adapter = createGrokAdapter();
    const result = await adapter.task({ mode: "task", prompt: "do the thing" }, {
      cwd: tempDir,
      bin: fakeGrok,
      worktree: true,
      // If routing ever regresses back to ACP, this fake agent answers
      // instead and produces a distinguishable ACP-shaped result (see the
      // runGrokAcpTask "read" tests above), which the assertions below rule
      // out.
      spawnImpl: nodeSpawnFakeAgent("read"),
      timeoutMs: 10_000,
    });

    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.ok(record.includes("--worktree"));
    assert.equal(result.provider, "grok");
    assert.equal(result.sessionId, "headless-session");
    assert.match(result.rawText, /worktree headless output/);
    assert.match(result.commandLine, /--worktree/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildGrokHeadlessCommand composes sandbox, model, and exclusive-mode flags", () => {
  const command = buildGrokHeadlessCommand({
    promptFile: "/tmp/supermodels-prompts/provider-grok.prompt.md", model: "grok-4.5", effort: "high", bestOfN: 3, jsonSchema: { type: "object" },
  });
  assert.equal(command.bin, "grok");
  assert.deepEqual(command.args, [
    "--prompt-file", "/tmp/supermodels-prompts/provider-grok.prompt.md", "--output-format", "streaming-json", "--no-memory",
    "-m", "grok-4.5", "--reasoning-effort", "high",
    "--sandbox", "read-only", "--best-of-n", "3",
    "--json-schema", '{"type":"object"}',
  ]);
  const writeCommand = buildGrokHeadlessCommand({
    promptFile: "/tmp/supermodels-prompts/provider-grok.prompt.md", write: true, model: "cli-default", effort: "cli-default", worktree: true,
  });
  assert.ok(writeCommand.args.includes("workspace"));
  // --check is never appended automatically (grok 0.2.x headless --check can
  // cancel the turn and swallow output); it appears only on explicit request.
  assert.ok(!writeCommand.args.includes("--check"));
  // --worktree is boolean (Grok auto-names); no worktree name is passed through.
  assert.equal(writeCommand.args.filter((arg) => arg === "--worktree").length, 1);
  assert.equal(writeCommand.args[writeCommand.args.indexOf("--worktree") + 1], undefined);
  assert.ok(writeCommand.args.includes("--no-memory"));
  const checkCommand = buildGrokHeadlessCommand({
    promptFile: "/tmp/supermodels-prompts/provider-grok.prompt.md", check: true, write: true,
  });
  assert.ok(checkCommand.args.includes("--check"));
});

test("buildGrokHeadlessCommand rejects a missing prompt file path", () => {
  assert.throws(
    () => buildGrokHeadlessCommand({ model: "grok-4.5" }),
    /prompt file/i,
  );
});

test("buildGrokHeadlessCommand never takes the rendered prompt text as an option", () => {
  const command = buildGrokHeadlessCommand({
    promptFile: "/tmp/supermodels-prompts/provider-grok.prompt.md",
  });
  assert.equal(command.stdin, false);
  assert(!("prompt" in command));
  assert(!command.args.includes("-p"));
  assert(command.args.includes("--prompt-file"));
});

test("runGrokTask headless path writes the prompt to a 0600 temp file and never puts it in argv or commandLine", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-grok-headless-prompt-file-"));
  try {
    const recordPath = path.join(tempDir, "record.json");
    const fakeGrok = path.join(tempDir, "grok");
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { writeFileSync, readFileSync, statSync } from 'node:fs';",
      "const argv = process.argv.slice(2);",
      "const idx = argv.indexOf('--prompt-file');",
      "const promptFile = idx >= 0 ? argv[idx + 1] : '';",
      "const promptText = promptFile ? readFileSync(promptFile, 'utf8') : '';",
      "const mode = promptFile ? (statSync(promptFile).mode & 0o777) : 0;",
      `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv, promptFile, promptText, mode }));`,
      "console.log(JSON.stringify({ type: 'text', data: 'headless prompt-file output' }));",
      "console.log(JSON.stringify({ type: 'end', stopReason: 'EndTurn', sessionId: 'headless-session', usage: { input_tokens: 1, output_tokens: 1 } }));",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);

    const adapter = createGrokAdapter();
    const result = await adapter.task({ mode: "task", prompt: "SENTINEL_SUPERMODELS_GROK_PROMPT" }, {
      cwd: tempDir,
      bin: fakeGrok,
      promptDir: tempDir,
      worktree: true,
      timeoutMs: 10_000,
    });

    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.ok(record.promptFile);
    assert.equal(record.promptText, "SENTINEL_SUPERMODELS_GROK_PROMPT");
    assert.equal(record.mode, 0o600);
    assert(!record.argv.includes("SENTINEL_SUPERMODELS_GROK_PROMPT"));
    assert(!record.argv.includes("-p"));
    assert(record.argv.includes("--prompt-file"));
    assert.match(result.commandLine, /--prompt-file/);
    assert(!result.commandLine.includes("SENTINEL_SUPERMODELS_GROK_PROMPT"));
    // The temp prompt file is cleaned up once the run completes.
    await assert.rejects(() => stat(record.promptFile), /ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseGrokHeadlessOutput collects text, usage, and session from NDJSON", () => {
  const stdout = [
    '{"type":"thought","data":"hmm"}',
    '{"type":"text","data":"hello "}',
    '{"type":"text","data":"world"}',
    '{"type":"end","stopReason":"EndTurn","sessionId":"s-1","usage":{"input_tokens":9,"output_tokens":2}}',
  ].join("\n");
  const parsed = parseGrokHeadlessOutput(stdout);
  assert.equal(parsed.text, "hello world");
  assert.equal(parsed.sessionId, "s-1");
  assert.equal(parsed.usage.input_tokens, 9);
  assert.equal(parsed.stopReason, "EndTurn");
});

test("createGrokAdapter capabilities include writeTask and nativeInterrupt", () => {
  const adapter = createGrokAdapter();
  assert.equal(adapter.id, "grok");
  const capabilities = adapter.capabilities();
  assert.equal(capabilities.review, true);
  assert.equal(capabilities.writeTask, true);
  assert.equal(capabilities.nativeInterrupt, true);
});

function fakeDirectReviewFactory(provider) {
  return {
    reviewTransport: {
      calls: 0,
      async messages() {
        this.calls += 1;
        if (this.calls === 1) {
          return directToolResponse("diff_1", "get_diff", {});
        }
        if (this.calls === 2) {
          return directToolResponse("read_1", "read_file", { path: "plugins/supermodels/scripts/lib/runtime.mjs" });
        }
        if (this.calls === 3) {
          return directToolResponse("search_1", "search", { query: "runReviewAgent" });
        }
        return directToolResponse("submit_1", "submit_review", {
          verdict: "clean",
          summary: `${provider} inspected repository tools.`,
          findings: [],
          assumptions: [],
          verification_gaps: [],
        });
      },
    },
    reviewTools: {
      schemas: [],
      async execute(name) {
        if (name === "get_review_context") {
          return {
            ok: true,
            diffSummary: "1 file changed",
            diff: "diff --git a/plugins/supermodels/scripts/lib/runtime.mjs b/plugins/supermodels/scripts/lib/runtime.mjs",
            changedFiles: [{ status: "M", path: "plugins/supermodels/scripts/lib/runtime.mjs" }],
            fileSnippets: [{
              path: "plugins/supermodels/scripts/lib/runtime.mjs",
              content: "1: export {};",
            }],
          };
        }
        if (name === "get_diff") {
          return { ok: true, diffSummary: "1 file changed", diff: "diff --git a/a b/a" };
        }
        if (name === "read_file") {
          return { ok: true, path: "plugins/supermodels/scripts/lib/runtime.mjs", content: "1: export {};" };
        }
        if (name === "list_changed_files") {
          return { ok: true, files: ["M plugins/supermodels/scripts/lib/runtime.mjs"] };
        }
        if (name === "search") {
          return { ok: true, query: "runReviewAgent", output: "review-agent.mjs:1:export async function runReviewAgent" };
        }
        throw new Error(`unexpected tool ${name}`);
      },
    },
  };
}

function directToolResponse(id, name, input) {
  const normalizedInput = name === "submit_review" && input && !("missing_change_findings" in input)
    ? { ...input, missing_change_findings: [] }
    : input;
  return {
    content: [{ type: "tool_use", id, name, input: normalizedInput }],
    tool_calls: [{ id, name, input: normalizedInput }],
    text: "",
    completion: { status: "complete", reason: "tool_use" },
  };
}

async function writeFakeClaudeStatus(fakeClaude) {
  await writeFile(fakeClaude, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('2.1.167 (Claude Code)'); process.exit(0); }",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));",
    "  process.exit(0);",
    "}",
    "console.error('unexpected fake claude invocation: ' + args.join(' '));",
    "process.exit(2);",
  ].join("\n"));
  await chmod(fakeClaude, 0o755);
}

test("readWorkspaceTextFile serves an in-workspace file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supermodels-grok-fs-"));
  try {
    await writeFile(path.join(dir, "in.txt"), "inside", "utf8");
    const result = await readWorkspaceTextFile(dir, "in.txt");
    assert.equal(result.content, "inside");
    assert.equal(result.truncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readWorkspaceTextFile denies a symlink that escapes the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "supermodels-grok-fsroot-"));
  const outside = await mkdtemp(path.join(tmpdir(), "supermodels-grok-fsout-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), "TOP_SECRET", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await assert.rejects(() => readWorkspaceTextFile(root, "link.txt"), /outside workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("readWorkspaceTextFile rejects a non-regular file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supermodels-grok-fsdir-"));
  try {
    await mkdir(path.join(dir, "subdir"));
    await assert.rejects(() => readWorkspaceTextFile(dir, "subdir"), /not a regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readWorkspaceTextFile bounds the read to maxBytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supermodels-grok-fsbig-"));
  try {
    await writeFile(path.join(dir, "big.txt"), "x".repeat(5000), "utf8");
    const result = await readWorkspaceTextFile(dir, "big.txt", { maxBytes: 1000 });
    assert.equal(result.content.length, 1000);
    assert.equal(result.truncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claudeTaskPermissionDecision read-only denies writes and shell, allows reads", () => {
  const cwd = "/work";
  assert.equal(claudeTaskPermissionDecision({ toolName: "Read", toolInput: { file_path: "/work/a" }, cwd }, { write: false }).decision, "allow");
  assert.equal(claudeTaskPermissionDecision({ toolName: "Write", toolInput: { file_path: "/work/a" }, cwd }, { write: false }).decision, "deny");
  assert.equal(claudeTaskPermissionDecision({ toolName: "Bash", toolInput: { command: "ls" }, cwd }, { write: false }).decision, "deny");
});

test("claudeTaskPermissionDecision denies Bash even on write tasks (no sandbox)", () => {
  assert.equal(claudeTaskPermissionDecision({ toolName: "Bash", toolInput: { command: "npm test" }, cwd: "/work" }, { write: true }).decision, "deny");
});

test("claudeTaskPermissionDecision write allows in-workspace edits, denies lexical escapes and unknown tools", () => {
  const cwd = "/work";
  assert.equal(claudeTaskPermissionDecision({ toolName: "Edit", toolInput: { file_path: "/work/src/a.mjs" }, cwd }, { write: true }).decision, "allow");
  assert.equal(claudeTaskPermissionDecision({ toolName: "Write", toolInput: { file_path: "/etc/passwd" }, cwd }, { write: true }).decision, "deny");
  assert.equal(claudeTaskPermissionDecision({ toolName: "Mystery", toolInput: {}, cwd }, { write: true }).decision, "deny");
});

test("claudeTaskPermissionDecision gates NotebookEdit on notebook_path (CLI sends notebook_path, not file_path)", () => {
  const cwd = "/work";
  assert.equal(
    claudeTaskPermissionDecision({ toolName: "NotebookEdit", toolInput: { notebook_path: "/work/nb.ipynb" }, cwd }, { write: true }).decision,
    "allow",
  );
  assert.equal(
    claudeTaskPermissionDecision({ toolName: "NotebookEdit", toolInput: { notebook_path: "/etc/nb.ipynb" }, cwd }, { write: true }).decision,
    "deny",
  );
  assert.equal(
    claudeTaskPermissionDecision({ toolName: "NotebookEdit", toolInput: { notebook_path: "/work/nb.ipynb" }, cwd }, { write: false }).decision,
    "deny",
  );
});

test("claudeTaskPermissionDecision denies an in-workspace symlink that escapes (real fixture)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "supermodels-claude-cwd-"));
  const outside = await mkdtemp(path.join(tmpdir(), "supermodels-claude-out-"));
  try {
    await symlink(outside, path.join(root, "link")); // /root/link -> /outside
    // A write to /root/link/evil.txt lexically looks in-workspace but realpaths outside.
    const d = claudeTaskPermissionDecision({ toolName: "Write", toolInput: { file_path: path.join(root, "link", "evil.txt") }, cwd: root }, { write: true });
    assert.equal(d.decision, "deny");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("writeClaudeTaskHook produces a settings file registering a PreToolUse hook", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supermodels-claude-hook-"));
  try {
    const { settingsPath, hookScriptPath } = await writeClaudeTaskHook({ dir, cwd: "/work", write: false });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const entry = settings.hooks.PreToolUse[0];
    assert.equal(entry.matcher, ".*");
    assert.ok(entry.hooks[0].command.includes(path.basename(hookScriptPath)));
    const mode = (await stat(hookScriptPath)).mode & 0o111;
    assert.ok(mode, "hook script must be executable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the generated hook script denies a write on a read-only task", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supermodels-claude-hook-"));
  try {
    const { hookScriptPath } = await writeClaudeTaskHook({ dir, cwd: "/work", write: false });
    const res = spawnSync(hookScriptPath, {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/work/a.txt" } }),
      encoding: "utf8",
    });
    const out = JSON.parse(res.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildClaudeCommand isolates and fail-closes claude task permissions", () => {
  const cmd = buildClaudeCommand({ mode: "task", write: false, settingsPath: "/tmp/s.json" });
  assert.ok(!cmd.args.includes("--allowedTools"), "must not use the coarse allow-list");
  assert.ok(!cmd.args.includes("bypassPermissions"), "must never bypass permissions");
  // isolation triple from B0 (verified on CLI 2.1.209):
  assert.deepEqual(cmd.args.slice(cmd.args.indexOf("--settings"), cmd.args.indexOf("--settings") + 2), ["--settings", "/tmp/s.json"]);
  assert.ok(cmd.args.includes("--setting-sources"));
  const ssIdx = cmd.args.indexOf("--setting-sources");
  assert.equal(cmd.args[ssIdx + 1], "");
  assert.deepEqual(cmd.args.slice(cmd.args.indexOf("--permission-mode"), cmd.args.indexOf("--permission-mode") + 2), ["--permission-mode", "dontAsk"]);
});

test("buildClaudeCommand refuses to build a task command without an isolated settings file (fail-closed)", () => {
  assert.throws(() => buildClaudeCommand({ mode: "task" }), /isolated settings/);
});

test("parseClaudeOutput surfaces permission_denials as provider events", () => {
  const stdout = [
    JSON.stringify({ type: "result", subtype: "success", result: "done",
      permission_denials: [{ tool_name: "Write", tool_use_id: "t1", tool_input: { file_path: "/etc/x" } }] }),
  ].join("\n");
  const parsed = parseClaudeOutput(stdout);
  const denial = parsed.events.find((e) => e.type === "permission-denied");
  assert.ok(denial, "a permission-denied event must be emitted");
  assert.match(denial.message, /Write/);
});

test("parseClaudeOutput handles both object-shaped and string-shaped permission_denials", () => {
  const objectShaped = parseClaudeOutput(JSON.stringify({
    type: "result",
    permission_denials: [{ tool_name: "Write", tool_input: { file_path: "/etc/x" } }],
  }));
  const objectDenial = objectShaped.events.find((e) => e.type === "permission-denied");
  assert.equal(objectDenial.message, "claude denied Write (/etc/x)");

  const stringShaped = parseClaudeOutput(JSON.stringify({
    type: "result",
    permission_denials: ["Write", "Bash"],
  }));
  const stringDenials = stringShaped.events.filter((e) => e.type === "permission-denied");
  assert.equal(stringDenials.length, 2);
  assert.equal(stringDenials[0].message, "claude denied Write");
  assert.equal(stringDenials[1].message, "claude denied Bash");
  assert.ok(!stringDenials.some((e) => /unknown tool/.test(e.message)), "distinct string denials must not collapse to \"unknown tool\"");
});

test("parseClaudeOutput includes notebook_path for a denied NotebookEdit (not only file_path)", () => {
  const parsed = parseClaudeOutput(JSON.stringify({
    type: "result",
    permission_denials: [{ tool_name: "NotebookEdit", tool_input: { notebook_path: "/work/nb.ipynb" } }],
  }));
  const denial = parsed.events.find((e) => e.type === "permission-denied");
  assert.equal(denial.message, "claude denied NotebookEdit (/work/nb.ipynb)");
});
