import path from "node:path";
import { lstat, open } from "node:fs/promises";

import { runCommand } from "./process.mjs";

const MAX_UNTRACKED_FILES = 32;
const MAX_UNTRACKED_BYTES = 200_000;

export async function collectGitContext(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const scope = options.scope ?? "working-tree";
  const baseRef = options.baseRef ?? "";
  const repoLabel = path.basename(workspaceRoot);

  const inside = await runCommand({
    bin: "git",
    args: ["-C", workspaceRoot, "rev-parse", "--is-inside-work-tree"],
  }, { timeoutMs: 5000 });

  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return {
      workspaceRoot,
      repoLabel,
      scope,
      baseRef,
      diffSummary: "Not a git work tree.",
      diff: "",
      gitAvailable: false,
    };
  }

  const primaryDiffArgs = baseRef
    ? ["-C", workspaceRoot, "diff", `${baseRef}...HEAD`]
    : ["-C", workspaceRoot, "diff", "HEAD"];
  const primaryDiff = await runCommand({ bin: "git", args: primaryDiffArgs }, { timeoutMs: 30000 });
  let usedDiffArgs = primaryDiffArgs;
  let fallbackDiff = primaryDiff;
  if (!primaryDiff.stdout.trim()) {
    usedDiffArgs = ["-C", workspaceRoot, "diff"];
    fallbackDiff = await runCommand({
      bin: "git",
      args: usedDiffArgs,
    }, { timeoutMs: 30000 });
  }
  const summary = await runCommand({
    bin: "git",
    args: diffArgsWithShortstat(usedDiffArgs),
  }, { timeoutMs: 10000 });
  const untracked = await collectUntrackedContext(workspaceRoot, options);
  const diffParts = [
    fallbackDiff.stdout,
    untracked.diff,
  ].filter((part) => part.trim());
  const summaryParts = [
    summary.stdout.trim(),
    untracked.summary,
  ].filter(Boolean);

  return {
    workspaceRoot,
    repoLabel,
    scope,
    baseRef,
    diffSummary: summaryParts.join("; ") || "No diff summary available.",
    diff: diffParts.join("\n\n"),
    gitAvailable: true,
  };
}

function diffArgsWithShortstat(args) {
  const diffIndex = args.indexOf("diff");
  if (diffIndex === -1) {
    return args;
  }
  return [
    ...args.slice(0, diffIndex + 1),
    "--shortstat",
    ...args.slice(diffIndex + 1),
  ];
}

async function collectUntrackedContext(workspaceRoot, options = {}) {
  const listed = await runCommand({
    bin: "git",
    args: ["-C", workspaceRoot, "ls-files", "--others", "--exclude-standard", "-z"],
  }, { timeoutMs: 10000 });
  const files = listed.stdout.split("\0").filter(Boolean);
  if (!files.length) {
    return { summary: "", diff: "" };
  }

  let totalBytes = 0;
  const patches = [];
  for (const file of files.slice(0, MAX_UNTRACKED_FILES)) {
    const absolute = path.resolve(workspaceRoot, file);
    if (!absolute.startsWith(path.resolve(workspaceRoot) + path.sep)) {
      continue;
    }
    const info = await lstat(absolute).catch(() => null);
    if (!info) {
      patches.push(renderUntrackedOmitted(file, "could not stat file"));
      continue;
    }
    if (!info.isFile()) {
      patches.push(renderUntrackedOmitted(file, "not a regular file"));
      continue;
    }
    const remainingBytes = MAX_UNTRACKED_BYTES - totalBytes;
    if (remainingBytes <= 0 || info.size > remainingBytes) {
      patches.push(renderUntrackedOmitted(file, "untracked context byte budget reached"));
      continue;
    }
    let content;
    try {
      await options.beforeReadUntrackedFile?.(file, absolute);
      content = await readTextFileWithinLimit(absolute, remainingBytes, info);
    } catch {
      patches.push(renderUntrackedOmitted(file, "could not read file"));
      continue;
    }
    if (content.replaced) {
      patches.push(renderUntrackedOmitted(file, "file changed while reading"));
      continue;
    }
    if (content.truncated) {
      patches.push(renderUntrackedOmitted(file, "untracked context byte budget reached"));
      continue;
    }
    content = content.content;
    if (content.includes("\0")) {
      patches.push(renderUntrackedOmitted(file, "binary content omitted"));
      continue;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (totalBytes + bytes > MAX_UNTRACKED_BYTES) {
      patches.push(renderUntrackedOmitted(file, "untracked context byte budget reached"));
      continue;
    }
    totalBytes += bytes;
    patches.push(renderUntrackedPatch(file, content));
  }

  if (files.length > MAX_UNTRACKED_FILES) {
    patches.push(`# ${files.length - MAX_UNTRACKED_FILES} additional untracked files omitted.`);
  }

  return {
    summary: `${files.length} untracked ${files.length === 1 ? "file" : "files"}`,
    diff: patches.join("\n"),
  };
}

async function readTextFileWithinLimit(filePath, maxBytes, expectedInfo) {
  const handle = await open(filePath, "r");
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || !sameFileIdentity(expectedInfo, openedInfo)) {
      return {
        replaced: true,
        truncated: false,
        content: "",
      };
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    return {
      replaced: false,
      truncated: bytesRead > maxBytes,
      content: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left, right) {
  return Number(left?.dev) === Number(right?.dev)
    && Number(left?.ino) === Number(right?.ino);
}

function renderUntrackedPatch(file, content) {
  const lines = content.split(/\r?\n/);
  const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${lineCount} @@`,
    body,
  ].join("\n");
}

function renderUntrackedOmitted(file, reason) {
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    "@@ -0,0 +1,1 @@",
    `+# Untracked file content omitted: ${reason}.`,
  ].join("\n");
}
