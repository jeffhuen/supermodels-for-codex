import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunController } from "../scripts/lib/run-control.mjs";
import { findExecutable, runCommand, signalProcessTree } from "../scripts/lib/process.mjs";

test("findExecutable returns only regular executable files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-executable-probe-"));
  const directoryName = `directory-provider-${process.pid}`;
  const fileName = `file-provider-${process.pid}`;
  try {
    await mkdir(path.join(tempDir, directoryName), { mode: 0o755 });
    await writeFile(path.join(tempDir, fileName), "probe\n", { mode: 0o755 });
    const env = { ...process.env, PATH: tempDir };

    assert.equal(await findExecutable(directoryName, { env }), "");
    assert.equal(await findExecutable(fileName, { env }), path.join(tempDir, fileName));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

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

test("runCommand timeout terminates provider subprocesses", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-process-tree-"));
  const pidPath = path.join(tempDir, "grandchild.pid");
  try {
    // The grandchild records its REAL pid at startup and stays alive.
    const childScript = [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join(" ");

    // A generous timeout so the whole tree is provably established before the kill
    // (the old 100ms raced tree setup and occasionally let the grandchild escape).
    const result = await runCommand({
      bin: process.execPath,
      args: ["-e", parentScript],
    }, {
      timeoutMs: 800,
    });

    assert.equal(result.timedOut, true);
    // Causal: read the grandchild's actual pid, then confirm the timeout kill
    // reached it — poll until the pid no longer exists (SIGKILL is immediate).
    const grandchildPid = Number(await readFile(pidPath, "utf8"));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "grandchild recorded its pid");
    await waitForDead(grandchildPid);
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

test("runCommand forwards controller cancellation without exiting the parent", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-controller-signal-"));
  const markerPath = path.join(tempDir, "provider-survived.txt");
  try {
    // Install the SIGTERM handler, THEN emit ready — so "ready" causally guarantees
    // the handler exists before we cancel; otherwise SIGTERM could terminate the
    // provider before its handler is installed, producing SIGTERM not SIGKILL.
    const providerScript = [
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('ready\\n');",
      `setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, 'survived'), 900);`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const controller = createRunController();
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    const command = runCommand({
      bin: process.execPath,
      args: ["-e", providerScript],
    }, {
      timeoutMs: 10_000,
      signalKillMs: 0,
      controller,
      onStdout: (chunk) => { if (String(chunk).includes("ready")) markReady(); },
    });

    await ready; // causal: the SIGTERM handler is installed
    assert.equal(controller.cancel("SIGTERM"), true);
    const result = await command;

    // The command resolves only after the provider process has exited, so it can no
    // longer write its 900ms marker — the SIGTERM was ignored and SIGKILL won.
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, "SIGKILL");
    await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCommand forwards AbortSignal cancellation to the subprocess", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const abort = new AbortController();
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const command = runCommand({
    bin: process.execPath,
    // Install the SIGTERM handler FIRST, then announce readiness — so "ready"
    // causally guarantees the handler is in place (the write runs after the
    // handler line). Otherwise the abort could land SIGTERM before the handler
    // exists and terminate the child with SIGTERM instead of the expected SIGKILL.
    args: ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
  }, {
    timeoutMs: 10_000,
    signalKillMs: 0,
    signal: abort.signal,
    onStdout: (chunk) => { if (String(chunk).includes("ready")) markReady(); },
  });

  await ready; // deterministic: the child has executed and is running
  abort.abort(new Error("deadline"));
  const result = await command;

  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.timedOut, false);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll until a pid no longer exists (SIGKILL is immediate; a brief zombie window
// clears once its reparented init reaps it), with a hard cap so a failure to kill
// fails fast instead of hanging.
async function waitForDead(pid, { timeoutMs = 5_000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0); // signal 0: existence check only
    } catch (error) {
      if (error.code === "ESRCH") {
        return; // no such process — dead
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}
