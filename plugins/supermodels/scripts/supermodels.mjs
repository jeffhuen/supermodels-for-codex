#!/usr/bin/env node
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseRuntimeArgs, resolveProviderIds } from "./lib/args.mjs";
import { cancelJob } from "./lib/cancellation.mjs";
import {
  buildReviewRequest,
  buildTaskRequest,
  installWorkerCancelHandlers,
  outputFromJob,
  runStoredWorkerJob,
  startWorkerJob,
  waitForWorker,
} from "./lib/job-lifecycle.mjs";
import { findExecutable, signalProcessTree } from "./lib/process.mjs";
import { signalExitCode } from "./lib/run-control.mjs";
import {
  checkProviders,
  getStatus,
  renderHumanResult,
  runReview,
  runTask,
  setupProviders,
} from "./lib/runtime.mjs";
import { createJob, createState, readJob, updateJob } from "./lib/state.mjs";
import { decodeUtf8Prefix } from "./lib/text.mjs";
import { createAntigravityAdapter } from "./providers/antigravity/adapter.mjs";
import { createClaudeAdapter } from "./providers/claude/adapter.mjs";
import { createGrokAdapter } from "./providers/grok/adapter.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MAX_REVIEW_CONTEXT_BYTES = 200_000;

const adapters = {
  claude: createClaudeAdapter(),
  antigravity: createAntigravityAdapter(),
  grok: createGrokAdapter(),
};

async function main(argv = process.argv.slice(2)) {
  const parsed = parseRuntimeArgs(argv);

  if (parsed.options.help || parsed.command === "help" || parsed.command === "--help") {
    writeText(usage());
    return;
  }

  switch (parsed.command) {
    case "setup":
      await handleSetup(parsed);
      return;
    case "providers":
    case "doctor":
      await handleProviders(parsed);
      return;
    case "review":
    case "adversarial-review":
      await handleReview(parsed);
      return;
    case "task":
      await handleTask(parsed);
      return;
    case "worker":
      await handleWorker(parsed);
      return;
    case "status":
      await handleStatus(parsed);
      return;
    case "watch":
      await handleWatch(parsed);
      return;
    case "result":
      await handleResult(parsed);
      return;
    case "cancel":
      await handleCancel(parsed);
      return;
    default:
      throw new Error(`Unknown command '${parsed.command}'.\n\n${usage()}`);
  }
}

async function handleSetup(parsed) {
  const node = {
    ready: true,
    version: process.version,
  };
  const gitPath = await findExecutable("git");
  const git = {
    ready: Boolean(gitPath),
    path: gitPath,
  };
  const state = createState({
    workspaceRoot: process.cwd(),
    dataRoot: parsed.options["data-root"],
  });
  const setupResults = await setupProviders(adapters, {
    dataRoot: state.dataRoot,
  });
  const checks = Object.fromEntries(
    Object.entries(setupResults).map(([id, result]) => [id, result.check]),
  );
  const output = {
    ready: node.ready && Object.values(checks).some((provider) => provider.ready),
    node,
    git,
    dataRoot: state.dataRoot,
    workspaceState: state.root,
    providerSetup: Object.fromEntries(
      Object.entries(setupResults).map(([id, result]) => [id, result.setup]),
    ),
    providers: checks,
  };
  writeOutput(parsed, output, renderSetup(output));
}

async function handleProviders(parsed) {
  const state = createState({
    workspaceRoot: process.cwd(),
    dataRoot: parsed.options["data-root"],
  });
  const output = await checkProviders(adapters, {
    dataRoot: state.dataRoot,
  });
  writeOutput(parsed, output, renderProviders(output));
}

