import { randomBytes } from "node:crypto";

// This is the Cloud Code Assist endpoint used by the AGY/Gemini CLI family.
// It looks like a staging hostname, but the OAuth token from the native CLI is
// scoped for this v1internal service.
const DEFAULT_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const USER_AGENT = "google-cloud-sdk vscode_cloudshelleditor/0.1";
const API_CLIENT = "gl-node/22.17.0";
const DEFAULT_RPM = 3;
const DEFAULT_BURST = 1;
const MIN_RATE_LIMIT_WAIT_MS = 8_000;
const MAX_RATE_LIMIT_WAIT_MS = 90_000;
const CLIENT_METADATA = JSON.stringify({
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "ANTIGRAVITY",
});

export class AntigravityCodeAssistTransport {
  constructor(options = {}) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? process.env.SUPERMODELS_ANTIGRAVITY_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.projectIdValue = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT_ID ?? "";
    this.projectDiscovery = null;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 2000;
    this.retryMinDelayMs = options.retryMinDelayMs ?? MIN_RATE_LIMIT_WAIT_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? MAX_RATE_LIMIT_WAIT_MS;
    this.rateLimiter = options.rateLimiter ?? new AsyncTokenBucket({
      rpm: numberFromEnv("SUPERMODELS_ANTIGRAVITY_RPM", options.rateLimitRpm ?? DEFAULT_RPM),
      burst: numberFromEnv("SUPERMODELS_ANTIGRAVITY_BURST", options.rateLimitBurst ?? DEFAULT_BURST),
    });
  }

  async messages(body, options = {}) {
    if (!this.credentials) {
      throw new Error("AntigravityCodeAssistTransport requires credentials.");
    }
    return await this.request(body, options, false);
  }

  async request(body, options, refreshed) {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const signal = combineAbortSignals(options.signal, timeoutMs);
    try {
      const request = toCodeAssistRequest(body);
      const project = await this.projectId({ signal: signal.signal, timeoutMs });
      const envelope = {
        model: mapAntigravityModel(body.model),
        userAgent: "supermodels-antigravity",
        requestId: `tag-${Date.now()}-${randomBytes(4).toString("hex")}`,
        request,
        ...(project ? { project } : {}),
      };
      await this.rateLimiter.take(signal.signal);
      const response = await this.fetchImpl(`${this.baseUrl}/v1internal:generateContent`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.credentials.accessToken()}`,
          "User-Agent": USER_AGENT,
          "x-goog-api-client": API_CLIENT,
          "client-metadata": CLIENT_METADATA,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(envelope),
        signal: signal.signal,
      });
      if (response.status === 401 && !refreshed) {
        this.credentials.forceReload?.();
        return await this.request(body, options, true);
      }
      if (!response.ok) {
        const bodyText = await response.text();
        const attempt = options.retryAttempt ?? 0;
        if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
          const delayMs = this.retryDelayMs(response, bodyText, attempt);
          if (delayMs !== null) {
            await sleep(delayMs, signal.signal);
            return await this.request(body, { ...options, retryAttempt: attempt + 1 }, refreshed);
          }
        }
        throw new Error(`Cloud Code Assist request failed: ${response.status} ${bodyText}`);
      }
      const data = await response.json();
      return collectAntigravityResponse(data.response ?? data);
    } finally {
      signal.cleanup();
    }
  }

  async projectId(options = {}) {
    if (this.projectIdValue) {
      return this.projectIdValue;
    }
    this.projectDiscovery ??= this.discoverProject(options).catch((error) => {
      this.projectDiscovery = null;
      throw error;
    });
    this.projectIdValue = await this.projectDiscovery;
    return this.projectIdValue;
  }

  async discoverProject(options = {}) {
    const body = await this.postJson("v1internal:loadCodeAssist", {}, options, false);
    if (body.status === "USER_NOT_ONBOARDED") {
      await this.postJson("v1internal:onboardUser", {}, options, false).catch(() => null);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await sleep(1000, options.signal);
        const polled = await this.postJson("v1internal:loadCodeAssist", {}, options, false);
        const project = extractProjectId(polled);
        if (project) {
          return project;
        }
      }
      return "";
    }
    return extractProjectId(body);
  }

  async postJson(path, body, options = {}, refreshed) {
    await this.rateLimiter.take(options.signal);
    const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.credentials.accessToken()}`,
        "User-Agent": USER_AGENT,
        "x-goog-api-client": API_CLIENT,
        "client-metadata": CLIENT_METADATA,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (response.status === 401 && !refreshed) {
      this.credentials.forceReload?.();
      return await this.postJson(path, body, options, true);
    }
    if (!response.ok) {
      const bodyText = await response.text();
      const attempt = options.retryAttempt ?? 0;
      if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
        const delayMs = this.retryDelayMs(response, bodyText, attempt);
        if (delayMs !== null) {
          await sleep(delayMs, options.signal);
          return await this.postJson(path, body, { ...options, retryAttempt: attempt + 1 }, refreshed);
        }
      }
      throw new Error(`Cloud Code Assist request failed: ${response.status} ${bodyText}`);
    }
    return await response.json();
  }

  retryDelayMs(response, bodyText, attempt) {
    const parsed = retryDelayMs(response, bodyText, this.retryBaseDelayMs, attempt);
    if (!Number.isFinite(parsed)) {
      return this.retryMinDelayMs;
    }
    if (parsed > this.retryMaxDelayMs) {
      return null;
    }
    return Math.max(parsed, this.retryMinDelayMs);
  }
}

