import { spawn } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { commandLine } from "../../lib/process.mjs";
import { decodeUtf8Prefix } from "../../lib/text.mjs";

const STDERR_LIMIT = 16 * 1024;
const THOUGHT_EMIT_THRESHOLD = 2000;
const CANCEL_GRACE_MS = 2000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const READ_FILE_LIMIT_BYTES = 1024 * 1024;
const READ_ONLY_REDIRECT_PROMPT = [
  "Supermodels policy notice: your previous action was denied because this task is read-only.",
  "Do not run shell commands or modify files.",
  "Complete the task using only your built-in file read and search tools, then report your findings.",
].join(" ");

// write: allow_once > allow_always > null (fail closed). read-only: first
// reject-kind option (reject_once/reject_always/...) > null (fail closed).
// A null decision is never defaulted to options[0] — the caller must respond
// with a cancelled outcome so an unrecognized or missing option set can never
// be silently approved (write) or silently allowed through (read-only).
export function grokAcpPermissionDecision(params, policy = {}) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const pick = policy.write
    ? options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always") ?? null
    : options.find((o) => String(o?.kind ?? "").startsWith("reject")) ?? null;
  return pick?.optionId ?? "";
}

// Line-buffered newline-delimited JSON-RPC 2.0 connection over a child process's stdio.
class JsonRpcConnection {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.requestHandlers = new Map();
    this.buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => this._onData(chunk));
  }

  _onData(chunk) {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          this._handleMessage(JSON.parse(line));
        } catch {
          // Ignore malformed lines rather than dropping the connection.
        }
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  _handleMessage(message) {
    if (message.method !== undefined) {
      if (message.id !== undefined) {
        this._handleIncomingRequest(message);
      } else {
        this.notificationHandlers.get(message.method)?.(message.params);
      }
      return;
    }
    const pending = message.id !== undefined ? this.pending.get(message.id) : null;
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(Object.assign(new Error(message.error.message || "JSON-RPC error"), {
        code: message.error.code,
        data: message.error.data,
      }));
    } else {
      pending.resolve(message.result);
    }
  }

  _handleIncomingRequest(message) {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this._write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(message.params))
      .then((result) => {
        this._write({ jsonrpc: "2.0", id: message.id, result: result ?? null });
      })
      .catch((error) => {
        this._write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: error?.code ?? -32000, message: error?.message ?? String(error) },
        });
      });
  }

  _write(payload) {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) {
      return;
    }
    try {
      stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // The child may already be gone; best-effort delivery only.
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }
}

function jsonRpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isWithinCwd(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

// Serve a workspace file to the agent's client-side fs capability safely:
// canonicalize both root and target so an in-workspace symlink can't escape
// containment, reject anything that isn't a regular file (no FIFOs/devices/
// dirs), and bound the read so a huge file can't exhaust worker memory.
export async function readWorkspaceTextFile(root, requestedPath, options = {}) {
  const maxBytes = options.maxBytes ?? READ_FILE_LIMIT_BYTES;
  const canonicalRoot = await realpath(root);
  const resolved = path.resolve(canonicalRoot, String(requestedPath ?? ""));
  const canonical = await realpath(resolved);
  if (!isWithinCwd(canonicalRoot, canonical)) {
    throw new Error("path outside workspace");
  }
  const info = await stat(canonical);
  if (!info.isFile()) {
    throw new Error("not a regular file");
  }
  const handle = await open(canonical, "r");
  try {
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { content: decodeUtf8Prefix(buffer, bytesRead), truncated: info.size > maxBytes };
  } finally {
    await handle.close();
  }
}

function buildUsage(meta) {
  const usage = {};
  if (!meta) {
    return usage;
  }
  const fields = { inputTokens: "input_tokens", outputTokens: "output_tokens", totalTokens: "total_tokens" };
  for (const [from, to] of Object.entries(fields)) {
    if (Number.isFinite(meta[from])) {
      usage[to] = meta[from];
    }
  }
  return usage;
}

function sumUsage(first, second) {
  const merged = { ...first };
  for (const [key, value] of Object.entries(second)) {
    merged[key] = Number.isFinite(merged[key]) ? merged[key] + value : value;
  }
  return merged;
}

// Ends the child's stdin (agents exit on EOF) and waits (bounded) for it to close.
async function finalizeChild(child, childClosed) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), CANCEL_GRACE_MS);
    timer.unref?.();
    childClosed.then((info) => {
      clearTimeout(timer);
      resolve(info);
    });
    try {
      child.stdin.end();
    } catch {
      // The child may already have exited.
    }
  });
}

