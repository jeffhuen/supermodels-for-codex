import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createJob, createState, readJob, updateJob } from "../scripts/lib/state.mjs";

test("worker failures mark the persisted job failed", async () => {
  const fixture = await createFixture("supermodels-background-failure-");
  try {
    const { state, dataRoot, workspaceRoot } = fixture;
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["not-a-real-provider"],
      providerSelection: {
        explicit: true,
        requested: ["not-a-real-provider"],
      },
      options: {
        "data-root": dataRoot,
      },
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
      "worker",
      "--job-id",
      job.id,
      "--data-root",
      dataRoot,
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SUPERMODELS_WORKSPACE_ROOT: workspaceRoot,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Provider 'not-a-real-provider' is not ready/i);

    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.status, "failed");
    assert.equal(reloaded.stage, "failed");
    assert.match(reloaded.error, /Provider 'not-a-real-provider' is not ready/i);
  } finally {
    await fixture.cleanup();
  }
});

test("cancel escalates to SIGKILL when a worker ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const fixture = await createFixture("supermodels-cancel-worker-");
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ], {
    cwd: fixture.workspaceRoot,
    stdio: "ignore",
  });
  try {
    const { state, dataRoot, workspaceRoot } = fixture;
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
    const output = JSON.parse(result.stdout);
    assert(output.cancellationSignals.some((entry) => entry.signal === "SIGTERM" && entry.pid === child.pid));
    assert(output.cancellationSignals.some((entry) => entry.signal === "SIGKILL" && entry.pid === child.pid));
    const close = await closed;
    assert.equal(close.signal, "SIGKILL");
    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.status, "cancelled");
  } finally {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    await fixture.cleanup();
  }
});

test("cancel does not signal already terminal jobs", { skip: process.platform === "win32" }, async () => {
  const fixture = await createFixture("supermodels-cancel-terminal-");
  const signalPath = path.join(fixture.workspaceRoot, "signalled.txt");
  const child = spawn(process.execPath, [
    "-e",
    [
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(signalPath)}, 'signalled'); process.exit(0); });`,
      "setInterval(() => {}, 1000);",
    ].join(" "),
  ], {
    cwd: fixture.workspaceRoot,
    stdio: "ignore",
  });
  try {
    const { state, dataRoot, workspaceRoot } = fixture;
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
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.cancellationSignals, []);
    await assert.rejects(() => access(signalPath), /ENOENT/);
    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.status, "completed");
  } finally {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    await fixture.cleanup();
  }
});

test("cancel skips workers whose recorded start identity does not match", { skip: process.platform === "win32" }, async () => {
  const fixture = await createFixture("supermodels-cancel-stale-worker-");
  const signalPath = path.join(fixture.workspaceRoot, "signalled.txt");
  const child = spawn(process.execPath, [
    "-e",
    [
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(signalPath)}, 'signalled'); process.exit(0); });`,
      "setInterval(() => {}, 1000);",
    ].join(" "),
  ], {
    cwd: fixture.workspaceRoot,
    stdio: "ignore",
  });
  try {
    const { state, dataRoot, workspaceRoot } = fixture;
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
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.cancellationSignals, []);
    await assert.rejects(() => access(signalPath), /ENOENT/);
    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.status, "cancelled");
  } finally {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    await fixture.cleanup();
  }
});

test("watch rejects invalid numeric timing options before polling", async () => {
  const fixture = await createFixture("supermodels-watch-invalid-timing-");
  try {
    const { state, dataRoot, workspaceRoot } = fixture;
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
    }));

    const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
    const result = spawnSync(process.execPath, [
      scriptPath,
      "watch",
      job.id,
      "--data-root",
      dataRoot,
      "--interval",
      "abc",
      "--max-wait",
      "xyz",
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 1000,
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /--interval must be a positive number/i);
  } finally {
    await fixture.cleanup();
  }
});

test("status and result expose context packet summary and artifacts", async () => {
  const fixture = await createFixture("supermodels-context-packet-cli-");
  try {
    const { state, dataRoot, workspaceRoot } = fixture;
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      background: false,
    });
    const markdownPath = path.join(job.dir, "context-packet.md");
    const jsonPath = path.join(job.dir, "context-packet.json");
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "completed",
      stage: "synthesis-ready",
      completedAt: new Date().toISOString(),
      contextPacket: {
        summary: "Review the supplied implementation/context for production-relevant bugs, gaps, and verification risks.",
        markdownPath,
        jsonPath,
        createdAt: new Date().toISOString(),
      },
    }));

    const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
    const status = spawnSync(process.execPath, [
      scriptPath,
      "status",
      job.id,
      "--data-root",
      dataRoot,
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    const result = spawnSync(process.execPath, [
      scriptPath,
      "result",
      job.id,
      "--data-root",
      dataRoot,
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Context packet: Review the supplied implementation\/context/);
    assert.doesNotMatch(status.stdout, /context-packet\.json/);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Context packet markdown: .*context-packet\.md/);
    assert.match(result.stdout, /Context packet JSON: .*context-packet\.json/);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(prefix) {
  const tempRoot = await realpath(tmpdir());
  const dataRoot = await mkdtemp(path.join(tempRoot, `${prefix}data-`));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, `${prefix}workspace-`));
  return {
    dataRoot,
    workspaceRoot,
    state: createState({ workspaceRoot, dataRoot }),
    async cleanup() {
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

function onceClosed(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
