import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { collectGitContext } from "./git.mjs";
import { runCommand } from "./process.mjs";
import { parseUnifiedDiffHeaderPath } from "./diff-paths.mjs";
import { decodeUtf8Prefix } from "./text.mjs";

const DEFAULT_MAX_FILE_BYTES = 80_000;
const DEFAULT_MAX_TOOL_BYTES = 120_000;
const DEFAULT_CONTEXT_FILE_LIMIT = 6;
const DEFAULT_CONTEXT_FILE_BYTES = 12_000;

export function createReviewTools(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxToolBytes = options.maxToolBytes ?? DEFAULT_MAX_TOOL_BYTES;
  const controller = options.controller ?? null;

  return {
    schemas: reviewToolSchemas(),
    async execute(name, input = {}, executionOptions = {}) {
      const activeController = executionOptions.controller ?? controller;
      throwIfCancelled(activeController);
      if (name === "get_diff") {
        const context = await collectGitContext({
          workspaceRoot,
          scope: options.scope ?? "working-tree",
          baseRef: options.baseRef ?? "",
        });
        throwIfCancelled(activeController);
        return truncateObject({
          ok: true,
          workspaceRoot,
          diffSummary: context.diffSummary,
          diff: context.diff,
        }, maxToolBytes);
      }
      if (name === "get_review_context") {
        return await getReviewContext(workspaceRoot, options, maxToolBytes, activeController);
      }
      if (name === "list_changed_files") {
        return await listChangedFiles(workspaceRoot, options, maxToolBytes, activeController);
      }
      if (name === "list_files") {
        return await listFiles(workspaceRoot, input, maxToolBytes, activeController);
      }
      if (name === "search") {
        return await search(workspaceRoot, input, maxToolBytes, activeController);
      }
      if (name === "read_file") {
        return await readWorkspaceFile(workspaceRoot, input, maxFileBytes, activeController);
      }
      throw new Error(`Unknown review tool: ${name}`);
    },
  };
}

