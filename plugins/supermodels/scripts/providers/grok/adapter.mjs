import { readFileSync } from "node:fs";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine, findExecutable, runCommand } from "../../lib/process.mjs";
import { withAbortTimeout } from "../../lib/abort.mjs";
import { runReviewAgent } from "../../lib/review-agent.mjs";
import { createSnapshotReviewTools } from "../../lib/review-tools.mjs";
import { parseStructuredReviewText } from "../../lib/review-schema.mjs";
import { runGrokAcpTask } from "./acp-client.mjs";
import { GrokCredentials, readGrokClientVersion } from "./oauth.mjs";
import { GrokOAuthResponsesTransport } from "./responses-transport.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = JSON.parse(readFileSync(path.join(__dirname, "defaults.json"), "utf8"));
const DEFAULT_MODEL = process.env.SUPERMODELS_GROK_MODEL || DEFAULTS.defaultModel;
const DEFAULT_EFFORT = process.env.SUPERMODELS_GROK_EFFORT || DEFAULTS.defaultEffort;
// grok-4.5's 500K context window can absorb the most generous per-page review
// budget on the panel, so large reviews require fewer lossless diff cursors.
// Double the review-tools library defaults (120_000/80_000).
const REVIEW_MAX_TOOL_BYTES = 240_000;
const REVIEW_MAX_FILE_BYTES = 160_000;
const REVIEW_MAX_TOKENS = 64_000;
const POST_EVIDENCE_INSPECTION_ROUNDS = 4;
const REVIEW_SYSTEM_INSTRUCTIONS = Object.freeze([Object.freeze({
  type: "text",
  text: "You are Grok Build reviewing for Codex. Be direct and adversarial toward the diff, but ground every claim in inspected repository evidence.",
})]);

export const providerDefinition = Object.freeze({
  id: "grok",
  aliases: Object.freeze([]),
  label: "Grok Build",
  create: createGrokAdapter,
});

export function createGrokAdapter(factoryOptions = {}) {
  return {
    id: providerDefinition.id,
    label: providerDefinition.label,
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

export function resolveGrokReviewPolicy(options = {}) {
  const requestedEffort = options.effort ?? DEFAULT_EFFORT;
  const effort = requestedEffort === "cli-default" ? null : requestedEffort;
  return {
    maxTokens: options.maxTokens ?? REVIEW_MAX_TOKENS,
    reasoningOptions: effort ? { reasoning_effort: effort } : {},
    strictSubmit: false,
    cacheControl: false,
    allowForcedToolChoice: true,
    forceAfterSatisfiedRounds: options.forceAfterSatisfiedRounds
      ?? POST_EVIDENCE_INSPECTION_ROUNDS,
    systemInstructions: REVIEW_SYSTEM_INSTRUCTIONS,
    auditMetadata: {
      effort: effort ?? "",
    },
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

  const versionResult = await runCommand({ bin: binPath, args: ["--version"] }, { timeoutMs: 5000 });
  if (versionResult.exitCode !== 0 || versionResult.timedOut) {
    return {
      provider: "grok",
      label: "Grok Build",
      ready: false,
      installed: true,
      path: binPath,
      version: "unknown",
      auth: "missing",
      error: `Grok Build is installed but \`grok --version\` failed: ${versionResult.stderr || versionResult.stdout || "no version output"}`,
    };
  }

  let version = "";
  try {
    version = await withAbortTimeout(
      (signal) => readGrokClientVersion({
        ...(factoryOptions.versionOptions ?? {}),
        signal,
      }),
      options.versionTimeoutMs ?? 5_000,
      "Grok version readiness check",
    );
  } catch {
    // The native CLI is the authoritative fallback when the cache is absent,
    // malformed, or cannot be read within the readiness budget.
  }
  version ||= versionResult.stdout.trim().split(/\s+/)[1] ?? "";

  let ready = true;
  let error = "";
  try {
    const credentials = factoryOptions.credentials
      ?? new GrokCredentials(factoryOptions.credentialsOptions ?? {});
    await withAbortTimeout(
      (signal) => credentials.accessToken({ signal }),
      options.credentialTimeoutMs ?? 10_000,
      "Grok credential readiness check",
    );
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
  if (!options.promptFile) {
    throw new Error("Grok headless mode requires a prompt file path.");
  }
  const args = ["--prompt-file", options.promptFile, "--output-format", "streaming-json", "--no-memory"];
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
  if (options.jsonSchema !== undefined) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }
  // Boolean only: Grok auto-names the worktree. Supermodels does not accept a
  // worktree name (a bare `--worktree <name>` would otherwise leak the name
  // into the task prompt as a positional).
  if (options.worktree) {
    args.push("--worktree");
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
  const promptFile = await writeGrokPromptFile(input.prompt, options);
  try {
    const command = buildGrokHeadlessCommand({
      bin: options.bin,
      promptFile,
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
  } finally {
    // Best-effort cleanup on completion or error: the prompt can carry
    // private context, so it must not linger on disk once the run is done.
    await unlink(promptFile).catch(() => {});
  }
}

// Mirrors the antigravity adapter's writePromptFile: a 0700 directory and a
// 0600 file so the rendered prompt (which can include private context) never
// transits argv/ps and is readable only by the invoking user.
async function writeGrokPromptFile(prompt, options = {}) {
  const promptDir = options.promptDir
    ? path.resolve(options.promptDir)
    : path.join(os.tmpdir(), "supermodels-prompts");
  await mkdir(promptDir, { recursive: true, mode: 0o700 });
  await chmod(promptDir, 0o700).catch(() => {});
  const promptPath = path.join(promptDir, "provider-grok.prompt.md");
  await writeFile(promptPath, String(prompt ?? ""), { mode: 0o600 });
  return promptPath;
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
    ?? createSnapshotReviewTools({
      workspaceRoot: options.cwd,
      snapshot: options.snapshot,
      scope: input.context?.scope,
      baseRef: input.context?.baseRef,
      controller: options.controller,
      maxToolBytes: REVIEW_MAX_TOOL_BYTES,
      maxFileBytes: REVIEW_MAX_FILE_BYTES,
    });
  const reviewPolicy = resolveGrokReviewPolicy({
    effort,
    maxTokens: options.maxTokens ?? factoryOptions.maxTokens,
    forceAfterSatisfiedRounds: options.forceAfterSatisfiedRounds
      ?? factoryOptions.forceAfterSatisfiedRounds,
  });
  const structured = await runReviewAgent({
    provider: "grok",
    transport,
    tools,
    brief: input.prompt,
    focus: input.focus,
    mode: input.mode,
    model,
    reviewPolicy,
    maxRounds: factoryOptions.maxRounds,
    forceAfterRounds: factoryOptions.forceAfterRounds,
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