async function handleReview(parsed) {
  const providerSelection = resolveProviderIds(parsed.options);
  const focus = parsed.positionals.join(" ").trim();
  const contextBrief = await readReviewContext(parsed.options);
  const request = buildReviewRequest({
    command: parsed.command,
    options: parsed.options,
    providerSelection,
    focus,
    contextBrief,
    live: parsed.options.live,
    background: parsed.options.background,
  });

  if (parsed.options.live && parsed.options.background) {
    throw new Error("Use either --live or --background, not both.");
  }
  if (parsed.options.live && parsed.options.json) {
    throw new Error("--live cannot be combined with --json.");
  }
  if (parsed.options.live) {
    const output = await runLiveWorkerJob({
      parsed,
      request,
    });
    writeOutput(parsed, output, renderHumanResult(output));
    return;
  }

  if (parsed.options.background) {
    const job = await startBackgroundWorkerJob({ parsed, request });
    writeOutput(parsed, job, [
      `Started Supermodels background job ${job.id}`,
      `Requested providers: ${providerSelection.requested.join(", ")}`,
      `Status: node ${SCRIPT_PATH} status ${job.id}`,
      `Watch: node ${SCRIPT_PATH} watch ${job.id}`,
    ].join("\n"));
    return;
  }

  const output = await runForegroundWorkerJob({ parsed, request });
  writeOutput(parsed, output, renderHumanResult(output));
}

async function readReviewContext(options = {}) {
  const parts = [];
  if (options.context) {
    parts.push(String(options.context));
  }
  if (options["context-file"]) {
    const contextPath = path.resolve(process.cwd(), options["context-file"]);
    parts.push(await readContextFileWithinLimit(contextPath));
  }
  return limitReviewContext(parts.map((part) => part.trim()).filter(Boolean).join("\n\n"));
}

async function readContextFileWithinLimit(contextPath) {
  const handle = await open(contextPath, "r");
  try {
    const buffer = Buffer.alloc(MAX_REVIEW_CONTEXT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const text = decodeUtf8Prefix(buffer, Math.min(bytesRead, MAX_REVIEW_CONTEXT_BYTES));
    return bytesRead > MAX_REVIEW_CONTEXT_BYTES
      ? `${text}\n\n[Supermodels truncated review context to ${MAX_REVIEW_CONTEXT_BYTES} bytes.]`
      : text;
  } finally {
    await handle.close();
  }
}

function limitReviewContext(value) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= MAX_REVIEW_CONTEXT_BYTES) {
    return text;
  }
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > MAX_REVIEW_CONTEXT_BYTES) {
    end = Math.floor(end * 0.9);
  }
  return `${text.slice(0, end)}\n\n[Supermodels truncated review context to ${MAX_REVIEW_CONTEXT_BYTES} bytes.]`;
}

async function runLiveWorkerJob({ parsed, request }) {
  const workspaceRoot = process.cwd();
  const dataRoot = parsed.options["data-root"];
  const { state, job, child } = await startWorkerJob({
    scriptPath: SCRIPT_PATH,
    workspaceRoot,
    dataRoot,
    request,
  });
  writeText(`Started Supermodels live ${parsed.command} ${job.id}\n`);

  let exitCodeFromSignal = null;
  const cleanup = installWorkerCancelHandlers({
    state,
    workspaceRoot,
    dataRoot,
    jobId: job.id,
    signaler: signalProcessTree,
    sleep,
    onSignal: (signal) => {
      exitCodeFromSignal = signalExitCode(signal);
      process.exitCode = exitCodeFromSignal;
    },
  });
  const runPromise = waitForWorker(child);

  try {
    await watchLiveProgress({
      state,
      jobId: job.id,
      runPromise,
      intervalMs: positiveSecondsOption(parsed, "interval", 5) * 1000,
      heartbeatMs: 60 * 1000,
    });
  } finally {
    cleanup();
  }

  const close = await runPromise;
  if (!exitCodeFromSignal && close.code) {
    process.exitCode = close.code;
  }
  return outputFromJob(await getStatus({ workspaceRoot, dataRoot, jobId: job.id }));
}

