import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  abortLiveJob,
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
    assert.match(result.text, /no processes signaled/i);
    assert.equal((await readJob(state, job.id)).status, "completed");
  } finally {
    await fixture.cleanup();
  }
});

test("cancelJob gives late-discovered provider pids a graceful signal before force", async () => {
  const fixture = await createFixture("supermodels-cancellation-late-pid-");
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
      pid: 111,
    }));
    const signaled = [];
    let sleepCount = 0;

    const result = await cancelJob({
      state,
      workspaceRoot,
      dataRoot,
      jobId: job.id,
      signaler: (pid, signal) => {
        signaled.push([pid, signal]);
        return true;
      },
      sleep: async () => {
        sleepCount += 1;
        if (sleepCount === 1) {
          await updateJob(state, job.id, (current) => ({
            ...current,
            providerRuns: {
              ...(current.providerRuns ?? {}),
              claude: {
                provider: "claude",
                status: "running",
                pid: 222,
              },
            },
          }));
        }
      },
    });

    assert.deepEqual(signaled, [
      [111, "SIGTERM"],
      [222, "SIGTERM"],
      [111, "SIGKILL"],
      [222, "SIGKILL"],
    ]);
    assert.deepEqual(result.signals, [
      { signal: "SIGTERM", pid: 111, phase: "initial" },
      { signal: "SIGTERM", pid: 222, phase: "late" },
      { signal: "SIGKILL", pid: 111, phase: "force" },
      { signal: "SIGKILL", pid: 222, phase: "force" },
    ]);
    assert.equal((await readJob(state, job.id)).status, "cancelled");
  } finally {
    await fixture.cleanup();
  }
});

test("abortLiveJob excludes the foreground orchestrator pid", async () => {
  const fixture = await createFixture("supermodels-cancellation-live-abort-");
  try {
    const { state } = fixture;
    const job = await createJob(state, {
      command: "review",
      mode: "review",
      requestedProviders: ["claude"],
      live: true,
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "running",
      stage: "calling-providers",
      pid: 333,
      providerRuns: {
        claude: {
          provider: "claude",
          status: "running",
          pid: 444,
        },
      },
    }));
    const signaled = [];

    const result = await abortLiveJob({
      state,
      jobId: job.id,
      signal: "SIGINT",
      currentPid: 333,
      signaler: (pid, sig) => {
        signaled.push([pid, sig]);
        return true;
      },
      sleep: async () => {},
    });

    assert.deepEqual(signaled, [
      [444, "SIGTERM"],
      [444, "SIGKILL"],
    ]);
    assert.deepEqual(result.signals, [
      { signal: "SIGTERM", pid: 444, phase: "initial" },
      { signal: "SIGKILL", pid: 444, phase: "force" },
    ]);
    const reloaded = await readJob(state, job.id);
    assert.equal(reloaded.status, "cancelled");
    assert.equal(reloaded.cancellation.signal, "SIGINT");
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
    "Processes signaled: SIGTERM 111, SIGKILL 111",
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
