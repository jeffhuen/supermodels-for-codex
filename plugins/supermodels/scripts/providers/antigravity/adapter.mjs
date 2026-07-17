import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine, findExecutable, runCommand } from "../../lib/process.mjs";
import { withAbortTimeout } from "../../lib/abort.mjs";
import { runReviewAgent } from "../../lib/review-agent.mjs";
import { createSnapshotReviewTools } from "../../lib/review-tools.mjs";
import { AntigravityCodeAssistTransport } from "./code-assist-transport.mjs";
import { AntigravityCredentials } from "./oauth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_CONFIG = JSON.parse(readFileSync(path.join(__dirname, "model-aliases.json"), "utf8"));
const MODEL_ALIASES = Object.freeze(MODEL_CONFIG.aliases);
const DEFAULT_REVIEW_MODEL = process.env.SUPERMODELS_ANTIGRAVITY_REVIEW_MODEL
  || MODEL_CONFIG.defaultReviewModel
  || "";
const DEFAULT_CODE_ASSIST_REVIEW_MODEL = process.env.SUPERMODELS_ANTIGRAVITY_CODE_ASSIST_MODEL
  || MODEL_CONFIG.defaultReviewModel
  || "Gemini 3.5 Flash (High)";
const REVIEW_MAX_TOKENS = 64_000;
const DEFAULT_THINKING_BUDGET = -1;
const POST_EVIDENCE_INSPECTION_ROUNDS = 4;
const REVIEW_SYSTEM_INSTRUCTIONS = Object.freeze([Object.freeze({
  type: "text",
  text: "You are Antigravity reviewing for Codex. Use broad systems judgment, but ground every claim in inspected repository evidence.",
})]);

const CANONICAL_MODELS = new Set(Object.values(MODEL_ALIASES));

export const providerDefinition = Object.freeze({
  id: "antigravity",
  aliases: Object.freeze(["agy"]),
  label: "Google Antigravity",
  create: createAntigravityAdapter,
});

export function createAntigravityAdapter(factoryOptions = {}) {
  return {
    id: providerDefinition.id,
    label: providerDefinition.label,
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
    review: (input, options) => runAntigravityReview(input, options, factoryOptions),
    task: runAntigravityPrompt,
  };
}

export function resolveAntigravityReviewPolicy(options = {}) {
  const parsedBudget = Number(options.thinkingBudget ?? DEFAULT_THINKING_BUDGET);
  const mode = options.mode ?? "review";
  const reasoningOptions = Number.isFinite(parsedBudget)
    ? { thinkingBudget: parsedBudget }
    : {};
  return {
    maxTokens: options.maxTokens ?? REVIEW_MAX_TOKENS,
    reasoningOptions,
    strictSubmit: false,
    cacheControl: false,
    allowForcedToolChoice: true,
    forceAfterSatisfiedRounds: options.forceAfterSatisfiedRounds
      ?? (mode === "review"
        ? POST_EVIDENCE_INSPECTION_ROUNDS
        : Number.POSITIVE_INFINITY),
    systemInstructions: REVIEW_SYSTEM_INSTRUCTIONS,
    auditMetadata: {
      thinkingBudget: reasoningOptions.thinkingBudget ?? null,
    },
  };
}

export async function check(options = {}, factoryOptions = {}) {
  const binPath = await findExecutable("agy", options);
  if (!binPath) {
    return {
      provider: "antigravity",
      label: "Google Antigravity",
      ready: false,
      installed: false,
      path: "",
      version: "",
      auth: "missing",
      error: "agy binary not found. Install Antigravity CLI and run `agy` once interactively.",
    };
  }

  const version = await runCommand({ bin: binPath, args: ["--version"] }, { timeoutMs: 5000 });
  if (version.exitCode !== 0 || version.timedOut) {
    return {
      provider: "antigravity",
      label: "Google Antigravity",
      ready: false,
      installed: true,
      path: binPath,
      version: "unknown",
      auth: "missing",
      error: `Antigravity CLI is installed but \`agy --version\` failed: ${version.stderr || version.stdout || "no version output"}`,
    };
  }
  const auth = await antigravityAuthStatus(options, factoryOptions);
  const ready = auth !== "missing";

  return {
    provider: "antigravity",
    label: "Google Antigravity",
    ready,
    installed: true,
    path: binPath,
    version: version.stdout.trim() || "unknown",
    auth,
    error: ready ? "" : "Antigravity CLI is installed but no local auth/config was detected.",
  };
}

