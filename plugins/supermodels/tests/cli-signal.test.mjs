import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { signalProcessTree } from "../scripts/lib/process.mjs";
import { createState, listJobs } from "../scripts/lib/state.mjs";

const execFileAsync = promisify(execFile);

test("live review aborts the direct provider request before exiting on Ctrl+C", { skip: process.platform === "win32" }, async () => {
  const fixture = await createCliFixture("supermodels-live-signal-");
  let cli;
  try {
    cli = spawnReview(fixture, ["--live"]);

    await waitForStdout(cli, "Started Supermodels live review");
    await fixture.server.requested;
    const closedPromise = onceClosed(cli, 3000);
    cli.kill("SIGINT");
    const closed = await closedPromise;

    assert.equal(closed.code, 130);
    await withTimeout(fixture.server.requestClosed, 3000, "provider request was not aborted");

    const jobs = await listJobs(createState({ workspaceRoot: fixture.repoRoot, dataRoot: fixture.dataRoot }));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "cancelled");
    assert.equal(jobs[0].providerRuns.claude.status, "cancelled");
  } finally {
    await cleanupCli(cli);
    await fixture.cleanup();
  }
});

test("foreground review records Ctrl+C as cancelled for direct provider requests", { skip: process.platform === "win32" }, async () => {
  const fixture = await createCliFixture("supermodels-foreground-signal-");
  let cli;
  try {
    cli = spawnReview(fixture);

    await waitForJob(fixture, (job) => job.providerRuns.claude?.status === "running");
    await fixture.server.requested;
    const closedPromise = onceClosed(cli, 3000);
    cli.kill("SIGINT");
    const closed = await closedPromise;

    assert.equal(closed.code, 130);
    await withTimeout(fixture.server.requestClosed, 3000, "provider request was not aborted");

    const jobs = await listJobs(createState({ workspaceRoot: fixture.repoRoot, dataRoot: fixture.dataRoot }));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "cancelled");
    assert.equal(jobs[0].providerRuns.claude.status, "cancelled");
  } finally {
    await cleanupCli(cli);
    await fixture.cleanup();
  }
});

async function createCliFixture(prefix) {
  const tempDir = await mkdtemp(path.join(tmpdir(), prefix));
  const binDir = path.join(tempDir, "bin");
  const dataRoot = path.join(tempDir, "data");
  const credentialsPath = path.join(tempDir, "claude-credentials.json");
  const repoRoot = await createWorkspaceRepo(tempDir);
  const server = await createBlockingMessagesServer();
  await mkdir(binDir, { recursive: true });
  await writeFakeClaudeStatus(binDir);
  await writeClaudeCredentials(credentialsPath);
  return {
    tempDir,
    binDir,
    dataRoot,
    credentialsPath,
    repoRoot,
    server,
    async cleanup() {
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function createWorkspaceRepo(tempDir) {
  const repoRoot = path.join(tempDir, "workspace");
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "sample.mjs"), "export const value = 1;\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "sample.mjs"), "export const value = 2;\n", "utf8");
  return await realpath(repoRoot);
}

function spawnReview(fixture, extraArgs = []) {
  const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
  return spawn(process.execPath, [
    scriptPath,
    "review",
    ...extraArgs,
    "--provider",
    "claude",
    "--data-root",
    fixture.dataRoot,
  ], {
    cwd: fixture.repoRoot,
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      CLAUDE_CODE_AUTH_PATH: fixture.credentialsPath,
      SUPERMODELS_CLAUDE_MESSAGES_URL: fixture.server.url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function writeFakeClaudeStatus(binDir) {
  const fakeClaude = path.join(binDir, "claude");
  await writeFile(fakeClaude, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('2.1.162 (Claude Code)'); process.exit(0); }",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));",
    "  process.exit(0);",
    "}",
    "console.error('unexpected fake claude invocation: ' + args.join(' '));",
    "process.exit(2);",
  ].join("\n"));
  await chmod(fakeClaude, 0o755);
}

async function writeClaudeCredentials(credentialsPath) {
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference"],
    },
  }), "utf8");
}

async function createBlockingMessagesServer() {
  let resolveRequested;
  let resolveClosed;
  const requested = new Promise((resolve) => {
    resolveRequested = resolve;
  });
  const requestClosed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    resolveRequested();
    req.on("close", () => {
      resolveClosed();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    requested,
    requestClosed,
    url: `http://127.0.0.1:${address.port}/v1/messages`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function waitForStdout(child, expected) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}. stdout=${stdout} stderr=${stderr}`)), 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(expected)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (!stdout.includes(expected)) {
        clearTimeout(timer);
        reject(new Error(`Command closed before ${expected}: code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
      }
    });
  });
}

async function waitForJob(fixture, predicate, timeoutMs = 15_000) {
  const state = createState({ workspaceRoot: fixture.repoRoot, dataRoot: fixture.dataRoot });
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const jobs = await listJobs(state);
    const job = jobs[0];
    if (job && predicate(job)) {
      return job;
    }
    await sleep(20);
  }
  assert.fail("Timed out waiting for job state");
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

async function cleanupCli(cli) {
  if (cli?.pid) {
    signalProcessTree(cli.pid, "SIGKILL");
  }
  await sleep(200);
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
