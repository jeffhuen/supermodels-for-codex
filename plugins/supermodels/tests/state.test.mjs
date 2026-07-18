import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createJob,
  createState,
  isLockStale,
  listJobs,
  readJob,
  updateJob,
  validateJobId,
  writeFileAtomic,
  writeProviderResult,
  jobPath,
} from "../scripts/lib/state.mjs";

test("isLockStale decides staleness purely from timestamps (deterministic)", () => {
  assert.equal(isLockStale(1_000, 900, 50), true, "aged past staleLockMs -> stale");
  assert.equal(isLockStale(1_000, 960, 50), false, "within staleLockMs -> fresh");
  assert.equal(isLockStale(1_000, 950, 50), false, "exactly at the boundary -> not yet stale");
  assert.equal(isLockStale(1_000, Number.NaN, 50), false, "missing mtime -> never stale (fail closed)");
});

test("state stores jobs and provider artifacts outside the repo", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-state-"));
  try {
    const state = createState({
      workspaceRoot: "/tmp/workspace",
      dataRoot,
    });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: false,
    });

    assert.match(job.id, /^job-/);
    assert.match(job.dir, /runs/);

    await writeProviderResult(state, job.id, {
      provider: "claude",
      status: "completed",
      rawText: "raw review",
      normalized: {
        provider: "claude",
        verdict: "needs-attention",
        summary: "summary",
        findings: [],
      },
      stderr: "stderr",
    });

    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.providerRuns.claude.status, "completed");
    assert.equal(reloaded.providerRuns.claude.normalized.verdict, "needs-attention");
    assert.equal((await stat(state.root)).mode & 0o777, 0o700);
    assert.equal((await stat(state.jobsDir)).mode & 0o777, 0o700);
    assert.equal((await stat(state.runsDir)).mode & 0o777, 0o700);
    assert.equal((await stat(job.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(jobPath(state, job.id))).mode & 0o777, 0o600);

    const rawText = await readFile(reloaded.providerRuns.claude.rawResultPath, "utf8");
    assert.equal(rawText, "raw review");
    assert.equal((await stat(reloaded.providerRuns.claude.rawResultPath)).mode & 0o777, 0o600);
    assert.equal((await stat(reloaded.providerRuns.claude.stderrPath)).mode & 0o777, 0o600);
    assert.equal((await stat(reloaded.providerRuns.claude.normalizedResultPath)).mode & 0o777, 0o600);

    const jobs = await listJobs(state);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, job.id);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("state bounds artifact filenames without truncating the provider run identity", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-state-long-provider-"));
  try {
    const state = createState({ workspaceRoot: "/tmp/workspace", dataRoot });
    const job = await createJob(state, {
      command: "adversarial-review",
      mode: "adversarial-review",
      requestedProviders: ["claude"],
      background: false,
    });
    const provider = `claude-challenge-v2-${"a".repeat(900)}`;

    await writeProviderResult(state, job.id, {
      provider,
      status: "completed",
      rawText: "raw",
      normalized: { provider, verdict: "clean", summary: "clean", findings: [] },
    });

    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.providerRuns[provider].provider, provider);
    assert.ok(Buffer.byteLength(path.basename(reloaded.providerRuns[provider].rawResultPath)) < 150);
    assert.equal(await readFile(reloaded.providerRuns[provider].rawResultPath, "utf8"), "raw");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("listJobs skips malformed job files", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-state-malformed-list-"));
  try {
    const state = createState({
      workspaceRoot: "/tmp/workspace",
      dataRoot,
    });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: false,
    });
    await writeFile(path.join(state.jobsDir, "job-20260606000000-deadbe.json"), "{");

    const jobs = await listJobs(state);

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, job.id);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("listJobs skips valid non-object job JSON", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-state-nonobject-list-"));
  try {
    const state = createState({
      workspaceRoot: "/tmp/workspace",
      dataRoot,
    });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: false,
    });
    await writeFile(path.join(state.jobsDir, "job-20260606000000-deadbe.json"), "null");
    await writeFile(path.join(state.jobsDir, "job-20260606000000-badbad.json"), "[]");

    const jobs = await listJobs(state);

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, job.id);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("writeFileAtomic removes temp files when rename fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supermodels-state-atomic-cleanup-"));
  try {
    const finalPath = path.join(dir, "target");
    await mkdir(finalPath);

    await assert.rejects(() => writeFileAtomic(finalPath, "payload"), /EISDIR|ENOTEMPTY|is a directory/i);

    const entries = await readdir(dir);
    assert.deepEqual(entries, ["target"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state rejects unsafe job ids before path construction", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-state-job-id-"));
  try {
    const state = createState({
      workspaceRoot: "/tmp/workspace",
      dataRoot,
    });

    assert.throws(() => validateJobId("../outside"), /invalid job id/i);
    assert.throws(() => jobPath(state, "../outside"), /invalid job id/i);
    await assert.rejects(() => readJob(state, "../outside"), /invalid job id/i);
    await assert.rejects(
      () => writeProviderResult(state, "../outside", {
        provider: "claude",
        rawText: "raw",
        normalized: { verdict: "clean", findings: [] },
      }),
      /invalid job id/i,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("state serializes concurrent job updates", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-state-lock-"));
  try {
    const state = createState({
      workspaceRoot: "/tmp/workspace",
      dataRoot,
      staleLockMs: 30_000,
      lockHeartbeatMs: 10_000,
      lockWaitMs: 2_000,
    });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: false,
    });

    await Promise.all(Array.from({ length: 20 }, (_, index) => updateJob(state, job.id, (current) => ({
      ...current,
      markers: [...(current.markers ?? []), index],
    }))));

    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.markers.length, 20);
    assert.deepEqual([...new Set(reloaded.markers)].sort((left, right) => left - right), Array.from({ length: 20 }, (_, index) => index));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("state recovers stale job locks", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "supermodels-state-stale-lock-"));
  try {
    const state = createState({
      workspaceRoot: "/tmp/workspace",
      dataRoot,
    });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: false,
    });
    const lockPath = `${jobPath(state, job.id)}.lock`;
    await writeFile(lockPath, "stale lock\n");
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleAt, staleAt);

    await updateJob(state, job.id, (current) => ({
      ...current,
      staleLockRecovered: true,
    }));

    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.staleLockRecovered, true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
