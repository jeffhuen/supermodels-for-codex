import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine, findExecutable, runCommand } from "../../lib/process.mjs";
import { runReviewAgent } from "../../lib/review-agent.mjs";
import { createReviewTools } from "../../lib/review-tools.mjs";
import { parseStructuredReviewText } from "../../lib/review-schema.mjs";
import { runGrokAcpTask } from "./acp-client.mjs";
import { GrokCredentials, readGrokClientVersion } from "./oauth.mjs";
import { GrokOAuthResponsesTransport } from "./responses-transport.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = JSON.parse(readFileSync(path.join(__dirname, "defaults.json"), "utf8"));
const DEFAULT_MODEL = process.env.SUPERMODELS_GROK_MODEL || DEFAULTS.defaultModel;
const DEFAULT_EFFORT = process.env.SUPERMODELS_GROK_EFFORT || DEFAULTS.defaultEffort;
// grok-4.5's 500K context window can absorb the most generous review budget
// on the panel, so large diffs truncate last and coverage enforcement
// survives longest. Double the review-tools library defaults (120_000/80_000).
const REVIEW_MAX_TOOL_BYTES = 240_000;
const REVIEW_MAX_FILE_BYTES = 160_000;

export function createGrokAdapter(factoryOptions = {}) {
  return {
    id: "grok",
    label: "Grok Build",
    capabilities: () => ({
      review: true,
      adversarialReview: true,
      task: true,
      writeTask: true,
      // v1: ACP sessions die with the process; revisit with session/load later.
      resume: false,
      nativeInterrupt: true,
      background: "worker",
    }),
    check: (options) => check(options, factoryOptions),
    review: (input, options) => runGrokReview(input, options, factoryOptions),
    task: runGrokTask,
  };
}

export async function check(options = {}, factoryOptions = {}) {
  const binPath = await findExecutable("grok", options);
  if (!binPath) {
    return {
      provider: "grok",
      label: "Grok Build",
      ready: false,
      installed: false,
      path: "",
      version: "",
      auth: "missing",
      error: "grok binary not found. Install Grok Build (https://x.ai/cli) and run `grok login`.",
    };
  }

  let version = await readGrokClientVersion(factoryOptions.versionOptions ?? {});
  if (!version) {
    const versionResult = await runCommand({ bin: binPath, args: ["--version"] }, { timeoutMs: 5000 });
    version = versionResult.stdout.trim().split(/\s+/)[1] ?? "";
  }

  let ready = true;
  let error = "";
  try {
    const credentials = factoryOptions.credentials
      ?? new GrokCredentials(factoryOptions.credentialsOptions ?? {});
    await credentials.accessToken();
  } catch (authError) {
    ready = false;
    error = authError?.message ?? String(authError);
  }

  return {
    provider: "grok",
    label: "Grok Build",
    ready,
    installed: true,
    path: binPath,
    version: version || "unknown",
    auth: ready ? "oauth" : "missing",
    error,
  };
}

export function buildGrokHeadlessCommand(options = {}) {
  const args = ["-p", options.prompt ?? "", "--output-format", "streaming-json", "--no-memory"];
  const model = resolveGrokModelAlias(options.model ?? DEFAULT_MODEL);
  const effort = options.effort ?? DEFAULT_EFFORT;
  if (model && model !== "cli-default") {
    args.push("-m", model);
  }
  if (effort && effort !== "cli-default") {
    args.push("--reasoning-effort", effort);
  }
  args.push("--sandbox", options.write ? "workspace" : "read-only");
  if (options.bestOfN) {
    args.push("--best-of-n", String(options.bestOfN));
  }
  // Only on explicit request: grok 0.2.x's headless --check verifier can end
  // the turn as Cancelled and swallow the final answer (verified live), so it
  // is never appended automatically.
  if (options.check) {
    args.push("--check");
  }
  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }
  if (options.worktree) {
    args.push("--worktree", ...(typeof options.worktree === "string" ? [options.worktree] : []));
  }
  return { bin: options.bin ?? "grok", args, stdin: false };
}

export function resolveGrokModelAlias(model) {
  if (!model) {
    return "";
  }
  return DEFAULTS.aliases[String(model).toLowerCase()] ?? model;
}

