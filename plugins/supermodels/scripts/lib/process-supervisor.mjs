import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const specPath = process.argv[2];

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(127);
});

async function main() {
  if (!specPath) {
    throw new Error("Missing supervisor spec path.");
  }
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  const startSignal = await waitForStartSignal(spec.armPath, spec.abortPath, 5_000);
  if (startSignal !== "armed") {
    process.stderr.write("Supermodels supervisor was not armed; provider was not started.\n");
    process.exit(127);
  }

  const child = spawn(spec.command.bin, spec.command.args ?? [], {
    cwd: spec.cwd || process.cwd(),
    env: process.env,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const terminate = (signal) => {
    signalChild(child.pid, signal);
  };
  process.once("SIGTERM", () => terminate("SIGTERM"));
  process.once("SIGINT", () => terminate("SIGINT"));

  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on("error", (error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exit(127);
  });
  child.on("close", (exitCode, signal) => {
    process.exit(exitCode ?? signalExitCode(signal));
  });

  child.stdin.on("error", () => {});
  process.stdin.pipe(child.stdin);
}

async function waitForStartSignal(armPath, abortPath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await access(armPath);
      return "armed";
    } catch {
      // Keep checking.
    }
    try {
      await access(abortPath);
      return "aborted";
    } catch {
      await sleep(10);
    }
  }
  return "timeout";
}

function signalChild(pid, signal) {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // The child may already be gone.
  }
}

function signalExitCode(signal) {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
