import { readGrokClientVersion } from "./oauth.mjs";
import { awaitAbortable, throwIfAborted } from "../../lib/abort.mjs";

const DEFAULT_RESPONSES_URL = "https://cli-chat-proxy.grok.com/v1/responses";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export function toGrokResponsesRequest(body = {}) {
  const request = {
    model: body.model,
    input: messagesToInput(body.messages ?? []),
  };
  const instructions = instructionsFrom(body.system);
  if (instructions) {
    request.instructions = instructions;
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = body.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));
  }
  if (body.tool_choice && body.tool_choice.type === "tool") {
    request.tool_choice = { type: "function", name: body.tool_choice.name };
  }
  if (body.max_tokens !== undefined) {
    request.max_output_tokens = body.max_tokens;
  }
  if (body.reasoning_effort !== undefined) {
    // The request is built fresh here (no spread of `body`), so the raw
    // `reasoning_effort` key never lands on `request` in the first place —
    // this branch only needs to add the translated `reasoning` field.
    request.reasoning = { effort: body.reasoning_effort };
  }
  return request;
}

export function collectGrokResponse(payload = {}) {
  const completion = grokCompletion(payload);
  const content = [];
  const toolCalls = [];
  for (const item of payload.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") {
          content.push({ type: "text", text: part.text });
        }
      }
      continue;
    }
    if (item.type === "function_call") {
      const id = item.call_id || item.id;
      const input = parseArguments(item.arguments);
      content.push({ type: "tool_use", id, name: item.name, input });
      toolCalls.push({ id, name: item.name, input });
      continue;
    }
    // "reasoning" items (and any other unrecognized item types) are never
    // round-tripped back to the caller.
  }
  if (!content.length && !toolCalls.length && (completion.status === "complete" || !payload.status)) {
    throw new Error("Empty Grok response: no output content or tool calls.");
  }
  return {
    content,
    tool_calls: toolCalls,
    text: content.filter((item) => item.type === "text").map((item) => item.text).join(""),
    usage: payload.usage,
    model: payload.model ?? "",
    stop_reason: completion.status === "complete"
      ? (toolCalls.length ? "tool_use" : "end_turn")
      : completion.reason,
    completion,
  };
}

function grokCompletion(payload) {
  const status = String(payload?.status ?? "").trim();
  if (status === "completed") {
    return { status: "complete", reason: "completed" };
  }
  const reason = String(payload?.incomplete_details?.reason ?? status).trim()
    || "missing-response-status";
  return { status: "incomplete", reason };
}