async function handleTask(parsed) {
  const providerSelection = resolveProviderIds(parsed.options);
  const task = parsed.positionals.join(" ").trim();
  const contextBrief = await readReviewContext(parsed.options);
  if (!task) {
    throw new Error("task requires a task description.");
  }
  if (parsed.options.write && providerSelection.requested.length > 1) {
    throw new Error("Refusing multi-provider --write task in v1. Pick --provider claude or --provider antigravity.");
  }
  const request = buildTaskRequest({
    options: parsed.options,
    providerSelection,
    task,
    contextBrief,
    background: parsed.options.background,
  });

  if (parsed.options.background) {
    const job = await startBackgroundWorkerJob({ parsed, request });
    writeOutput(parsed, job, [
      `Started Supermodels background job ${job.id}`,
      `Requested providers: ${providerSelection.requested.join(", ")}`,
      `Status: node ${SCRIPT_PATH} status ${job.id}`,
      `Watch: node ${SCRIPT_PATH} watch ${job.id}`,
    ].join("\n"));
    return;
  }

  const output = await runForegroundWorkerJob({ parsed, request });
  writeOutput(parsed, output, renderHumanResult(output));
}

async function handleWorker(parsed) {
  const jobId = parsed.options["job-id"];
  if (!jobId) {
    throw new Error("worker requires --job-id.");
  }
  await runStoredWorkerJob({
    adapters,
    workspaceRoot: process.env.SUPERMODELS_WORKSPACE_ROOT || process.cwd(),
    dataRoot: parsed.options["data-root"],
    jobId,
    runReview,
    runTask,
  });
}

async function handleStatus(parsed) {
  const jobId = parsed.positionals[0] || parsed.options["job-id"] || "";
  const output = await getStatus({
    workspaceRoot: process.cwd(),
    dataRoot: parsed.options["data-root"],
    jobId,
  });
  writeOutput(parsed, output, Array.isArray(output) ? renderJobList(output) : renderJob(output));
}

async function handleResult(parsed) {
  const jobId = parsed.positionals[0] || parsed.options["job-id"];
  if (!jobId) {
    throw new Error("result requires a job id.");
  }
  const output = await getStatus({
    workspaceRoot: process.cwd(),
    dataRoot: parsed.options["data-root"],
    jobId,
  });
  writeOutput(parsed, output, renderJob(output, { includeArtifacts: true }));
}

async function handleWatch(parsed) {
  const jobId = parsed.positionals[0] || parsed.options["job-id"];
  if (!jobId) {
    throw new Error("watch requires a job id.");
  }
  const intervalMs = positiveSecondsOption(parsed, "interval", 10) * 1000;
  const maxWaitMs = positiveSecondsOption(parsed, "max-wait", 600) * 1000;
  const startedAt = Date.now();
  let lastText = "";

  while (true) {
    const job = await getStatus({
      workspaceRoot: process.cwd(),
      dataRoot: parsed.options["data-root"],
      jobId,
    });
    const text = renderJob(job);
    if (text !== lastText) {
      writeText(`${text}\n\n`);
      lastText = text;
    }
    if (["completed", "partial", "failed", "cancelled"].includes(job.status)) {
      return;
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      writeText(`Still running after ${Math.round(maxWaitMs / 1000)}s. Re-run status or result for ${jobId}.\n`);
      return;
    }
    await sleep(intervalMs);
  }
}

