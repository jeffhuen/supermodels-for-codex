import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine, findExecutable, runCommand } from "../../lib/process.mjs";
import { runReviewAgent } from "../../lib/review-agent.mjs";
import { createReviewTools } from "../../lib/review-tools.mjs";
import {
  REVIEW_RESULT_SCHEMA,
  parseStructuredReviewText,
} from "../../lib/review-schema.mjs";
import { ClaudeCodeCredentials } from "./oauth.mjs";
import { ClaudeOAuthMessagesTransport } from "./messages-transport.mjs";
import {
  writeClaudeTaskHook,
  READ_TASK_TOOL_NAMES,
  EDIT_TASK_TOOL_NAMES,
} from "./task-permissions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = JSON.parse(readFileSync(path.join(__dirname, "defaults.json"), "utf8"));
const DEFAULT_MODEL = process.env.SUPERMODELS_CLAUDE_MODEL || DEFAULTS.defaultModel;
const DEFAULT_EFFORT = process.env.SUPERMODELS_CLAUDE_EFFORT || DEFAULTS.defaultEffort;
const READ_ONLY_TOOLS = "Read,Grep,Glob,LS";

export function createClaudeAdapter(factoryOptions = {}) {
  return {
    id: "claude",
    label: "Claude Code",
    capabilities: () => ({
      review: true,
      adversarialReview: true,
      task: true,
      writeTask: true,
      resume: true,
      nativeInterrupt: false,
      background: "worker",
    }),
    check: (options) => check(options, factoryOptions),
    review: (input, options) => runClaudeReview(input, options, factoryOptions),
    task: runClaudePrompt,
  };
}

export async function check(options = {}, factoryOptions = {}) {
  const binPath = await findExecutable("claude", options);
  if (!binPath) {
    return {
      provider: "claude",
      label: "Claude Code",
      ready: false,
      installed: false,
      path: "",
      version: "",
      auth: "missing",
      error: "claude binary not found. Install Claude Code and run `claude auth login`.",
    };
  }

  const version = await runCommand({ bin: binPath, args: ["--version"] }, { timeoutMs: 5000 });
  const auth = await runCommand({ bin: binPath, args: ["auth", "status"] }, { timeoutMs: 5000 });
  const authInfo = parseClaudeAuth(auth.stdout);
  const cliReady = auth.exitCode === 0 && authInfo.loggedIn !== false;
  let ready = cliReady;
  let error = cliReady ? "" : "Claude Code is installed but not authenticated.";
  if (cliReady) {
    try {
      const credentials = factoryOptions.credentials
        ?? new ClaudeCodeCredentials(factoryOptions.credentialsOptions ?? {});
      await credentials.accessToken();
    } catch (directAuthError) {
      ready = false;
      error = [
        "Claude Code OAuth credentials are not usable for direct reviews.",
        "Run `claude auth login` to refresh Claude Code auth, then rerun `$supermodels:setup`.",
        directAuthError?.message ? `Details: ${directAuthError.message}` : "",
      ].filter(Boolean).join(" ");
    }
  }

  return {
    provider: "claude",
    label: "Claude Code",
    ready,
    installed: true,
    path: binPath,
    version: version.stdout.trim() || "unknown",
    auth: ready ? authInfo.authMethod || "ok" : "missing",
    subscriptionType: authInfo.subscriptionType || "",
    error: ready ? "" : error,
  };
}

export function buildClaudeCommand(options = {}) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  const model = resolveClaudeModelAlias(options.model ?? DEFAULT_MODEL);
  const effort = options.effort ?? DEFAULT_EFFORT;

  if (model && model !== "cli-default") {
    args.push("--model", model);
  }
  if (effort && effort !== "cli-default") {
    args.push("--effort", effort);
  }
  if (isReviewMode(options)) {
    // Reviews stay read-only via the coarse allow-list + plan mode. They never
    // touch the workspace, and the direct Messages transport does the real work.
    args.push("--allowedTools", READ_ONLY_TOOLS);
    args.push("--permission-mode", "plan");
    args.push("--json-schema", JSON.stringify(REVIEW_RESULT_SCHEMA));
  }
  if (isTaskMode(options)) {
    // Tasks (read-only AND write) are gated per-call by the broker's isolated,
    // fail-closed PreToolUse hook. The generated settings file is the SOLE
    // permission authority: `--setting-sources ""` excludes user/project/local
    // sources, and `--permission-mode dontAsk` denies anything the hook does not
    // explicitly allow. Write vs read-only authority lives in the hook script's
    // embedded policy, not in argv.
    if (!options.settingsPath) {
      throw new Error("refusing to build a Claude task command without an isolated settings file (fail-closed)");
    }
    args.push("--settings", options.settingsPath);
    args.push("--setting-sources", "");
    args.push("--permission-mode", "dontAsk");
    // The hook does per-call path-scoping of edits, but it is not sufficient on
    // its own: `--permission-mode dontAsk` auto-allows read-only Bash, so a
    // missing/crashing/malformed/timed-out hook fails OPEN to shell execution.
    // `--tools` is the coarse availability bound that closes that fail-open — it
    // makes Bash (and, in read-only mode, the edit tools) unavailable regardless
    // of hook health, and it composes with the hook (it bounds availability
    // without pre-approving). NEVER emit `--allowedTools` (it pre-approves and
    // would void the hook's path-scoping) or `bypassPermissions`.
    const taskTools = options.write
      ? [...READ_TASK_TOOL_NAMES, ...EDIT_TASK_TOOL_NAMES]
      : READ_TASK_TOOL_NAMES;
    args.push("--tools", ...taskTools);
  }
  if (options.resume) {
    args.push("--resume", options.resume);
  }
  if (options.name) {
    args.push("--name", options.name);
  }

  return {
    bin: options.bin ?? "claude",
    args,
    stdin: true,
  };
}

