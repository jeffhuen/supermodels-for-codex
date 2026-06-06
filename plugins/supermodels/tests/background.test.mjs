import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBackgroundChildArgs, markBackgroundJobRunning } from "../scripts/lib/background.mjs";
import { createJob, createState, readJob, updateJob } from "../scripts/lib/state.mjs";

test("background child args preserve dash-leading focus text behind passthrough separator", () => {
  const args = buildBackgroundChildArgs({
    scriptPath: "/plugin/scripts/supermodels.mjs",
    command: "review",
    options: {
      background: true,
      "job-id": "job-123",
    },
    positionals: ["--literal-focus"],
  });

  assert.deepEqual(args, [
    "/plugin/scripts/supermodels.mjs",
    "review",
    "--job-id",
    "job-123",
    "--",
    "--literal-focus",
  ]);
});

test("background child failures mark the persisted job failed", async () => {
  const tempRoot = await realpath(tmpdir());
  const dataRoot = await mkdtemp(path.join(tempRoot, "supermodels-background-failure-data-"));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, "supermodels-background-failure-workspace-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["grok"],
      background: true,
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "running",
      pid: 12345,
    }));

    const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
    const result = spawnSync(process.execPath, [
      scriptPath,
      "review",
      "--job-id",
      job.id,
      "--data-root",
      dataRoot,
      "--provider",
      "grok",
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SUPERMODELS_WORKSPACE_ROOT: workspaceRoot,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported provider/i);

    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.status, "failed");
    assert.equal(reloaded.stage, "failed");
    assert.match(reloaded.error, /unsupported provider/i);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("background parent running update does not overwrite terminal child status", () => {
  const failed = {
    id: "job-20260605235900-abcdef",
    status: "failed",
    stage: "failed",
    pid: 111,
  };

  const next = markBackgroundJobRunning(failed, 222);

  assert.strictEqual(next, failed);
  assert.equal(next.status, "failed");
  assert.equal(next.pid, 111);
});

test("cancel escalates to SIGKILL when a job process ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const tempRoot = await realpath(tmpdir());
  const dataRoot = await mkdtemp(path.join(tempRoot, "supermodels-cancel-data-"));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, "supermodels-cancel-workspace-"));
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ], {
    cwd: workspaceRoot,
    stdio: "ignore",
  });
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: true,
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "running",
      stage: "calling-providers",
      pid: child.pid,
    }));

    const closed = onceClosed(child);
    const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
    const result = spawnSync(process.execPath, [
      scriptPath,
      "cancel",
      job.id,
      "--data-root",
      dataRoot,
      "--json",
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const close = await closed;
    assert.equal(close.signal, "SIGKILL");
    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.status, "cancelled");
  } finally {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function onceClosed(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