export async function runGrokAcpTask(input, options = {}) {
  const startedAt = new Date().toISOString();
  const spawnImpl = options.spawnImpl ?? spawn;
  const bin = options.bin ?? "grok";
  const modelArgs = options.model ? ["-m", options.model] : [];
  const effortArgs = options.effort && options.effort !== "cli-default"
    ? ["--reasoning-effort", options.effort]
    : [];
  // Model/effort are options of the `agent` subcommand and must precede `stdio`.
  const args = ["agent", ...modelArgs, ...effortArgs, "stdio"];
  const resolvedCwd = path.resolve(options.cwd ?? process.cwd());
  const env = {
    ...process.env,
    GROK_SANDBOX: options.sandbox ?? (options.write ? "workspace" : "read-only"),
  };
  const commandLineStr = commandLine({ bin, args });

  const child = spawnImpl(bin, args, { cwd: options.cwd, env });

  return await new Promise((resolveOuter, rejectOuter) => {
    let settled = false;
    let timedOut = false;
    let permissionDenials = 0;
    let cancelTriggered = false;
    let killTimer = null;
    let timeoutTimer = null;
    let controllerUnsubscribe = () => {};
    let rawText = "";
    let sessionId = "";
    let stderrBuf = "";
    let thoughtChars = 0;
    const events = [];

    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      controllerUnsubscribe();
      fn(value);
    };
    const resolveOnce = (value) => settle(resolveOuter, value);

    child.on("error", (error) => settle(rejectOuter, error));
    options.onStart?.({ pid: child.pid ?? null });

    const connection = new JsonRpcConnection(child);

    const appendStderr = (error) => {
      const message = error?.message ?? String(error ?? "");
      if (!message) {
        return;
      }
      stderrBuf = `${stderrBuf}${stderrBuf ? "\n" : ""}${message}`.slice(-STDERR_LIMIT);
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderrBuf = (stderrBuf + chunk).slice(-STDERR_LIMIT);
    });
    // Async EPIPE (child dies mid-write, e.g. while a permission response is
    // in flight) surfaces as an 'error' event on stdin, not a synchronous
    // throw from _write(). Without a listener this is an uncaught exception
    // that crashes the host. Buffer it like any other diagnostic; never throw.
    child.stdin?.on("error", (error) => appendStderr(error));

    const emit = (event) => {
      events.push(event);
      options.onEvent?.(event);
    };

    connection.onNotification("session/update", (params) => {
      const update = params?.update ?? {};
      const at = new Date().toISOString();
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          rawText += update.content?.text ?? "";
          break;
        case "agent_thought_chunk": {
          const text = update.content?.text ?? "";
          thoughtChars += text.length;
          if (thoughtChars >= THOUGHT_EMIT_THRESHOLD) {
            thoughtChars = 0;
            emit({ type: "thinking", message: text.slice(0, 200), at });
          }
          break;
        }
        case "tool_call":
          emit({ type: "tool_call", message: `grok used ${update.title ?? "tool"}`, at });
          break;
        case "tool_call_update":
          if (update.status) {
            emit({ type: "progress", message: `grok tool ${update.status}`, at });
          }
          break;
        case "plan":
          emit({ type: "progress", message: "grok plan updated", at });
          break;
        default:
          break;
      }
    });

    connection.onRequest("fs/read_text_file", async (params) => {
      try {
        const { content } = await readWorkspaceTextFile(resolvedCwd, params?.path);
        return { content };
      } catch (error) {
        throw jsonRpcError(-32000, error?.message ?? String(error));
      }
    });

    connection.onRequest("session/request_permission", (params) => {
      const optionId = grokAcpPermissionDecision(params, { write: Boolean(options.write) });
      if (!optionId) {
        // Fail closed: no acceptable option (reject-kind for read-only,
        // allow_once/allow_always for write) was offered. Never fall back to
        // options[0] — cancel the permission request instead.
        permissionDenials += 1;
        emit({
          type: "progress",
          message: "grok permission denied (no acceptable option; failing closed)",
          at: new Date().toISOString(),
        });
        return { outcome: { outcome: "cancelled" } };
      }
      const rejected = (params?.options ?? []).some((option) =>
        option?.optionId === optionId && String(option?.kind ?? "").startsWith("reject"));
      if (rejected) {
        permissionDenials += 1;
      }
      emit({ type: "progress", message: `grok permission ${optionId}`, at: new Date().toISOString() });
      return { outcome: { outcome: "selected", optionId } };
    });

    const triggerCancel = (isTimeout) => {
      if (cancelTriggered) {
        return;
      }
      cancelTriggered = true;
      if (isTimeout) {
        timedOut = true;
      }
      connection.notify("session/cancel", { sessionId });
      killTimer = setTimeout(() => child.kill("SIGKILL"), CANCEL_GRACE_MS);
      killTimer.unref?.();
    };

    timeoutTimer = setTimeout(() => triggerCancel(true), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeoutTimer.unref?.();

    if (options.controller) {
      controllerUnsubscribe = options.controller.onCancel(() => triggerCancel(false));
      if (options.controller.cancelled) {
        triggerCancel(false);
      }
    }

    const childClosed = new Promise((resolve) => {
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });

    const guarded = (promise) => Promise.race([
      promise.then((result) => ({ kind: "ok", result }), (error) => ({ kind: "error", error })),
      childClosed.then((info) => ({ kind: "closed", info })),
    ]);

    const buildResult = ({ stopReason, usage, exitCode, signal }) => ({
      provider: "grok",
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      timedOut,
      rawText,
      stderr: stderrBuf,
      sessionId,
      pid: child.pid ?? null,
      commandLine: commandLineStr,
      structured: null,
      usage,
      events,
      startedAt,
      completedAt: new Date().toISOString(),
      stopReason,
    });

    const earlyResult = async (outcome) => {
      let exitCode = null;
      let signal = null;
      if (outcome.kind === "closed") {
        exitCode = outcome.info.exitCode;
        signal = outcome.info.signal;
      } else {
        appendStderr(outcome.error);
        ({ exitCode, signal } = await finalizeChild(child, childClosed));
      }
      return buildResult({ stopReason: "", usage: {}, exitCode, signal });
    };

    const run = async () => {
      const initOutcome = await guarded(connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
      }));
      if (initOutcome.kind !== "ok") {
        return await earlyResult(initOutcome);
      }

      const sessionOutcome = await guarded(connection.request("session/new", {
        cwd: resolvedCwd,
        mcpServers: [],
      }));
      if (sessionOutcome.kind !== "ok") {
        return await earlyResult(sessionOutcome);
      }
      sessionId = sessionOutcome.result?.sessionId ?? "";

      let promptOutcome = await guarded(connection.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: input.prompt }],
      }));

      if (promptOutcome.kind === "ok") {
        let stopReason = promptOutcome.result?.stopReason ?? "";
        let usage = buildUsage(promptOutcome.result?._meta);
        // A denial on a read-only task ends the turn as "cancelled"; give the
        // agent one redirect toward its permitted tools before giving up.
        // Never redirect once our own cancellation (controller-cancel or
        // timeout) has fired — that also stops the turn as "cancelled", and
        // starting a new session/prompt would race the kill timer.
        if (stopReason === "cancelled" && permissionDenials > 0 && !options.write && !cancelTriggered) {
          emit({
            type: "progress",
            message: "grok redirected after read-only policy denial",
            at: new Date().toISOString(),
          });
          const redirectOutcome = await guarded(connection.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: READ_ONLY_REDIRECT_PROMPT }],
          }));
          if (redirectOutcome.kind !== "ok") {
            return await earlyResult(redirectOutcome);
          }
          stopReason = redirectOutcome.result?.stopReason ?? "";
          usage = sumUsage(usage, buildUsage(redirectOutcome.result?._meta));
        }
        // Reap the child, but a client-initiated teardown after a successful
        // prompt is not a task failure — the real agent ignores stdin EOF and
        // has to be killed, which must not read as a failed run.
        await finalizeChild(child, childClosed);
        return buildResult({ stopReason, usage, exitCode: 0, signal: null });
      }
      return await earlyResult(promptOutcome);
    };

    run().then(resolveOnce, (error) => {
      appendStderr(error);
      resolveOnce(buildResult({
        stopReason: "",
        usage: {},
        exitCode: child.exitCode ?? null,
        signal: child.signalCode ?? null,
      }));
    });
  });
}