function reviewToolSchemas() {
  return [
    {
      name: "get_diff",
      description: "Return the current git diff and diff summary for the workspace.",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "get_review_context",
      description: "Return the current diff, changed files, and bounded snippets from changed files.",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_changed_files",
      description: "List files changed in the working tree, including untracked files.",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_files",
      description: "List repository files. Use this to discover nearby tests or related modules.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional substring that file paths must contain." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "search",
      description: "Search the workspace with ripgrep and return bounded line matches.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal or regex search query." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "read_file",
      description: "Read a bounded line range from a workspace file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ];
}

async function getReviewContext(workspaceRoot, options, maxToolBytes, controller) {
  throwIfCancelled(controller);
  const context = await collectGitContext({
    workspaceRoot,
    scope: options.scope ?? "working-tree",
    baseRef: options.baseRef ?? "",
  });
  throwIfCancelled(controller);
  const changedFiles = await changedFilesForReview(workspaceRoot, options, controller);
  const fileLimit = options.contextFileLimit ?? DEFAULT_CONTEXT_FILE_LIMIT;
  const fileBytes = options.contextFileBytes ?? DEFAULT_CONTEXT_FILE_BYTES;
  const fileSnippets = [];
  for (const changed of changedFiles.filter((file) => file.status !== "D").slice(0, fileLimit)) {
    throwIfCancelled(controller);
    const snippet = await readWorkspaceFile(workspaceRoot, {
      path: changed.path,
      start_line: 1,
      end_line: 200,
    }, fileBytes, controller).catch((error) => ({
      ok: false,
      error: error?.message || String(error),
      path: changed.path,
    }));
    fileSnippets.push({
      status: changed.status,
      path: changed.path,
      ...(snippet.ok
        ? {
          start_line: snippet.start_line,
          end_line: snippet.end_line,
          truncated: snippet.truncated,
          content: snippet.content,
        }
        : { error: snippet.error ?? "could not read file" }),
    });
  }
  return truncateObject({
    ok: true,
    workspaceRoot,
    diffSummary: context.diffSummary,
    diff: context.diff,
    changedFiles,
    fileSnippets,
  }, maxToolBytes);
}

async function readWorkspaceFile(workspaceRoot, input, maxBytes, controller) {
  throwIfCancelled(controller);
  const safe = await safeWorkspacePath(workspaceRoot, input.path);
  if (!safe.ok) {
    return safe;
  }
  const info = await lstat(safe.absolute).catch(() => null);
  if (!info || !info.isFile()) {
    return { ok: false, error: "Path is not a regular file.", path: safe.relative };
  }
  const start = normalizeLine(input.start_line, 1);
  const end = Math.max(start, normalizeLine(input.end_line, start + 199));
  const bounded = await readLineRangeWithinLimit(safe.absolute, {
    start,
    end: Math.min(end, start + 199),
    maxBytes,
    controller,
  });
  return {
    ok: true,
    path: safe.relative,
    start_line: start,
    end_line: bounded.endLine,
    truncated: bounded.truncated,
    content: bounded.content,
  };
}

async function search(workspaceRoot, input, maxBytes, controller) {
  const query = String(input.query ?? "").trim();
  if (!query) {
    return { ok: false, error: "search query is required." };
  }
  throwIfCancelled(controller);
  const result = await runCommand({
    bin: "rg",
    args: ["--line-number", "--hidden", "--glob", "!.git", "--", query, "."],
  }, {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    controller,
  });
  throwIfCancelled(controller);
  if (result.exitCode > 1) {
    return { ok: false, error: result.stderr || `rg exited ${result.exitCode}` };
  }
  return {
    ok: true,
    query,
    output: truncateText(result.stdout || "(no matches)", maxBytes),
    truncated: Buffer.byteLength(result.stdout ?? "", "utf8") > maxBytes,
  };
}

async function listFiles(workspaceRoot, input, maxBytes, controller) {
  throwIfCancelled(controller);
  const result = await runCommand({
    bin: "rg",
    args: ["--files", "--hidden", "--glob", "!.git"],
  }, {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    controller,
  });
  throwIfCancelled(controller);
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr || `rg exited ${result.exitCode}` };
  }
  const query = String(input.query ?? "").trim();
  const files = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !query || file.includes(query));
  return {
    ok: true,
    files: truncateText(files.join("\n"), maxBytes).split(/\r?\n/).filter(Boolean),
    truncated: Buffer.byteLength(files.join("\n"), "utf8") > maxBytes,
  };
}

async function listChangedFiles(workspaceRoot, options, maxBytes, controller) {
  throwIfCancelled(controller);
  const files = await changedFilesForReview(workspaceRoot, options, controller);
  return {
    ok: true,
    changedFiles: files,
    output: truncateText(
      files.length
        ? files.map((file) => `${file.status.padEnd(2)} ${file.path}`).join("\n")
        : "(no changed files)",
      maxBytes,
    ),
    truncated: Buffer.byteLength(files.map((file) => `${file.status} ${file.path}`).join("\n"), "utf8") > maxBytes,
  };
}

async function changedFilesForReview(workspaceRoot, options = {}, controller) {
  const baseRef = String(options.baseRef ?? "").trim();
  if (!baseRef) {
    return await changedFilesFromGitStatus(workspaceRoot, controller);
  }
  throwIfCancelled(controller);
  await assertValidBaseRef(workspaceRoot, baseRef, controller);
  const diff = await runCommand({
    bin: "git",
    args: ["diff", "--name-status", baseRef],
  }, {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    controller,
  });
  throwIfCancelled(controller);
  if (diff.exitCode !== 0) {
    throw new Error(`git diff --name-status failed: ${diff.stderr || diff.stdout || `exit ${diff.exitCode}`}`);
  }
  const committed = parseGitNameStatus(diff.stdout);
  const untracked = (await changedFilesFromGitStatus(workspaceRoot, controller))
    .filter((file) => file.status === "??");
  return dedupeChangedFiles([...committed, ...untracked]);
}