export function parseResponsesSseLines(lines) {
  let finalResponse = null;
  for (const raw of lines) {
    const line = String(raw ?? "");
    if (!line.startsWith("data: ")) {
      continue;
    }
    const payload = line.slice("data: ".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (["response.completed", "response.incomplete", "response.failed"].includes(event?.type)) {
      finalResponse = event.response ?? null;
    }
  }
  return finalResponse;
}

export class GrokOAuthResponsesTransport {
  constructor(options = {}) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.url ?? process.env.SUPERMODELS_GROK_RESPONSES_URL ?? DEFAULT_RESPONSES_URL;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.clientVersion = options.clientVersion;
    this.now = options.now ?? (() => Date.now());
  }

  async messages(body, options = {}) {
    return await this.request(body, options, false);
  }

  async request(body, options, refreshed, tokenOverride) {
    if (!this.credentials) {
      throw new Error("GrokOAuthResponsesTransport requires credentials.");
    }
    const attempt = options.retryAttempt ?? 0;
    // One absolute deadline for the whole call: retries and refreshes draw down
    // the same budget instead of each re-arming a fresh full timeout.
    const deadline = options.deadline ?? this.now() + (options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      throw new Error("Grok Responses request exceeded its overall deadline before completing.");
    }
    const nextOptions = { ...options, deadline };
    const signal = combineAbortSignals(options.signal, remaining);
    try {
      const clientVersion = await this.resolveClientVersion(signal.signal);
      const token = tokenOverride ?? await awaitAbortable(
        () => this.credentials.accessToken({ signal: signal.signal }),
        signal.signal,
      );
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: await this.buildHeaders(token, clientVersion, signal.signal),
        body: JSON.stringify({ ...toGrokResponsesRequest(body), stream: true }),
        signal: signal.signal,
      });
      if (response.status === 401) {
        if (!refreshed) {
          const refreshedToken = await awaitAbortable(
            () => this.credentials.forceRefresh({ signal: signal.signal }),
            signal.signal,
          );
          return await this.request(body, nextOptions, true, refreshedToken);
        }
        this.credentials.forceReload?.();
        throw new Error("Grok auth expired — run `grok login`.");
      }
      if (response.status === 426) {
        const bodyText = await response.text();
        throw new Error(`Grok CLI is too old for the chat proxy — run \`grok update\`, then retry. (${bodyText.slice(0, 200)})`);
      }
      if (!response.ok) {
        const bodyText = await response.text();
        if (isRetryableGrokStatus(response.status) && attempt < this.maxRetries) {
          await sleep(retryDelayMs(response, this.retryBaseDelayMs, this.retryMaxDelayMs, attempt), signal.signal);
          return await this.request(body, { ...nextOptions, retryAttempt: attempt + 1 }, refreshed, tokenOverride);
        }
        throw new Error(`Grok Responses request failed: ${response.status} ${bodyText}`);
      }
      const text = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const isSse = text.startsWith("data: ") || contentType.includes("text/event-stream");
      let responseJson;
      if (isSse) {
        responseJson = parseResponsesSseLines(text.split(/\r?\n/));
        if (responseJson === null) {
          if (attempt < this.maxRetries) {
            await sleep(retryDelayMs(response, this.retryBaseDelayMs, this.retryMaxDelayMs, attempt), signal.signal);
            return await this.request(body, { ...nextOptions, retryAttempt: attempt + 1 }, refreshed, tokenOverride);
          }
          throw new Error("Grok Responses stream ended without a response.completed event.");
        }
      } else {
        responseJson = JSON.parse(text);
      }
      return collectGrokResponse(responseJson);
    } finally {
      signal.cleanup();
    }
  }

  async resolveClientVersion(signal) {
    if (typeof this.clientVersion === "string" && this.clientVersion) {
      return this.clientVersion;
    }
    const resolved = await readGrokClientVersion({ signal });
    this.clientVersion = resolved || "0.0.0";
    return this.clientVersion;
  }

  async buildHeaders(token, clientVersion, signal) {
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": clientVersion,
      "x-grok-client-identifier": "grok-shell",
      "x-grok-client-mode": "headless",
      "user-agent": `grok-shell/${clientVersion} (${grokPlatformName()}; ${grokArchName()})`,
    };
    try {
      const identity = await awaitAbortable(
        () => this.credentials.identity({ signal }),
        signal,
      );
      if (identity?.userId) {
        headers["x-userid"] = identity.userId;
      }
      if (identity?.email) {
        headers["x-email"] = identity.email;
      }
    } catch {
      throwIfAborted(signal);
      // identity() failures must not fail the request; omit the identity headers.
    }
    return headers;
  }
}

function isRetryableGrokStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function grokPlatformName() {
  return process.platform === "darwin" ? "macos" : process.platform;
}

function grokArchName() {
  return process.arch === "arm64" ? "aarch64" : process.arch;
}

function retryDelayMs(response, fallbackMs, maxMs, attempt) {
  const header = response.headers.get("retry-after") ?? response.headers.get("Retry-After");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, maxMs);
    }
  }
  const delay = fallbackMs * (attempt + 1);
  return Math.min(Math.max(0, delay), maxMs);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Request aborted."));
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Request aborted."));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function combineAbortSignals(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? new Error("Request aborted."));
    }
  };
  if (parentSignal?.aborted) {
    abort();
  }
  parentSignal?.addEventListener?.("abort", abort, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("Request timed out."));
    }
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", abort);
    },
  };
}

function instructionsFrom(system) {
  if (!Array.isArray(system)) {
    return "";
  }
  return system.map((block) => stringValue(block?.text)).filter(Boolean).join("\n\n");
}

function messagesToInput(messages) {
  const input = [];
  for (const message of messages) {
    let textBlocks = [];
    const flushText = () => {
      if (textBlocks.length) {
        input.push({
          type: "message",
          role: message.role,
          content: textBlocks.map((text) => ({
            type: message.role === "assistant" ? "output_text" : "input_text",
            text,
          })),
        });
        textBlocks = [];
      }
    };
    for (const block of message.content ?? []) {
      if (block.type === "text") {
        textBlocks.push(block.text);
        continue;
      }
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        continue;
      }
      flushText();
      if (block.type === "tool_use") {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        });
      }
    }
    flushText();
  }
  return input;
}

function parseArguments(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function stringValue(value) {
  return typeof value === "string" && value ? value : "";
}
