import crypto from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function defaultDataRoot() {
  return path.join(os.homedir(), ".codex", "plugins", "data", "supermodels");
}

export function workspaceHash(workspaceRoot) {
  return crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

export function createState(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const dataRoot = path.resolve(options.dataRoot ?? process.env.SUPERMODELS_DATA_ROOT ?? defaultDataRoot());
  const root = path.join(dataRoot, "state", workspaceHash(workspaceRoot));
  return {
    workspaceRoot,
    dataRoot,
    root,
    jobsDir: path.join(root, "jobs"),
    runsDir: path.join(root, "runs"),
    staleLockMs: options.staleLockMs,
    lockWaitMs: options.lockWaitMs,
    lockHeartbeatMs: options.lockHeartbeatMs,
  };
}

export function validateJobId(jobId) {
  const value = String(jobId ?? "");
  if (!/^job-\d{14}-[a-f0-9]{6}$/i.test(value)) {
    throw new Error(`Invalid job id '${value}'.`);
  }
  return value;
}

export async function ensureState(state) {
  await ensurePrivateDir(state.root);
  await ensurePrivateDir(state.jobsDir);
  await ensurePrivateDir(state.runsDir);
}

export async function createJob(state, request) {
  await ensureState(state);
  const id = `job-${timestampId()}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(state.runsDir, id);
  await ensurePrivateDir(dir);
  const now = new Date().toISOString();
  const job = {
    id,
    status: "queued",
    workspaceRoot: state.workspaceRoot,
    dir,
    stage: "queued",
    request,
    providerRuns: {},
    pid: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  await writeJob(state, job);
  return job;
}

export async function readJob(state, jobId) {
  const payload = await readFile(jobPath(state, jobId), "utf8");
  return JSON.parse(payload);
}

export async function writeJob(state, job) {
  await ensureState(state);
  const next = {
    ...job,
    updatedAt: new Date().toISOString(),
  };
  await writeFileAtomic(jobPath(state, job.id), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function updateJob(state, jobId, updater) {
  return await withJobLock(state, jobId, async (lock) => {
    const current = await readJob(state, jobId);
    const next = await updater(current);
    await lock.assertOwned();
    return await writeJob(state, next);
  });
}

export async function listJobs(state) {
  await ensureState(state);
  const entries = await readdir(state.jobsDir).catch(() => []);
  const jobs = [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    try {
      const payload = await readFile(path.join(state.jobsDir, entry), "utf8");
      const job = JSON.parse(payload);
      if (!isJobRecord(job)) {
        continue;
      }
      jobs.push(job);
    } catch {
      // Ignore malformed or partially-written job files so one bad record does not
      // break status listing for the rest of the workspace.
    }
  }
  jobs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  return jobs;
}

export async function writeProviderResult(state, jobId, result) {
  const safeJobId = validateJobId(jobId);
  const provider = result.provider;
  const runDir = path.join(state.runsDir, safeJobId);
  await ensurePrivateDir(runDir);

  const rawResultPath = path.join(runDir, `provider-${provider}.raw.txt`);
  const normalizedResultPath = path.join(runDir, `provider-${provider}.normalized.json`);
  const stderrPath = path.join(runDir, `provider-${provider}.stderr.log`);
  const normalized = {
    ...(result.normalized ?? {}),
    provider,
    provider_session_id: result.normalized?.provider_session_id ?? result.sessionId ?? "",
    raw_result_path: rawResultPath,
  };

  await writeFile(rawResultPath, result.rawText ?? "", { mode: 0o600 });
  await writeFile(stderrPath, result.stderr ?? "", { mode: 0o600 });
  await writeFileAtomic(normalizedResultPath, `${JSON.stringify(normalized, null, 2)}\n`);

  return await updateJob(state, jobId, (job) => {
    const providerRuns = { ...(job.providerRuns ?? {}) };
    providerRuns[provider] = {
      ...(providerRuns[provider] ?? {}),
      provider,
      status: result.status ?? "completed",
      exitCode: result.exitCode ?? 0,
      commandLine: result.commandLine ?? "",
      pid: result.pid ?? providerRuns[provider]?.pid ?? null,
      sessionId: normalized.provider_session_id,
      rawResultPath,
      normalizedResultPath,
      stderrPath,
      normalized,
      structured: result.structured ?? null,
      usage: result.usage ?? null,
      events: Array.isArray(result.events) ? result.events.slice(-100) : [],
      lastEvent: result.lastEvent ?? "",
      startedAt: result.startedAt ?? null,
      completedAt: result.completedAt ?? new Date().toISOString(),
    };
    return {
      ...job,
      providerRuns,
    };
  });
}

export async function initializeProviderRuns(state, jobId, providers) {
  return await updateJob(state, jobId, (job) => {
    const providerRuns = { ...(job.providerRuns ?? {}) };
    const now = new Date().toISOString();
    for (const provider of providers) {
      providerRuns[provider] = {
        provider,
        status: providerRuns[provider]?.status ?? "queued",
        exitCode: providerRuns[provider]?.exitCode ?? null,
        commandLine: providerRuns[provider]?.commandLine ?? "",
        pid: providerRuns[provider]?.pid ?? null,
        sessionId: providerRuns[provider]?.sessionId ?? "",
        rawResultPath: providerRuns[provider]?.rawResultPath ?? "",
        normalizedResultPath: providerRuns[provider]?.normalizedResultPath ?? "",
        stderrPath: providerRuns[provider]?.stderrPath ?? "",
        normalized: providerRuns[provider]?.normalized ?? null,
        structured: providerRuns[provider]?.structured ?? null,
        usage: providerRuns[provider]?.usage ?? null,
        events: providerRuns[provider]?.events ?? [],
        lastEvent: providerRuns[provider]?.lastEvent ?? "",
        startedAt: providerRuns[provider]?.startedAt ?? null,
        completedAt: providerRuns[provider]?.completedAt ?? null,
        updatedAt: now,
      };
    }
    return {
      ...job,
      providerRuns,
    };
  });
}

export async function updateProviderRun(state, jobId, provider, patch) {
  return await updateJob(state, jobId, (job) => {
    const providerRuns = { ...(job.providerRuns ?? {}) };
    providerRuns[provider] = {
      provider,
      ...(providerRuns[provider] ?? {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return {
      ...job,
      providerRuns,
    };
  });
}

export function jobPath(state, jobId) {
  return path.join(state.jobsDir, `${validateJobId(jobId)}.json`);
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export async function writeFileAtomic(finalPath, payload) {
  const tempPath = `${finalPath}.${process.pid}.${Date.now().toString(36)}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, payload, { mode: 0o600 });
    await rename(tempPath, finalPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function ensurePrivateDir(dirPath) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  await chmod(dirPath, 0o700).catch(() => {});
}

function isJobRecord(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    return false;
  }
  try {
    validateJobId(job.id);
  } catch {
    return false;
  }
  return typeof job.createdAt === "string";
}

