#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseRuntimeArgs, resolveProviderIds } from "./lib/args.mjs";
import { buildBackgroundChildArgs, markBackgroundJobRunning } from "./lib/background.mjs";
import { findExecutable, signalProcessTree } from "./lib/process.mjs";
import { signalJobProcesses } from "./lib/provider-pids.mjs";
import {
  checkProviders,
  getStatus,
  markCancelled,
  renderHumanResult,
  runReview,
  runTask,
  setupProviders,
} from "./lib/runtime.mjs";
import { createJob, createState, readJob, updateJob } from "./lib/state.mjs";
import { createAntigravityAdapter } from "./providers/antigravity/adapter.mjs";
import { createClaudeAdapter } from "./providers/claude/adapter.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const adapters = {
  claude: createClaudeAdapter(),
  antigravity: createAntigravityAdapter(),
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

  if (parsed.options.live && parsed.options.background) {
    throw new Error("Use either --live or --background, not both.");
  }
  if (parsed.options.live && parsed.options.json) {
    throw new Error("--live cannot be combined with --json.");
  }
  if (parsed.options.live) {
    const output = await runLiveReview({
      parsed,
      providerSelection,
      focus,
    });
    writeOutput(parsed, output, renderHumanResult(output));
    return;
  }

  if (parsed.options.background) {
    const job = await startBackgroundJob({
      command: parsed.command,
      options: parsed.options,
      positionals: parsed.positionals,
      providerSelection,
      payload: { focus },
    });
    writeOutput(parsed, job, [
      `Started Supermodels background job ${job.id}`,
      `Requested providers: ${providerSelection.requested.join(", ")}`,
      `Status: node ${SCRIPT_PATH} status ${job.id}`,
      `Watch: node ${SCRIPT_PATH} watch ${job.id}`,
    ].join("\n"));
    return;
  }

  const output = await runReview({
    adapters,
    providerSelection,
    mode: parsed.command,
    options: parsed.options,
    focus,
    workspaceRoot: process.cwd(),
  });
  writeOutput(parsed, output, renderHumanResult(output));
}

async function runLiveReview({ parsed, providerSelection, focus }) {
  const workspaceRoot = process.cwd();
  const state = createState({
    workspaceRoot,
    dataRoot: parsed.options["data-root"],
  });
  const job = await createJob(state, {
    command: parsed.command,
    mode: parsed.command,
    requestedProviders: providerSelection.requested,
    background: false,
    live: true,
    focus,
  });
  writeText(`Started Supermodels live ${parsed.command} ${job.id}\n`);
  const cleanupAbortHandlers = installLiveAbortHandlers({ state, jobId: job.id });

  try {
    const runPromise = runReview({
      adapters,
      providerSelection,
      mode: parsed.command,
      options: {
        ...parsed.options,
        background: false,
        live: false,
        "job-id": job.id,
      },
      focus,
      workspaceRoot,
    });

    await watchLiveProgress({
      state,
      jobId: job.id,
      runPromise,
      intervalMs: Math.max(1, Number(parsed.options.interval || 5)) * 1000,
      heartbeatMs: 60 * 1000,
    });

    return await runPromise;
  } finally {
    cleanupAbortHandlers();
  }
}

