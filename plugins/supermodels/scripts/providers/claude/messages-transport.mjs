const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

export class ClaudeOAuthMessagesTransport {
  constructor(options = {}) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.url ?? process.env.SUPERMODELS_CLAUDE_MESSAGES_URL ?? ANTHROPIC_MESSAGES_URL;
  }

  async messages(body, options = {}) {
    return await this.request(body, options, false);
  }

  async request(body, options, refreshed) {
    if (!this.credentials) {
      throw new Error("ClaudeOAuthMessagesTransport requires credentials.");
    }
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
        throw new Error(`Anthropic Messages request failed: ${response.status} ${bodyText}`);
      }
      return collectClaudeMessageEvents(parseAnthropicSseLines((await response.text()).split(/\r?\n/)));
    } finally {
      signal.cleanup();
    }
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
        id: "",
        name: "",
        argsJson: "",
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
      } else if (delta.type === "input_json_delta") {
        current.type ||= "tool_use";
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
      throw new Error(`Anthropic stream error: ${JSON.stringify(event.error ?? event)}`);
    }
  }

  const content = [];
  const toolCalls = [];
  for (const index of order) {
    const current = slots.get(index);
    if (current.type === "text" && current.text) {
      content.push({ type: "text", text: current.text });
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
