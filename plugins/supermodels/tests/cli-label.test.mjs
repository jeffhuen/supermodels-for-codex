import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createJob, createState, updateJob } from "../scripts/lib/state.mjs";

test("status renders provider labels from the registry", async () => {
  const tempRoot = await realpath(tmpdir());
  const dataRoot = await mkdtemp(path.join(tempRoot, "supermodels-cli-label-data-"));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, "supermodels-cli-label-workspace-"));
  try {
    const state = createState({ workspaceRoot, dataRoot });
    const job = await createJob(state, {
      command: "adversarial-review",
      requestedProviders: ["grok", "claude"],
    });
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "completed",
      stage: "completed",
      completedAt: new Date().toISOString(),
      providerRuns: {
        grok: { provider: "grok", status: "completed", sessionId: "" },
        "grok-challenge-claude": {
          provider: "grok-challenge-claude",
          phase: "cross-challenge",
          status: "completed",
          sessionId: "",
        },
      },
    }));

    const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
    const result = spawnSync(process.execPath, [
      scriptPath,
      "status",
      job.id,
      "--data-root",
      dataRoot,
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Grok Build: completed/);
    assert.match(result.stdout, /Grok Build challenging Claude Code: completed/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("setup renders actionable next steps for every registered provider", async () => {
  const tempRoot = await realpath(tmpdir());
  const dataRoot = await mkdtemp(path.join(tempRoot, "supermodels-cli-setup-data-"));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, "supermodels-cli-setup-workspace-"));
  try {
    const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
    const result = spawnSync(process.execPath, [
      scriptPath,
      "setup",
      "--data-root",
      dataRoot,
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: workspaceRoot,
        PATH: "",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Next steps:/);
    assert.match(result.stdout, /claude binary not found/i);
    assert.match(result.stdout, /agy binary not found/i);
    assert.match(result.stdout, /grok binary not found/i);
    assert.equal(result.stdout.match(/rerun `\$supermodels:setup`/g)?.length, 3);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
