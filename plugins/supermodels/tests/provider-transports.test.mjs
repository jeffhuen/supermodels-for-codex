import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { REVIEW_RESULT_SCHEMA } from "../scripts/lib/review-schema.mjs";
import { ClaudeCodeCredentials } from "../scripts/providers/claude/oauth.mjs";
import {
  ClaudeOAuthMessagesTransport,
  collectClaudeMessageEvents,
  parseAnthropicSseLines,
} from "../scripts/providers/claude/messages-transport.mjs";
import {
  AntigravityCredentials,
  buildAntigravityKeychainWriteCommand,
} from "../scripts/providers/antigravity/oauth.mjs";
import {
  AntigravityCodeAssistTransport,
  collectAntigravityResponse,
  mapToolChoiceToFunctionConfig,
  parseCodeAssistSseLines,
  toCodeAssistRequest,
} from "../scripts/providers/antigravity/code-assist-transport.mjs";

const noRateLimit = { take: async () => {} };

test("ClaudeCodeCredentials refreshes expired tokens without a client secret", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "supermodels-claude-oauth-"));
  const file = path.join(dir, "credentials.json");
  try {
    await writeFile(file, JSON.stringify({
      other: "kept",
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 1,
        scopes: ["user:profile", "user:inference"],
        clientId: "client-1",
      },
    }), "utf8");
    const requests = [];
    const credentials = new ClaudeCodeCredentials({
      credentialsPath: file,
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      now: () => 1_000_000,
    });

    assert.equal(await credentials.accessToken(), "new-access");
    assert.equal(requests[0].client_id, "client-1");
    assert.equal(requests[0].refresh_token, "old-refresh");
    assert.equal(Object.hasOwn(requests[0], "client_secret"), false);
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.other, "kept");
    assert.equal(persisted.claudeAiOauth.accessToken, "new-access");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ClaudeCodeCredentials persists resolved refresh scopes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "supermodels-claude-oauth-scopes-"));
  const file = path.join(dir, "credentials.json");
  try {
    await writeFile(file, JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 1,
        scopes: [],
      },
    }), "utf8");
    const credentials = new ClaudeCodeCredentials({
      credentialsPath: file,
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope: "user:profile user:inference",
      }), { status: 200, headers: { "content-type": "application/json" } }),
      now: () => 1_000_000,
    });

    await credentials.accessToken();
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(persisted.claudeAiOauth.scopes, ["user:profile", "user:inference"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ClaudeCodeCredentials decodes hex-encoded macOS Keychain JSON", async () => {
  const envelope = {
    claudeAiOauth: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 9_999_999_999_999,
      scopes: ["user:profile", "user:inference"],
    },
  };
  const credentials = new ClaudeCodeCredentials({
    platform: "darwin",
    keychainReader: async () => Buffer.from(JSON.stringify(envelope), "utf8").toString("hex"),
    now: () => 1_000_000,
  });

  assert.equal(await credentials.accessToken(), "access-token");
});

test("ClaudeCodeCredentials writes refreshed macOS Keychain JSON as hex", async () => {
  const envelope = {
    claudeAiOauth: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 1,
      scopes: ["user:profile", "user:inference"],
    },
  };
  let writtenHex = "";
  const credentials = new ClaudeCodeCredentials({
    platform: "darwin",
    keychainReader: async () => Buffer.from(JSON.stringify(envelope), "utf8").toString("hex"),
    keychainWriter: async (payload) => {
      writtenHex = payload;
    },
    fetchImpl: async () => new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } }),
    now: () => 1_000_000,
  });

  assert.equal(await credentials.accessToken(), "new-access");
  assert.match(writtenHex, /^[0-9a-f]+$/);
  const persisted = JSON.parse(Buffer.from(writtenHex, "hex").toString("utf8"));
  assert.equal(persisted.claudeAiOauth.accessToken, "new-access");
});

test("collectClaudeMessageEvents preserves streamed tool calls and text", () => {
  const result = collectClaudeMessageEvents([
    {
      type: "message_start",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Inspecting diff." } },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{\"path\":\"runtime.mjs\"" },
    },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "}" } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
  ]);

  assert.equal(result.text, "Inspecting diff.");
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.deepEqual(result.tool_calls, [{ id: "toolu_1", name: "read_file", input: { path: "runtime.mjs" } }]);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 8 });
});

