export const PROVIDER_IDS = Object.freeze(["claude", "antigravity", "grok"]);

const PROVIDER_ALIASES = Object.freeze({
  agy: "antigravity",
  antigravity: "antigravity",
  claude: "claude",
  "claude-code": "claude",
  grok: "grok",
});

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined || (inlineValue === undefined && looksLikeOption(nextValue))) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      throw new Error(`Unknown option --${rawKey}. Use -- before focus text that starts with '-'.`);
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined || looksLikeOption(nextValue)) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option -${shortKey}. Use -- before focus text that starts with '-'.`);
  }

  return { options, positionals };
}

function looksLikeOption(value) {
  return typeof value === "string" && value.startsWith("-") && value !== "-";
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function parseRuntimeArgs(argv) {
  const [command = "help", ...rest] = argv;
  const parsed = parseArgs(rest, {
    booleanOptions: [
      "all",
      "background",
      "check",
      "help",
      "json",
      "live",
      "worktree",
      "write",
    ],
    valueOptions: [
      "base",
      "best-of-n",
      "context",
      "context-file",
      "data-root",
      "effort",
      "interval",
      "job-id",
      "json-schema",
      "max-wait",
      "model",
      "provider",
      "resume",
      "scope",
      "timeout",
    ],
    aliasMap: {
      a: "all",
      b: "base",
      h: "help",
      j: "json",
      m: "model",
      p: "provider",
      r: "resume",
    },
  });

  return {
    command,
    options: normalizeGrokTaskOptions(parsed.options),
    positionals: parsed.positionals,
  };
}

// --best-of-n and --json-schema are Grok-exclusive task options (see
// providers/grok/adapter.mjs). Normalize them to real types here, right
// after parsing, so every downstream consumer (request building, job
// storage, the worker's adapter.task() call) sees a validated number /
// parsed object instead of a raw CLI string.
function normalizeGrokTaskOptions(options) {
  const next = { ...options };
  if (next["best-of-n"] !== undefined) {
    const raw = next["best-of-n"];
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`--best-of-n must be a positive integer, got '${raw}'.`);
    }
    next["best-of-n"] = value;
  }
  if (next["json-schema"] !== undefined) {
    const raw = next["json-schema"];
    try {
      next["json-schema"] = JSON.parse(raw);
    } catch (error) {
      throw new Error(`--json-schema must be valid JSON: ${error.message}`);
    }
  }
  return next;
}

export function resolveProviderIds(options = {}, config = {}) {
  const defaultAll = config.defaultAll ?? true;
  const rawProvider = options.provider?.trim();
  const requestedRaw = options.all || rawProvider === "all" || (!rawProvider && defaultAll)
    ? PROVIDER_IDS
    : rawProvider
      ? rawProvider.split(",").map((part) => part.trim()).filter(Boolean)
      : [];

  const requested = [];
  for (const raw of requestedRaw) {
    const normalized = PROVIDER_ALIASES[raw.toLowerCase()];
    if (!normalized) {
      throw new Error(`Unsupported provider '${raw}'. Supported providers: claude, antigravity, grok.`);
    }
    if (!requested.includes(normalized)) {
      requested.push(normalized);
    }
  }

  if (requested.length === 0) {
    throw new Error("At least one provider is required.");
  }

  return {
    explicit: Boolean(rawProvider && rawProvider !== "all" && !options.all),
    requested,
  };
}
