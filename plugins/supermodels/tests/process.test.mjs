import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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

test("runCommand supervised mode starts after pid recording is accepted", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-supervised-start-"));
  const markerPath = path.join(tempDir, "started.txt");
  try {
    const result = await runCommand({
      bin: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started')`],
    }, {
      supervised: true,
      guardDir: tempDir,
      timeoutMs: 5_000,
      onStart: ({ pid }) => Number.isFinite(Number(pid)) && Number(pid) > 0,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(markerPath, "utf8"), "started");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCommand supervised mode does not start provider when pid recording is rejected", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-supervised-reject-"));
  const markerPath = path.join(tempDir, "started.txt");
  try {
    const result = await runCommand({
      bin: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started')`],
    }, {
      supervised: true,
      guardDir: tempDir,
      timeoutMs: 5_000,
      onStart: () => false,
    });

    assert.notEqual(result.exitCode, 0);
    await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