test("collectClaudeMessageEvents preserves thinking blocks for tool turns", () => {
  const result = collectClaudeMessageEvents([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "I need to inspect the diff before judging." },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "thinking-signature" },
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "get_diff", input: {} },
    },
  ]);

  assert.deepEqual(result.content[0], {
    type: "thinking",
    thinking: "I need to inspect the diff before judging.",
    signature: "thinking-signature",
  });
  assert.deepEqual(result.tool_calls, [{ id: "toolu_1", name: "get_diff", input: {} }]);
  assert.equal(result.text, "");
});

test("collectClaudeMessageEvents prefers streamed tool argument deltas over block-start input", () => {
  const result = collectClaudeMessageEvents([
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: "read_file",
        input: { path: "stale.mjs" },
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"path\":\"runtime.mjs\"" },
    },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "}" } },
  ]);

  assert.deepEqual(result.tool_calls, [{ id: "toolu_1", name: "read_file", input: { path: "runtime.mjs" } }]);
});

test("parseAnthropicSseLines yields Anthropic data payloads", () => {
  assert.deepEqual([...parseAnthropicSseLines([
    "event: content_block_delta",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}",
    "",
    "data: [DONE]",
  ])], [{
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "hello" },
  }]);
});

test("ClaudeOAuthMessagesTransport surfaces 429 responses without blind retry", async () => {
  let calls = 0;
  const transport = new ClaudeOAuthMessagesTransport({
    credentials: { accessToken: async () => "access-token", forceRefresh: async () => {} },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Error" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await assert.rejects(
    () => transport.messages({ model: "claude-test", messages: [] }, { timeoutMs: 5000 }),
    /Anthropic Messages request failed: 429/,
  );

  assert.equal(calls, 1);
});

test("ClaudeOAuthMessagesTransport retries transient overloaded stream errors", async () => {
  let calls = 0;
  const transport = new ClaudeOAuthMessagesTransport({
    credentials: { accessToken: async () => "access-token", forceRefresh: async () => {} },
    retryBaseDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response([
          "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}",
          "",
        ].join("\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response([
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"ok\"}}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const response = await transport.messages({ model: "claude-test", messages: [] }, { timeoutMs: 5000 });

  assert.equal(response.text, "ok");
  assert.equal(calls, 2);
});

test("ClaudeOAuthMessagesTransport rejects content-less successful streams", async () => {
  const transport = new ClaudeOAuthMessagesTransport({
    credentials: { accessToken: async () => "access-token", forceRefresh: async () => {} },
    fetchImpl: async () => new Response([
      "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-test\",\"usage\":{\"input_tokens\":1}}}",
      "",
      "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":0}}",
      "",
      "data: [DONE]",
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  });

  await assert.rejects(
    () => transport.messages({ model: "claude-test", messages: [] }, { timeoutMs: 5000 }),
    /empty Claude response/i,
  );
});

test("AntigravityCredentials reads fresh CLI token envelope", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "supermodels-agy-oauth-"));
  const file = path.join(dir, "antigravity-oauth-token");
  try {
    await writeFile(file, JSON.stringify({
      token: {
        access_token: "access",
        refresh_token: "old-refresh",
        expiry: "2099-01-01T00:00:00.000Z",
      },
      auth_method: "consumer",
    }), "utf8");
    const credentials = new AntigravityCredentials({
      credentialsPath: file,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(await credentials.accessToken(), "access");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AntigravityCredentials refreshes expired flat CLI credentials directly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "supermodels-agy-oauth-missing-client-"));
  const file = path.join(dir, "oauth_creds.json");
  try {
    await writeFile(file, JSON.stringify({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expiry_date: 1,
      extra: "kept",
    }), "utf8");
    const requests = [];
    const credentials = new AntigravityCredentials({
      credentialsPath: file,
      fetchImpl: async (_url, init) => {
        requests.push(String(init.body));
        return new Response(JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(await credentials.accessToken(), "new-access");
    assert.match(requests[0], /grant_type=refresh_token/);
    assert.match(requests[0], /refresh_token=old-refresh/);
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.extra, "kept");
    assert.equal(persisted.access_token, "new-access");
    assert.equal(persisted.refresh_token, "new-refresh");
    assert.equal(persisted.expiry_date, Date.parse("2026-01-01T01:00:00.000Z"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AntigravityCredentials refreshes expired keychain credentials directly", async () => {
  const envelope = {
    token: {
      access_token: "old-access",
      refresh_token: "old-refresh",
      expiry: "2000-01-01T00:00:00.000Z",
    },
    auth_method: "consumer",
    extra: "kept",
  };
  let writtenPassword = "";
  const credentials = new AntigravityCredentials({
    platform: "darwin",
    keychainReader: async () => envelope,
    keychainWriter: async (password) => {
      writtenPassword = password;
    },
    fetchImpl: async () => new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } }),
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(await credentials.accessToken(), "new-access");
  assert.match(writtenPassword, /^go-keyring-base64:/);
  const persisted = JSON.parse(Buffer.from(writtenPassword.slice("go-keyring-base64:".length), "base64").toString("utf8"));
  assert.equal(persisted.extra, "kept");
  assert.equal(persisted.token.access_token, "new-access");
  assert.equal(persisted.token.refresh_token, "new-refresh");
  assert.equal(Date.parse(persisted.token.expiry), Date.parse("2026-01-01T01:00:00.000Z"));
});

test("Antigravity keychain write command keeps token envelope out of argv", () => {
  const secret = "go-keyring-base64:refresh-token-secret";
  const command = buildAntigravityKeychainWriteCommand(secret);

  assert.equal(command.bin, "security");
  assert.equal(command.input, `${secret}\n${secret}\n`);
  assert.equal(command.args.at(-1), "-w");
  assert(!command.args.includes(secret));
  assert(!command.args.some((arg) => arg.includes("refresh-token-secret")));
});

test("AntigravityCredentials surfaces direct refresh failures with setup guidance", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "supermodels-agy-oauth-refresh-fails-"));
  const file = path.join(dir, "antigravity-oauth-token");
  try {
    await writeFile(file, JSON.stringify({
      token: {
        access_token: "old-access",
        refresh_token: "old-refresh",
        expiry: "2000-01-01T00:00:00.000Z",
      },
      auth_method: "consumer",
    }), "utf8");
    const credentials = new AntigravityCredentials({
      credentialsPath: file,
      fetchImpl: async () => new Response(JSON.stringify({
        error: "invalid_grant",
        error_description: "Bad Request",
      }), { status: 400, headers: { "content-type": "application/json" } }),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });

    await assert.rejects(
      () => credentials.accessToken(),
      /Antigravity OAuth token refresh failed.*Run `agy`/is,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AntigravityCredentials prefers macOS keychain over stale default token file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "supermodels-agy-oauth-keychain-"));
  const tokenDir = path.join(dir, ".gemini", "antigravity-cli");
  const file = path.join(tokenDir, "antigravity-oauth-token");
  try {
    await mkdir(tokenDir, { recursive: true });
    await writeFile(file, JSON.stringify({
      token: {
        access_token: "stale-file-access",
        refresh_token: "stale-file-refresh",
        expiry: "2000-01-01T00:00:00.000Z",
      },
      auth_method: "consumer",
    }), "utf8");
    const credentials = new AntigravityCredentials({
      env: { HOME: dir },
      platform: "darwin",
      keychainReader: async () => ({
        token: {
          access_token: "fresh-keychain-access",
          refresh_token: "fresh-keychain-refresh",
          expiry: "2099-01-01T00:00:00.000Z",
        },
        auth_method: "consumer",
      }),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(await credentials.accessToken(), "fresh-keychain-access");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AntigravityCredentials does not silently fall back to token file when macOS keychain fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "supermodels-agy-oauth-keychain-fails-"));
  const tokenDir = path.join(dir, ".gemini", "antigravity-cli");
  const file = path.join(tokenDir, "antigravity-oauth-token");
  try {
    await mkdir(tokenDir, { recursive: true });
    await writeFile(file, JSON.stringify({
      token: {
        access_token: "file-access",
        refresh_token: "file-refresh",
        expiry: "2099-01-01T00:00:00.000Z",
      },
      auth_method: "consumer",
    }), "utf8");
    const credentials = new AntigravityCredentials({
      env: { HOME: dir },
      platform: "darwin",
      keychainReader: async () => {
        throw new Error("keychain unavailable");
      },
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });

    await assert.rejects(
      () => credentials.accessToken(),
      /keychain credential read failed.*ANTIGRAVITY_OAUTH_CREDS_PATH/is,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AntigravityCodeAssistTransport defaults to reference pacing with env overrides", () => {
  const previousRpm = process.env.SUPERMODELS_ANTIGRAVITY_RPM;
  const previousBurst = process.env.SUPERMODELS_ANTIGRAVITY_BURST;
  try {
    delete process.env.SUPERMODELS_ANTIGRAVITY_RPM;
    delete process.env.SUPERMODELS_ANTIGRAVITY_BURST;
    const defaults = new AntigravityCodeAssistTransport({
      credentials: { accessToken: async () => "access-token" },
    });
    assert.equal(defaults.rateLimiter.rpm, 12);
    assert.equal(defaults.rateLimiter.capacity, 2);

    process.env.SUPERMODELS_ANTIGRAVITY_RPM = "6";
    process.env.SUPERMODELS_ANTIGRAVITY_BURST = "3";
    const overridden = new AntigravityCodeAssistTransport({
      credentials: { accessToken: async () => "access-token" },
    });
    assert.equal(overridden.rateLimiter.rpm, 6);
    assert.equal(overridden.rateLimiter.capacity, 3);
  } finally {
    if (previousRpm === undefined) {
      delete process.env.SUPERMODELS_ANTIGRAVITY_RPM;
    } else {
      process.env.SUPERMODELS_ANTIGRAVITY_RPM = previousRpm;
    }
    if (previousBurst === undefined) {
      delete process.env.SUPERMODELS_ANTIGRAVITY_BURST;
    } else {
      process.env.SUPERMODELS_ANTIGRAVITY_BURST = previousBurst;
    }
  }
});

test("toCodeAssistRequest converts tool turns into function call and response parts", () => {
  const request = toCodeAssistRequest({
    system: [{ type: "text", text: "system prompt" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "review this" }] },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_1",
          name: "get_diff",
          input: {},
          thoughtSignature: "sig-get-diff",
        }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "{\"ok\":true}" }],
      },
    ],
    tools: [{
      name: "get_diff",
      description: "Get diff",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    }],
    tool_choice: { type: "tool", name: "submit_review" },
    max_tokens: 4096,
  });

  assert.equal(request.systemInstruction.parts[0].text, "system prompt");
  assert.deepEqual(request.contents[1].parts, [{
    functionCall: { id: "call_1", name: "get_diff", args: {} },
    thoughtSignature: "sig-get-diff",
  }]);
  assert.deepEqual(request.contents[2].parts, [{
    functionResponse: { id: "call_1", name: "get_diff", response: { ok: true } },
  }]);
  assert.deepEqual(request.tools[0].functionDeclarations[0], {
    name: "get_diff",
    description: "Get diff",
    parameters: { type: "object", properties: {} },
  });
  assert.deepEqual(request.toolConfig, mapToolChoiceToFunctionConfig({ type: "tool", name: "submit_review" }));
  assert.equal(request.generationConfig.maxOutputTokens, 4096);
});

test("toCodeAssistRequest hardens AGY tool history with ids and synthetic signatures", () => {
  const request = toCodeAssistRequest({
    messages: [
      { role: "user", content: [{ type: "text", text: "review this" }] },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "server-call-7",
          name: "read_file",
          input: { path: "runtime.mjs" },
        }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "server-call-7", content: "{\"ok\":true}" }],
      },
    ],
  });

  assert.deepEqual(request.contents[1].parts, [{
    functionCall: { id: "server-call-7", name: "read_file", args: { path: "runtime.mjs" } },
    thoughtSignature: "supermodels-synthetic-thought-signature",
  }]);
  assert.deepEqual(request.contents[2].parts, [{
    functionResponse: { id: "server-call-7", name: "read_file", response: { ok: true } },
  }]);
});

