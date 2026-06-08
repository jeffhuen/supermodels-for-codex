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
  const separatorIndex = lastUnquotedSeparator(value, " b/");
  if (separatorIndex === -1) {
    return null;
  }
  const oldPath = value.slice(0, separatorIndex).trim();
  const newPath = value.slice(separatorIndex + 1).trim();
  return oldPath && newPath ? [oldPath, newPath] : null;
}

function lastUnquotedSeparator(value, separator) {
  let matchIndex = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\"" && !escaped) {
      quoted = !quoted;
    }
    if (!quoted && value.startsWith(separator, index)) {
      matchIndex = index;
    }
    escaped = char === "\\" && !escaped;
    if (char !== "\\") {
      escaped = false;
    }
  }
  return matchIndex;
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
    return value.replace(/^"|"$/g, "").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
}