async function handleTask(parsed) {
  const providerSelection = resolveProviderIds(parsed.options);
  const task = parsed.positionals.join(" ").trim();
  if (!task) {
    throw new Error("task requires a task description.");
  }
  if (parsed.options.write && providerSelection.requested.length > 1) {
    throw new Error("Refusing multi-provider --write task in v1. Pick --provider claude or --provider antigravity.");
  }

  if (parsed.options.background) {
    const job = await startBackgroundJob({
      command: "task",
      options: parsed.options,
      positionals: parsed.positionals,
      providerSelection,
      payload: { task },
    });
    writeOutput(parsed, job, [
      `Started Supermodels background job ${job.id}`,
      `Requested providers: ${providerSelection.requested.join(", ")}`,
      `Status: node ${SCRIPT_PATH} status ${job.id}`,
      `Watch: node ${SCRIPT_PATH} watch ${job.id}`,
    ].join("\n"));
    return;
  }

  const output = await runTask({
    adapters,
    providerSelection,
    options: parsed.options,
    task,
    workspaceRoot: process.cwd(),
  });
  writeOutput(parsed, output, renderHumanResult(output));
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
  const intervalMs = Math.max(1, Number(parsed.options.interval || 10)) * 1000;
  const maxWaitMs = Math.max(1, Number(parsed.options["max-wait"] || 600)) * 1000;
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
    await sleep(intervalMs);
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
  const job = await readJob(state, jobId);
  signalJobProcesses(job, { signal: "SIGTERM", signaler: signalProcessTree });
  const output = await markCancelled({
    workspaceRoot: process.cwd(),
    dataRoot: parsed.options["data-root"],
    jobId,
  });
  await sleep(1500);
  signalJobProcesses(job, { signal: "SIGKILL", signaler: signalProcessTree });
  writeOutput(parsed, output, `Cancelled Supermodels job ${jobId}`);
}

async function startBackgroundJob(input) {
  const state = createState({
    workspaceRoot: process.cwd(),
    dataRoot: input.options["data-root"],
  });
  const job = await createJob(state, {
    command: input.command,
    mode: input.command,
    requestedProviders: input.providerSelection.requested,
    background: true,
    ...input.payload,
  });
  const childArgs = buildBackgroundChildArgs({
    scriptPath: SCRIPT_PATH,
    command: input.command,
    options: input.options,
    jobId: job.id,
    positionals: input.positionals,
  });
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      SUPERMODELS_WORKSPACE_ROOT: state.workspaceRoot,
    },
    stdio: "ignore",
  });
  child.unref();
  return await updateJob(state, job.id, (current) => markBackgroundJobRunning(current, child.pid));
}

function installLiveAbortHandlers({ state, jobId }) {
  let active = true;
  let handling = false;
  const cleanup = () => {
    if (!active) {
      return;
    }
    active = false;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    cleanup();
    handleLiveAbort({ state, jobId, signal }).finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return cleanup;
}

async function handleLiveAbort({ state, jobId, signal }) {
  const job = await readJob(state, jobId).catch(() => null);
  if (job) {
    signalJobProcesses(job, { signal: "SIGTERM", signaler: signalProcessTree });
  }
  await updateJob(state, jobId, (current) => ({
    ...current,
    status: "cancelled",
    completedAt: new Date().toISOString(),
    cancellation: {
      signal,
      at: new Date().toISOString(),
    },
  })).catch(() => null);
  if (job) {
    await sleep(1500);
    signalJobProcesses(job, { signal: "SIGKILL", signaler: signalProcessTree });
  }
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
  return jobs.map((job) => `${job.id}: ${job.status} ${job.request?.command ?? ""} ${job.createdAt} ${providerProgressSummary(job)}`).join("\n");
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
  const completed = runs.filter((run) => run.status === "completed").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const invalid = runs.filter((run) => run.status === "invalid-output").length;
  return `${completed}/${runs.length} providers completed${failed ? `, ${failed} failed` : ""}${invalid ? `, ${invalid} invalid` : ""}`;
}

function providerLabel(provider) {
  return {
    claude: "Claude Code",
    antigravity: "Antigravity",
  }[provider] ?? provider;
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
  review [--all|--provider claude,antigravity] [--live|--background] [focus]
  adversarial-review [--all|--provider claude,antigravity] [--model MODEL] [--effort xhigh|max] [--live|--background] [focus]
  task [--provider claude|antigravity] [--write] [--background] <task>
  status [job-id] [--json]
  watch <job-id> [--interval seconds] [--max-wait seconds]
  result <job-id> [--json]
  cancel <job-id> [--json]

Provider v1 scope: claude and antigravity only.`;
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
