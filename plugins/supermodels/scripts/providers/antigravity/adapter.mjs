import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine, findExecutable, runCommand } from "../../lib/process.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_CONFIG = JSON.parse(readFileSync(path.join(__dirname, "model-aliases.json"), "utf8"));
const MODEL_ALIASES = Object.freeze(MODEL_CONFIG.aliases);
const DEFAULT_REVIEW_MODEL = process.env.SUPERMODELS_ANTIGRAVITY_REVIEW_MODEL
  || MODEL_CONFIG.defaultReviewModel
  || "";

const CANONICAL_MODELS = new Set(Object.values(MODEL_ALIASES));

export function createAntigravityAdapter() {
  return {
    id: "antigravity",
    label: "Google Antigravity",
    capabilities: () => ({
      review: true,
      adversarialReview: true,
      task: true,
      writeTask: true,
      resume: true,
      nativeInterrupt: false,
      background: "worker",
    }),
    check,
    setup,
    review: runAntigravityPrompt,
    task: runAntigravityPrompt,
  };
}

export async function setup(options = {}) {
  const status = await check(options);
  return {
    ready: status.ready,
    changed: false,
    source: "cli",
    error: status.error,
  };
}

export async function check(options = {}) {
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
  const auth = await antigravityAuthStatus(options);
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

async function antigravityAuthStatus(options = {}) {
  const env = options.env ?? process.env;
  if (env.ANTIGRAVITY_API_KEY) {
    return "api-key";
  }
  const home = env.HOME || os.homedir();

  const candidates = [
    path.join(home, ".config", "antigravity"),
    path.join(home, ".gemini", "antigravity-cli"),
  ];
  for (const candidate of candidates) {
    if (await hasAntigravityConfigMarker(candidate)) {
      return "local-config";
    }
  }

  return "missing";
}

async function hasAntigravityConfigMarker(configRoot) {
  const info = await stat(configRoot).catch(() => null);
  if (!info?.isDirectory()) {
    return false;
  }
  const markers = [
    "antigravity-oauth-token",
    "settings.json",
    path.join("cache", "onboarding.json"),
    path.join("cache", "projects.json"),
  ];
  for (const marker of markers) {
    const markerInfo = await stat(path.join(configRoot, marker)).catch(() => null);
    if (markerInfo?.isFile()) {
      return true;
    }
  }

  const conversations = await readdir(path.join(configRoot, "conversations")).catch(() => []);
  return conversations.some((entry) => /\.(db|pb)$/i.test(entry));
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
