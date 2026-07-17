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

test("runCommand forwards controller cancellation without exiting the parent", { skip: process.platform === "win32" }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-controller-signal-"));
  const markerPath = path.join(tempDir, "provider-survived.txt");
  try {
    const providerScript = [
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, 'survived'), 900);`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const controller = createRunController();
    const command = runCommand({
      bin: process.execPath,
      args: ["-e", providerScript],
    }, {
      timeoutMs: 10_000,
      signalKillMs: 0,
      controller,
    });

    await sleep(100);
    assert.equal(controller.cancel("SIGTERM"), true);
    const result = await command;
    await sleep(1000);

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
    // Announce readiness, ignore SIGTERM, then run forever — so we abort a
    // subprocess that is PROVABLY running (not a fixed-sleep guess) and assert
    // it is force-killed.
    args: ["-e", "process.stdout.write('ready\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
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
