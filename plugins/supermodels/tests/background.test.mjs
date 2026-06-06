import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBackgroundChildArgs, markBackgroundJobRunning } from "../scripts/lib/background.mjs";
import { createJob, createState, readJob, updateJob } from "../scripts/lib/state.mjs";
import { writeProviderPid } from "../scripts/lib/provider-pids.mjs";

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

test("cancel does not signal already terminal jobs", { skip: process.platform === "win32" }, async () => {
  const tempRoot = await realpath(tmpdir());
  const dataRoot = await mkdtemp(path.join(tempRoot, "supermodels-cancel-terminal-data-"));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, "supermodels-cancel-terminal-workspace-"));
  const signalPath = path.join(workspaceRoot, "signalled.txt");
  const child = spawn(process.execPath, [
    "-e",
    [
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(signalPath)}, 'signalled'); process.exit(0); });`,
      "setInterval(() => {}, 1000);",
    ].join(" "),
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
      status: "completed",
      stage: "synthesis-ready",
      completedAt: new Date().toISOString(),
      pid: child.pid,
      pidStartedAt: processStartedAt(child.pid),
    }));

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
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(() => access(signalPath), /ENOENT/);
    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.status, "completed");
  } finally {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("cancel uses pid identity checks for initial SIGTERM", { skip: process.platform === "win32" }, async () => {
  const tempRoot = await realpath(tmpdir());
  const dataRoot = await mkdtemp(path.join(tempRoot, "supermodels-cancel-identity-data-"));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, "supermodels-cancel-identity-workspace-"));
  const signalPath = path.join(workspaceRoot, "signalled.txt");
  const child = spawn(process.execPath, [
    "-e",
    [
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(signalPath)}, 'signalled'); process.exit(0); });`,
      "setInterval(() => {}, 1000);",
    ].join(" "),
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
      pidStartedAt: "Mon Jan 1 00:00:00 1970",
    }));

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
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(() => access(signalPath), /ENOENT/);
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

test("cancel re-reads job state before SIGKILL escalation", { skip: process.platform === "win32" }, async () => {
  const tempRoot = await realpath(tmpdir());
  const dataRoot = await mkdtemp(path.join(tempRoot, "supermodels-cancel-reread-data-"));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, "supermodels-cancel-reread-workspace-"));
  const provider = spawn(process.execPath, [
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
      pid: null,
    }));

    const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
    const cancel = spawn(process.execPath, [
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

    await waitFor(async () => (await readJob(state, job.id)).status === "cancelled", 1000);
    writeProviderPid(job, "claude", provider.pid, { pidStartedAt: processStartedAt(provider.pid) });

    const providerClosed = onceClosed(provider);
    const cancelClosed = await onceClosed(cancel);
    assert.equal(cancelClosed.code, 0);
    const close = await providerClosed;
    assert.equal(close.signal, "SIGKILL");
  } finally {
    if (!provider.killed) {
      provider.kill("SIGKILL");
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

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}

function processStartedAt(pid) {
  if (process.platform === "win32") {
    return "";
  }
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim().replace(/\s+/g, " ");
}
