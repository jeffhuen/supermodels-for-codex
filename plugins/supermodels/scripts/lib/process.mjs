import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import { spawn } from "node:child_process";

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
    options.onStart?.({ pid: child.pid ?? null });

    let stdout = "";
    let stderr = "";
    let stdinError = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child.pid, "SIGTERM");
      setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), 1500).unref();
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
