import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  jobProcessDescriptors,
  jobProcessPids,
  signalJobProcesses,
  writeProviderPid,
} from "../scripts/lib/provider-pids.mjs";

test("jobProcessPids includes provider pid sidecars when state has not caught up", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supermodels-provider-pids-"));
  try {
    const job = {
      pid: 111,
      dir,
      providerRuns: {
        claude: { provider: "claude", pid: null },
      },
    };

    writeProviderPid(job, "claude", 222);

    assert.deepEqual(jobProcessPids(job), [111, 222]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeProviderPid is best-effort when the job dir is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supermodels-provider-pids-missing-"));
  await rm(dir, { recursive: true, force: true });
  const job = {
    pid: 111,
    dir,
    providerRuns: {},
  };

  assert.equal(writeProviderPid(job, "claude", 222), false);
  assert.deepEqual(jobProcessPids(job), [111]);
});

test("provider pid sidecars preserve process start signatures", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supermodels-provider-pids-signature-"));
  try {
    const job = {
      pid: 111,
      pidStartedAt: "Mon Jan 1 00:00:00 2024",
      dir,
      providerRuns: {},
    };

    writeProviderPid(job, "claude", 222, { pidStartedAt: "Tue Jan 2 00:00:00 2024" });

    assert.deepEqual(jobProcessDescriptors(job), [
      { pid: 111, pidStartedAt: "Mon Jan 1 00:00:00 2024", source: "job" },
      { pid: 222, pidStartedAt: "Tue Jan 2 00:00:00 2024", source: "provider-sidecar" },
    ]);
    assert.deepEqual(jobProcessPids(job), [111, 222]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("signalJobProcesses signals job and sidecar provider process groups", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supermodels-signal-pids-"));
  try {
    const job = {
      pid: 111,
      dir,
      providerRuns: {
        claude: { provider: "claude", pid: 222 },
        antigravity: { provider: "antigravity", pid: null },
      },
    };
    const signalled = [];
    writeProviderPid(job, "antigravity", 333);

    signalJobProcesses(job, {
      signal: "SIGTERM",
      signaler: (pid, signal) => {
        signalled.push([pid, signal]);
        return true;
      },
    });

    assert.deepEqual(signalled, [
      [111, "SIGTERM"],
      [222, "SIGTERM"],
      [333, "SIGTERM"],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
