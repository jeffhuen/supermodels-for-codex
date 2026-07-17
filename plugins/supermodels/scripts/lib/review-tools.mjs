import { lstat, open, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { collectGitContext } from "./git.mjs";
import { runCommand } from "./process.mjs";

const DEFAULT_MAX_FILE_BYTES = 80_000;
const DEFAULT_MAX_TOOL_BYTES = 120_000;
const DEFAULT_CONTEXT_FILE_LIMIT = 6;
const DEFAULT_CONTEXT_FILE_BYTES = 12_000;
// Headroom reserved on ledger-bearing tool results (get_diff, get_review_context,
// read_file) for the coverage_ledger the review agent attaches AFTER the tool
// returns — so the final model-visible payload (result + ledger) still fits
// maxToolBytes. The agent bounds the ledger itself to this size.
export const COVERAGE_LEDGER_RESERVE = 8_000;
const PRELOAD_MESSAGE_RESERVE = 1_024;
const LEDGER_TOOLS = new Set(["get_diff", "get_review_context", "read_file"]);

export function createReviewTools(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const snapshot = options.snapshot ?? null;
  const toolRoot = path.resolve(snapshot?.root ?? workspaceRoot);
  const snapshotId = String(snapshot?.id ?? `live:${workspaceRoot}`);
  const cursors = createCursorStore(snapshotId);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxToolBytes = options.maxToolBytes ?? DEFAULT_MAX_TOOL_BYTES;
  const controller = options.controller ?? null;

  return {
    schemas: reviewToolSchemas(),
    maxToolBytes,
    reviewDiff: snapshot?.context?.diff ?? null,
    reviewFilteredFiles: snapshot?.filteredFiles ?? [],
    snapshotId: snapshot?.id ?? "",
    async execute(name, input = {}, executionOptions = {}) {
      const activeController = executionOptions.controller ?? controller;
      const activeSignal = executionOptions.signal ?? null;
      throwIfCancelled(activeController, activeSignal);
      const resultCap = executionOptions.preload
        ? Math.max(0, maxToolBytes - PRELOAD_MESSAGE_RESERVE)
        : maxToolBytes;
      // Ledger-bearing tools reserve headroom for the coverage_ledger the review
      // agent attaches after the tool returns, so the final model-visible payload
      // (result + ledger) still fits maxToolBytes.
      const budget = LEDGER_TOOLS.has(name)
        ? Math.max(0, resultCap - COVERAGE_LEDGER_RESERVE)
        : resultCap;
      const compute = async () => {
        if (name === "get_diff") {
          const context = await contextForReviewTools(workspaceRoot, options);
          throwIfCancelled(activeController, activeSignal);
          return pageDiff(context, input.cursor, budget, cursors, workspaceRoot);
        }
        if (name === "get_review_context") {
          return await getReviewContext(
            workspaceRoot,
            toolRoot,
            options,
            input,
            budget,
            cursors,
            activeController,
            activeSignal,
          );
        }
        if (name === "list_changed_files") {
          return await listChangedFiles(
            workspaceRoot,
            options,
            input,
            resultCap,
            cursors,
            activeController,
            activeSignal,
          );
        }
        if (name === "list_files") {
          return await listFiles(toolRoot, input, resultCap, activeController, activeSignal);
        }
        if (name === "search") {
          return await search(toolRoot, input, resultCap, activeController, activeSignal);
        }
        if (name === "read_file") {
          // Line-aware bound: keeps end_line consistent with the returned content
          // (an integrity requirement — coverage/citation trust end_line).
          return boundReadFileResult(
            await readWorkspaceFile(toolRoot, input, maxFileBytes, activeController, activeSignal),
            budget,
          );
        }
        throw new Error(`Unknown review tool: ${name}`);
      };
      const raw = await compute();
      // read_file self-bounds line-aware above; every other result passes through
      // the shared byte budgeter so no tool can exceed the serialized cap.
      return name === "read_file" ? raw : enforceSerializedCap(raw, budget);
    },
  };
}

export function createSnapshotReviewTools(options = {}) {
  if (!options.snapshot?.root || !options.snapshot?.context) {
    throw new Error("Direct reviews require an immutable review snapshot.");
  }
  return createReviewTools(options);
}

function reviewToolSchemas() {
  return [
    {
      name: "get_diff",
      description: "Return one lossless page of the immutable review diff.",
      input_schema: {
        type: "object",
        properties: {
          cursor: { type: "string", description: "Opaque next_cursor from a prior diff page." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_review_context",
      description: "Return one immutable diff page plus bounded changed-file context.",
      input_schema: {
        type: "object",
        properties: {
          cursor: { type: "string", description: "Opaque next_cursor from a prior diff page." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "list_changed_files",
      description: "List one lossless page of files in the immutable review snapshot.",
      input_schema: {
        type: "object",
        properties: {
          cursor: { type: "string", description: "Opaque next_cursor from a prior file-list page." },
        },
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

async function getReviewContext(
  workspaceRoot,
  toolRoot,
  options,
  input,
  maxToolBytes,
  cursors,
  controller,
  signal,
) {
  throwIfCancelled(controller, signal);
  const context = await contextForReviewTools(workspaceRoot, options);
  throwIfCancelled(controller, signal);
  const changedFiles = await changedFilesForReview(workspaceRoot, options, controller, signal);
  const fileLimit = options.contextFileLimit ?? DEFAULT_CONTEXT_FILE_LIMIT;
  const fileBytes = options.contextFileBytes ?? DEFAULT_CONTEXT_FILE_BYTES;
  const offset = cursors.consume(input.cursor, "diff");
  const fileSnippets = [];
  for (const changed of (offset === 0
    ? changedFiles.filter((file) => file.status !== "D").slice(0, fileLimit)
    : [])) {
    throwIfCancelled(controller, signal);
    const snippet = await readWorkspaceFile(toolRoot, {
      path: changed.path,
      start_line: 1,
      end_line: 200,
    }, fileBytes, controller, signal).catch((error) => ({
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
  const metadata = {
    ok: true,
    workspaceRoot,
    snapshotId: context.snapshotId ?? "",
    baseOid: context.baseOid ?? "",
    diffSummary: context.diffSummary,
    changedFiles: offset === 0 ? changedFiles : [],
    fileSnippets,
    truncated: false,
    diffTruncated: false,
  };
  fitReviewContextMetadata(metadata, maxToolBytes, context.diff.length > offset);
  return pageString({
    text: context.diff,
    offset,
    maxBytes: maxToolBytes,
    kind: "diff",
    cursors,
    build: (diff, complete, nextCursor) => ({
      ...metadata,
      diff,
      complete,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    }),
  });
}

async function contextForReviewTools(workspaceRoot, options) {
  if (options.snapshot?.context) {
    return options.snapshot.context;
  }
  return await collectGitContext({
    workspaceRoot,
    scope: options.scope ?? "working-tree",
    baseRef: options.baseRef ?? "",
  });
}

function createCursorStore(snapshotId) {
  const entries = new Map();
  const placeholder = "00000000-0000-4000-8000-000000000000";
  return {
    placeholder,
    issue(kind, offset) {
      const token = randomUUID();
      entries.set(token, { snapshotId, kind, offset });
      return token;
    },
    consume(token, kind) {
      if (token === undefined || token === null || token === "") {
        return 0;
      }
      const key = String(token);
      const entry = entries.get(key);
      if (!entry || entry.snapshotId !== snapshotId || entry.kind !== kind) {
        throw new Error("Invalid, expired, used, or wrong-kind review cursor.");
      }
      entries.delete(key);
      return entry.offset;
    },
  };
}

function pageDiff(context, cursor, maxBytes, cursors, workspaceRoot) {
  const offset = cursors.consume(cursor, "diff");
  return pageString({
    text: context.diff,
    offset,
    maxBytes,
    kind: "diff",
    cursors,
    build: (diff, complete, nextCursor) => ({
      ok: true,
      workspaceRoot,
      snapshotId: context.snapshotId ?? "",
      baseOid: context.baseOid ?? "",
      diffSummary: context.diffSummary,
      diff,
      complete,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    }),
  });
}

function pageString({ text, offset, maxBytes, kind, cursors, build }) {
  const value = String(text ?? "");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) {
    throw new Error("Invalid or expired review cursor.");
  }
  const remaining = value.length - offset;
  const candidate = (count, nextCursor = cursors.placeholder) => {
    const end = offset + count;
    const complete = end >= value.length;
    return build(
      value.slice(offset, end),
      complete,
      complete ? "" : nextCursor,
    );
  };
  // No serialized character can consume less than one byte. Searching beyond
  // one response budget only re-serializes an enormous remainder that cannot
  // fit, making a complete pagination walk quadratic on giant diffs.
  const searchLimit = Math.min(remaining, maxBytes);
  let count = largestFittingValue(searchLimit, (amount) => withinCap(candidate(amount), maxBytes));
  if (count > 0 && splitsSurrogatePair(value, offset + count)) {
    count -= 1;
  }
  if (remaining > 0 && count === 0) {
    throw new Error("maxToolBytes is too small for one diff character.");
  }
  const end = offset + count;
  const complete = end >= value.length;
  return candidate(count, complete ? "" : cursors.issue(kind, end));
}

function fitReviewContextMetadata(metadata, maxBytes, hasRemainingDiff) {
  const placeholder = "00000000-0000-4000-8000-000000000000";
  const originalSnippetCount = metadata.fileSnippets.length;
  const originalFileCount = metadata.changedFiles.length;
  const probe = () => ({
    ...metadata,
    diff: hasRemainingDiff ? "x" : "",
    complete: !hasRemainingDiff,
    ...(hasRemainingDiff ? { next_cursor: placeholder } : {}),
  });
  while (!withinCap(probe(), maxBytes) && metadata.fileSnippets.length) {
    metadata.fileSnippets = metadata.fileSnippets.slice(0, -1);
    metadata.fileSnippetsOmitted = originalSnippetCount - metadata.fileSnippets.length;
    metadata.truncated = true;
  }
  while (!withinCap(probe(), maxBytes) && metadata.changedFiles.length) {
    metadata.changedFiles = metadata.changedFiles.slice(0, -1);
    metadata.changedFilesOmitted = originalFileCount - metadata.changedFiles.length;
    metadata.truncated = true;
  }
  if (!withinCap(probe(), maxBytes) && metadata.diffSummary) {
    const summary = metadata.diffSummary;
    const kept = largestFittingValue(summary.length, (count) => {
      metadata.diffSummary = summary.slice(0, count);
      return withinCap(probe(), maxBytes);
    });
    metadata.diffSummary = summary.slice(0, kept);
    metadata.truncated = true;
  }
  if (!withinCap(probe(), maxBytes)) {
    throw new Error("maxToolBytes is too small for review context metadata.");
  }
}

function largestFittingValue(hi, fits) {
  if (fits(hi)) {
    return hi;
  }
  let lo = 0;
  let high = hi;
  let best = 0;
  while (lo <= high) {
    const mid = (lo + high) >>> 1;
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

async function readWorkspaceFile(workspaceRoot, input, maxBytes, controller, signal) {
  throwIfCancelled(controller, signal);
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
    signal,
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

async function search(workspaceRoot, input, maxBytes, controller, signal) {
  const query = String(input.query ?? "").trim();
  if (!query) {
    return { ok: false, error: "search query is required." };
  }
  throwIfCancelled(controller, signal);
  const result = await runCommand({
    bin: "rg",
    args: ["--line-number", "--hidden", "--glob", "!.git", "--", query, "."],
  }, {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    controller,
    signal,
  });
  throwIfCancelled(controller, signal);
  if (result.exitCode > 1) {
    return { ok: false, error: result.stderr || `rg exited ${result.exitCode}` };
  }
  // Return the full matches; the shared budgeter (enforceSerializedCap) bounds
  // the serialized payload escaping-aware and flags truncation. Truncating the
  // raw text here undercounts JSON escaping and overshoots the cap.
  return {
    ok: true,
    query,
    output: result.stdout || "(no matches)",
    truncated: false,
  };
}

async function listFiles(workspaceRoot, input, maxBytes, controller, signal) {
  throwIfCancelled(controller, signal);
  const result = await runCommand({
    bin: "rg",
    args: ["--files", "--hidden", "--glob", "!.git"],
  }, {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    controller,
    signal,
  });
  throwIfCancelled(controller, signal);
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr || `rg exited ${result.exitCode}` };
  }
  const query = String(input.query ?? "").trim();
  const files = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !query || file.includes(query));
  // Return the full list; the shared budgeter drops whole trailing entries to fit
  // the serialized cap — no marker injected as a fake filename, escaping-aware.
  return {
    ok: true,
    files,
    truncated: false,
  };
}

async function listChangedFiles(workspaceRoot, options, input, maxBytes, cursors, controller, signal) {
  throwIfCancelled(controller, signal);
  const files = await changedFilesForReview(workspaceRoot, options, controller, signal);
  const offset = cursors.consume(input.cursor, "changed-files");
  if (offset > files.length) {
    throw new Error("Invalid or expired review cursor.");
  }
  const renderLine = (file) => `${file.status.padEnd(2)} ${file.path}`;
  const placeholder = cursors.placeholder;
  const build = (count, nextCursor = placeholder) => {
    const end = offset + count;
    const complete = end >= files.length;
    const changedFiles = files.slice(offset, end);
    return {
      ok: true,
      snapshotId: options.snapshot?.id ?? "",
      baseOid: options.snapshot?.baseOid ?? "",
      changedFiles,
      output: changedFiles.length > 0
        ? changedFiles.map(renderLine).join("\n")
        : "(no changed files)",
      complete,
      truncated: !complete,
      ...(!complete
        ? { changedFilesOmitted: files.length - end, next_cursor: nextCursor }
        : {}),
    };
  };
  const remaining = files.length - offset;
  // Every retained entry costs at least one serialized byte, so entries beyond
  // maxBytes cannot possibly fit and must not be repeatedly serialized on each
  // page of a huge file list.
  const count = largestFittingValue(
    Math.min(remaining, maxBytes),
    (value) => withinCap(build(value), maxBytes),
  );
  if (remaining > 0 && count === 0) {
    throw new Error("maxToolBytes is too small for one changed-file entry.");
  }
  const end = offset + count;
  const complete = end >= files.length;
  return build(count, complete ? "" : cursors.issue("changed-files", end));
}

function splitsSurrogatePair(value, index) {
  if (index <= 0 || index >= value.length) {
    return false;
  }
  const left = value.charCodeAt(index - 1);
  const right = value.charCodeAt(index);
  return left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF;
}

async function changedFilesForReview(workspaceRoot, options = {}, controller, signal) {
  if (options.snapshot?.changedFiles) {
    return options.snapshot.changedFiles;
  }
  const baseRef = String(options.baseRef ?? "").trim();
  if (!baseRef) {
    return await changedFilesFromGitStatus(workspaceRoot, controller, signal);
  }
  throwIfCancelled(controller, signal);
  await assertValidBaseRef(workspaceRoot, baseRef, controller, signal);
  const diff = await runCommand({
    bin: "git",
    args: ["diff", "--name-status", "-z", baseRef],
  }, {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    controller,
    signal,
  });
  throwIfCancelled(controller, signal);
  if (diff.exitCode !== 0) {
    throw new Error(`git diff --name-status failed: ${diff.stderr || diff.stdout || `exit ${diff.exitCode}`}`);
  }
  const committed = parseGitNameStatusZ(diff.stdout);
  const untracked = (await changedFilesFromGitStatus(workspaceRoot, controller, signal))
    .filter((file) => file.status === "??");
  return dedupeChangedFiles([...committed, ...untracked]);
}

async function assertValidBaseRef(workspaceRoot, baseRef, controller, signal) {
  const resolved = await runCommand({
    bin: "git",
    args: ["rev-parse", "--verify", `${baseRef}^{commit}`],
  }, {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    controller,
    signal,
  });
  throwIfCancelled(controller, signal);
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
  let lastLine = Math.max(options.start - 1, 0);

  const addLine = (line) => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (lineNumber >= options.start && lineNumber <= options.end) {
      const rendered = `${lineNumber}: ${normalized}`;
      const separatorBytes = lines.length ? 1 : 0;
      const renderedBytes = Buffer.byteLength(rendered, "utf8");
      if (outputBytes + separatorBytes + renderedBytes > options.maxBytes) {
        truncated = true;
        return "truncated";
      }
      lines.push(rendered);
      outputBytes += separatorBytes + renderedBytes;
      lastLine = lineNumber;
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
    if (Buffer.byteLength(pending, "utf8") <= remainingLineBytes) {
      return "continue";
    }
    truncated = true;
    return "truncated";
  };

  try {
    while (lineNumber <= options.end) {
      throwIfCancelled(options.controller, options.signal);
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
      throwIfCancelled(options.controller, options.signal);
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
      endLine: lastLine,
      truncated,
    };
  } finally {
    await handle.close();
  }
}

async function changedFilesFromGitStatus(workspaceRoot, controller, signal) {
  throwIfCancelled(controller, signal);
  const status = await runCommand({
    bin: "git",
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  }, {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    controller,
    signal,
  });
  throwIfCancelled(controller, signal);
  if (status.exitCode !== 0) {
    throw new Error(`git status failed: ${status.stderr || status.stdout || `exit ${status.exitCode}`}`);
  }
  return parseGitStatusZ(status.stdout);
}

function parseGitNameStatusZ(stdout) {
  const fields = String(stdout ?? "").split("\0");
  const files = [];
  let index = 0;
  while (index < fields.length && fields[index]) {
    const rawStatus = fields[index++];
    const status = normalizeNameStatus(rawStatus);
    if (/^[RC]/.test(rawStatus)) {
      const oldPath = fields[index++] ?? "";
      const filePath = fields[index++] ?? "";
      if (oldPath && filePath) {
        files.push({ status, path: filePath, oldPath });
      }
      continue;
    }
    const filePath = fields[index++] ?? "";
    if (filePath) {
      files.push({ status, path: filePath });
    }
  }
  return files;
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

function parseGitStatusZ(stdout) {
  const fields = String(stdout ?? "").split("\0");
  const files = [];
  let index = 0;
  while (index < fields.length && fields[index]) {
    const entry = fields[index++];
    const rawStatus = entry.slice(0, 2);
    const status = rawStatus.trim() || rawStatus;
    const filePath = entry.slice(3);
    if (/[RC]/.test(rawStatus)) {
      const oldPath = fields[index++] ?? "";
      if (filePath) {
        files.push({ status, path: filePath, ...(oldPath ? { oldPath } : {}) });
      }
      continue;
    }
    if (filePath) {
      files.push({ status, path: filePath });
    }
  }
  return files;
}

async function safeWorkspacePath(workspaceRoot, requestedPath) {
  const root = await realpath(workspaceRoot);
  const relative = String(requestedPath ?? "");
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

const TRUNCATION_MARKER = "\n... truncated ...";

// True when `result` serializes within the byte cap (measured on the FINAL
// escaped JSON — the only size the model actually receives).
function withinCap(result, maxBytes) {
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= maxBytes;
}

// Largest k in [0, hi] for which fits() holds after apply(k), assuming
// monotonicity (fits at k ⇒ fits at every smaller k). Leaves state at the chosen
// k. O(log hi) evaluations, so it reclaims exactly the bytes required rather than
// a fixed fraction or a coarse geometric step.
function largestFitting(hi, apply, fits) {
  apply(hi);
  if (fits()) {
    return hi;
  }
  let lo = 0;
  let high = hi;
  let best = 0;
  while (lo <= high) {
    const mid = (lo + high) >>> 1;
    apply(mid);
    if (fits()) {
      best = mid;
      lo = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  apply(best);
  return best;
}

// Trim a string field to the largest prefix that keeps the SERIALIZED result
// within maxBytes (escaping-aware), appending a marker only when it actually
// trims. Returns whether it trimmed.
function fitFieldToBudget(result, field, maxBytes, marker = TRUNCATION_MARKER) {
  const full = String(result[field] ?? "");
  result[field] = full;
  if (withinCap(result, maxBytes)) {
    return false;
  }
  const kept = largestFitting(
    full.length,
    (n) => {
      result[field] = n >= full.length ? full : full.slice(0, n) + marker;
    },
    () => withinCap(result, maxBytes),
  );
  // Pathological caps below the marker size: if not even an empty prefix + marker
  // fits, drop the field to empty (the minimal form) rather than leaving a marker
  // that still overflows.
  if (kept === 0 && !withinCap(result, maxBytes)) {
    result[field] = "";
  }
  return true;
}

// The one shared budgeter for every review tool: guarantee the SERIALIZED result
// never exceeds maxBytes by reclaiming — minimally — from its largest reclaimable
// component (a string field trimmed to a fitting prefix, or an array's tail
// dropped). Tools that bound themselves (get_review_context, list_changed_files)
// already fit, so this is their backstop; for raw-text tools it is the escaping-
// aware enforcement their pre-serialization truncation could not provide.
export function enforceSerializedCap(result, maxBytes) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  let guard = 0;
  while (!withinCap(result, maxBytes) && guard < 128) {
    guard += 1;
    let key = null;
    let kind = null;
    let bytes = -1;
    for (const [candidate, value] of Object.entries(result)) {
      if (typeof value === "string" && value.length) {
        const size = Buffer.byteLength(value, "utf8");
        if (size > bytes) {
          bytes = size;
          key = candidate;
          kind = "string";
        }
      } else if (Array.isArray(value) && value.length) {
        const size = Buffer.byteLength(JSON.stringify(value), "utf8");
        if (size > bytes) {
          bytes = size;
          key = candidate;
          kind = "array";
        }
      }
    }
    if (!key) {
      break; // nothing left to reclaim
    }
    if (kind === "string") {
      fitFieldToBudget(result, key, maxBytes);
    } else {
      const items = result[key];
      largestFitting(
        items.length,
        (n) => {
          result[key] = items.slice(0, n);
        },
        () => withinCap(result, maxBytes),
      );
    }
    result.truncated = true;
  }
  return result;
}

// The number of the last `N: ...` line present in read_file content, or NaN if
// none. Used to keep end_line honest about what the model can actually see.
export function lastNumberedLine(content) {
  const text = String(content ?? "");
  const regex = /(?:^|\n)(\d+):/g;
  let last = NaN;
  let match;
  while ((match = regex.exec(text)) !== null) {
    last = Number(match[1]);
  }
  return last;
}

// Bound a read_file result to the serialized cap by dropping WHOLE trailing
// content lines (never a mid-line byte cut) and resetting end_line to the last
// line that survives — so content and end_line never disagree. Coverage and
// citation both trust end_line, so a stale end_line past the visible content is a
// verification-gate bypass, not cosmetic.
export function boundReadFileResult(result, maxBytes) {
  if (!result || result.ok === false || withinCap(result, maxBytes)) {
    return result;
  }
  const content = String(result.content ?? "");
  const lines = content.length ? content.split("\n") : [];
  const start = Number(result.start_line ?? 1);
  largestFitting(
    lines.length,
    (k) => {
      result.content = lines.slice(0, k).join("\n");
    },
    () => withinCap(result, maxBytes),
  );
  const visibleEnd = lastNumberedLine(result.content);
  result.end_line = Number.isFinite(visibleEnd) ? visibleEnd : Math.max(start - 1, 0);
  result.truncated = true;
  return result;
}

function throwIfCancelled(controller, signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Review tool execution aborted.");
  }
  if (controller?.cancelled) {
    throw new Error(`Review tool execution cancelled by ${controller.signal ?? "signal"}.`);
  }
}
