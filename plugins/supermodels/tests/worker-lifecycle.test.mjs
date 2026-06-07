import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { signalProcessTree } from "../scripts/lib/process.mjs";
import { buildReviewRequest, startWorkerJob } from "../scripts/lib/job-lifecycle.mjs";
import { createState, listJobs, readJob } from "../scripts/lib/state.mjs";

const execFileAsync = promisify(execFile);

test("foreground review runs in a dedicated worker process", { skip: process.platform === "win32" }, async () => {
  const fixture = await createFixture("supermodels-worker-foreground-");
  let workerPid = null;
  let cli;
  try {
    cli = spawnReview(fixture);

    const job = await waitForJob(fixture, (candidate) => candidate.providerRuns.claude?.status === "running");
    await fixture.server.requested;

    assert.equal(job.status, "running");
    workerPid = job.pid;
    assert.notEqual(job.pid, cli.pid);
  } finally {
    if (cli?.pid) {
      signalProcessTree(cli.pid, "SIGKILL");
    }
    if (workerPid) {
      signalProcessTree(workerPid, "SIGKILL");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fixture.cleanup();
  }
});

test("worker jobs persist explicit review context briefs", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supermodels-worker-brief-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const dataRoot = path.join(tempDir, "data");
  const scriptPath = path.join(tempDir, "idle-worker.mjs");
  let child = null;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(scriptPath, "setInterval(() => {}, 1000);\n", "utf8");
    const request = buildReviewRequest({
      command: "review",
      options: {},
      providerSelection: {
        explicit: true,
        requested: ["claude"],
      },
      focus: "brief persistence",
      contextBrief: "session context survives worker persistence",
    });

    const started = await startWorkerJob({
      scriptPath,
      workspaceRoot,
      dataRoot,
      request,
    });
    child = started.child;

    const persisted = await readJob(started.state, started.job.id);
    assert.equal(persisted.request.contextBrief, "session context survives worker persistence");
  } finally {
    if (child?.pid) {
      signalProcessTree(child.pid, "SIGKILL");
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function createFixture(prefix) {
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

function spawnReview(fixture) {
  const scriptPath = path.resolve(import.meta.dirname, "../scripts/supermodels.mjs");
  return spawn(process.execPath, [
    scriptPath,
    "review",
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
  const requested = new Promise((resolve) => {
    resolveRequested = resolve;
  });
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    resolveRequested();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    requested,
    url: `http://127.0.0.1:${address.port}/v1/messages`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for job state");
}