export function parseGrokHeadlessOutput(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).filter((line) => line.trim());
  let parsedAny = false;
  let sessionId = "";
  let stopReason = "";
  let usage = null;
  const textParts = [];
  const events = [];

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
      parsedAny = true;
    } catch {
      continue;
    }

    if (event.type === "text") {
      textParts.push(String(event.data ?? ""));
    } else if (event.type === "thought") {
      events.push({ type: "thinking", message: String(event.data ?? "").slice(0, 200) });
    } else if (event.type === "end") {
      stopReason = event.stopReason ?? "";
      sessionId = event.sessionId ?? "";
      usage = event.usage ?? null;
    }
  }

  if (!parsedAny) {
    const text = String(stdout ?? "").trim();
    return {
      sessionId: "",
      text,
      structured: parseStructuredReviewText(text),
      usage: null,
      events: [],
      stopReason: "",
    };
  }

  const text = textParts.join("");
  return {
    sessionId,
    text,
    structured: parseStructuredReviewText(text),
    usage,
    events,
    stopReason,
  };
}

async function runGrokTask(input, options = {}) {
  const model = resolveGrokModelAlias(options.model ?? DEFAULT_MODEL);
  const effort = options.effort ?? DEFAULT_EFFORT;

  if (options.bestOfN || options.check || options.jsonSchema || options.worktree) {
    return await runGrokHeadlessTask(input, options, model, effort);
  }

  return await runGrokAcpTask(input, {
    ...options,
    model,
    effort,
    write: Boolean(options.write),
  });
}

async function runGrokHeadlessTask(input, options, model, effort) {
  const startedAt = new Date().toISOString();
  const command = buildGrokHeadlessCommand({
    bin: options.bin,
    prompt: input.prompt,
    model,
    effort,
    write: Boolean(options.write),
    bestOfN: options.bestOfN,
    check: options.check,
    jsonSchema: options.jsonSchema,
    worktree: options.worktree,
  });
  const streamParser = createGrokStreamEventParser(options.onEvent);
  const result = await runCommand(command, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
    controller: options.controller,
    signalKillMs: options.signalKillMs,
    onStart: options.onStart,
    onStdout: (chunk) => streamParser.push(chunk),
  });
  streamParser.end();
  const parsed = parseGrokHeadlessOutput(result.stdout);

  return {
    provider: "grok",
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
    stopReason: parsed.stopReason,
  };
}

async function runGrokReview(input, options = {}, factoryOptions = {}) {
  const startedAt = new Date().toISOString();
  const model = resolveGrokModelAlias(options.model ?? DEFAULT_MODEL);
  const effort = options.effort ?? DEFAULT_EFFORT;
  const transport = factoryOptions.reviewTransport
    ?? new GrokOAuthResponsesTransport({
      credentials: factoryOptions.credentials ?? new GrokCredentials(factoryOptions.credentialsOptions ?? {}),
      fetchImpl: factoryOptions.fetchImpl,
    });
  const tools = factoryOptions.reviewTools
    ?? createReviewTools({
      workspaceRoot: options.cwd,
      scope: input.context?.scope,
      baseRef: input.context?.baseRef,
      controller: options.controller,
      maxToolBytes: REVIEW_MAX_TOOL_BYTES,
      maxFileBytes: REVIEW_MAX_FILE_BYTES,
    });
  const structured = await runReviewAgent({
    provider: "grok",
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
    provider: "grok",
    exitCode: 0,
    signal: null,
    timedOut: false,
    rawText: JSON.stringify(structured, null, 2),
    stderr: "",
    sessionId: "",
    pid: null,
    commandLine: "grok oauth responses",
    structured,
    usage: structured.usage ?? null,
    reviewConfig: structured.reviewConfig ?? {
      provider: "grok",
      model,
      effort: effort === "cli-default" ? "" : effort,
      maxTokens: null,
      rounds: null,
      toolUsage: {},
    },
    events: [],
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

function createGrokStreamEventParser(onEvent) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        emitGrokLine(line, onEvent);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    end() {
      emitGrokLine(buffer.trim(), onEvent);
      buffer = "";
    },
  };
}

function emitGrokLine(line, onEvent) {
  if (!line || !onEvent) {
    return;
  }
  try {
    const event = JSON.parse(line);
    for (const providerEvent of grokProviderEvents(event)) {
      onEvent(providerEvent);
    }
  } catch {
    // Plain text fallback is parsed after process exit.
  }
}

function grokProviderEvents(event) {
  const at = new Date().toISOString();
  const events = [];
  const type = event?.type ?? "";
  if (type === "text") {
    events.push({ type: "text", message: "Grok Build is working", at });
  }
  if (type === "thought") {
    events.push({ type: "thinking", message: String(event.data ?? "").slice(0, 200), at });
  }
  if (type === "tool_call" || type === "tool_use") {
    events.push({ type: "tool_call", message: "Grok Build is inspecting", at });
  }
  if (type === "end") {
    events.push({ type: "finish", message: "Grok Build completed", at, usage: event.usage });
  }
  if (type === "error") {
    events.push({ type: "error", message: event.error?.message || event.message || "Grok stream error", at });
  }
  return events;
}
