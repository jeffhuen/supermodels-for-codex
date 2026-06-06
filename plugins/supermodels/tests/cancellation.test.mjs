import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cancelJob,
  renderCancelResult,
} from "../scripts/lib/cancellation.mjs";
import { createJob, createState, readJob, updateJob } from "../scripts/lib/state.mjs";

test("cancelJob never signals already terminal jobs", async () => {
  const fixture = await createFixture("supermodels-cancellation-terminal-");
  try {
    const { state, workspaceRoot, dataRoot } = fixture;
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "completed",
      stage: "synthesis-ready",
      completedAt: new Date().toISOString(),
      pid: 12345,
    }));
    const signals = [];

    const result = await cancelJob({
      state,
      workspaceRoot,
      dataRoot,
      jobId: job.id,
      signaler: (pid, signal) => {
        signals.push([pid, signal]);
        return true;
      },
      sleep: async () => {},
    });

    assert.deepEqual(signals, []);
    assert.deepEqual(result.signals, []);
    assert.equal(result.job.status, "completed");
    assert.match(result.text, /no worker signaled/i);
    assert.equal((await readJob(state, job.id)).status, "completed");
  } finally {
    await fixture.cleanup();
  }
});

test("cancelJob never re-signals already cancelled jobs", async () => {
  const fixture = await createFixture("supermodels-cancellation-already-cancelled-");
  try {
    const { state, workspaceRoot, dataRoot } = fixture;
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "cancelled",
      stage: "calling-providers",
      completedAt: new Date().toISOString(),
      pid: 12345,
    }));
    const signals = [];

    const result = await cancelJob({
      state,
      workspaceRoot,
      dataRoot,
      jobId: job.id,
      signaler: (pid, signal) => {
        signals.push([pid, signal]);
        return true;
      },
      sleep: async () => {},
    });

    assert.deepEqual(signals, []);
    assert.deepEqual(result.signals, []);
    assert.equal(result.job.status, "cancelled");
    assert.match(result.text, /no worker signaled/i);
    assert.equal((await readJob(state, job.id)).status, "cancelled");
  } finally {
    await fixture.cleanup();
  }
});

test("cancelJob signals only the worker pid", async () => {
  const fixture = await createFixture("supermodels-cancellation-worker-only-");
  try {
    const { state, workspaceRoot, dataRoot } = fixture;
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "running",
      stage: "calling-providers",
      pid: process.pid,
      providerRuns: {
        claude: {
          provider: "claude",
          status: "running",
          pid: 222,
        },
      },
    }));
    const signaled = [];

    const result = await cancelJob({
      state,
      workspaceRoot,
      dataRoot,
      jobId: job.id,
      signaler: (pid, signal) => {
        signaled.push([pid, signal]);
        return true;
      },
      sleep: async () => {},
    });

    assert.deepEqual(signaled, [
      [process.pid, "SIGTERM"],
      [process.pid, "SIGKILL"],
    ]);
    assert.deepEqual(result.signals, [
      { signal: "SIGTERM", pid: process.pid, phase: "initial" },
      { signal: "SIGKILL", pid: process.pid, phase: "force" },
    ]);
    assert.equal((await readJob(state, job.id)).status, "cancelled");
  } finally {
    await fixture.cleanup();
  }
});

test("renderCancelResult reports exact signal attempts", () => {
  const text = renderCancelResult({ id: "job-20260606000000-abcdef" }, [
    { signal: "SIGTERM", pid: 111, phase: "initial" },
    { signal: "SIGKILL", pid: 111, phase: "force" },
  ]);

  assert.equal(text, [
    "Cancelled Supermodels job job-20260606000000-abcdef",
    "Workers signaled: SIGTERM worker 111, SIGKILL worker 111",
  ].join("\n"));
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
