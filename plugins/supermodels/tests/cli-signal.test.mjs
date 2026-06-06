import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { signalProcessTree } from "../scripts/lib/process.mjs";
import { createState, listJobs } from "../scripts/lib/state.mjs";

test("live review force-kills provider child before exiting on Ctrl+C", { skip: process.platform === "win32" }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-live-signal-"));
  const binDir = path.join(tempDir, "bin");
  const dataRoot = path.join(tempDir, "data");
  const providerPidPath = path.join(tempDir, "provider.pid");
  const markerPath = path.join(tempDir, "provider-survived.txt");
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  let cli;
  try {
    await mkdir(binDir, { recursive: true });
    await writeFakeClaude(binDir, { providerPidPath, markerPath });

    const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
    cli = spawn(process.execPath, [
      scriptPath,
      "review",
      "--live",
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

    await waitForStdout(cli, "Claude Code: running");
    cli.kill("SIGINT");
    const closed = await onceClosed(cli, 3000);
    assert.equal(closed.code, 130);
    await sleep(1800);

    await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/);
  } finally {
    if (cli?.pid) {
      signalProcessTree(cli.pid, "SIGKILL");
    }
    const providerPid = await readFile(providerPidPath, "utf8").catch(() => "");
    if (providerPid) {
      signalProcessTree(Number(providerPid), "SIGKILL");
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("foreground review records Ctrl+C as cancelled", { skip: process.platform === "win32" }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-foreground-signal-"));
  const binDir = path.join(tempDir, "bin");
  const dataRoot = path.join(tempDir, "data");
  const providerPidPath = path.join(tempDir, "provider.pid");
  const markerPath = path.join(tempDir, "provider-survived.txt");
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  let cli;
  try {
    await mkdir(binDir, { recursive: true });
    await writeFakeClaude(binDir, { providerPidPath, markerPath });

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
    cli.kill("SIGINT");
    const closed = await onceClosed(cli, 3000);
    assert.equal(closed.code, 130);

    const jobs = await listJobs(createState({ workspaceRoot: repoRoot, dataRoot }));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "cancelled");
  } finally {
    if (cli?.pid) {
      signalProcessTree(cli.pid, "SIGKILL");
    }
    const providerPid = await readFile(providerPidPath, "utf8").catch(() => "");
    if (providerPid) {
      signalProcessTree(Number(providerPid), "SIGKILL");
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function writeFakeClaude(binDir, { providerPidPath, markerPath }) {
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
    "const markSurvival = () => setTimeout(() => writeFileSync(",
    `  ${JSON.stringify(markerPath)},`,
    "  'survived',",
    "), 1500);",
    "process.on('SIGINT', markSurvival);",
    "process.on('SIGTERM', markSurvival);",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  await chmod(fakeClaude, 0o755);
}

function waitForStdout(child, expected) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}. stdout=${stdout}`)), 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(expected)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", () => {});
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (!stdout.includes(expected)) {
        clearTimeout(timer);
        reject(new Error(`Command closed before ${expected}: code=${code} signal=${signal} stdout=${stdout}`));
      }
    });
  });
}

async function waitForFile(filePath, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const text = await readFile(filePath, "utf8").catch(() => "");
    if (text) {
      return text;
    }
    await sleep(20);
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}

function onceClosed(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for command close")), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