async function withJobLock(state, jobId, operation) {
  await ensureState(state);
  const lockPath = `${jobPath(state, jobId)}.lock`;
  const startedAt = Date.now();
  const staleLockMs = Number(state.staleLockMs ?? 5_000);
  const lockWaitMs = Number(state.lockWaitMs ?? 10_000);
  const lockHeartbeatMs = Number(state.lockHeartbeatMs ?? Math.min(1_000, Math.max(100, Math.floor(staleLockMs / 2))));
  const ownerToken = `${process.pid}:${Date.now().toString(36)}:${crypto.randomBytes(8).toString("hex")}`;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${ownerToken}\n`);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        handle = null;
        await unlinkOwnedLock(lockPath, ownerToken).catch(() => {});
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const lockInfo = await stat(lockPath).catch(() => null);
      if (lockInfo && Date.now() - lockInfo.mtimeMs > staleLockMs) {
        if (await removeStaleLock(lockPath, staleLockMs)) {
          continue;
        }
      }
      if (Date.now() - startedAt > lockWaitMs) {
        throw new Error(`Timed out waiting for job state lock: ${jobId}`);
      }
      await sleep(10);
    }
  }

  let heartbeat;
  const lock = {
    async assertOwned() {
      if (!await lockOwnedBy(lockPath, ownerToken)) {
        throw new Error(`Lost job state lock ownership: ${jobId}`);
      }
    },
  };
  try {
    heartbeat = setInterval(() => {
      const now = new Date();
      touchOwnedLock(lockPath, ownerToken, now).catch(() => {});
    }, lockHeartbeatMs);
    heartbeat.unref?.();
    return await operation(lock);
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    await handle.close().catch(() => {});
    await unlinkOwnedLock(lockPath, ownerToken).catch(() => {});
  }
}

async function removeStaleLock(lockPath, staleLockMs) {
  const reaperPath = `${lockPath}.reap`;
  let reaper;
  try {
    reaper = await open(reaperPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      const reaperInfo = await stat(reaperPath).catch(() => null);
      if (reaperInfo && Date.now() - reaperInfo.mtimeMs > staleLockMs) {
        await unlink(reaperPath).catch(() => {});
      }
      return false;
    }
    throw error;
  }

  try {
    const before = await stat(lockPath).catch(() => null);
    const lockToken = await readLockToken(lockPath);
    const after = await stat(lockPath).catch(() => null);
    if (
      !before
      || !after
      || before.dev !== after.dev
      || before.ino !== after.ino
      || Date.now() - after.mtimeMs <= staleLockMs
    ) {
      return false;
    }
    if (lockToken) {
      await unlinkLockIfToken(lockPath, lockToken);
    } else {
      await unlinkEmptyLockIfSameFile(lockPath, after);
    }
    return true;
  } finally {
    await reaper.close().catch(() => {});
    await unlink(reaperPath).catch(() => {});
  }
}

async function readLockToken(lockPath) {
  const text = await readFile(lockPath, "utf8").catch(() => "");
  return text.trim();
}

async function lockOwnedBy(lockPath, ownerToken) {
  return await readLockToken(lockPath) === ownerToken;
}

async function touchOwnedLock(lockPath, ownerToken, when) {
  if (await lockOwnedBy(lockPath, ownerToken)) {
    await utimes(lockPath, when, when);
  }
}

async function unlinkOwnedLock(lockPath, ownerToken) {
  await unlinkLockIfToken(lockPath, ownerToken);
}

async function unlinkLockIfToken(lockPath, token) {
  if (await readLockToken(lockPath) === token) {
    await unlink(lockPath);
  }
}

async function unlinkEmptyLockIfSameFile(lockPath, expectedInfo) {
  const token = await readLockToken(lockPath);
  const currentInfo = await stat(lockPath).catch(() => null);
  if (
    token === ""
    && currentInfo
    && Number(currentInfo.dev) === Number(expectedInfo.dev)
    && Number(currentInfo.ino) === Number(expectedInfo.ino)
  ) {
    await unlink(lockPath);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
