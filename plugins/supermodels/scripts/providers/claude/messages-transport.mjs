const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

export class ClaudeOAuthMessagesTransport {
  constructor(options = {}) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.url ?? process.env.SUPERMODELS_CLAUDE_MESSAGES_URL ?? ANTHROPIC_MESSAGES_URL;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  }

  async messages(body, options = {}) {
    return await this.request(body, options, false);
  }

  async request(body, options, refreshed) {
    if (!this.credentials) {
      throw new Error("ClaudeOAuthMessagesTransport requires credentials.");
    }
    const attempt = options.retryAttempt ?? 0;
    const timeoutMs = options.timeoutMs ?? 600_000;
    const signal = combineAbortSignals(options.signal, timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.credentials.accessToken()}`,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": OAUTH_BETA,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: signal.signal,
      });
      if (response.status === 401 && !refreshed) {
        await refreshCredentials(this.credentials);
        return await this.request(body, options, true);
      }
      if (!response.ok) {
        const bodyText = await response.text();
        if (isRetryableAnthropicStatus(response.status) && attempt < this.maxRetries) {
          await sleep(retryDelayMs(response, this.retryBaseDelayMs, this.retryMaxDelayMs, attempt), signal.signal);
          return await this.request(body, { ...options, retryAttempt: attempt + 1 }, refreshed);
        }
        throw new Error(`Anthropic Messages request failed: ${response.status} ${bodyText}`);
      }
      try {
        return collectClaudeMessageEvents(parseAnthropicSseLines((await response.text()).split(/\r?\n/)));
      } catch (error) {
        if (isRetryableAnthropicStreamError(error) && attempt < this.maxRetries) {
          await sleep(retryDelayMs(response, this.retryBaseDelayMs, this.retryMaxDelayMs, attempt), signal.signal);
          return await this.request(body, { ...options, retryAttempt: attempt + 1 }, refreshed);
        }
        throw error;
      }
    } finally {
      signal.cleanup();
    }
  }
}

class AnthropicStreamError extends Error {
  constructor(error) {
    super(`Anthropic stream error: ${JSON.stringify(error)}`);
    this.name = "AnthropicStreamError";
    this.errorType = typeof error?.type === "string" ? error.type : "";
    this.providerError = error;
  }
}

export function* parseAnthropicSseLines(lines) {
  for (const raw of lines) {
    const line = String(raw ?? "");
    if (!line.startsWith("data: ")) {
      continue;
    }
    const payload = line.slice("data: ".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      yield JSON.parse(payload);
    } catch {
      // Drop malformed chunks; missing output is classified by the caller.
    }
  }
}

export function collectClaudeMessageEvents(events) {
  const slots = new Map();
  const order = [];
  let model = "";
  let usage = {};
  let stopReason = null;

  const slot = (index) => {
    if (!slots.has(index)) {
      slots.set(index, {
        type: "",
        text: "",
        thinking: "",
        signature: "",
        data: "",
        id: "",
        name: "",
        argsJson: "",
        argsFromDelta: false,
      });
      order.push(index);
    }
    return slots.get(index);
  };

  for (const event of events) {
    const kind = event?.type;
    if (kind === "message_start") {
      const message = event.message ?? {};
      model = typeof message.model === "string" ? message.model : model;
      if (message.usage && typeof message.usage === "object") {
        usage = { ...usage, ...message.usage };
      }
      continue;
    }
    if (kind === "content_block_start") {
      const index = Number(event.index);
      if (!Number.isInteger(index)) {
        continue;
      }
      const block = event.content_block ?? {};
      const current = slot(index);
      current.type = typeof block.type === "string" ? block.type : current.type;
      if (current.type === "text") {
        current.text += typeof block.text === "string" ? block.text : "";
      }
      if (current.type === "thinking") {
        current.thinking += typeof block.thinking === "string" ? block.thinking : "";
        current.signature = typeof block.signature === "string" ? block.signature : current.signature;
      }
      if (current.type === "redacted_thinking") {
        current.data = typeof block.data === "string" ? block.data : current.data;
      }
      if (current.type === "tool_use") {
        current.id = typeof block.id === "string" ? block.id : current.id;
        current.name = typeof block.name === "string" ? block.name : current.name;
        if (block.input && typeof block.input === "object" && !Array.isArray(block.input)) {
          current.argsJson = Object.keys(block.input).length ? JSON.stringify(block.input) : current.argsJson;
        }
      }
      continue;
    }
    if (kind === "content_block_delta") {
      const index = Number(event.index);
      if (!Number.isInteger(index)) {
        continue;
      }
      const current = slot(index);
      const delta = event.delta ?? {};
      if (delta.type === "text_delta") {
        current.type ||= "text";
        current.text += typeof delta.text === "string" ? delta.text : "";
      } else if (delta.type === "thinking_delta") {
        current.type ||= "thinking";
        current.thinking += typeof delta.thinking === "string" ? delta.thinking : "";
      } else if (delta.type === "signature_delta") {
        current.type ||= "thinking";
        current.signature = typeof delta.signature === "string" ? delta.signature : current.signature;
      } else if (delta.type === "input_json_delta") {
        current.type ||= "tool_use";
        if (!current.argsFromDelta) {
          current.argsJson = "";
          current.argsFromDelta = true;
        }
        current.argsJson += typeof delta.partial_json === "string" ? delta.partial_json : "";
      }
      continue;
    }
    if (kind === "message_delta") {
      const delta = event.delta ?? {};
      stopReason = typeof delta.stop_reason === "string" ? delta.stop_reason : stopReason;
      if (event.usage && typeof event.usage === "object") {
        usage = { ...usage, ...event.usage };
      }
      continue;
    }
    if (kind === "error") {
      throw new AnthropicStreamError(event.error ?? event);
    }
  }

  const content = [];
  const toolCalls = [];
  for (const index of order) {
    const current = slots.get(index);
    if (current.type === "text" && current.text) {
      content.push({ type: "text", text: current.text });
    }
    if (current.type === "thinking" && (current.thinking || current.signature)) {
      content.push({
        type: "thinking",
        ...(current.thinking ? { thinking: current.thinking } : {}),
        ...(current.signature ? { signature: current.signature } : {}),
      });
    }
    if (current.type === "redacted_thinking" && current.data) {
      content.push({ type: "redacted_thinking", data: current.data });
    }
    if (current.type === "tool_use" && current.id && current.name) {
      const input = decodeArgs(current.argsJson);
      content.push({
        type: "tool_use",
        id: current.id,
        name: current.name,
        input,
      });
      toolCalls.push({
        id: current.id,
        name: current.name,
        input,
      });
    }
  }
  if (!content.length && !toolCalls.length) {
    throw new Error("Empty Claude response: stream ended without content or tool calls.");
  }

  return {
    content,
    tool_calls: toolCalls,
    text: content.filter((item) => item.type === "text").map((item) => item.text).join(""),
    usage,
    model,
    stop_reason: stopReason,
  };
}

function decodeArgs(value) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRetryableAnthropicStatus(status) {
  return status === 529 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableAnthropicStreamError(error) {
  return error?.name === "AnthropicStreamError"
    && ["overloaded_error", "api_error"].includes(error.errorType);
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
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", abort);
    },
  };
}

async function refreshCredentials(credentials) {
  if (credentials.forceRefresh) {
    await credentials.forceRefresh();
    return;
  }
  credentials.forceReload?.();
}
