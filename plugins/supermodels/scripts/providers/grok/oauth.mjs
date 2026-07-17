import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { throwIfAborted } from "../../lib/abort.mjs";
import { runCommand } from "../../lib/process.mjs";

const REFRESH_SAFETY_MS = 300_000;
const DEFAULT_ISSUER = "https://auth.x.ai";

export class GrokCredentials {
  constructor(options = {}) {
    this.authPath = options.authPath ?? defaultGrokAuthPath();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
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

  async identity(options = {}) {
    const creds = await this.load(false, options);
    return { userId: creds.userId, email: creds.email };
  }

  async load(force = false, options = {}) {
    throwIfAborted(options.signal);
    if (this.cache && !force) {
      return this.cache;
    }
    let raw;
    try {
      raw = await readFile(this.authPath, { encoding: "utf8", signal: options.signal });
    } catch (error) {
      throw new Error(`Grok auth is missing or unreadable at ${this.authPath}. Run \`grok login\`. (${error?.message ?? error})`);
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Grok auth.json at ${this.authPath} is corrupt and could not be parsed. Run \`grok login\`. (${error?.message ?? error})`);
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new Error("Grok auth.json is not a JSON object. Run `grok login`.");
    }
    const found = selectAuthEntry(envelope);
    if (!found) {
      throw new Error("Grok auth.json has no usable OIDC entry (key + refresh_token). Run `grok login`.");
    }
    const { entryKey, entry } = found;
    const expiresAt = Date.parse(entry.expires_at ?? "");
    this.cache = {
      envelope,
      entryKey,
      accessToken: entry.key,
      refreshToken: entry.refresh_token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      issuer: stringValue(entry.oidc_issuer) || DEFAULT_ISSUER,
      clientId: stringValue(entry.oidc_client_id),
      userId: stringValue(entry.user_id),
      email: stringValue(entry.email),
    };
    return this.cache;
  }

  async refresh(creds, options = {}) {
    throwIfAborted(options.signal);
    const tokenUrl = `${creds.issuer.replace(/\/$/, "")}/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      ...(creds.clientId ? { client_id: creds.clientId } : {}),
    });
    const response = await this.fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`Grok token refresh failed (${response.status}). Run \`grok login\` to re-authenticate.`);
    }
    const payload = await response.json();
    const accessToken = stringValue(payload.access_token);
    if (!accessToken) {
      throw new Error("Grok token refresh response did not include access_token. Run `grok login`.");
    }
    const refreshToken = stringValue(payload.refresh_token) || creds.refreshToken;
    const expiresIn = Number(payload.expires_in);
    const expiresAt = this.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_600_000);
    const entry = {
      ...(this.cache?.envelope?.[creds.entryKey] ?? {}),
      key: accessToken,
      refresh_token: refreshToken,
      expires_at: new Date(expiresAt).toISOString(),
    };
    const envelope = { ...creds.envelope, [creds.entryKey]: entry };
    throwIfAborted(options.signal);
    await this.persist(envelope, options);
    this.cache = { ...creds, envelope, accessToken, refreshToken, expiresAt };
    return this.cache;
  }

  async persist(envelope, options = {}) {
    throwIfAborted(options.signal);
    const payload = `${JSON.stringify(envelope, null, 2)}\n`;
    await mkdir(path.dirname(this.authPath), { recursive: true });
    const tempPath = `${this.authPath}.supermodels-${process.pid}.tmp`;
    try {
      throwIfAborted(options.signal);
      await writeFile(tempPath, payload, { mode: 0o600, signal: options.signal });
      throwIfAborted(options.signal);
      await rename(tempPath, this.authPath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

export function defaultGrokAuthPath() {
  if (process.env.SUPERMODELS_GROK_AUTH_PATH) {
    return path.resolve(process.env.SUPERMODELS_GROK_AUTH_PATH);
  }
  return path.join(os.homedir(), ".grok", "auth.json");
}

export async function readGrokClientVersion(options = {}) {
  const versionPath = options.versionPath
    ?? path.join(path.dirname(options.authPath ?? defaultGrokAuthPath()), "version.json");
  throwIfAborted(options.signal);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const result = await runCommand({
    bin: process.execPath,
    args: ["-e", GROK_VERSION_READ_SCRIPT, versionPath],
  }, {
    timeoutMs,
    signal: options.signal,
  });
  throwIfAborted(options.signal);
  if (result.timedOut) {
    throw new Error(`Grok client version read timed out after ${timeoutMs}ms.`);
  }
  if (result.exitCode !== 0 || !result.stdout) {
    return "";
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return stringValue(parsed.version) || stringValue(parsed.stable_version);
  } catch {
    return "";
  }
}

const GROK_VERSION_READ_SCRIPT = String.raw`
const fs = require("node:fs");
const filePath = process.argv[1];
try {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 65536) process.exit(2);
  process.stdout.write(fs.readFileSync(filePath, "utf8"));
} catch {
  process.exit(1);
}
`;

function selectAuthEntry(envelope) {
  const entries = Object.entries(envelope).filter(([, value]) =>
    value && typeof value === "object" && !Array.isArray(value)
    && stringValue(value.key) && stringValue(value.refresh_token));
  if (!entries.length) {
    return null;
  }
  const preferred = entries.find(([, value]) => stringValue(value.oidc_issuer) === DEFAULT_ISSUER)
    ?? entries[0];
  return { entryKey: preferred[0], entry: preferred[1] };
}

function stringValue(value) {
  return typeof value === "string" && value ? value : "";
}
