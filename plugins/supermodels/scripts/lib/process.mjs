import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  return await runSpawnedCommand(command, options);
}

async function runSpawnedCommand(command, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const env = { ...process.env, ...(options.env ?? {}) };
  const killProcessGroup = process.platform !== "win32";
  const exitOnForwardSignal = options.exitOnForwardSignal ?? isBackgroundWorkerProcess(env);

  return await new Promise((resolve) => {
    const child = spawn(command.bin, command.args ?? [], {
      cwd: options.cwd ?? process.cwd(),
      env,
      detached: killProcessGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdinError = "";
    let timedOut = false;
    let timer;
    let killTimer;

    const signalHandlers = installForwardSignalHandlers(child, {
      exitOnForwardSignal,
      signalKillMs: options.signalKillMs,
    });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signalHandlers.cleanup();
    };

    timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), 1500);
      killTimer.unref();
    }, timeoutMs);

    const startAccepted = options.onStart?.({ pid: child.pid ?? null });
    if (startAccepted === false) {
      signalProcessTree(child.pid, "SIGTERM");
    }

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
      cleanup();
      resolve({
        exitCode: 127,
        stdout,
        stderr: `${stderr}${error.message}`,
        pid: child.pid ?? null,
        timedOut,
      });
    });

    child.on("close", (exitCode, signal) => {
      cleanup();
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

function installForwardSignalHandlers(child, options = {}) {
  const signalKillMs = options.signalKillMs ?? 1000;
  let forwarded = false;
  let forceTimer;
  let exitTimer;
  const forward = (signal) => {
    if (forwarded) {
      return;
    }
    forwarded = true;
    if (!child.pid) {
      if (options.exitOnForwardSignal) {
        process.exit(signalExitCode(signal));
      }
      return;
    }
    signalProcessTree(child.pid, signal);
    if (signalKillMs <= 0) {
      signalProcessTree(child.pid, "SIGKILL");
    } else {
      forceTimer = setTimeout(() => {
        signalProcessTree(child.pid, "SIGKILL");
      }, signalKillMs);
      forceTimer.unref();
    }
    if (options.exitOnForwardSignal) {
      exitTimer = setTimeout(() => {
        process.exit(signalExitCode(signal));
      }, signalKillMs + 100);
      exitTimer.unref();
    }
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return {
    cleanup() {
      clearTimeout(forceTimer);
      clearTimeout(exitTimer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function isBackgroundWorkerProcess(env = process.env) {
  return env.SUPERMODELS_BACKGROUND_WORKER === "1";
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

export async function processStartedAt(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0 || process.platform === "win32") {
    return "";
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 1000 });
    return stdout.trim().replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

export function isProcessAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