export function resolveClaudeModelAlias(model) {
  if (!model) {
    return "";
  }
  return DEFAULTS.aliases[String(model).toLowerCase()] ?? model;
}

export function parseClaudeOutput(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).filter((line) => line.trim());
  let parsedAny = false;
  let sessionId = "";
  const text = [];
  const events = [];
  let usage = null;
  let structured = null;
  const seenText = new Set();
  const addText = (value) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed || seenText.has(trimmed)) {
      return;
    }
    seenText.add(trimmed);
    text.push(trimmed);
  };

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
      parsedAny = true;
    } catch {
      continue;
    }

    sessionId ||= event.session_id || event.sessionId || event.session?.id || "";
    usage = event.usage || event.message?.usage || usage;
    if (event.structured_output && typeof event.structured_output === "object") {
      structured = event.structured_output;
    }
    events.push(...claudeProviderEvents(event));

    // Surface every broker denial to the user through the persisted provider
    // `events` channel. A bare top-level field would be dropped by
    // normalizeProviderResult (runtime.mjs), so each denial becomes an event.
    if (Array.isArray(event.permission_denials)) {
      const at = new Date().toISOString();
      for (const denial of event.permission_denials) {
        const toolName = typeof denial === "string" ? denial : (denial?.tool_name ?? "unknown tool");
        const filePath = typeof denial === "string" ? "" : (denial?.tool_input?.file_path ?? denial?.tool_input?.notebook_path ?? "");
        const detail = filePath ? ` (${filePath})` : "";
        events.push({
          type: "permission-denied",
          message: `claude denied ${toolName}${detail}`,
          at,
        });
      }
    }

    if (typeof event.result === "string") {
      addText(event.result);
    }
    if (typeof event.content === "string") {
      addText(event.content);
    }
    const messageContent = event.message?.content;
    if (Array.isArray(messageContent)) {
      for (const part of messageContent) {
        if (typeof part?.text === "string") {
          addText(part.text);
        }
      }
    } else if (typeof messageContent === "string") {
      addText(messageContent);
    }
  }

  if (!parsedAny) {
    return {
      sessionId: "",
      text: String(stdout ?? "").trim(),
      structured: parseStructuredReviewText(stdout),
      usage: null,
      events: [],
    };
  }

  const finalText = text.join("\n").trim();
  return {
    sessionId,
    text: finalText,
    structured: structured ?? parseStructuredReviewText(finalText),
    usage,
    events,
  };
}

