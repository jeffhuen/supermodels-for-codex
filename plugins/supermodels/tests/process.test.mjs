import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runCommand, signalProcessTree } from "../scripts/lib/process.mjs";

test("runCommand handles stdin pipe errors when child exits early", async () => {
  const result = await runCommand({
    bin: process.execPath,
    args: ["-e", "process.exit(0)"],
  }, {
    input: "x".repeat(8 * 1024 * 1024),
    timeoutMs: 5000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test("runCommand timeout terminates provider subprocesses", { skip: process.platform === "win32" }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-process-tree-"));
  const markerPath = path.join(tempDir, "survived.txt");
  try {
    const childScript = [
      "const { writeFileSync } = require('node:fs');",
      `setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, 'survived'), 500);`,
    ].join(" ");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join(" ");

    const result = await runCommand({
      bin: process.execPath,
      args: ["-e", parentScript],
    }, {
      timeoutMs: 100,
    });
    await sleep(900);

    assert.equal(result.timedOut, true);
    await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("signalProcessTree terminates a detached provider subprocess group", { skip: process.platform === "win32" }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-process-cancel-"));
  const markerPath = path.join(tempDir, "survived.txt");
  try {
    const childScript = [
      "const { writeFileSync } = require('node:fs');",
      `setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, 'survived'), 500);`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' });`,
      "console.log(child.pid);",
    ].join(" ");

    const result = await runCommand({
      bin: process.execPath,
      args: ["-e", parentScript],
    }, {
      timeoutMs: 5_000,
      onStdout: (chunk) => {
        const pid = Number(String(chunk).trim());
        if (pid) {
          signalProcessTree(pid, "SIGTERM");
        }
      },
    });
    await sleep(900);

    assert.equal(result.exitCode, 0);
    await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCommand force-kills provider child when worker receives SIGTERM", { skip: process.platform === "win32" }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-worker-signal-"));
  const markerPath = path.join(tempDir, "provider-survived.txt");
  try {
    const providerScript = [
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, 'survived'), 900);`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const processLib = path.resolve(import.meta.dirname, "../scripts/lib/process.mjs");
    const workerScript = [
      `import { runCommand } from ${JSON.stringify(pathToFileURL(processLib).href)};`,
      "await runCommand({",
      `  bin: ${JSON.stringify(process.execPath)},`,
      `  args: ['-e', ${JSON.stringify(providerScript)}],`,
      "}, {",
      "  timeoutMs: 10_000,",
      "  exitOnForwardSignal: true,",
      "  signalKillMs: 0,",
      "  onStart: () => { console.log('READY'); },",
      "});",
    ].join("\n");

    const worker = spawn(process.execPath, ["--input-type=module", "-e", workerScript], {
      cwd: tempDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForStdout(worker, "READY");
    worker.kill("SIGTERM");
    await onceClosed(worker);
    await sleep(1000);

    await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCommand exits after forwarded signal even when provider child exits quickly", { skip: process.platform === "win32" }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-worker-exit-"));
  let worker;
  try {
    const providerScript = [
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const processLib = path.resolve(import.meta.dirname, "../scripts/lib/process.mjs");
    const workerScript = [
      `import { runCommand } from ${JSON.stringify(pathToFileURL(processLib).href)};`,
      "await runCommand({",
      `  bin: ${JSON.stringify(process.execPath)},`,
      `  args: ['-e', ${JSON.stringify(providerScript)}],`,
      "}, {",
      "  timeoutMs: 10_000,",
      "  exitOnForwardSignal: true,",
      "  signalKillMs: 50,",
      "  onStart: () => { console.log('READY'); },",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    worker = spawn(process.execPath, ["--input-type=module", "-e", workerScript], {
      cwd: tempDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForStdout(worker, "READY");
    worker.kill("SIGTERM");

    const closed = await onceClosed(worker, 1000);
    assert.equal(closed.code, 143);
  } finally {
    if (worker?.pid) {
      signalProcessTree(worker.pid, "SIGKILL");
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForStdout(child, expected) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}. stdout=${stdout}`)), 5000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(expected)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (!stdout.includes(expected)) {
        clearTimeout(timer);
        reject(new Error(`Worker closed before ${expected}: code=${code} signal=${signal} stdout=${stdout}`));
      }
    });
  });
}

function onceClosed(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for child close")), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
