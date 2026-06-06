import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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

test("buildClaudeCommand defaults review effort to high", () => {
  const command = buildClaudeCommand({ model: "opus" });
  assert.deepEqual(command.args.slice(-4), ["--model", "claude-opus-4-8", "--effort", "high"]);
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
      async messages(body) {
        firstRequest ??= body;
        return directToolResponse("submit_1", "submit_review", {
          verdict: "clean",
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

  assert.equal(result.structured.verdict, "clean");
  assert.deepEqual(executed, ["get_review_context"]);
  assert.match(JSON.stringify(firstRequest.messages), /Codex preloaded/);
});

test("Antigravity model aliases keep review defaults on Flash High and typo-like aliases fail", () => {
  assert.equal(resolveAntigravityModelAlias("pro"), "Gemini 3.5 Flash (High)");
  assert.equal(
    resolveAntigravityModelAlias("Gemini 3.5 Flash (High)"),
    "Gemini 3.5 Flash (High)",
  );
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
  const command = buildAntigravityCommand({ model: "pro", promptPath: "/tmp/supermodels-prompt.md" });
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

test("Antigravity check refreshes expired credentials through native agy", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-agy-native-refresh-"));
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
      "const fs = require('node:fs');",
      "if (process.argv.includes('--version')) { console.log('1.2.3-test'); process.exit(0); }",
      "if (process.argv[2] === 'models') {",
      "  fs.writeFileSync(process.env.ANTIGRAVITY_OAUTH_CREDS_PATH, JSON.stringify({ token: { access_token: 'new-access', refresh_token: 'refresh', expiry: '2099-01-01T00:00:00.000Z' }, auth_method: 'consumer' }));",
      "  console.log('Gemini 3.5 Flash (High)');",
      "}",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const adapter = createAntigravityAdapter();
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

test("Antigravity direct reviews default to a Code Assist model id", async () => {
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

  assert.equal(seenModel, "gemini-2.5-pro");
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
