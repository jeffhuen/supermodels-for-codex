import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const PID_FILE_PREFIX = "provider-";
const PID_FILE_SUFFIX = ".pid";

export function writeProviderPid(job, provider, pid) {
  const numericPid = Number(pid);
  if (!job?.dir || !Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    writeFileSync(providerPidPath(job.dir, provider), `${numericPid}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function jobProcessPids(job) {
  return [...new Set([
    Number(job?.pid),
    ...Object.values(job?.providerRuns ?? {}).map((run) => Number(run.pid)),
    ...readProviderPidSidecars(job),
  ].filter((pid) => Number.isFinite(pid) && pid > 0))];
}

export function signalJobProcesses(job, options = {}) {
  const signal = options.signal ?? "SIGTERM";
  const signaler = options.signaler;
  const signalled = [];
  for (const pid of jobProcessPids(job)) {
    if (signaler?.(pid, signal)) {
      signalled.push(pid);
    }
  }
  return signalled;
}

function providerPidPath(jobDir, provider) {
  const safeProvider = String(provider ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(jobDir, `${PID_FILE_PREFIX}${safeProvider}${PID_FILE_SUFFIX}`);
}

function readProviderPidSidecars(job) {
  if (!job?.dir || !existsSync(job.dir)) {
    return [];
  }
  const pids = [];
  let entries;
  try {
    entries = readdirSync(job.dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(PID_FILE_PREFIX) || !entry.name.endsWith(PID_FILE_SUFFIX)) {
      continue;
    }
    let text;
    try {
      text = readFileSync(path.join(job.dir, entry.name), "utf8").trim();
    } catch {
      continue;
    }
    const pid = Number(text);
    if (Number.isFinite(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return pids;
}
