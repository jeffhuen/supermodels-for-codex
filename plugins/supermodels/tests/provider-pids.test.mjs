import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
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
