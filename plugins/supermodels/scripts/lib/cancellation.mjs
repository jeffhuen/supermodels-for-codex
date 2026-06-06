import { signalJobProcesses } from "./provider-pids.mjs";
import { createState, readJob, updateJob } from "./state.mjs";

export const CANCEL_GRACE_MS = 1500;
export const CANCEL_LATE_GRACE_MS = 250;

const TERMINAL_STATUSES = new Set(["cancelled", "completed", "partial", "failed"]);

export async function markCancelled({ workspaceRoot, dataRoot, jobId }) {
  return (await transitionToCancelled({ workspaceRoot, dataRoot, jobId })).job;
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
      text: `Supermodels job ${jobId} is ${output.status}; no processes signaled.`,
    };
  }

  const signals = [];
  const gracefulPids = new Set();
  const initialJob = await readJob(state, jobId).catch(() => output);
  const initialSignals = signalPhase(initialJob, {
    phase: "initial",
    signal: "SIGTERM",
    signaler,
  });
  rememberPids(gracefulPids, initialSignals);
  signals.push(...initialSignals);

  await sleep(CANCEL_GRACE_MS);

  const latestJob = await readJob(state, jobId).catch(() => initialJob);
  const lateSignals = signalPhase(latestJob, {
    phase: "late",
    signal: "SIGTERM",
    signaler,
    skipPids: gracefulPids,
  });
  rememberPids(gracefulPids, lateSignals);
  signals.push(...lateSignals);

  await sleep(CANCEL_LATE_GRACE_MS);

  const forceJob = await readJob(state, jobId).catch(() => latestJob);
  signals.push(...signalPhase(forceJob, {
    phase: "force",
    signal: "SIGKILL",
    signaler,
  }));

  const job = addCancellationSignals(output, signals);
  return {
    job,
    signals,
    text: renderCancelResult(output, signals),
  };
}

export async function abortLiveJob({
  state,
  jobId,
  signal,
  currentPid,
  signaler,
  sleep = defaultSleep,
}) {
  const initialJob = await readJob(state, jobId).catch(() => null);
  if (!isCancellableJob(initialJob)) {
    return {
      job: initialJob,
      signals: [],
    };
  }

  const excludePids = [currentPid].filter((pid) => Number.isFinite(Number(pid)) && Number(pid) > 0);
  const signals = [];
  const gracefulPids = new Set();
  const initialSignals = signalPhase(initialJob, {
    phase: "initial",
    signal: "SIGTERM",
    signaler,
    excludePids,
  });
  rememberPids(gracefulPids, initialSignals);
  signals.push(...initialSignals);

  const cancelled = await updateJob(state, jobId, (current) => {
    if (!isCancellableJob(current)) {
      return current;
    }
    return {
      ...current,
      status: "cancelled",
      completedAt: new Date().toISOString(),
      cancellation: {
        signal,
        at: new Date().toISOString(),
      },
    };
  }).catch(() => null);

  await sleep(CANCEL_GRACE_MS);

  const latestJob = await readJob(state, jobId).catch(() => cancelled ?? initialJob);
  const lateSignals = signalPhase(latestJob, {
    phase: "late",
    signal: "SIGTERM",
    signaler,
    excludePids,
    skipPids: gracefulPids,
  });
  rememberPids(gracefulPids, lateSignals);
  signals.push(...lateSignals);

  await sleep(CANCEL_LATE_GRACE_MS);

  const forceJob = await readJob(state, jobId).catch(() => latestJob);
  signals.push(...signalPhase(forceJob, {
    phase: "force",
    signal: "SIGKILL",
    signaler,
    excludePids,
  }));

  return {
    job: addCancellationSignals(cancelled ?? initialJob, signals),
    signals,
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
    ? signals.map((entry) => `${entry.signal} ${entry.pid}`).join(", ")
    : "none";
  return [
    `Cancelled Supermodels job ${job.id}`,
    `Processes signaled: ${signaled}`,
  ].join("\n");
}

function signalPhase(job, options) {
  if (!job) {
    return [];
  }
  const skipPids = new Set(Array.from(options.skipPids ?? [], (pid) => Number(pid)));
  const excludePids = new Set(Array.from(options.excludePids ?? [], (pid) => Number(pid)));
  for (const pid of skipPids) {
    excludePids.add(pid);
  }
  return signalJobProcesses(job, {
    signal: options.signal,
    signaler: options.signaler,
    excludePids: [...excludePids],
    verifyIdentity: true,
  }).map((pid) => ({
    signal: options.signal,
    pid,
    phase: options.phase,
  }));
}

function rememberPids(target, signals) {
  for (const entry of signals) {
    target.add(Number(entry.pid));
  }
}

function isCancellableJob(job) {
  return Boolean(job && !TERMINAL_STATUSES.has(job.status));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