test("toCodeAssistRequest coalesces adjacent same-role turns for Gemini history", () => {
  const request = toCodeAssistRequest({
    messages: [
      { role: "user", content: [{ type: "text", text: "initial prompt" }] },
      { role: "user", content: [{ type: "text", text: "preloaded context" }] },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "runtime.mjs" },
          thoughtSignature: "sig-read",
        }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "{\"ok\":true}" }] },
      { role: "user", content: [{ type: "text", text: "continue with evidence" }] },
    ],
  });

  assert.equal(request.contents.length, 3);
  assert.equal(request.contents[0].role, "user");
  assert.deepEqual(request.contents[0].parts, [
    { text: "initial prompt" },
    { text: "preloaded context" },
  ]);
  assert.equal(request.contents[2].role, "user");
  assert.deepEqual(request.contents[2].parts, [
    { functionResponse: { id: "call_1", name: "read_file", response: { ok: true } } },
    { text: "continue with evidence" },
  ]);
});

test("toCodeAssistRequest maps dynamic thinking budget into generation config", () => {
  const request = toCodeAssistRequest({
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    max_tokens: 64_000,
    thinkingBudget: -1,
  });

  assert.deepEqual(request.generationConfig, {
    maxOutputTokens: 64_000,
    thinkingConfig: { thinkingBudget: -1 },
  });
});