async function assertValidBaseRef(workspaceRoot, baseRef, controller) {
  const resolved = await runCommand({
    bin: "git",
    args: ["rev-parse", "--verify", `${baseRef}^{commit}`],
  }, {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    controller,
  });
  throwIfCancelled(controller);
  if (resolved.exitCode !== 0) {
    throw new Error(`Base ref '${baseRef}' could not be resolved: ${resolved.stderr || resolved.stdout || `exit ${resolved.exitCode}`}`);
  }
}

async function readLineRangeWithinLimit(absolutePath, options) {
  const handle = await open(absolutePath, "r");
  const decoder = new TextDecoder("utf-8");
  const chunk = Buffer.alloc(64 * 1024);
  const lines = [];
  let pending = "";
  let position = 0;
  let lineNumber = 1;
  let outputBytes = 0;
  let truncated = false;
  let lastLine = options.start;

  const addLine = (line, { forceTruncated = false } = {}) => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (lineNumber >= options.start && lineNumber <= options.end) {
      const rendered = `${lineNumber}: ${normalized}`;
      const separatorBytes = lines.length ? 1 : 0;
      const renderedBytes = Buffer.byteLength(rendered, "utf8");
      if (outputBytes + separatorBytes + renderedBytes > options.maxBytes) {
        const remainingLineBytes = Math.max(0, options.maxBytes - outputBytes - separatorBytes);
        if (remainingLineBytes > 0) {
          const partial = decodeUtf8Prefix(Buffer.from(rendered, "utf8"), remainingLineBytes);
          if (partial) {
            lines.push(partial);
            lastLine = lineNumber;
          }
        }
        truncated = true;
        return "truncated";
      }
      lines.push(rendered);
      outputBytes += separatorBytes + renderedBytes;
      lastLine = lineNumber;
      if (forceTruncated) {
        truncated = true;
        return "truncated";
      }
    }
    lineNumber += 1;
    return lineNumber <= options.end ? "continue" : "done";
  };

  const capPendingLine = () => {
    if (!pending) {
      return "continue";
    }
    if (lineNumber < options.start) {
      if (pending.length > chunk.byteLength) {
        pending = "";
      }
      return "continue";
    }
    if (lineNumber > options.end) {
      return "done";
    }
    const separatorBytes = lines.length ? 1 : 0;
    const prefixBytes = Buffer.byteLength(`${lineNumber}: `, "utf8");
    const remainingLineBytes = Math.max(0, options.maxBytes - outputBytes - separatorBytes - prefixBytes);
    const pendingBuffer = Buffer.from(pending, "utf8");
    if (pendingBuffer.byteLength <= remainingLineBytes) {
      return "continue";
    }
    pending = remainingLineBytes > 0 ? decodeUtf8Prefix(pendingBuffer, remainingLineBytes) : "";
    return addLine(pending, { forceTruncated: true });
  };

  try {
    while (lineNumber <= options.end) {
      throwIfCancelled(options.controller);
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      pending += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
      let newlineIndex;
      while ((newlineIndex = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        const result = addLine(line);
        if (result === "truncated") {
          return { content: lines.join("\n"), endLine: lastLine, truncated: true };
        }
        if (result === "done") {
          return { content: lines.join("\n"), endLine: lastLine, truncated: false };
        }
      }
      const pendingResult = capPendingLine();
      if (pendingResult === "truncated") {
        return { content: lines.join("\n"), endLine: lastLine, truncated: true };
      }
      if (pendingResult === "done") {
        return { content: lines.join("\n"), endLine: lastLine, truncated: false };
      }
    }

    pending += decoder.decode();
    if (pending && lineNumber <= options.end && !truncated) {
      addLine(pending);
    }
    return {
      content: lines.join("\n"),
      endLine: lines.length ? lastLine : options.start,
      truncated,
    };
  } finally {
    await handle.close();
  }
}

async function changedFilesFromGitStatus(workspaceRoot, controller) {
  throwIfCancelled(controller);
  const status = await runCommand({
    bin: "git",
    args: ["status", "--short"],
  }, {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    controller,
  });
  throwIfCancelled(controller);
  if (status.exitCode !== 0) {
    throw new Error(`git status failed: ${status.stderr || status.stdout || `exit ${status.exitCode}`}`);
  }
  return parseGitStatus(status.stdout);
}