async function runClaudePrompt(input, options = {}) {
  const startedAt = new Date().toISOString();
  // Broker an isolated, fail-closed PreToolUse hook for this task. Its temp
  // settings file is the sole permission authority for the run; we never mutate
  // the user's repo/global .claude config. Cleaned up in the finally below even
  // on throw/timeout so no broker settings survive the process.
  const hookDir = await mkdtemp(path.join(tmpdir(), "supermodels-claude-hook-"));
  let settingsPath, cleanup;
  try {
    ({ settingsPath, cleanup } = await writeClaudeTaskHook({
      dir: hookDir,
      cwd: options.cwd,
      write: Boolean(options.write),
    }));
  } catch (err) {
    await rm(hookDir, { recursive: true, force: true });
    throw err;
  }
  try {
    const command = buildClaudeCommand({
      bin: options.bin,
      model: options.model,
      effort: options.effort,
      // runClaudePrompt is exclusively the task implementation. Force task mode
      // at the boundary so a caller passing a missing/misspelled input.mode can
      // never skip the isolation triple + --tools gating (which would run the
      // task wide open). Never forward input.mode here.
      mode: "task",
      write: Boolean(options.write),
      settingsPath,
      resume: options.resume,
      name: options.name ?? "supermodels-task",
    });
    const streamParser = createClaudeStreamEventParser(options.onEvent);
    const result = await runCommand(command, {
      cwd: options.cwd,
      input: input.prompt,
      timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
      controller: options.controller,
      signalKillMs: options.signalKillMs,
      onStart: options.onStart,
      onStdout: (chunk) => streamParser.push(chunk),
    });
    streamParser.end();
    const parsed = parseClaudeOutput(result.stdout);

    return {
      provider: "claude",
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      timedOut: result.timedOut ?? false,
      rawText: parsed.text || result.stdout,
      stderr: result.stderr,
      sessionId: parsed.sessionId,
      pid: result.pid ?? null,
      commandLine: commandLine(command),
      structured: parsed.structured,
      usage: parsed.usage,
      events: parsed.events,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } finally {
    await cleanup();
  }
}

async function runClaudeReview(input, options = {}, factoryOptions = {}) {
  const startedAt = new Date().toISOString();
  const model = resolveClaudeModelAlias(options.model ?? DEFAULT_MODEL);
  const effort = options.effort ?? DEFAULT_EFFORT;
  const transport = factoryOptions.reviewTransport
    ?? new ClaudeOAuthMessagesTransport({
      credentials: factoryOptions.credentials ?? new ClaudeCodeCredentials(factoryOptions.credentialsOptions ?? {}),
      fetchImpl: factoryOptions.fetchImpl,
    });
  const tools = factoryOptions.reviewTools
    ?? createReviewTools({
      workspaceRoot: options.cwd,
      scope: input.context?.scope,
      baseRef: input.context?.baseRef,
      controller: options.controller,
    });
  const structured = await runReviewAgent({
    provider: "claude",
    transport,
    tools,
    brief: input.prompt,
    focus: input.focus,
    mode: input.mode,
    model,
    effort,
    maxRounds: factoryOptions.maxRounds,
    forceAfterRounds: factoryOptions.forceAfterRounds,
    forceAfterSatisfiedRounds: factoryOptions.forceAfterSatisfiedRounds,
    forceInspectionTools: factoryOptions.forceInspectionTools,
    preloadTools: factoryOptions.preloadTools ?? ["get_review_context"],
    timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
    controller: options.controller,
    onEvent: options.onEvent,
  });
  return {
    provider: "claude",
    exitCode: 0,
    signal: null,
    timedOut: false,
    rawText: JSON.stringify(structured, null, 2),
    stderr: "",
    sessionId: "",
    pid: null,
    commandLine: "claude oauth messages",
    structured,
    usage: structured.usage ?? null,
    reviewConfig: structured.reviewConfig ?? {
      provider: "claude",
      model,
      effort: effort === "cli-default" ? "" : effort,
      maxTokens: null,
      thinking: null,
      rounds: null,
      toolUsage: {},
    },
    events: [],
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

function parseClaudeAuth(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout.trim() ? { authMethod: stdout.trim() } : {};
  }
}

export async function hasClaudeNativeSessionStore() {
  const dir = path.join(process.env.HOME ?? "", ".claude", "projects");
  try {
    const info = await stat(dir);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function isTaskMode(options = {}) {
  return options.mode === "task";
}

function isReviewMode(options = {}) {
  return options.mode === "review" || options.mode === "adversarial-review";
}

function createClaudeStreamEventParser(onEvent) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        emitLine(line, onEvent);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    end() {
      emitLine(buffer.trim(), onEvent);
      buffer = "";
    },
  };
}

function emitLine(line, onEvent) {
  if (!line || !onEvent) {
    return;
  }
  try {
    const event = JSON.parse(line);
    for (const providerEvent of claudeProviderEvents(event)) {
      onEvent(providerEvent);
    }
  } catch {
    // Plain text fallback is parsed after process exit.
  }
}

function claudeProviderEvents(event) {
  const at = new Date().toISOString();
  const events = [];
  const type = event?.type ?? "";
  if (type === "system") {
    events.push({
      type: "session",
      message: "Claude Code started",
      at,
    });
  }
  if (type === "assistant") {
    const content = event.message?.content;
    const textParts = Array.isArray(content)
      ? content.filter((part) => typeof part?.text === "string").length
      : typeof content === "string"
        ? 1
        : 0;
    const toolCalls = Array.isArray(content)
      ? content.filter((part) => part?.type === "tool_use" || part?.name).length
      : 0;
    if (textParts) {
      events.push({ type: "text", message: "Claude Code is working", at });
    }
    if (toolCalls) {
      events.push({ type: "tool_call", message: "Claude Code is inspecting", at });
    }
  }
  if (type === "result") {
    events.push({ type: "finish", message: "Claude Code completed", at, usage: event.usage });
  }
  if (type === "error") {
    events.push({ type: "error", message: event.error?.message || "Claude stream error", at });
  }
  return events;
}
