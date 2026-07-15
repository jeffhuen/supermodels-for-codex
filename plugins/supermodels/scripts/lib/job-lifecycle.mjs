import { spawn } from "node:child_process";

import { cancelJob } from "./cancellation.mjs";
import { processStartedAt, signalProcessTree } from "./process.mjs";
import { createJob, createState, readJob, updateJob } from "./state.mjs";

const TERMINAL_STATUSES = new Set(["cancelled", "completed", "failed", "partial"]);

export function buildReviewRequest({ command, options, providerSelection, focus, contextBrief = "", live = false, background = false }) {
  return {
    command,
    mode: command,
    providerSelection,
    requestedProviders: providerSelection.requested,
    options: workerOptions(options),
    focus,
    contextBrief,
    live: Boolean(live),
    background: Boolean(background),
  };
}

export function buildTaskRequest({ options, providerSelection, task, contextBrief = "", background = false }) {
  return {
    command: "task",
    mode: "task",
    providerSelection,
    requestedProviders: providerSelection.requested,
    options: workerOptions(options),
    task,
    contextBrief,
    write: Boolean(options.write),
    background: Boolean(background),
  };
}

export async function startWorkerJob({ scriptPath, workspaceRoot, dataRoot, request, unref = false }) {
  const state = createState({ workspaceRoot, dataRoot });
  const job = await createJob(state, {
    command: request.command,
    mode: request.mode,
    requestedProviders: request.requestedProviders,
    providerSelection: request.providerSelection,
    background: request.background,
    live: request.live,
    focus: request.focus,
    contextBrief: request.contextBrief,
    task: request.task,
    write: request.write,
    options: request.options,
  });
  const child = spawnWorker({ scriptPath, state, job });
  if (unref) {
    child.unref();
  }
  const started = await attachWorkerPid(state, job.id, child.pid);
  return {
    state,
    job: started,
    child,
  };
}

export async function runStoredWorkerJob({ adapters, workspaceRoot, dataRoot, jobId, runReview, runTask }) {
  const state = createState({ workspaceRoot, dataRoot });
  const job = await readJob(state, jobId);
  const request = job.request ?? {};
  const providerSelection = request.providerSelection;
  if (!providerSelection?.requested?.length) {
    throw new Error(`Stored job ${jobId} is missing provider selection.`);
  }
  const options = {
    ...(request.options ?? {}),
    background: false,
    live: false,
    "job-id": jobId,
    "data-root": dataRoot,
  };

  if (request.command === "review" || request.command === "adversarial-review") {
    return await runReview({
      adapters,
      providerSelection,
      mode: request.mode ?? request.command,
      options,
      focus: request.focus ?? "",
      contextBrief: request.contextBrief ?? "",
      workspaceRoot,
    });
  }

  if (request.command === "task") {
    return await runTask({
      adapters,
      providerSelection,
      options,
      task: request.task ?? "",
      contextBrief: request.contextBrief ?? "",
      workspaceRoot,
    });
  }

  throw new Error(`Stored job ${jobId} has unsupported command '${request.command}'.`);
}

export function waitForWorker(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export function installWorkerCancelHandlers({
  state,
  workspaceRoot,
  dataRoot,
  jobId,
  signaler = signalProcessTree,
  sleep,
  onSignal,
}) {
  let handling = false;
  const handleSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    onSignal?.(signal);
    cancelJob({
      state,
      workspaceRoot,
      dataRoot,
      jobId,
      signaler,
      sleep,
    }).catch(() => {});
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

// Foreground/live CLI runs must exit nonzero when the job did not succeed, so
// CI and scripts don't read a failed or partial review as a pass. Terminal
// success is "completed"; "cancelled" keeps the shell's signal-based exit code.
export function exitCodeForJobStatus(status) {
  return status === "failed" || status === "partial" ? 1 : 0;
}

export function outputFromJob(job) {
  const request = job.request ?? {};
  const runs = Object.values(job.providerRuns ?? {});
  return {
    job,
    checks: {},
    selected: request.selectedProviders ?? request.providerSelection?.requested ?? request.requestedProviders ?? [],
    skipped: request.skippedProviders ?? [],
    results: runs.map((run) => run.normalized).filter(Boolean),
    synthesis: job.synthesis ?? "",
  };
}

function spawnWorker({ scriptPath, state, job }) {
  return spawn(process.execPath, [
    scriptPath,
    "worker",
    "--job-id",
    job.id,
    "--data-root",
    state.dataRoot,
  ], {
    cwd: state.workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      SUPERMODELS_WORKSPACE_ROOT: state.workspaceRoot,
    },
    stdio: "ignore",
    windowsHide: true,
  });
}

async function attachWorkerPid(state, jobId, pid) {
  const workerPid = Number(pid);
  if (!Number.isFinite(workerPid) || workerPid <= 0) {
    return await updateJob(state, jobId, (current) => markWorkerStartFailed(current, "Worker process did not expose a PID."));
  }
  const pidStartedAt = await processStartedAt(workerPid);
  return await updateJob(state, jobId, (current) => {
    if (TERMINAL_STATUSES.has(current.status)) {
      return current;
    }
    return {
      ...current,
      pid: workerPid,
      pidStartedAt,
      stage: "worker-starting",
    };
  });
}

function markWorkerStartFailed(job, message) {
  if (TERMINAL_STATUSES.has(job.status)) {
    return job;
  }
  return {
    ...job,
    status: "failed",
    stage: "failed",
    completedAt: new Date().toISOString(),
    error: message,
  };
}

function workerOptions(options = {}) {
  const next = { ...options };
  delete next.background;
  delete next.live;
  delete next.json;
  delete next["job-id"];
  delete next.context;
  delete next["context-file"];
  return next;
}