function positiveSecondsOption(parsed, name, fallback) {
  const raw = parsed.options[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number of seconds.`);
  }
  return value;
}

async function watchLiveProgress({ state, jobId, runPromise, intervalMs, heartbeatMs }) {
  let done = false;
  let error = null;
  runPromise.then(
    () => {
      done = true;
    },
    (caught) => {
      done = true;
      error = caught;
    },
  );

  let lastSignature = "";
  let lastHeartbeatAt = 0;
  while (!done) {
    const job = await readJob(state, jobId);
    const signature = liveSignature(job);
    const now = Date.now();
    const heartbeatDue = heartbeatMs > 0 && now - lastHeartbeatAt >= heartbeatMs;
    if (signature !== lastSignature || heartbeatDue) {
      writeText(`${renderLiveProgress(job, { now })}\n`);
      lastSignature = signature;
      lastHeartbeatAt = now;
    }
    if (done) {
      break;
    }
    await sleep(Math.min(intervalMs, 250));
  }

  if (error) {
    throw error;
  }

  const finalJob = await readJob(state, jobId);
  const finalSignature = liveSignature(finalJob);
  if (finalSignature !== lastSignature) {
    writeText(`${renderLiveProgress(finalJob, { now: Date.now() })}\n`);
  }
}

async function handleCancel(parsed) {
  const jobId = parsed.positionals[0] || parsed.options["job-id"];
  if (!jobId) {
    throw new Error("cancel requires a job id.");
  }

  const state = createState({
    workspaceRoot: process.cwd(),
    dataRoot: parsed.options["data-root"],
  });
  const result = await cancelJob({
    state,
    workspaceRoot: process.cwd(),
    dataRoot: parsed.options["data-root"],
    jobId,
    signaler: signalProcessTree,
    sleep,
  });
  writeOutput(parsed, result.job, result.text);
}

async function runForegroundWorkerJob({ parsed, request }) {
  const workspaceRoot = process.cwd();
  const dataRoot = parsed.options["data-root"];
  const { state, job, child } = await startWorkerJob({
    scriptPath: SCRIPT_PATH,
    workspaceRoot,
    dataRoot,
    request,
  });
  let exitCodeFromSignal = null;
  const cleanup = installWorkerCancelHandlers({
    state,
    workspaceRoot,
    dataRoot,
    jobId: job.id,
    signaler: signalProcessTree,
    sleep,
    onSignal: (signal) => {
      exitCodeFromSignal = signalExitCode(signal);
      process.exitCode = exitCodeFromSignal;
    },
  });
  try {
    const close = await waitForWorker(child);
    if (!exitCodeFromSignal && close.code) {
      process.exitCode = close.code;
    }
  } finally {
    cleanup();
  }
  return outputFromJob(await getStatus({ workspaceRoot, dataRoot, jobId: job.id }));
}

async function startBackgroundWorkerJob({ parsed, request }) {
  const { job } = await startWorkerJob({
    scriptPath: SCRIPT_PATH,
    workspaceRoot: process.cwd(),
    dataRoot: parsed.options["data-root"],
    request,
    unref: true,
  });
  return job;
}

function renderSetup(output) {
  const lines = ["Supermodels setup", ""];
  lines.push(`Ready: ${output.ready ? "yes" : "no"}`);
  lines.push(`Node: ${output.node.version}`);
  lines.push(`Git: ${output.git.ready ? output.git.path : "missing"}`);
  lines.push(`Data: ${output.dataRoot}`);
  lines.push("");
  lines.push(renderProviders(output.providers));
  const nextSteps = setupNextSteps(output.providers);
  if (nextSteps.length) {
    lines.push("", "Next steps:");
    lines.push(...nextSteps.map((step) => `- ${step}`));
  }
  return lines.join("\n");
}

function setupNextSteps(providers) {
  const steps = [];
  const claude = providers.claude;
  const antigravity = providers.antigravity;
  if (!claude?.ready) {
    steps.push("Install Claude Code and run `claude auth login`, then rerun `$supermodels:setup`.");
  }
  if (!antigravity?.ready) {
    steps.push("Install Antigravity CLI, run `agy` once interactively, then rerun `$supermodels:setup`.");
  }
  return steps;
}

function renderProviders(providers) {
  const lines = ["Providers:"];
  for (const provider of Object.values(providers)) {
    lines.push(`- ${provider.provider}: ${provider.ready ? "ready" : "not ready"} (${provider.version || "unknown"})`);
    if (provider.auth) {
      lines.push(`  auth: ${provider.auth}`);
    }
    if (provider.error) {
      lines.push(`  ${provider.error}`);
    }
  }
  return lines.join("\n");
}

function renderJobList(jobs) {
  if (!jobs.length) {
    return "No Supermodels jobs found for this workspace.";
  }
  return jobs.map((job) => {
    const context = job.contextPacket?.summary ? ` context: ${job.contextPacket.summary}` : "";
    return `${job.id}: ${job.status} ${job.request?.command ?? ""} ${job.createdAt} ${providerProgressSummary(job)}${context}`;
  }).join("\n");
}

function renderJob(job, options = {}) {
  const lines = [
    `Supermodels job ${job.id}: ${job.status}`,
    `Stage: ${job.stage ?? "queued"}`,
    `Created: ${job.createdAt}`,
  ];
  if (job.completedAt) {
    lines.push(`Completed: ${job.completedAt}`);
  }
  if (job.contextPacket?.summary) {
    lines.push(`Context packet: ${job.contextPacket.summary}`);
    if (options.includeArtifacts) {
      if (job.contextPacket.markdownPath) {
        lines.push(`Context packet markdown: ${job.contextPacket.markdownPath}`);
      }
      if (job.contextPacket.jsonPath) {
        lines.push(`Context packet JSON: ${job.contextPacket.jsonPath}`);
      }
    }
  }
  lines.push(`Progress: ${providerProgressSummary(job)}`);
  if (job.synthesis) {
    lines.push("", job.synthesis);
  }
  const runs = Object.values(job.providerRuns ?? {});
  if (runs.length) {
    lines.push("", "Provider progress:");
    for (const run of runs) {
      lines.push(`- ${providerLabel(run.provider)}: ${providerStatusText(run)}`);
      if (options.includeArtifacts) {
        if (run.rawResultPath) {
          lines.push(`  raw: ${run.rawResultPath}`);
        }
        if (run.normalizedResultPath) {
          lines.push(`  normalized: ${run.normalizedResultPath}`);
        }
        if (run.stderrPath) {
          lines.push(`  stderr: ${run.stderrPath}`);
        }
      }
    }
  } else if (job.request?.requestedProviders?.length) {
    lines.push("", "Provider progress:");
    for (const provider of job.request.requestedProviders) {
      lines.push(`- ${providerLabel(provider)}: queued - waiting for provider checks`);
    }
  }
  return lines.join("\n");
}

function renderLiveProgress(job, options = {}) {
  const now = options.now ?? Date.now();
  const providers = Object.values(job.providerRuns ?? {});
  const runs = providers.length
    ? providers
    : (job.request?.requestedProviders ?? []).map((provider) => ({
        provider,
        status: "queued",
      }));
  const providerText = runs
    .map((run) => `${providerLabel(run.provider)}: ${providerLiveStatus(run, now)}`)
    .join(" | ");
  return `${job.id} ${job.status}/${job.stage ?? "queued"} ${providerProgressSummary(job)} :: ${providerText}`;
}

function providerLiveStatus(run, now) {
  if (run.status === "queued") {
    return "queued";
  }
  if (run.status === "running") {
    const detail = run.lastEvent ? ` - ${run.lastEvent}` : "";
    return `running${run.startedAt ? ` ${formatElapsed(run.startedAt, now)}` : ""}${detail}`;
  }
  if (run.status === "completed") {
    const detail = run.lastEvent ? ` - ${run.lastEvent}` : "";
    return `completed${run.startedAt && run.completedAt ? ` ${formatDuration(run.startedAt, run.completedAt)}` : ""}${detail}`;
  }
  if (run.status === "failed") {
    return `failed${run.lastEvent ? ` - ${run.lastEvent}` : ""}`;
  }
  if (run.status === "invalid-output") {
    return `invalid output${run.lastEvent ? ` - ${run.lastEvent}` : ""}`;
  }
  if (run.status === "rate-limited") {
    return `rate limited${run.lastEvent ? ` - ${run.lastEvent}` : ""}`;
  }
  return run.status ?? "unknown";
}

function liveSignature(job) {
  const runs = Object.values(job.providerRuns ?? {});
  return [
    job.status,
    job.stage,
    ...runs.map((run) => [
      run.provider,
      run.status,
      run.startedAt ?? "",
      run.completedAt ?? "",
      run.exitCode ?? "",
      run.lastEvent ?? "",
    ].join(":")),
  ].join("|");
}

function formatElapsed(startedAt, now) {
  return formatSeconds(Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)));
}

function formatDuration(startedAt, completedAt) {
  return formatSeconds(Math.max(0, Math.floor((Date.parse(completedAt) - Date.parse(startedAt)) / 1000)));
}

function formatSeconds(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function providerProgressSummary(job) {
  const runs = Object.values(job.providerRuns ?? {});
  if (!runs.length) {
    const total = job.request?.requestedProviders?.length ?? 0;
    return total ? `0/${total} providers completed` : "no providers selected";
  }
  const hasChallengeRuns = runs.some((run) => run.phase === "cross-challenge" || String(run.provider ?? "").includes("-challenge-"));
  const completed = runs.filter((run) => run.status === "completed").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const invalid = runs.filter((run) => run.status === "invalid-output").length;
  const rateLimited = runs.filter((run) => run.status === "rate-limited").length;
  const noun = hasChallengeRuns ? "review runs" : "providers";
  return `${completed}/${runs.length} ${noun} completed${failed ? `, ${failed} failed` : ""}${invalid ? `, ${invalid} invalid` : ""}${rateLimited ? `, ${rateLimited} rate-limited` : ""}`;
}

function providerLabel(provider) {
  const challenge = parseChallengeProvider(provider);
  if (challenge) {
    const targets = challenge.targets.map((target) => providerLabel(target)).join(", ");
    return `${providerLabel(challenge.source)} challenging ${targets}`;
  }
  return {
    claude: "Claude Code",
    antigravity: "Antigravity",
  }[provider] ?? provider;
}

function parseChallengeProvider(provider) {
  const value = String(provider ?? "");
  const marker = "-challenge-";
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const source = value.slice(0, markerIndex);
  const targetValue = value.slice(markerIndex + marker.length);
  if (!source || !targetValue) {
    return null;
  }
  return {
    source,
    targets: targetValue.split("-").filter(Boolean),
  };
}

function providerStatusText(run) {
  if (run.status === "queued") {
    return "queued - waiting to start";
  }
  if (run.status === "running") {
    return `running - ${run.lastEvent || `calling ${providerLabel(run.provider)}`}${run.startedAt ? ` since ${run.startedAt}` : ""}`;
  }
  if (run.status === "completed") {
    const detail = run.lastEvent ? ` - ${run.lastEvent}` : "";
    return `completed${run.sessionId ? `, session ${run.sessionId}` : ", session not exposed"}${detail}`;
  }
  if (run.status === "failed") {
    return `failed${run.stderrPath ? `, see ${run.stderrPath}` : ""}`;
  }
  if (run.status === "invalid-output") {
    return `invalid output${run.rawResultPath ? `, raw ${run.rawResultPath}` : ""}`;
  }
  if (run.status === "rate-limited") {
    return `rate limited${run.stderrPath ? `, see ${run.stderrPath}` : ""}`;
  }
  return run.status ?? "unknown";
}

function writeOutput(parsed, jsonValue, textValue) {
  if (parsed.options.json) {
    writeText(`${JSON.stringify(jsonValue, null, 2)}\n`);
  } else {
    writeText(`${textValue}\n`);
  }
}

function writeText(text) {
  process.stdout.write(text);
}

function usage() {
  return `Supermodels for Codex

Commands:
  setup [--json]
  providers [--json]
  review [--all|--provider claude,antigravity,grok] [--base REF] [--context-file PATH] [--live|--background] [focus]
  adversarial-review [--all|--provider claude,antigravity,grok] [--base REF] [--context-file PATH] [--model MODEL] [--effort xhigh|max] [--live|--background] [focus]
  task [--provider claude|antigravity|grok] [--write] [--background] <task>
  status [job-id] [--json]
  watch <job-id> [--interval seconds] [--max-wait seconds]
  result <job-id> [--json]
  cancel <job-id> [--json]

Supported providers: claude, antigravity, grok.`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markFailedJobFromArgv(error, argv = process.argv.slice(2)) {
  const jobId = optionValue(argv, "job-id");
  if (!jobId) {
    return;
  }
  const state = createState({
    workspaceRoot: process.env.SUPERMODELS_WORKSPACE_ROOT || process.cwd(),
    dataRoot: optionValue(argv, "data-root"),
  });
  const message = error?.message || String(error);
  await updateJob(state, jobId, (current) => {
    if (["cancelled", "completed", "partial", "failed"].includes(current.status)) {
      return current;
    }
    return {
      ...current,
      status: "failed",
      stage: "failed",
      completedAt: new Date().toISOString(),
      error: message,
    };
  });
}

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === `--${name}`) {
      return argv[index + 1] ?? "";
    }
    if (typeof token === "string" && token.startsWith(prefix)) {
      return token.slice(prefix.length);
    }
  }
  return "";
}

try {
  await main();
} catch (error) {
  await markFailedJobFromArgv(error).catch(() => {});
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