export function toCodeAssistRequest(body = {}) {
  const contents = messagesToContents(body.messages ?? []);
  const generationConfig = {
    maxOutputTokens: body.max_tokens ?? body.maxOutputTokens ?? 8192,
  };
  if (body.temperature !== undefined) {
    generationConfig.temperature = body.temperature;
  }
  const request = {
    contents,
    generationConfig,
  };
  const systemText = systemTextFrom(body.system);
  if (systemText) {
    request.systemInstruction = { parts: [{ text: systemText }] };
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = [{
      functionDeclarations: body.tools.map(toFunctionDeclaration),
    }];
  }
  if (body.tool_choice) {
    request.toolConfig = mapToolChoiceToFunctionConfig(body.tool_choice);
  }
  return request;
}

export function collectAntigravityResponse(body = {}) {
  const candidate = (body.candidates ?? [{}])[0] ?? {};
  const parts = candidate.content?.parts ?? [];
  const content = [];
  const toolCalls = [];
  let callIndex = 1;
  for (const part of parts) {
    if (part.thought) {
      continue;
    }
    if (typeof part.text === "string" && part.text) {
      content.push({ type: "text", text: part.text });
    }
    if (part.functionCall) {
      const id = `call_${callIndex}`;
      callIndex += 1;
      const call = {
        id,
        name: String(part.functionCall.name ?? ""),
        input: normalizeObject(part.functionCall.args),
      };
      content.push({
        type: "tool_use",
        id,
        name: call.name,
        input: call.input,
      });
      toolCalls.push(call);
    }
  }
  return {
    content,
    tool_calls: toolCalls,
    text: content.filter((item) => item.type === "text").map((item) => item.text).join(""),
    usage: toUsage(body.usageMetadata ?? {}),
    model: "",
    stop_reason: candidate.finishReason ?? null,
  };
}

export function mapToolChoiceToFunctionConfig(toolChoice) {
  if (!toolChoice || toolChoice === "auto") {
    return { functionCallingConfig: { mode: "AUTO" } };
  }
  if (toolChoice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  const name = typeof toolChoice === "string"
    ? toolChoice
    : toolChoice.name ?? toolChoice.function?.name ?? "";
  if (name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [name],
      },
    };
  }
  return { functionCallingConfig: { mode: "ANY" } };
}

function messagesToContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const parts = [];
      for (const block of message.content ?? []) {
        if (block.type === "text" && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          parts.push({
            functionCall: {
              name: block.name,
              args: normalizeObject(block.input),
            },
          });
        }
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      continue;
    }
    const toolResults = (message.content ?? []).filter((block) => block.type === "tool_result");
    if (toolResults.length) {
      contents.push({
        role: "user",
        parts: toolResults.map((block) => ({
          functionResponse: {
            name: block.name || toolNameForResult(messages, block.tool_use_id),
            response: parseToolResponse(block.content),
          },
        })),
      });
      continue;
    }
    contents.push({
      role: "user",
      parts: (message.content ?? [{ type: "text", text: "" }])
        .filter((block) => block.type === "text")
        .map((block) => ({ text: String(block.text ?? "") })),
    });
  }
  return contents;
}

