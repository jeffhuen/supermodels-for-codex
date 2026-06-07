export const PROVIDER_IDS = Object.freeze(["claude", "antigravity"]);

const PROVIDER_ALIASES = Object.freeze({
  agy: "antigravity",
  antigravity: "antigravity",
  claude: "claude",
  "claude-code": "claude",
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
      "help",
      "json",
      "live",
      "write",
    ],
    valueOptions: [
      "base",
      "context",
      "context-file",
      "data-root",
      "effort",
      "interval",
      "job-id",
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
    options: parsed.options,
    positionals: parsed.positionals,
  };
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
      throw new Error(`Unsupported provider '${raw}'. Version 1 supports claude and antigravity only.`);
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