test("toCodeAssistRequest preserves schema property names that match stripped metadata keys", () => {
  const request = toCodeAssistRequest({
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [{
      name: "submit_review",
      description: "Submit review",
      input_schema: REVIEW_RESULT_SCHEMA,
    }],
  });

  const params = request.tools[0].functionDeclarations[0].parameters;
  assert(params.properties.findings.items.properties.title);
  assert(params.properties.findings.items.properties.severity);
  assert(params.properties.findings.items.required.includes("title"));
});

test("collectAntigravityResponse parses function calls, text, and usage", () => {
  const result = collectAntigravityResponse({
    candidates: [{
      content: {
        parts: [
          { text: "Inspecting." },
          {
            functionCall: { id: "server-call-1", name: "read_file", args: { path: "runtime.mjs" } },
            thoughtSignature: "sig-read-file",
          },
        ],
      },
      finishReason: "STOP",
    }],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
  });

  assert.equal(result.text, "Inspecting.");
  assert.deepEqual(result.tool_calls, [{
    id: "server-call-1",
    name: "read_file",
    input: { path: "runtime.mjs" },
    thoughtSignature: "sig-read-file",
  }]);
  assert.deepEqual(result.content[1], {
    type: "tool_use",
    id: "server-call-1",
    name: "read_file",
    input: { path: "runtime.mjs" },
    thoughtSignature: "sig-read-file",
  });
  assert.deepEqual(result.usage, {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
  });
});

