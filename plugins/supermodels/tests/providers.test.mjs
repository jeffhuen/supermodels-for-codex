import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildClaudeCommand,
  createClaudeAdapter,
  parseClaudeOutput,
} from "../scripts/providers/claude/adapter.mjs";
import {
  createAntigravityAdapter,
  buildAntigravityCommand,
  parseAntigravitySessionMetadata,
  resolveAntigravityModelAlias,
} from "../scripts/providers/antigravity/adapter.mjs";
import {
  grokAcpPermissionDecision,
  runGrokAcpTask,
} from "../scripts/providers/grok/acp-client.mjs";
import {
  buildGrokHeadlessCommand,
  createGrokAdapter,
  parseGrokHeadlessOutput,
} from "../scripts/providers/grok/adapter.mjs";

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-grok-acp.mjs", import.meta.url));
const nodeSpawnFakeAgent = (mode) => (bin, args, opts) =>
  spawn(process.execPath, [FAKE_ACP], { ...opts, env: { ...opts.env, FAKE_ACP_MODE: mode } });

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
    "assumptions",
    "verification_gaps",
  ]);
});

test("buildClaudeCommand constrains read-only review and task sessions", () => {
  const command = buildClaudeCommand({ mode: "review" });
  assert(command.args.includes("--allowedTools"));
  assert(command.args.includes("Read,Grep,Glob,LS"));
  assert.deepEqual(
    command.args.slice(command.args.indexOf("--permission-mode"), command.args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "plan"],
  );
  assert(!command.args.includes("--no-session-persistence"));

  const task = buildClaudeCommand({ mode: "task" });
  assert(task.args.includes("--allowedTools"));
  assert(task.args.includes("Read,Grep,Glob,LS"));
});

test("buildClaudeCommand leaves write tasks write-capable", () => {
  const command = buildClaudeCommand({ mode: "task", write: true });
  assert(command.args.includes("--allowedTools"));
  assert(command.args.includes("Read,Grep,Glob,LS,Edit,MultiEdit,Write"));
  assert.deepEqual(
    command.args.slice(command.args.indexOf("--permission-mode"), command.args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "acceptEdits"],
  );
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

test("grokAcpPermissionDecision picks reject for read-only and allow for write", () => {
  const params = {
    options: [
      { optionId: "allow-edits-session", kind: "allow_always" },
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  };
  assert.equal(grokAcpPermissionDecision(params, { write: false }), "reject-once");
  assert.equal(grokAcpPermissionDecision(params, { write: true }), "allow-edits-session");
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
    prompt: "do it", model: "grok-4.5", effort: "high", bestOfN: 3, jsonSchema: { type: "object" },
  });
  assert.equal(command.bin, "grok");
  assert.deepEqual(command.args, [
    "-p", "do it", "--output-format", "streaming-json",
    "-m", "grok-4.5", "--reasoning-effort", "high",
    "--sandbox", "read-only", "--best-of-n", "3",
    "--json-schema", '{"type":"object"}',
  ]);
  const writeCommand = buildGrokHeadlessCommand({
    prompt: "fix", write: true, model: "cli-default", effort: "cli-default", worktree: "feat-x",
  });
  assert.ok(writeCommand.args.includes("workspace"));
  assert.ok(writeCommand.args.includes("--check"));
  assert.ok(writeCommand.args.includes("--worktree"));
  assert.ok(writeCommand.args.includes("feat-x"));
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
  return {
    content: [{ type: "tool_use", id, name, input }],
    tool_calls: [{ id, name, input }],
    text: "",
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