export function buildAntigravityCommand(options = {}) {
  if (!options.promptPath) {
    throw new Error("Antigravity print mode requires a prompt path.");
  }

  const args = [
    "-p",
    `Read the Supermodels prompt from this file and follow it exactly: ${options.promptPath}`,
  ];
  const model = resolveAntigravityModelAlias(options.model ?? defaultModelForMode(options.mode));
  if (isReadOnlyMode(options)) {
    args.push("--sandbox");
  }
  if (model) {
    args.push("--model", model);
  }
  args.push("--print-timeout", options.printTimeout ?? "20m");
  if (options.resume) {
    args.push("--conversation", options.resume);
  }
  if (options.logFile) {
    args.push("--log-file", options.logFile);
  }

  return {
    bin: options.bin ?? "agy",
    args,
    stdin: false,
  };
}

export function resolveAntigravityModelAlias(model) {
  if (!model || model === "cli-default") {
    return "";
  }
  if (CANONICAL_MODELS.has(model)) {
    return model;
  }
  const resolved = MODEL_ALIASES[String(model).toLowerCase()];
  if (!resolved) {
    throw new Error(`Unknown Antigravity model '${model}'. Update the provider-local alias table if this is a new model.`);
  }
  return resolved;
}

export function parseAntigravitySessionMetadata(stdout, options = {}) {
  if (!options.trusted) {
    return { sessionId: "" };
  }
  const text = String(stdout ?? "");
  const patterns = [
    /\bCreated conversation\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
    /\bconversation[_ -]?id\s*[:=]\s*([A-Za-z0-9._:-]+)/i,
    /\bsession[_ -]?id\s*[:=]\s*([A-Za-z0-9._:-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return { sessionId: match[1] };
    }
  }
  return { sessionId: "" };
}

async function runAntigravityPrompt(input, options = {}) {
  const startedAt = new Date().toISOString();
  const promptPath = await writePromptFile(input.prompt, options);
  const logFile = await antigravityLogFile(options);
  const command = buildAntigravityCommand({
    bin: options.bin,
    model: options.model,
    mode: input.mode,
    write: Boolean(options.write),
    resume: options.resume,
    promptPath,
    logFile,
  });
  const result = await runCommand(command, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
    controller: options.controller,
    signalKillMs: options.signalKillMs,
    onStart: options.onStart,
  });
  await chmod(logFile, 0o600).catch(() => {});
  const logText = await readFile(logFile, "utf8").catch(() => "");
  const parsed = parseAntigravitySessionMetadata(`${result.stderr}\n${logText}`, { trusted: true });

  return {
    provider: "antigravity",
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut ?? false,
    rawText: result.stdout.trim(),
    stderr: result.stderr,
    sessionId: parsed.sessionId,
    pid: result.pid ?? null,
    commandLine: commandLine(command),
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

async function runAntigravityReview(input, options = {}, factoryOptions = {}) {
  const startedAt = new Date().toISOString();
  const model = resolveAntigravityCodeAssistModel(options.model);
  const transport = factoryOptions.reviewTransport
    ?? new AntigravityCodeAssistTransport({
      credentials: factoryOptions.credentials ?? new AntigravityCredentials(factoryOptions.credentialsOptions ?? {}),
      fetchImpl: factoryOptions.fetchImpl,
      projectId: factoryOptions.projectId,
      baseUrl: factoryOptions.baseUrl,
    });
  const tools = factoryOptions.reviewTools
    ?? createSnapshotReviewTools({
      workspaceRoot: options.cwd,
      snapshot: options.snapshot,
      scope: input.context?.scope,
      baseRef: input.context?.baseRef,
      controller: options.controller,
    });
  const reviewPolicy = resolveAntigravityReviewPolicy({
    mode: input.mode,
    thinkingBudget: options.thinkingBudget ?? factoryOptions.thinkingBudget,
    maxTokens: options.maxTokens ?? factoryOptions.maxTokens,
    forceAfterSatisfiedRounds: options.forceAfterSatisfiedRounds
      ?? factoryOptions.forceAfterSatisfiedRounds,
  });
  const structured = await runReviewAgent({
    provider: "antigravity",
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
    provider: "antigravity",
    exitCode: 0,
    signal: null,
    timedOut: false,
    rawText: JSON.stringify(structured, null, 2),
    stderr: "",
    sessionId: "",
    pid: null,
    commandLine: "agy code-assist messages",
    structured,
    usage: structured.usage ?? null,
    reviewConfig: structured.reviewConfig ?? {
      provider: "antigravity",
      model,
      maxTokens: null,
      thinkingBudget: null,
      rounds: null,
      toolUsage: {},
    },
    events: [],
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

function resolveAntigravityCodeAssistModel(model) {
  const candidate = (!model || model === "cli-default")
    ? DEFAULT_CODE_ASSIST_REVIEW_MODEL
    : model;
  const lower = String(candidate).toLowerCase();
  const directAliases = {
    flash: "gemini-3-flash-preview",
    "flash-high": "gemini-3-flash-preview",
    "gemini 3.5 flash (low)": "gemini-3-flash-preview",
    "gemini 3.5 flash (medium)": "gemini-3-flash-preview",
    "gemini 3.5 flash (high)": "gemini-3-flash-preview",
  };
  if (directAliases[lower]) {
    return directAliases[lower];
  }
  if (/^gemini-[\w.-]+$/i.test(candidate)) {
    return candidate;
  }
  return resolveAntigravityModelAlias(candidate);
}

async function antigravityLogFile(options = {}) {
  const promptDir = options.promptDir
    ? path.resolve(options.promptDir)
    : path.join(os.tmpdir(), "supermodels-prompts");
  await mkdir(promptDir, { recursive: true, mode: 0o700 });
  await chmod(promptDir, 0o700).catch(() => {});
  return path.join(promptDir, "provider-antigravity.log");
}

async function writePromptFile(prompt, options = {}) {
  const promptDir = options.promptDir
    ? path.resolve(options.promptDir)
    : path.join(os.tmpdir(), "supermodels-prompts");
  await mkdir(promptDir, { recursive: true, mode: 0o700 });
  await chmod(promptDir, 0o700).catch(() => {});
  const promptPath = path.join(promptDir, "provider-antigravity.prompt.md");
  await writeFile(promptPath, String(prompt ?? ""), { mode: 0o600 });
  return promptPath;
}

async function antigravityAuthStatus(options = {}, factoryOptions = {}) {
  const env = options.env ?? process.env;
  return await canLoadAntigravityCredentials(env, {
    ...factoryOptions,
    credentialTimeoutMs: options.credentialTimeoutMs ?? factoryOptions.credentialTimeoutMs,
  }) ? "local-oauth" : "missing";
}

async function canLoadAntigravityCredentials(env, factoryOptions = {}) {
  try {
    const credentials = factoryOptions.credentials ?? new AntigravityCredentials({
      ...(factoryOptions.credentialsOptions ?? {}),
      env,
    });
    await withAbortTimeout(
      (signal) => credentials.accessToken({ signal }),
      factoryOptions.credentialTimeoutMs ?? 10_000,
      "Antigravity credential readiness check",
    );
    return true;
  } catch {
    return false;
  }
}

function defaultModelForMode(mode) {
  if (mode === "review" || mode === "adversarial-review") {
    return DEFAULT_REVIEW_MODEL;
  }
  return "";
}

function isReadOnlyMode(options = {}) {
  return options.mode === "review"
    || options.mode === "adversarial-review"
    || (options.mode === "task" && !options.write);
}
