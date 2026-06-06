import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const PID_FILE_PREFIX = "provider-";
const PID_FILE_SUFFIX = ".pid";

export function writeProviderPid(job, provider, pid, options = {}) {
  const numericPid = Number(pid);
  if (!job?.dir || !Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    const payload = options.pidStartedAt
      ? `${JSON.stringify({ pid: numericPid, pidStartedAt: options.pidStartedAt })}\n`
      : `${numericPid}\n`;
    writeFileSync(providerPidPath(job.dir, provider), payload, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function jobProcessPids(job) {
  return jobProcessDescriptors(job).map((entry) => entry.pid);
}

export function jobProcessDescriptors(job) {
  const descriptors = [
    {
      pid: Number(job?.pid),
      pidStartedAt: job?.pidStartedAt ?? "",
      source: "job",
    },
    ...Object.values(job?.providerRuns ?? {}).map((run) => ({
      pid: Number(run.pid),
      pidStartedAt: run.pidStartedAt ?? "",
      source: "provider",
    })),
    ...readProviderPidSidecars(job),
  ].filter((entry) => Number.isFinite(entry.pid) && entry.pid > 0);

  const byPid = new Map();
  for (const entry of descriptors) {
    const existing = byPid.get(entry.pid);
    if (!existing || (!existing.pidStartedAt && entry.pidStartedAt)) {
      byPid.set(entry.pid, entry);
    }
  }
  return [...byPid.values()];
}

export function signalJobProcesses(job, options = {}) {
  const signal = options.signal ?? "SIGTERM";
  const signaler = options.signaler;
  const excludePids = new Set((options.excludePids ?? []).map((pid) => Number(pid)));
  const verifyIdentity = Boolean(options.verifyIdentity);
  const signalled = [];
  for (const descriptor of jobProcessDescriptors(job)) {
    const pid = Number(descriptor.pid);
    if (excludePids.has(pid)) {
      continue;
    }
    if (verifyIdentity && !descriptorIdentityMatches(descriptor)) {
      continue;
    }
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
    const parsed = parseProviderPidSidecar(text);
    if (parsed) {
      pids.push(parsed);
    }
  }
  return pids;
}

function parseProviderPidSidecar(text) {
  if (!text) {
    return null;
  }
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const pid = Number(parsed.pid);
      if (Number.isFinite(pid) && pid > 0) {
        return {
          pid,
          pidStartedAt: parsed.pidStartedAt ?? "",
          source: "provider-sidecar",
        };
      }
    } catch {
      return null;
    }
  }
  const pid = Number(text);
  if (Number.isFinite(pid) && pid > 0) {
    return {
      pid,
      pidStartedAt: "",
      source: "provider-sidecar",
    };
  }
  return null;
}

function descriptorIdentityMatches(descriptor) {
  if (!descriptor.pidStartedAt) {
    return true;
  }
  const observedStartedAt = processStartedAtSync(descriptor.pid);
  if (observedStartedAt) {
    return observedStartedAt === descriptor.pidStartedAt;
  }
  return isProcessAlive(descriptor.pid);
}

function processStartedAtSync(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0 || process.platform === "win32") {
    return "";
  }
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim().replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

function isProcessAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