test("collectAntigravityResponse rejects empty stopped responses without tool calls", () => {
  assert.throws(
    () => collectAntigravityResponse({
      candidates: [{
        content: { parts: [] },
        finishReason: "STOP",
      }],
      usageMetadata: {},
    }),
    /empty response text/i,
  );
});

test("parseCodeAssistSseLines flushes final payloads without a trailing blank line", () => {
  assert.deepEqual([...parseCodeAssistSseLines([
    "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}]}}",
  ])], [{
    candidates: [{
      content: { parts: [{ text: "ok" }] },
      finishReason: "STOP",
    }],
  }]);
});

test("AntigravityCodeAssistTransport streams requests in the Code Assist envelope", async () => {
  const requests = [];
  const transport = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token", forceReload: () => {} },
    rateLimiter: noRateLimit,
    projectId: "project-1",
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response([
        "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}]} }],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":2,\"totalTokenCount\":12}}}",
        "",
        "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[]},\"finishReason\":\"STOP\"}]}}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });

  const response = await transport.messages({
    model: "Gemini 3.5 Flash (High)",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  });

  assert.equal(response.text, "ok");
  assert.deepEqual(response.usage, {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
  });
  assert.match(requests[0].url, /v1internal:streamGenerateContent\?alt=sse$/);
  assert.equal(requests[0].body.project, "project-1");
  assert.equal(requests[0].body.request.contents[0].role, "user");
  assert.match(requests[0].headers.Authorization, /^Bearer /);
});

test("AntigravityCodeAssistTransport emits progress while SSE response is still open", async () => {
  let streamController;
  const encoder = new TextEncoder();
  const events = [];
  const transport = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token", forceReload: () => {} },
    rateLimiter: noRateLimit,
    projectId: "project-1",
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });

  const pending = transport.messages({
    model: "Gemini 3.5 Flash (High)",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  }, {
    timeoutMs: 5_000,
    onEvent: (event) => events.push(event),
  });

  await waitFor(() => streamController);
  streamController.enqueue(encoder.encode([
    "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"partial\"}]}}]}}",
    "",
  ].join("\n") + "\n"));

  await waitFor(() => events.some((event) => /streamed/.test(event.message ?? "")));

  streamController.enqueue(encoder.encode([
    "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{}}}",
    "",
    "data: [DONE]",
    "",
  ].join("\n") + "\n"));
  streamController.close();

  const response = await pending;
  assert.equal(response.text, "partial");
});

