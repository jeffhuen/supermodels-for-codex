import { access, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_PATH = path.join(__dirname, "process-supervisor.mjs");

export async function findExecutable(bin, options = {}) {
  const env = options.env ?? process.env;
  const candidates = [
    ...(options.candidates ?? []),
    ...String(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin)),
    path.join(os.homedir(), ".local", "bin", bin),
    path.join("/usr/local/bin", bin),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning.
    }
  }

  return "";
}

export async function runCommand(command, options = {}) {
  if (options.supervised) {
    return await runSupervisedCommand(command, options);
  }
  return await runSpawnedCommand(command, options);
}

async function runSupervisedCommand(command, options = {}) {
  const guardRoot = options.guardDir
    ? path.resolve(options.guardDir)
    : await mkdtemp(path.join(os.tmpdir(), "supermodels-command-"));
  const guardDir = await mkdtemp(path.join(guardRoot, ".supermodels-supervisor-"));
  const armPath = path.join(guardDir, "armed");
  const abortPath = path.join(guardDir, "abort");
  const specPath = path.join(guardDir, "spec.json");
  const inputPath = options.input === undefined ? "" : path.join(guardDir, "stdin.txt");
  if (inputPath) {
    await writeFile(inputPath, String(options.input));
  }
  await writeFile(specPath, `${JSON.stringify({
    command,
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    inputPath,
    armPath,
    abortPath,
  })}\n`);

  let startAccepted = true;
  return await runSpawnedCommand({
    bin: process.execPath,
    args: [SUPERVISOR_PATH, specPath],
  }, {
    ...options,
    input: undefined,
    onStart: (start) => {
      startAccepted = options.onStart?.(start) !== false;
      if (startAccepted) {
        writeFile(armPath, "armed\n").catch(() => {});
      } else {
        writeFile(abortPath, "abort\n").catch(() => {});
      }
    },
    onStderr: options.onStderr,
    onStdout: options.onStdout,
    timeoutMs: options.timeoutMs,
  }).then((result) => {
    if (!startAccepted && !result.stderr) {
      return {
        ...result,
        exitCode: result.exitCode || 127,
        stderr: "Provider supervisor PID was not recorded; provider was not started.",
      };
    }
    return result;
  });
}

async function runSpawnedCommand(command, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const env = { ...process.env, ...(options.env ?? {}) };
  const killProcessGroup = process.platform !== "win32";

  return await new Promise((resolve) => {
    const child = spawn(command.bin, command.args ?? [], {
      cwd: options.cwd ?? process.cwd(),
      env,
      detached: killProcessGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const startAccepted = options.onStart?.({ pid: child.pid ?? null });
    if (startAccepted === false) {
      signalProcessTree(child.pid, "SIGTERM");
    }

    let stdout = "";
    let stderr = "";
    let stdinError = "";
    let timedOut = false;
    let killTimer;

    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), 1500);
      killTimer.unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    child.stdin.on("error", (error) => {
      stdinError ||= error?.message || String(error);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        exitCode: 127,
        stdout,
        stderr: `${stderr}${error.message}`,
        pid: child.pid ?? null,
        timedOut,
      });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr: stdinError && exitCode !== 0 ? `${stderr}${stdinError}` : stderr,
        pid: child.pid ?? null,
        timedOut,
      });
    });

    try {
      if (options.input !== undefined && child.stdin.writable) {
        child.stdin.write(options.input);
      }
      if (child.stdin.writable) {
        child.stdin.end();
      }
    } catch (error) {
      stdinError ||= error?.message || String(error);
      child.stdin.destroy();
    }
  });
}

export function commandLine(command) {
  return [command.bin, ...(command.args ?? [])]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

export function signalProcessTree(pid, signal = "SIGTERM") {
  if (!pid) {
    return false;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall back to direct process signaling below.
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
