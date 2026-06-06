import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { signalProcessTree } from "../scripts/lib/process.mjs";
import { createState, listJobs } from "../scripts/lib/state.mjs";

test("foreground review runs in a dedicated worker process", { skip: process.platform === "win32" }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-worker-foreground-"));
  const binDir = path.join(tempDir, "bin");
  const dataRoot = path.join(tempDir, "data");
  const providerPidPath = path.join(tempDir, "provider.pid");
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  let workerPid = null;
  let cli;
  try {
    await mkdir(binDir, { recursive: true });
    await writeFakeClaude(binDir, { providerPidPath });

    const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
    cli = spawn(process.execPath, [
      scriptPath,
      "review",
      "--provider",
      "claude",
      "--data-root",
      dataRoot,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForFile(providerPidPath);
    const jobs = await listJobs(createState({ workspaceRoot: repoRoot, dataRoot }));

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "running");
    workerPid = jobs[0].pid;
    assert.notEqual(jobs[0].pid, cli.pid);
  } finally {
    if (cli?.pid) {
      signalProcessTree(cli.pid, "SIGKILL");
    }
    if (workerPid) {
      signalProcessTree(workerPid, "SIGKILL");
    }
    const providerPid = await readFile(providerPidPath, "utf8").catch(() => "");
    if (providerPid) {
      signalProcessTree(Number(providerPid), "SIGKILL");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function writeFakeClaude(binDir, { providerPidPath }) {
  const fakeClaude = path.join(binDir, "claude");
  await writeFile(fakeClaude, [
    "#!/usr/bin/env node",
    "const { writeFileSync } = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('2.1.162 (Claude Code)'); process.exit(0); }",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));",
    "  process.exit(0);",
    "}",
    `writeFileSync(${JSON.stringify(providerPidPath)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  await chmod(fakeClaude, 0o755);
}

async function waitForFile(filePath, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const text = await readFile(filePath, "utf8").catch(() => "");
    if (text) {
      return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}