test("AntigravityCodeAssistTransport forces OAuth refresh before retrying streamGenerateContent 401", async () => {
  const authorizations = [];
  let refreshed = false;
  let calls = 0;
  const transport = new AntigravityCodeAssistTransport({
    credentials: {
      accessToken: async () => refreshed ? "new-token" : "old-token",
      forceRefresh: async () => {
        refreshed = true;
      },
      forceReload: () => {
        throw new Error("forceReload should not handle rejected access tokens");
      },
    },
    rateLimiter: noRateLimit,
    projectId: "project-1",
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("v1internal:streamGenerateContent?alt=sse")) {
        calls += 1;
        authorizations.push(init.headers.Authorization);
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { code: 401, message: "stale token" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: {},
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await transport.messages({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  });

  assert.equal(response.text, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(authorizations, ["Bearer old-token", "Bearer new-token"]);
});

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

test("AntigravityCodeAssistTransport discovers project id before streamGenerateContent", async () => {
  const requests = [];
  const transport = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token", forceReload: () => {} },
    rateLimiter: noRateLimit,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      if (String(url).endsWith("v1internal:loadCodeAssist")) {
        return new Response(JSON.stringify({
          cloudaicompanionProject: "discovered-project",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: {},
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await transport.messages({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  });

  assert.equal(response.text, "ok");
  assert.match(requests[0].url, /v1internal:loadCodeAssist$/);
  assert.match(requests[1].url, /v1internal:streamGenerateContent\?alt=sse$/);
  assert.equal(requests[1].body.project, "discovered-project");
});

test("AntigravityCodeAssistTransport continues streamGenerateContent when project discovery is unavailable", async () => {
  const requests = [];
  const transport = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token", forceReload: () => {} },
    rateLimiter: noRateLimit,
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      if (String(url).endsWith("v1internal:loadCodeAssist")) {
        return new Response(JSON.stringify({ error: { code: 500, message: "discovery down" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: {},
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await transport.messages({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  });

  assert.equal(response.text, "ok");
  assert.match(requests[0].url, /v1internal:loadCodeAssist$/);
  assert.match(requests[1].url, /v1internal:streamGenerateContent\?alt=sse$/);
  assert.equal(Object.hasOwn(requests[1].body, "project"), false);
});

test("AntigravityCodeAssistTransport retries project discovery after unavailable discovery", async () => {
  const requests = [];
  let discoveryCalls = 0;
  const transport = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token", forceReload: () => {} },
    rateLimiter: noRateLimit,
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      if (String(url).endsWith("v1internal:loadCodeAssist")) {
        discoveryCalls += 1;
        if (discoveryCalls === 1) {
          return new Response(JSON.stringify({ error: { code: 500, message: "discovery down" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          cloudaicompanionProject: "project-after-retry",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: {},
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await transport.messages({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  });
  await transport.messages({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "review again" }] }],
    tools: [],
  });

  assert.equal(discoveryCalls, 2);
  const generateBodies = requests
    .filter((request) => String(request.url).endsWith("v1internal:streamGenerateContent?alt=sse"))
    .map((request) => request.body);
  assert.equal(Object.hasOwn(generateBodies[0], "project"), false);
  assert.equal(generateBodies[1].project, "project-after-retry");
});

test("AntigravityCodeAssistTransport uses reference onboarding poll bounds with test overrides", async () => {
  const defaults = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token" },
  });
  assert.equal(defaults.onboardPollAttempts, 24);
  assert.equal(defaults.onboardPollIntervalMs, 5000);

  const overridden = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token" },
    onboardPollAttempts: 2,
    onboardPollIntervalMs: 0,
  });
  assert.equal(overridden.onboardPollAttempts, 2);
  assert.equal(overridden.onboardPollIntervalMs, 0);
});

test("AntigravityCodeAssistTransport returns project-less after bounded onboarding exhaustion", async () => {
  let loadCalls = 0;
  let onboardCalls = 0;
  const transport = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token", forceReload: () => {} },
    rateLimiter: noRateLimit,
    onboardPollAttempts: 2,
    onboardPollIntervalMs: 0,
    fetchImpl: async (url) => {
      if (String(url).endsWith("v1internal:loadCodeAssist")) {
        loadCalls += 1;
        return new Response(JSON.stringify({ status: "USER_NOT_ONBOARDED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("v1internal:onboardUser")) {
        onboardCalls += 1;
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: {},
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await transport.messages({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  });

  assert.equal(response.text, "ok");
  assert.equal(onboardCalls, 1);
  assert.equal(loadCalls, 3);
});

test("AntigravityCodeAssistTransport forces OAuth refresh before retrying project discovery 401", async () => {
  const authorizations = [];
  let refreshed = false;
  let discoveryCalls = 0;
  const transport = new AntigravityCodeAssistTransport({
    credentials: {
      accessToken: async () => refreshed ? "new-token" : "old-token",
      forceRefresh: async () => {
        refreshed = true;
      },
      forceReload: () => {
        throw new Error("forceReload should not handle rejected access tokens");
      },
    },
    rateLimiter: noRateLimit,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("v1internal:loadCodeAssist")) {
        discoveryCalls += 1;
        authorizations.push(init.headers.Authorization);
        if (discoveryCalls === 1) {
          return new Response(JSON.stringify({ error: { code: 401, message: "stale token" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          cloudaicompanionProject: "project-1",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: {},
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await transport.messages({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  });

  assert.equal(response.text, "ok");
  assert.equal(discoveryCalls, 2);
  assert.deepEqual(authorizations, ["Bearer old-token", "Bearer new-token"]);
});

test("AntigravityCodeAssistTransport retries retryable 429 responses", async () => {
  let generateCalls = 0;
  const transport = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token", forceReload: () => {} },
    projectId: "project-1",
    rateLimiter: noRateLimit,
    retryBaseDelayMs: 1,
    retryMinDelayMs: 0,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("v1internal:streamGenerateContent?alt=sse")) {
        generateCalls += 1;
        if (generateCalls === 1) {
          return new Response(JSON.stringify({
            error: {
              code: 429,
              message: "Quota reset after 0s.",
              status: "RESOURCE_EXHAUSTED",
            },
          }), { status: 429, headers: { "content-type": "application/json" } });
        }
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: {},
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await transport.messages({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  });

  assert.equal(response.text, "ok");
  assert.equal(generateCalls, 2);
});

test("AntigravityCodeAssistTransport honors explicit short reset windows beyond fixed retry count", async () => {
  let generateCalls = 0;
  const transport = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token", forceReload: () => {} },
    projectId: "project-1",
    rateLimiter: noRateLimit,
    retryBaseDelayMs: 1,
    retryMinDelayMs: 0,
    retryMaxElapsedMs: 5_000,
    fetchImpl: async (url) => {
      if (String(url).endsWith("v1internal:streamGenerateContent?alt=sse")) {
        generateCalls += 1;
        if (generateCalls <= 4) {
          return new Response(JSON.stringify({
            error: {
              code: 429,
              message: "You have exhausted your capacity on this model. Your quota will reset after 0s.",
              status: "RESOURCE_EXHAUSTED",
            },
          }), { status: 429, headers: { "content-type": "application/json" } });
        }
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: {},
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await transport.messages({
    model: "gemini-3-flash-preview",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  });

  assert.equal(response.text, "ok");
  assert.equal(generateCalls, 5);
});

test("AntigravityCodeAssistTransport retries retryable project discovery 429 responses", async () => {
  let discoveryCalls = 0;
  const transport = new AntigravityCodeAssistTransport({
    credentials: { accessToken: async () => "access-token", forceReload: () => {} },
    rateLimiter: noRateLimit,
    retryBaseDelayMs: 1,
    retryMinDelayMs: 0,
    fetchImpl: async (url) => {
      if (String(url).endsWith("v1internal:loadCodeAssist")) {
        discoveryCalls += 1;
        if (discoveryCalls === 1) {
          return new Response(JSON.stringify({
            error: {
              code: 429,
              message: "Quota will reset after 0s.",
              status: "RESOURCE_EXHAUSTED",
            },
          }), { status: 429, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          cloudaicompanionProject: "project-1",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: {},
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await transport.messages({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
    tools: [],
  });

  assert.equal(response.text, "ok");
  assert.equal(discoveryCalls, 2);
});
