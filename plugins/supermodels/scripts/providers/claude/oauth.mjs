import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { awaitAbortable, throwIfAborted } from "../../lib/abort.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const REFRESH_SAFETY_MS = 300_000;
const DEFAULT_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

export class ClaudeCodeCredentials {
  constructor(options = {}) {
    this.credentialsPathExplicit = Boolean(options.credentialsPath);
    this.credentialsPath = options.credentialsPath ?? defaultClaudeCredentialsPath();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.platform = options.platform ?? process.platform;
    this.user = options.user ?? process.env.USER ?? os.userInfo().username;
    this.keychainReader = options.keychainReader;
    this.keychainWriter = options.keychainWriter;
    this.cache = null;
  }

  async accessToken(options = {}) {
    const creds = await this.load(false, options);
    if (creds.expiresAt - this.now() <= REFRESH_SAFETY_MS) {
      return (await this.refresh(creds, options)).accessToken;
    }
    return creds.accessToken;
  }

  async forceRefresh(options = {}) {
    return (await this.refresh(await this.load(true, options), options)).accessToken;
  }

  forceReload() {
    this.cache = null;
  }

  async load(force = false, options = {}) {
    throwIfAborted(options.signal);
    if (this.cache && !force) {
      return this.cache;
    }
    const envelope = await this.readEnvelope(options);
    const oauth = envelope.claudeAiOauth;
    if (!oauth || typeof oauth !== "object") {
      throw new Error("Claude Code credentials are missing claudeAiOauth.");
    }
    const accessToken = stringValue(oauth.accessToken);
    const refreshToken = stringValue(oauth.refreshToken);
    const expiresAt = Number(oauth.expiresAt);
    if (!accessToken || !refreshToken || !Number.isFinite(expiresAt)) {
      throw new Error("Claude Code credentials are missing accessToken, refreshToken, or expiresAt.");
    }
    this.cache = {
      envelope,
      accessToken,
      refreshToken,
      expiresAt,
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((item) => typeof item === "string") : [],
      clientId: stringValue(oauth.clientId) || DEFAULT_CLIENT_ID,
    };
    return this.cache;
  }

  async refresh(creds, options = {}) {
    throwIfAborted(options.signal);
    const requestedScopes = creds.scopes.length ? creds.scopes : DEFAULT_SCOPES;
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: creds.clientId || DEFAULT_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        scope: requestedScopes.join(" "),
      }),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`Claude Code token refresh failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    const accessToken = stringValue(body.access_token);
    if (!accessToken) {
      throw new Error("Claude Code token refresh response did not include access_token.");
    }
    const refreshToken = stringValue(body.refresh_token) || creds.refreshToken;
    const expiresIn = Number(body.expires_in);
    const expiresAt = this.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_600_000);
    const returnedScopes = parseScopes(body.scope);
    const persistedScopes = returnedScopes.length ? returnedScopes : requestedScopes;
    const envelope = {
      ...creds.envelope,
      claudeAiOauth: {
        ...(creds.envelope.claudeAiOauth ?? {}),
        accessToken,
        refreshToken,
        expiresAt,
        scopes: persistedScopes,
        clientId: creds.clientId || DEFAULT_CLIENT_ID,
      },
    };
    throwIfAborted(options.signal);
    await this.writeEnvelope(envelope, options);
    this.cache = {
      envelope,
      accessToken,
      refreshToken,
      expiresAt,
      scopes: persistedScopes,
      clientId: creds.clientId || DEFAULT_CLIENT_ID,
    };
    return this.cache;
  }

  async readEnvelope(options = {}) {
    throwIfAborted(options.signal);
    const raw = this.useKeychain()
      ? await this.readKeychain(options)
      : await readFile(this.credentialsPath, { encoding: "utf8", signal: options.signal });
    const parsed = parseCredentialPayload(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Claude Code credentials are not a JSON object.");
    }
    return parsed;
  }

  async writeEnvelope(envelope, options = {}) {
    throwIfAborted(options.signal);
    const payload = `${JSON.stringify(envelope, null, 2)}\n`;
    if (this.useKeychain()) {
      await this.writeKeychain(payload, options);
      return;
    }
    await mkdir(path.dirname(this.credentialsPath), { recursive: true });
    throwIfAborted(options.signal);
    await writeFile(this.credentialsPath, payload, { mode: 0o600, signal: options.signal });
  }

  async readKeychain(options = {}) {
    if (this.keychainReader) {
      return await awaitAbortable(() => this.keychainReader(options), options.signal);
    }
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      this.user,
      "-w",
    ], { timeout: 10_000, maxBuffer: 1024 * 1024, signal: options.signal });
    return stdout.trim();
  }

  async writeKeychain(payload, options = {}) {
    const hexPayload = Buffer.from(payload, "utf8").toString("hex");
    if (this.keychainWriter) {
      await awaitAbortable(() => this.keychainWriter(hexPayload, options), options.signal);
      return;
    }
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      this.user,
      "-X",
      hexPayload,
    ], { timeout: 10_000, maxBuffer: 1024 * 1024, signal: options.signal });
  }

  useKeychain() {
    return this.platform === "darwin" && !process.env.CLAUDE_CODE_AUTH_PATH && !this.credentialsPathExplicit;
  }
}

export function defaultClaudeCredentialsPath() {
  if (process.env.CLAUDE_CODE_AUTH_PATH) {
    return path.resolve(process.env.CLAUDE_CODE_AUTH_PATH);
  }
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

function stringValue(value) {
  return typeof value === "string" && value ? value : "";
}

function parseScopes(value) {
  return stringValue(value).split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function parseCredentialPayload(raw) {
  const text = String(raw ?? "").trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!isHexPayload(text)) {
      throw error;
    }
    return JSON.parse(Buffer.from(text, "hex").toString("utf8"));
  }
}

function isHexPayload(value) {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}
