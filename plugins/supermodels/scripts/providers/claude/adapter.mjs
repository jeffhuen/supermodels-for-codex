import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = JSON.parse(readFileSync(path.join(__dirname, "defaults.json"), "utf8"));
const DEFAULT_MODEL = process.env.SUPERMODELS_CLAUDE_MODEL || DEFAULTS.defaultModel;
const DEFAULT_EFFORT = process.env.SUPERMODELS_CLAUDE_EFFORT || DEFAULTS.defaultEffort;
const READ_ONLY_TOOLS = "Read,Grep,Glob,LS";
const WRITE_TASK_TOOLS = "Read,Grep,Glob,LS,Edit,MultiEdit,Write";

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
  if (isWriteTaskMode(options)) {
    args.push("--allowedTools", WRITE_TASK_TOOLS);
    args.push("--permission-mode", "acceptEdits");
  }
  if (isReadOnlyMode(options)) {
    args.push("--allowedTools", READ_ONLY_TOOLS);
    args.push("--permission-mode", "plan");
  }
  if (isReviewMode(options)) {
    args.push("--json-schema", JSON.stringify(REVIEW_RESULT_SCHEMA));
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
  const command = buildClaudeCommand({
    bin: options.bin,
    model: options.model,
    effort: options.effort,
    mode: input.mode,
    write: Boolean(options.write),
    resume: options.resume,
    name: options.name ?? `supermodels-${input.mode ?? "task"}`,
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
}

async function runClaudeReview(input, options = {}, factoryOptions = {}) {
  const startedAt = new Date().toISOString();
  const model = resolveClaudeModelAlias(options.model ?? DEFAULT_MODEL);
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
    maxRounds: factoryOptions.maxRounds,
    forceAfterRounds: factoryOptions.forceAfterRounds,
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

function isReadOnlyMode(options = {}) {
  return options.mode === "review"
    || options.mode === "adversarial-review"
    || (options.mode === "task" && !options.write);
}

function isWriteTaskMode(options = {}) {
  return options.mode === "task" && options.write === true;
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
