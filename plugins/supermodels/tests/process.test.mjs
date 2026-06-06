import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

test("runCommand supervised mode keeps handoff files private and removes them", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-supervised-private-"));
  const markerPath = path.join(tempDir, "payload.json");
  const secret = "SUPERMODELS_TEST_SECRET_VALUE";
  const prompt = "sensitive prompt and diff content";
  let guardDir = "";
  try {
    const childScript = [
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; });",
      `process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ secret: process.env.SUPERMODELS_TEST_SECRET, input })));`,
    ].join(" ");
    const result = await runCommand({
      bin: process.execPath,
      args: ["-e", childScript],
    }, {
      supervised: true,
      guardDir: tempDir,
      input: prompt,
      env: { SUPERMODELS_TEST_SECRET: secret },
      timeoutMs: 5_000,
      onStart: ({ pid }) => {
        const dirs = readdirSync(tempDir).filter((entry) => entry.startsWith(".supermodels-supervisor-"));
        assert.equal(dirs.length, 1);
        guardDir = path.join(tempDir, dirs[0]);
        const specPath = path.join(guardDir, "spec.json");
        const specText = readFileSync(specPath, "utf8");
        assert.equal(statSync(guardDir).mode & 0o777, 0o700);
        assert.equal(statSync(specPath).mode & 0o777, 0o600);
        assert.equal(specText.includes(secret), false);
        assert.equal(specText.includes(prompt), false);
        assert.equal(existsSync(path.join(guardDir, "stdin.txt")), false);
        return Number.isFinite(Number(pid)) && Number(pid) > 0;
      },
    });

    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(await readFile(markerPath, "utf8"));
    assert.deepEqual(payload, { secret, input: prompt });
    assert.equal(existsSync(guardDir), false);
    const remaining = (await readdir(tempDir)).filter((entry) => entry.startsWith(".supermodels-supervisor-"));
    assert.deepEqual(remaining, []);
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
