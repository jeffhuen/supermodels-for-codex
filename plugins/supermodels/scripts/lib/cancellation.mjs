import { isProcessAlive, processStartedAt } from "./process.mjs";
import { CANCEL_GRACE_MS } from "./run-control.mjs";
import { createState, readJob, updateJob } from "./state.mjs";

export { CANCEL_GRACE_MS };

const TERMINAL_STATUSES = new Set(["cancelled", "completed", "partial", "failed"]);

export async function markCancelled({ workspaceRoot, dataRoot, jobId }) {
  return (await transitionToCancelled({ workspaceRoot, dataRoot, jobId })).job;
}

export async function cancelJob({
  state,
  workspaceRoot,
  dataRoot,
  jobId,
  signaler,
  sleep = defaultSleep,
}) {
  const { job: output, transitioned } = await transitionToCancelled({ workspaceRoot, dataRoot, jobId });
  if (!transitioned) {
    const job = addCancellationSignals(output, []);
    return {
      job,
      signals: [],
      text: `Supermodels job ${jobId} is ${output.status}; no worker signaled.`,
    };
  }

  const signals = [];
  const latest = await readJob(state, jobId).catch(() => output);
  const graceful = await signalWorker(latest, {
    signal: "SIGTERM",
    phase: "initial",
    signaler,
  });
  signals.push(...graceful);

  if (graceful.length) {
    await sleep(CANCEL_GRACE_MS);
    const forceJob = await readJob(state, jobId).catch(() => latest);
    signals.push(...await signalWorker(forceJob, {
      signal: "SIGKILL",
      phase: "force",
      signaler,
    }));
  }

  const job = addCancellationSignals(output, signals);
  return {
    job,
    signals,
    text: renderCancelResult(output, signals),
  };
}

export function addCancellationSignals(job, signals) {
  return {
    ...job,
    cancellationSignals: signals,
  };
}

export function renderCancelResult(job, signals) {
  const signaled = signals.length
    ? signals.map((entry) => `${entry.signal} worker ${entry.pid}`).join(", ")
    : "none";
  return [
    `Cancelled Supermodels job ${job.id}`,
    `Workers signaled: ${signaled}`,
  ].join("\n");
}

async function transitionToCancelled({ workspaceRoot, dataRoot, jobId }) {
  const state = createState({ workspaceRoot, dataRoot });
  let transitioned = false;
  const job = await updateJob(state, jobId, (job) => {
    if (TERMINAL_STATUSES.has(job.status)) {
      return job;
    }
    transitioned = true;
    return {
      ...job,
      status: "cancelled",
      completedAt: new Date().toISOString(),
    };
  });
  return {
    job,
    transitioned,
  };
}

async function signalWorker(job, options) {
  if (!job || !await workerIdentityMatches(job)) {
    return [];
  }
  const pid = Number(job.pid);
  if (!options.signaler?.(pid, options.signal)) {
    return [];
  }
  return [{
    signal: options.signal,
    pid,
    phase: options.phase,
  }];
}

async function workerIdentityMatches(job) {
  const pid = Number(job?.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  if (!job.pidStartedAt) {
    return isProcessAlive(pid);
  }
  const observedStartedAt = await processStartedAt(pid);
  if (observedStartedAt) {
    return observedStartedAt === job.pidStartedAt;
  }
  return false;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
