import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REFRESH_SAFETY_MS = 300_000;
const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";

export class AntigravityCredentials {
  constructor(options = {}) {
    this.credentialsPathExplicit = Boolean(options.credentialsPath);
    this.credentialsPath = options.credentialsPath ?? defaultAntigravityCredentialsPath(options.env);
    this.env = options.env ?? process.env;
    this.refreshAuth = options.refreshAuth;
    this.refreshBin = options.refreshBin ?? "agy";
    this.keychainReader = options.keychainReader;
    this.now = options.now ?? (() => Date.now());
    this.platform = options.platform ?? process.platform;
    this.cache = null;
  }

  async accessToken() {
    const creds = await this.load();
    if (creds.expiryMs - this.now() <= REFRESH_SAFETY_MS) {
      return await this.forceRefresh();
    }
    return creds.accessToken;
  }

  async forceRefresh() {
    this.cache = null;
    await this.refreshNativeAuth();
    const refreshed = await this.load(true);
    if (refreshed.expiryMs - this.now() <= REFRESH_SAFETY_MS) {
      throw new Error("Antigravity OAuth access token is expired or near expiry after native AGY refresh. Refresh AGY login interactively, then retry.");
    }
    return refreshed.accessToken;
  }

  forceReload() {
    this.cache = null;
  }

  async load(force = false) {
    if (this.cache && !force) {
      return this.cache;
    }
    const envelope = await this.readEnvelope();
    const parsed = parseEnvelope(envelope);
    if (!parsed.accessToken || !parsed.refreshToken || !Number.isFinite(parsed.expiryMs)) {
      throw new Error("Antigravity credentials are missing access token, refresh token, or expiry.");
    }
    this.cache = {
      envelope,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiryMs: parsed.expiryMs,
      format: parsed.format,
    };
    return this.cache;
  }

  async readEnvelope() {
    if (this.useKeychain()) {
      try {
        return await this.readKeychain();
      } catch (error) {
        if (!existsSync(this.credentialsPath)) {
          throw error;
        }
      }
    }
    const parsed = JSON.parse(await readFile(this.credentialsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Antigravity credentials are not a JSON object.");
    }
    return parsed;
  }

  async readKeychain() {
    if (this.keychainReader) {
      return await this.keychainReader();
    }
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const value = stdout.trim();
    if (!value.startsWith("go-keyring-base64:")) {
      throw new Error("Unexpected Antigravity keychain credential format.");
    }
    return JSON.parse(Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8"));
  }

  useKeychain() {
    if (this.keychainReader) {
      return true;
    }
    if (this.env?.HOME && process.env.HOME && this.env.HOME !== process.env.HOME) {
      return false;
    }
    return this.platform === "darwin" && !this.credentialsPathExplicit;
  }

  async refreshNativeAuth() {
    if (this.refreshAuth) {
      await this.refreshAuth();
      return;
    }
    try {
      await execFileAsync(this.refreshBin, ["models"], {
        env: refreshCommandEnv(this.env),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const detail = [
        error?.stderr,
        error?.stdout,
        error?.message,
      ].map((part) => String(part ?? "").trim()).filter(Boolean).join("\n");
      throw new Error([
        `Antigravity native auth refresh failed while running \`${this.refreshBin} models\`.`,
        detail,
        "Run `agy` once interactively to refresh the native Antigravity login, then retry Supermodels.",
      ].filter(Boolean).join("\n"));
    }
  }
}

function refreshCommandEnv(env) {
  const merged = { ...process.env, ...env };
  if (env?.PATH && process.env.PATH && env.PATH !== process.env.PATH) {
    merged.PATH = `${env.PATH}${path.delimiter}${process.env.PATH}`;
  }
  return merged;
}

export function defaultAntigravityCredentialsPath(env = process.env) {
  if (env.ANTIGRAVITY_OAUTH_CREDS_PATH) {
    return path.resolve(env.ANTIGRAVITY_OAUTH_CREDS_PATH);
  }
  const home = env.HOME || os.homedir();
  const candidates = [
    path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    path.join(home, ".config", "antigravity", "antigravity-oauth-token"),
    path.join(home, ".antigravity", "oauth_creds.json"),
    path.join(home, ".gemini", "oauth_creds.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function parseEnvelope(envelope) {
  if (envelope.token && typeof envelope.token === "object") {
    return {
      accessToken: stringValue(envelope.token.access_token),
      refreshToken: stringValue(envelope.token.refresh_token),
      expiryMs: parseExpiry(envelope.token.expiry),
      format: "token-envelope",
    };
  }
  return {
    accessToken: stringValue(envelope.access_token),
    refreshToken: stringValue(envelope.refresh_token),
    expiryMs: Number(envelope.expiry_date),
    format: "flat",
  };
}

function parseExpiry(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number(value);
  }
  return NaN;
}

function stringValue(value) {
  return typeof value === "string" && value ? value : "";
}