function parseGitNameStatus(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.split("\t");
      const status = normalizeNameStatus(parts[0]);
      const filePath = parts.at(-1) ?? "";
      return {
        status,
        path: unquoteGitPath(filePath.trim()),
      };
    })
    .filter((file) => file.path);
}

function normalizeNameStatus(status) {
  const value = String(status ?? "").trim();
  if (/^R\d*/.test(value)) {
    return "R";
  }
  if (/^C\d*/.test(value)) {
    return "C";
  }
  return value.slice(0, 2).trim() || value;
}

function dedupeChangedFiles(files) {
  const out = [];
  const seen = new Set();
  for (const file of files) {
    if (!file.path || seen.has(file.path)) {
      continue;
    }
    seen.add(file.path);
    out.push(file);
  }
  return out;
}

function parseGitStatus(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const status = line.slice(0, 2).trim() || line.slice(0, 2);
      let filePath = line.slice(3).trim();
      const renameIndex = filePath.lastIndexOf(" -> ");
      if (renameIndex >= 0) {
        filePath = filePath.slice(renameIndex + " -> ".length);
      }
      return {
        status,
        path: unquoteGitPath(filePath),
      };
    })
    .filter((file) => file.path);
}

function unquoteGitPath(filePath) {
  return parseUnifiedDiffHeaderPath(filePath);
}

async function safeWorkspacePath(workspaceRoot, requestedPath) {
  const root = await realpath(workspaceRoot);
  const relative = String(requestedPath ?? "").trim();
  if (!relative || path.isAbsolute(relative)) {
    return { ok: false, error: "Path must be workspace-relative." };
  }
  const absolute = path.resolve(root, relative);
  if (!isInside(root, absolute)) {
    return { ok: false, error: "Path resolves outside workspace.", path: relative };
  }
  const resolved = await realpath(absolute).catch(() => "");
  if (!resolved || !isInside(root, resolved)) {
    return { ok: false, error: "Path resolves outside workspace.", path: relative };
  }
  return { ok: true, absolute, relative: path.relative(root, absolute) };
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function normalizeLine(value, fallback) {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : fallback;
}

export function truncateObject(value, maxBytes) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return value;
  }
  const out = {
    ...value,
    truncated: true,
  };
  // Reclaim space from file snippets BEFORE touching the diff. The diff is the
  // coverage-critical payload (the high-risk hunk ledger is built from it), so
  // keep it whole as long as it fits and truncate it only as a last resort —
  // otherwise a complete diff that would fit after dropping snippets gets cut,
  // needlessly disabling coverage enforcement.
  if (Array.isArray(out.fileSnippets) && out.fileSnippets.length) {
    const snippetBudget = Math.max(1000, Math.floor((maxBytes * 0.35) / out.fileSnippets.length));
    out.fileSnippets = out.fileSnippets.map((snippet) => ({
      ...snippet,
      content: truncateText(snippet.content ?? "", snippetBudget),
      truncated: snippet.truncated || Buffer.byteLength(snippet.content ?? "", "utf8") > snippetBudget,
    }));
  }
  while (Buffer.byteLength(JSON.stringify(out), "utf8") > maxBytes && out.fileSnippets?.length) {
    out.fileSnippets.pop();
  }
  // Only if the diff alone still exceeds the cap do we trim it — first to a
  // generous bound, then harder if it still does not fit.
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > maxBytes && typeof out.diff === "string") {
    out.diff = truncateText(out.diff, Math.floor(maxBytes * 0.55));
  }
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > maxBytes && typeof out.diff === "string") {
    out.diff = truncateText(out.diff, Math.floor(maxBytes * 0.2));
  }
  // The diff was truncated iff its content actually changed. Compare content,
  // not byte length: for tiny caps the appended truncation marker can make the
  // result longer than a very short original.
  out.diffTruncated = out.diff !== value.diff;
  return out;
}

function truncateText(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  return `${text.slice(0, end)}\n... truncated ...`;
}

function throwIfCancelled(controller) {
  if (controller?.cancelled) {
    throw new Error(`Review tool execution cancelled by ${controller.signal ?? "signal"}.`);
  }
}
