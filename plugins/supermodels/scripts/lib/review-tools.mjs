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
      const compute = async () => {
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
      };
      // Every tool result passes through the one shared budgeter, so no tool can
      // exceed the serialized cap regardless of its own bounding.
      return enforceSerializedCap(await compute(), maxToolBytes);
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
  // Return the full list; the shared budgeter drops whole trailing entries to fit
  // the serialized cap — no marker injected as a fake filename, escaping-aware.
  return {
    ok: true,
    files,
    truncated: false,
  };
}

async function listChangedFiles(workspaceRoot, options, maxBytes, controller) {
  throwIfCancelled(controller);
  const files = await changedFilesForReview(workspaceRoot, options, controller);
  // Keep the largest number of files whose BOTH views — the structured entry and
  // the text `output` line — fit within the serialized cap. Binary search the
  // retained count so the two always describe the same set and it reclaims only
  // what is required: no conservative estimate that stops one entry short of an
  // exact fit, and no early break that ignores later entries.
  const renderLine = (file) => `${file.status.padEnd(2)} ${file.path}`;
  const result = { ok: true, changedFiles: [], output: "", truncated: false };
  const apply = (k) => {
    result.changedFiles = files.slice(0, k);
    result.output = k > 0 ? files.slice(0, k).map(renderLine).join("\n") : "(no changed files)";
    if (k < files.length) {
      result.changedFilesOmitted = files.length - k;
    } else {
      delete result.changedFilesOmitted;
    }
    result.truncated = k < files.length;
  };
  largestFitting(files.length, apply, () => withinCap(result, maxBytes));
  return result;
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
    diffTruncated: false,
  };
  // Reclaim against the HARD cap. The bookkeeping fields are all present in `out`
  // at their largest form while we size it — `truncated` is constant, and both
  // `diffTruncated` (false→true) and `changedFilesOmitted` (reserved at its
  // maximum below) only ever shrink — so this already guarantees the final
  // payload fits, without over-dropping to a soft budget.
  const overCap = () => Buffer.byteLength(JSON.stringify(out), "utf8") > maxBytes;

  // Reclaim in priority order, taking only the bytes actually required at each
  // step (largest-fitting / binary-search trims, never fixed fractions). The diff
  // is the coverage-critical payload (the high-risk hunk ledger is built from it),
  // so it is kept whole while it fits and trimmed only as a last resort.
  //
  // 1. File snippets are the lowest-value context. Shrink every snippet's content
  //    to the LARGEST uniform byte-cap that still fits — so a small overflow trims
  //    them by only what it needs, not a fixed 35%/n — then drop whole snippets
  //    only if emptying their content is still not enough.
  if (overCap() && Array.isArray(out.fileSnippets) && out.fileSnippets.length) {
    const original = out.fileSnippets;
    const fullContents = original.map((snippet) => String(snippet.content ?? ""));
    const origTruncated = original.map((snippet) => Boolean(snippet.truncated));
    const maxContentBytes = fullContents.reduce(
      (max, content) => Math.max(max, Buffer.byteLength(content, "utf8")),
      0,
    );
    // Build fresh snippet objects each step (never mutate the caller's context,
    // which may be reused across the review loop).
    largestFitting(
      maxContentBytes,
      (cap) => {
        out.fileSnippets = original.map((snippet, i) => ({
          ...snippet,
          content: truncateText(fullContents[i], cap),
          truncated: origTruncated[i] || Buffer.byteLength(fullContents[i], "utf8") > cap,
        }));
      },
      () => !overCap(),
    );
  }
  while (overCap() && out.fileSnippets?.length) {
    out.fileSnippets = out.fileSnippets.slice(0, -1);
  }
  // 2 & 3. The diff outranks the changed-files list. Clear the list, then — only
  //    if the diff still overflows on its own — trim it to the largest prefix that
  //    fits, keeping a slice of the budget for the changed-files list (bounded by
  //    the list's real size) so a very large diff does not also discard the entire
  //    list. Finally re-pack the list into whatever budget remains.
  if (overCap()) {
    const allChanged = Array.isArray(out.changedFiles) ? out.changedFiles : null;
    const totalChanged = allChanged ? allChanged.length : 0;
    if (allChanged) {
      out.changedFiles = [];
      out.changedFilesOmitted = totalChanged; // reserve the widest bookkeeping form
    }
    if (overCap() && typeof out.diff === "string" && out.diff.length) {
      // The reserve is the list's real serialized size, capped so a pathological
      // list can never starve the coverage-critical diff. When there are no/few
      // changed files the reserve is ~0, so the diff is trimmed by only what the
      // overflow requires.
      const listBytes = allChanged ? Buffer.byteLength(JSON.stringify(allChanged), "utf8") : 0;
      const fileReserve = Math.min(listBytes, Math.floor(maxBytes * 0.15));
      fitFieldToBudget(out, "diff", Math.max(0, maxBytes - fileReserve));
    }
    if (allChanged) {
      // Binary search the largest count that fits — exact, so it neither over-drops
      // on a conservative estimate nor stops short of the cap.
      largestFitting(
        totalChanged,
        (k) => {
          out.changedFiles = allChanged.slice(0, k);
          if (k < totalChanged) {
            out.changedFilesOmitted = totalChanged - k;
          } else {
            delete out.changedFilesOmitted;
          }
        },
        () => !overCap(),
      );
    }
  }
  // The diff was truncated iff its content actually changed. Compare content,
  // not byte length: for tiny caps the appended truncation marker can make the
  // result longer than a very short original.
  out.diffTruncated = typeof value.diff === "string" && out.diff !== value.diff;
  return out;
}

const TRUNCATION_MARKER = "\n... truncated ...";

function truncateText(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  // Largest character prefix whose bytes plus the marker fit maxBytes — a precise
  // binary search, not a geometric 0.9 step that can overshoot far below budget
  // (which turned every bounded snippet into a fraction of the room it was given).
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
  let lo = 0;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= budget) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return `${text.slice(0, best)}${TRUNCATION_MARKER}`;
}

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
function enforceSerializedCap(result, maxBytes) {
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

function throwIfCancelled(controller) {
  if (controller?.cancelled) {
    throw new Error(`Review tool execution cancelled by ${controller.signal ?? "signal"}.`);
  }
}
