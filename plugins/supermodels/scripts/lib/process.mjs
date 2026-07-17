import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

import { PROVIDER_SIGKILL_MS } from "./run-control.mjs";

const execFileAsync = promisify(execFile);

export async function findExecutable(bin, options = {}) {
  const env = options.env ?? process.env;
  const candidates = [
    ...(options.candidates ?? []),
    ...String(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin)),
    path.join(os.homedir(), ".local", "bin", bin),
    path.join("/usr/local/bin", bin),
  ];

  // Filesystem metadata calls are not abortable and a PATH entry can live on
  // a dead network mount. Probe in a killable child so provider readiness has
  // a real deadline, and require a regular executable target (directories can
  // also satisfy X_OK but are not runnable providers).
  const result = await runCommand({
    bin: process.execPath,
    args: ["-e", EXECUTABLE_PROBE_SCRIPT],
  }, {
    timeoutMs: options.executableLookupTimeoutMs ?? 5_000,
    env,
    input: JSON.stringify(candidates),
    signal: options.signal,
  });
  if (result.timedOut) {
    throw new Error(`Executable discovery for '${bin}' timed out.`);
  }
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error(`Executable discovery for '${bin}' was aborted.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Executable discovery for '${bin}' failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
  try {
    return JSON.parse(result.stdout || '""');
  } catch {
    throw new Error(`Executable discovery for '${bin}' returned invalid output.`);
  }
}

const EXECUTABLE_PROBE_SCRIPT = String.raw`
const fs = require("node:fs");
const candidates = JSON.parse(fs.readFileSync(0, "utf8"));
let found = "";
for (const candidate of candidates) {
  try {
    if (!fs.statSync(candidate).isFile()) continue;
    fs.accessSync(candidate, fs.constants.X_OK);
    found = candidate;
    break;
  } catch {}
}
process.stdout.write(JSON.stringify(found));
`;

export async function runCommand(command, options = {}) {
  return await runSpawnedCommand(command, options);
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

    let stdout = "";
    let stderr = "";
    let stdinError = "";
    let timedOut = false;
    let timer;
    let killTimer;
    const signalKillMs = options.signalKillMs ?? PROVIDER_SIGKILL_MS;
    let controllerUnsubscribe = () => {};
    let signalUnsubscribe = () => {};
    let forwardedSignal = false;
    const forwardSignal = (signal) => {
      if (forwardedSignal) {
        return;
      }
      forwardedSignal = true;
      signalProcessTree(child.pid, signal);
      if (signalKillMs <= 0) {
        signalProcessTree(child.pid, "SIGKILL");
      } else {
        killTimer = setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), signalKillMs);
        killTimer.unref();
      }
    };
    if (options.controller) {
      controllerUnsubscribe = options.controller.onCancel(forwardSignal);
      if (options.controller.cancelled) {
        forwardSignal(options.controller.signal ?? "SIGTERM");
      }
    }
    if (options.signal) {
      const onAbort = () => forwardSignal("SIGTERM");
      options.signal.addEventListener("abort", onAbort, { once: true });
      signalUnsubscribe = () => options.signal.removeEventListener("abort", onAbort);
      if (options.signal.aborted) {
        onAbort();
      }
    }
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      controllerUnsubscribe();
      signalUnsubscribe();
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
  return (await processStartedAtLookup(pid)).startedAt;
}

export async function processStartedAtLookup(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0 || process.platform === "win32") {
    return { startedAt: "", unavailable: true };
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 1000 });
    return { startedAt: stdout.trim().replace(/\s+/g, " "), unavailable: false };
  } catch (error) {
    return { startedAt: "", unavailable: error?.code === "ENOENT" };
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