function toolNameForResult(messages, toolUseId) {
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type === "tool_use" && block.id === toolUseId) {
        return block.name || "tool";
      }
    }
  }
  return "tool";
}

function parseToolResponse(content) {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content;
  }
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      return normalizeObject(parsed);
    } catch {
      return { content };
    }
  }
  return { content: String(content ?? "") };
}

function toFunctionDeclaration(tool) {
  const declaration = {
    name: tool.name,
  };
  if (tool.description) {
    declaration.description = tool.description;
  }
  if (tool.input_schema) {
    declaration.parameters = stripForGemini(tool.input_schema);
  }
  return declaration;
}

function stripForGemini(schema) {
  if (Array.isArray(schema)) {
    return schema.map(stripForGemini);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const blocked = new Set([
    "$schema",
    "$defs",
    "definitions",
    "additionalProperties",
    "default",
    "examples",
    "title",
  ]);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [propertyName, stripForGemini(propertySchema)]),
      );
      continue;
    }
    if (blocked.has(key)) {
      continue;
    }
    out[key] = stripForGemini(value);
  }
  return out;
}

function systemTextFrom(system) {
  if (typeof system === "string") {
    return system;
  }
  if (!Array.isArray(system)) {
    return "";
  }
  return system
    .map((block) => block?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function toUsage(usage) {
  const input = Number(usage.promptTokenCount ?? 0);
  const output = Number(usage.candidatesTokenCount ?? 0);
  const total = Number(usage.totalTokenCount ?? input + output);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
  };
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function mapAntigravityModel(model) {
  return {
    "Gemini 3.5 Flash (Low)": "gemini-3-flash-preview",
    "Gemini 3.5 Flash (Medium)": "gemini-3-flash-preview",
    "Gemini 3.5 Flash (High)": "gemini-3-flash-preview",
    "Gemini 3.5 Pro": "gemini-3.1-pro-preview",
  }[model] ?? model ?? "gemini-3-flash-preview";
}

function extractProjectId(body) {
  return body?.cloudaicompanionProject
    || body?.codeAssistConfig?.projectId
    || body?.projectId
    || "";
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

function retryDelayMs(response, bodyText, fallbackMs, attempt) {
  const header = response.headers.get("retry-after") ?? response.headers.get("Retry-After");
  const headerSeconds = Number(header);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return headerSeconds * 1000;
  }
  const match = String(bodyText ?? "").match(/reset after\s+(\d+)\s*s/i);
  if (match) {
    return Number(match[1]) * 1000;
  }
  try {
    const body = JSON.parse(String(bodyText ?? "{}"));
    for (const detail of body?.error?.details ?? []) {
      const retryDelay = detail?.retryDelay;
      if (typeof retryDelay === "string" && retryDelay.endsWith("s")) {
        const seconds = Number(retryDelay.slice(0, -1));
        if (Number.isFinite(seconds) && seconds >= 0) {
          return seconds * 1000;
        }
      }
    }
  } catch {
    // Fall through to conservative backoff.
  }
  return fallbackMs * (attempt + 1);
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

class AsyncTokenBucket {
  constructor({ rpm, burst }) {
    this.rpm = Math.max(0, Number(rpm) || 0);
    this.capacity = Math.max(1, Number(burst) || 1);
    this.tokens = this.capacity;
    this.refillPerMs = this.rpm / 60_000;
    this.lastMs = Date.now();
    this.queue = Promise.resolve();
  }

  async take(signal) {
    if (this.rpm <= 0) {
      return;
    }
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      while (true) {
        throwIfAborted(signal);
        const now = Date.now();
        this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastMs) * this.refillPerMs);
        this.lastMs = now;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
        await sleep(waitMs, signal);
      }
    } finally {
      release();
    }
  }
}

function numberFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Request aborted.");
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
