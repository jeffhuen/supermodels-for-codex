export function parseDiffGitPathTokens(value) {
  const text = String(value ?? "").trim();
  const separated = splitUnquotedDiffGitSides(text);
  if (separated) {
    return separated;
  }
  const tokens = [];
  let index = 0;
  while (index < text.length && tokens.length < 2) {
    while (text[index] === " ") {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }
    if (text[index] === "\"") {
      const token = readQuotedToken(text, index);
      tokens.push(token.value);
      index = token.nextIndex;
      continue;
    }
    const nextSpace = text.indexOf(" ", index);
    if (nextSpace === -1) {
      tokens.push(text.slice(index));
      break;
    }
    tokens.push(text.slice(index, nextSpace));
    index = nextSpace + 1;
  }
  return tokens;
}

export function parseUnifiedDiffHeaderPath(value) {
  const text = String(value ?? "").trimEnd();
  if (text.startsWith("\"")) {
    return parseDiffGitPathTokens(text)[0] ?? "";
  }
  const tabIndex = text.indexOf("\t");
  return tabIndex === -1 ? text : text.slice(0, tabIndex);
}

export function stripGitSidePrefix(file) {
  return String(file ?? "").replace(/^[ab]\//, "");
}

function splitUnquotedDiffGitSides(value) {
  if (!value.startsWith("a/")) {
    return null;
  }
  const candidates = unquotedSeparatorIndexes(value, " b/");
  if (!candidates.length) {
    return null;
  }
  const matchingCandidate = candidates.find((separatorIndex) => {
    const oldPath = value.slice(0, separatorIndex).trim();
    const newPath = value.slice(separatorIndex + 1).trim();
    return stripGitSidePrefix(oldPath) === stripGitSidePrefix(newPath);
  });
  const separatorIndex = matchingCandidate ?? candidates.at(-1);
  const oldPath = value.slice(0, separatorIndex).trim();
  const newPath = value.slice(separatorIndex + 1).trim();
  return oldPath && newPath ? [oldPath, newPath] : null;
}

function unquotedSeparatorIndexes(value, separator) {
  const indexes = [];
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\"" && !escaped) {
      quoted = !quoted;
    }
    if (!quoted && value.startsWith(separator, index)) {
      indexes.push(index);
    }
    escaped = char === "\\" && !escaped;
    if (char !== "\\") {
      escaped = false;
    }
  }
  return indexes;
}

function readQuotedToken(value, startIndex) {
  let index = startIndex + 1;
  let escaped = false;
  while (index < value.length) {
    const char = value[index];
    if (char === "\"" && !escaped) {
      const raw = value.slice(startIndex, index + 1);
      return {
        value: parseQuotedPath(raw),
        nextIndex: index + 1,
      };
    }
    escaped = char === "\\" && !escaped;
    if (char !== "\\") {
      escaped = false;
    }
    index += 1;
  }
  return {
    value: parseQuotedPath(value.slice(startIndex)),
    nextIndex: value.length,
  };
}

function parseQuotedPath(value) {
  try {
    return JSON.parse(value);
  } catch {
    return decodeGitQuotedPath(value);
  }
}

function decodeGitQuotedPath(value) {
  const body = String(value ?? "").replace(/^"|"$/g, "");
  const bytes = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      const codePoint = body.codePointAt(index);
      const literal = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(literal, "utf8"));
      index += literal.length - 1;
      continue;
    }
    const next = body[index + 1];
    if (/[0-7]/.test(next ?? "")) {
      const octal = body.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
      const byte = Number.parseInt(octal, 8);
      if (byte <= 0xff) {
        bytes.push(byte);
      } else {
        bytes.push(...Buffer.from(`\\${octal}`, "utf8"));
      }
      index += octal.length;
      continue;
    }
    const escaped = gitEscapeByte(next);
    if (escaped !== null) {
      bytes.push(escaped);
      index += 1;
      continue;
    }
    bytes.push(...Buffer.from(next ?? "\\", "utf8"));
    if (next) {
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function gitEscapeByte(value) {
  switch (value) {
    case "a":
      return 0x07;
    case "b":
      return 0x08;
    case "f":
      return 0x0c;
    case "n":
      return 0x0a;
    case "r":
      return 0x0d;
    case "t":
      return 0x09;
    case "v":
      return 0x0b;
    case "\\":
      return 0x5c;
    case "\"":
      return 0x22;
    default:
      return null;
  }
}
