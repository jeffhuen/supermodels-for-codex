import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findExecutable, runCommand } from "../scripts/lib/process.mjs";
import { withAbortTimeout } from "../scripts/lib/abort.mjs";

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
  let grandchildPid = null;
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

    // Robust-by-margin, NOT fully deterministic: testing an autonomous timeout
    // inherently races the tree's own setup. The timeout is generous enough that
    // the tree is established first under any realistic scheduling, and the
    // grandchild's real pid then proves the kill reached it (the pid check confirms
    // setup happened when it passes; it cannot make the timeout itself causal).
    const result = await runCommand({
      bin: process.execPath,
      args: ["-e", parentScript],
    }, {
      timeoutMs: 800,
    });

    assert.equal(result.timedOut, true);
    grandchildPid = Number(await readFile(pidPath, "utf8"));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "grandchild recorded its pid");
    await waitForDead(grandchildPid);
  } finally {
    // Never leak the infinite grandchild if the kill assertion failed.
    if (grandchildPid) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch { /* already dead */ }
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("withAbortTimeout aborts the operation exactly at its deadline (virtual clock)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = withAbortTimeout(() => new Promise(() => {}), 50, "probe");
  const rejection = assert.rejects(pending, /probe timed out after 50ms/);
  let settled = false;
  pending.catch(() => { settled = true; });
  t.mock.timers.tick(49);
  await Promise.resolve();
  assert.equal(settled, false, "must not abort before the deadline");
  t.mock.timers.tick(1);
  await rejection;
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
