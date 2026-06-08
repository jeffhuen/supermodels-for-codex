import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REFRESH_SAFETY_MS = 300_000;
const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Public installed-app OAuth client used by the Antigravity CLI family. This is
// non-confidential by design; refresh tokens minted by the CLI require it.
const ANTIGRAVITY_CLI_CLIENT_ID = [
  "1071006060591",
  "-tmhssin2h21lcre235vtolojh4g403ep",
  ".apps.googleusercontent.com",
].join("");
const ANTIGRAVITY_CLI_CLIENT_SECRET = [
  "GOC",
  "SPX",
  "-K58FWR486LdLJ1mLB8sXC4z6qDAf",
].join("");

export class AntigravityCredentials {
  constructor(options = {}) {
    this.credentialsPathExplicit = Boolean(options.credentialsPath);
    this.credentialsPath = options.credentialsPath ?? defaultAntigravityCredentialsPath(options.env);
    this.env = options.env ?? process.env;
    this.refreshAuth = options.refreshAuth;
    this.refreshBin = options.refreshBin ?? "agy";
    this.keychainReader = options.keychainReader;
    this.keychainWriter = options.keychainWriter;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.platform = options.platform ?? process.platform;
    this.cache = null;
    this.loadedFromKeychain = false;
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
    if (this.refreshAuth) {
      await this.refreshNativeAuth();
      const refreshed = await this.load(true);
      if (refreshed.expiryMs - this.now() <= REFRESH_SAFETY_MS) {
        throw new Error("Antigravity OAuth access token is expired or near expiry after native AGY refresh. Refresh AGY login interactively, then retry.");
      }
      return refreshed.accessToken;
    }
    const current = await this.load(true);
    const refreshed = await this.refreshToken(current);
    await this.persist(refreshed);
    this.cache = {
      envelope: refreshed.envelope,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiryMs: refreshed.expiryMs,
      format: refreshed.format,
    };
    return refreshed.accessToken;
  }

  async refreshToken(creds) {
    let response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: ANTIGRAVITY_CLI_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLI_CLIENT_SECRET,
          refresh_token: creds.refreshToken,
          grant_type: "refresh_token",
        }).toString(),
      });
    } catch (error) {
      throw new Error(`Antigravity OAuth token refresh failed: ${error?.message || String(error)}. Run \`agy\` once interactively to refresh the native Antigravity login, then retry Supermodels.`);
    }

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new Error(`Antigravity OAuth token refresh failed: ${response.status} ${text.slice(0, 500)}. Run \`agy\` once interactively to refresh the native Antigravity login, then retry Supermodels.`);
    }
    const accessToken = stringValue(data.access_token);
    if (!accessToken) {
      throw new Error(`Antigravity OAuth token refresh failed: response missing access_token. Run \`agy\` once interactively to refresh the native Antigravity login, then retry Supermodels.`);
    }
    const expiresIn = Number(data.expires_in);
    const expiryMs = this.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
    return {
      envelope: updateEnvelope(creds.envelope, {
        accessToken,
        refreshToken: stringValue(data.refresh_token) || creds.refreshToken,
        expiryMs,
        format: creds.format,
      }),
      accessToken,
      refreshToken: stringValue(data.refresh_token) || creds.refreshToken,
      expiryMs,
      format: creds.format,
    };
  }

  async persist(refreshed) {
    if (this.loadedFromKeychain) {
      await this.writeKeychain(refreshed.envelope);
      return;
    }
    await writeFile(this.credentialsPath, `${JSON.stringify(refreshed.envelope, null, 2)}\n`, { mode: 0o600 });
  }

  async writeKeychain(envelope) {
    const password = `go-keyring-base64:${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64")}`;
    if (this.keychainWriter) {
      await this.keychainWriter(password);
      return;
    }
    await runCommandWithInput(buildAntigravityKeychainWriteCommand(password), {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  }

  async forceNativeRefresh() {
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
        const envelope = await this.readKeychain();
        this.loadedFromKeychain = true;
        return envelope;
      } catch (error) {
        throw new Error(`Antigravity keychain credential read failed; refusing to fall back to local token file. Run \`agy\` once interactively or set ANTIGRAVITY_OAUTH_CREDS_PATH explicitly. ${error?.message || String(error)}`);
      }
    }
    const parsed = JSON.parse(await readFile(this.credentialsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Antigravity credentials are not a JSON object.");
    }
    this.loadedFromKeychain = false;
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

export function buildAntigravityKeychainWriteCommand(password) {
  return {
    bin: "security",
    args: [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ],
    input: `${password}\n${password}\n`,
  };
}

function runCommandWithInput(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout = null;

    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(value);
    };
    if (options.timeout) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        rejectOnce(new Error(`${command.bin} timed out after ${options.timeout}ms`));
      }, options.timeout);
    }
    const append = (target, chunk) => {
      const next = target + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxBuffer) {
        child.kill("SIGTERM");
        rejectOnce(new Error(`${command.bin} output exceeded maxBuffer`));
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", rejectOnce);
    child.stdin.on("error", rejectOnce);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveOnce({ stdout, stderr });
        return;
      }
      rejectOnce(new Error(`${command.bin} exited with ${code ?? signal}: ${stderr || stdout}`));
    });
    child.stdin.end(command.input);
  });
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

function updateEnvelope(envelope, token) {
  const copy = structuredClone(envelope);
  if (token.format === "token-envelope") {
    copy.token ??= {};
    copy.token.access_token = token.accessToken;
    copy.token.refresh_token = token.refreshToken;
    copy.token.expiry = new Date(token.expiryMs).toISOString();
    return copy;
  }
  copy.access_token = token.accessToken;
  copy.refresh_token = token.refreshToken;
  copy.expiry_date = token.expiryMs;
  return copy;
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
