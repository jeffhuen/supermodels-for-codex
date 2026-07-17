import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { runCommand, signalProcessTree } from "./process.mjs";
import { throwIfAborted } from "./abort.mjs";

const STANDARD_DIFF_PREFIX_ARGS = ["--src-prefix=a/", "--dst-prefix=b/"];

export async function collectGitContext(options = {}) {
  throwIfAborted(options.signal);
  const requestedRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const probe = await probeGitWorkspace(requestedRoot, options.signal);
  if (!probe.inside) {
    assertNoBaseRefOutsideGit(options);
    return unavailableContext(requestedRoot, options);
  }
  const snapshot = await captureGitSnapshot(options, probe.root);
  try {
    return { ...snapshot.context };
  } finally {
    await snapshot.dispose();
  }
}

export async function createReviewSnapshot(options = {}) {
  throwIfAborted(options.signal);
  const requestedRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const probe = await probeGitWorkspace(requestedRoot, options.signal);
  if (!probe.inside) {
    assertNoBaseRefOutsideGit(options);
    return await createFilesystemSnapshot(requestedRoot, options);
  }
  return await captureGitSnapshot(options, probe.root);
}

function assertNoBaseRefOutsideGit(options) {
  if (String(options.baseRef ?? "").trim()) {
    throw new Error("Cannot review a base ref outside a Git worktree.");
  }
}

async function captureGitSnapshot(options, workspaceRoot) {
  const signal = options.signal;
  throwIfAborted(signal);
  const scope = options.scope ?? "working-tree";
  const baseRef = String(options.baseRef ?? "").trim();
  const repoLabel = path.basename(workspaceRoot);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-snapshot-"));
  const objectRoot = path.join(tempRoot, "objects");
  const indexPath = path.join(tempRoot, "index");
  const snapshotRoot = path.join(tempRoot, "tree");
  const filterRoot = path.join(tempRoot, "filter-tree");
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await rm(tempRoot, { recursive: true, force: true });
  };

  try {
    await mkdir(objectRoot, { recursive: true, mode: 0o700 });
    await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    await mkdir(filterRoot, { recursive: true, mode: 0o700 });

    const repoObjectsResult = await runGitChecked(workspaceRoot, ["rev-parse", "--git-path", "objects"], { signal });
    const repoObjects = resolveGitPath(workspaceRoot, gitOutputLine(repoObjectsResult.stdout));
    const gitDir = (await runGitChecked(workspaceRoot, ["rev-parse", "--absolute-git-dir"], { signal }))
      .stdout;
    const existingAlternates = String(process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? "");
    const env = {
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectRoot,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [encodeAlternateObjectDirectory(repoObjects), existingAlternates]
        .filter(Boolean)
        .join(path.delimiter),
      GIT_DIR: gitOutputLine(gitDir),
      GIT_WORK_TREE: snapshotRoot,
      GIT_LFS_SKIP_SMUDGE: "1",
    };

    const head = await resolveOptionalHead(workspaceRoot, signal);
    const baseOid = baseRef
      ? await resolveRequiredBase(workspaceRoot, baseRef, signal)
      : head;

    const sourceIndexResult = await runGitChecked(workspaceRoot, ["rev-parse", "--git-path", "index"], { signal });
    const sourceIndex = resolveGitPath(workspaceRoot, gitOutputLine(sourceIndexResult.stdout));
    let seededFromIndex = false;
    if (await exists(sourceIndex)) {
      await copyRegularFile(sourceIndex, indexPath, signal);
      seededFromIndex = true;
    }
    if (!seededFromIndex) {
      if (head) {
        await runGitChecked(workspaceRoot, ["read-tree", head], { env, signal });
      } else {
        await runGitChecked(workspaceRoot, ["read-tree", "--empty"], { env, signal });
      }
    }

    const indexEntries = await readIndexEntries(snapshotRoot, env, signal);
    const gitlinks = indexEntries.filter((entry) => entry.mode === "160000");
    const indexFlags = await readIndexFlags(snapshotRoot, env, signal);
    const sparseExcludedPaths = await assertReviewableIndexFlags(
      workspaceRoot,
      indexEntries,
      gitlinks,
      indexFlags,
      signal,
    );
    const deletedPaths = await deletedTrackedPaths(workspaceRoot, signal);
    await assertCleanSubmodules(workspaceRoot, gitlinks, deletedPaths, signal);
    const sourceCapture = await materializePrivateWorkTree({
      workspaceRoot,
      snapshotRoot,
      env,
      indexEntries,
      gitlinks,
      deletedPaths,
      sparseExcludedPaths,
      signal,
    });
    const capturedTree = await privateTreeManifest(snapshotRoot, signal);

    // Run configured clean filters only against a throwaway copy. A filter may
    // retain a child process after `git add`; that child must never have a path
    // or cwd inside the immutable tree later exposed to review tools.
    await copyTree(snapshotRoot, filterRoot, signal);
    const filterEnv = { ...env, GIT_WORK_TREE: filterRoot };
    await runGitChecked(filterRoot, ["add", "-A", "--", "."], {
      env: filterEnv,
      timeoutMs: 60_000,
      cleanupProcessGroup: true,
      signal,
    });
    await assertPrivateTreeUnchanged(filterRoot, capturedTree, "A Git content filter", signal);
    const treeOid = (await runGitChecked(filterRoot, ["write-tree"], { env: filterEnv, signal })).stdout.trim();
    let resolvedBaseOid = baseOid;
    if (!resolvedBaseOid) {
      resolvedBaseOid = (await runGitChecked(filterRoot, ["mktree"], { env: filterEnv, input: "", signal })).stdout.trim();
    }
    await assertNoChangedGitlinks(filterRoot, filterEnv, resolvedBaseOid, treeOid, signal);

    const diffArgs = [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      ...STANDARD_DIFF_PREFIX_ARGS,
      resolvedBaseOid,
      treeOid,
      "--",
    ];
    const diff = await runGitChecked(filterRoot, diffArgs, { env: filterEnv, timeoutMs: 60_000, signal });
    const summary = await runGitChecked(filterRoot, [
      "diff",
      "--shortstat",
      "--no-ext-diff",
      "--no-textconv",
      resolvedBaseOid,
      treeOid,
      "--",
    ], { env: filterEnv, timeoutMs: 30_000, signal });
    const names = await runGitChecked(filterRoot, [
      "diff",
      "--name-status",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      resolvedBaseOid,
      treeOid,
      "--",
    ], { env: filterEnv, timeoutMs: 30_000, signal });
    const changedFiles = parseGitNameStatusZ(names.stdout);
    const filteredFiles = await filteredChangedFiles(
      filterRoot,
      filterEnv,
      snapshotRoot,
      changedFiles,
      resolvedBaseOid,
      signal,
    );
    await assertSourceCaptureUnchanged({
      workspaceRoot,
      snapshotRoot,
      capturedTree,
      sourceCapture,
      signal,
    });
    await assertSourceIndexUnchanged(workspaceRoot, indexEntries, indexFlags, signal);
    await assertCleanSubmodules(workspaceRoot, gitlinks, await deletedTrackedPaths(workspaceRoot, signal), signal);
    if (!baseRef && (await resolveOptionalHead(workspaceRoot, signal)) !== head) {
      throw new Error("Repository HEAD changed while the review snapshot was captured.");
    }
    const snapshotId = snapshotManifestId(treeOid, capturedTree, signal);
    await rm(filterRoot, { recursive: true, force: true });

    const context = {
      workspaceRoot,
      repoLabel,
      scope,
      baseRef,
      baseOid: resolvedBaseOid,
      snapshotId,
      diffSummary: summary.stdout.trim() || "No changes.",
      diff: diff.stdout,
      changedFiles,
      filteredFiles,
      gitAvailable: true,
    };
    return {
      id: snapshotId,
      treeOid,
      baseOid: resolvedBaseOid,
      root: snapshotRoot,
      tempRoot,
      workspaceRoot,
      changedFiles,
      filteredFiles,
      context,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function createFilesystemSnapshot(workspaceRoot, options) {
  const signal = options.signal;
  throwIfAborted(signal);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-snapshot-"));
  const snapshotRoot = path.join(tempRoot, "tree");
  let disposed = false;
  try {
    // Dereference only the workspace root. Nested symlinks remain symlinks in
    // the captured tree, but a caller-supplied root symlink must never turn the
    // snapshot itself into a live alias of the source directory.
    const sourceRoot = await realpath(workspaceRoot);
    await copyTree(sourceRoot, snapshotRoot, signal);
    const capturedTree = await privateTreeManifest(snapshotRoot, signal);
    await assertPrivateTreeUnchanged(sourceRoot, capturedTree, "The source workspace", signal);
    const id = `filesystem-${randomUUID()}`;
    return {
      id,
      treeOid: "",
      baseOid: "",
      root: snapshotRoot,
      tempRoot,
      workspaceRoot,
      changedFiles: [],
      context: {
        ...unavailableContext(workspaceRoot, options),
        snapshotId: id,
        baseOid: "",
        changedFiles: [],
      },
      async dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readIndexEntries(privateRoot, env, signal) {
  const result = await runGitChecked(privateRoot, ["ls-files", "--stage", "-z"], { env, signal });
  return parseIndexEntries(result.stdout);
}

function parseIndexEntries(stdout) {
  const entries = [];
  for (const field of String(stdout ?? "").split("\0")) {
    if (!field) {
      continue;
    }
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(field);
    if (!match) {
      throw new Error("git ls-files returned an unparseable index entry; review snapshot aborted.");
    }
    const stage = Number(match[3]);
    if (stage !== 0) {
      throw new Error(`Cannot snapshot an unresolved index entry at '${match[4]}'.`);
    }
    entries.push({ mode: match[1], oid: match[2], path: match[4] });
  }
  return entries;
}

async function readIndexFlags(privateRoot, env, signal) {
  const result = await runGitChecked(privateRoot, ["ls-files", "-v", "-z"], { env, signal });
  return parseIndexFlags(result.stdout);
}

function parseIndexFlags(stdout) {
  const flags = new Map();
  for (const field of String(stdout ?? "").split("\0")) {
    if (!field) {
      continue;
    }
    const match = /^(.?) ([\s\S]+)$/.exec(field);
    if (!match) {
      throw new Error("git ls-files returned an unparseable index flag entry; review snapshot aborted.");
    }
    flags.set(match[2], match[1]);
  }
  return flags;
}

async function assertSourceIndexUnchanged(workspaceRoot, expectedEntries, expectedFlags, signal) {
  const entries = parseIndexEntries((await runGitChecked(workspaceRoot, [
    "ls-files",
    "--stage",
    "-z",
  ], { signal })).stdout);
  const flags = parseIndexFlags((await runGitChecked(workspaceRoot, [
    "ls-files",
    "-v",
    "-z",
  ], { signal })).stdout);
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)
    || JSON.stringify([...flags]) !== JSON.stringify([...expectedFlags])) {
    throw new Error("Repository index or sparse-checkout state changed while the review snapshot was captured.");
  }
}

async function assertReviewableIndexFlags(workspaceRoot, indexEntries, gitlinks, flags, signal) {
  const gitlinkPaths = new Set(gitlinks.map((entry) => entry.path));
  const absentSkipPaths = [];
  for (const entry of indexEntries) {
    throwIfAborted(signal);
    if (gitlinkPaths.has(entry.path)) {
      continue;
    }
    const flag = flags.get(entry.path) ?? "H";
    if (flag === flag.toLowerCase()) {
      throw new Error(
        `Cannot prove a complete snapshot while '${entry.path}' is marked assume-unchanged; `
        + "clear the index flag before review.",
      );
    }
    if (flag === "S") {
      if (await lstat(path.join(workspaceRoot, entry.path)).catch(() => null)) {
        throw new Error(
          `Cannot prove a complete snapshot while skip-worktree path '${entry.path}' is present; `
          + "clear the index flag before review.",
        );
      }
      absentSkipPaths.push(entry.path);
    }
  }
  if (!absentSkipPaths.length) {
    return new Set();
  }
  const sparseExcluded = await sparseExcludedPaths(workspaceRoot, absentSkipPaths, signal);
  if (!sparseExcluded) {
    throw new Error(
      "Cannot verify absent skip-worktree paths against sparse-checkout rules; "
      + "Git 2.41 or newer is required, or restore the paths/clear their index flags before review.",
    );
  }
  for (const filePath of absentSkipPaths) {
    if (!sparseExcluded.has(filePath)) {
      throw new Error(
        `Cannot prove whether absent skip-worktree path '${filePath}' is an intentional sparse exclusion; `
        + "restore the path or clear the index flag before review.",
      );
    }
  }
  return sparseExcluded;
}

async function sparseExcludedPaths(workspaceRoot, paths, signal) {
  const result = await runCommand({
    bin: "git",
    args: ["-C", workspaceRoot, "sparse-checkout", "check-rules", "-z"],
  }, {
    timeoutMs: 10_000,
    input: `${paths.join("\0")}\0`,
    signal,
  });
  throwIfAborted(signal);
  if (result.exitCode !== 0) {
    return null;
  }
  const included = new Set(parseNulPaths(result.stdout));
  return new Set(paths.filter((filePath) => !included.has(filePath)));
}

async function materializePrivateWorkTree({
  workspaceRoot,
  snapshotRoot,
  env,
  indexEntries,
  gitlinks,
  deletedPaths,
  sparseExcludedPaths,
  signal,
}) {
  const gitlinkPaths = new Set(gitlinks.map((entry) => entry.path));
  const trackedStates = new Map();
  const deleted = deletedPaths;
  const missingFromSparseCheckout = [];

  for (const entry of indexEntries) {
    throwIfAborted(signal);
    if (gitlinkPaths.has(entry.path)) {
      continue;
    }
    const source = path.join(workspaceRoot, entry.path);
    const info = await lstat(source).catch(() => null);
    if (info?.isFile() || info?.isSymbolicLink()) {
      await copyRawEntry(source, path.join(snapshotRoot, entry.path), info, signal);
      trackedStates.set(entry.path, "present");
      continue;
    }
    if (info?.isDirectory()) {
      await rm(path.join(snapshotRoot, entry.path), { recursive: true, force: true });
      trackedStates.set(entry.path, "directory");
      continue;
    }
    if (info) {
      throw new Error(`Tracked path '${entry.path}' has unsupported live file type; review snapshot aborted.`);
    }
    if (deleted.has(entry.path) || !sparseExcludedPaths.has(entry.path)) {
      await rm(path.join(snapshotRoot, entry.path), { recursive: true, force: true });
      trackedStates.set(entry.path, "missing");
      continue;
    }
    missingFromSparseCheckout.push(entry.path);
    trackedStates.set(entry.path, "missing");
  }

  if (missingFromSparseCheckout.length) {
    await runGitChecked(snapshotRoot, [
      "checkout-index",
      "--force",
      "--ignore-skip-worktree-bits",
      "--stdin",
      "-z",
      `--prefix=${snapshotRoot}${path.sep}`,
    ], {
      env,
      input: `${missingFromSparseCheckout.join("\0")}\0`,
      timeoutMs: 60_000,
      signal,
    });
  }

  const untrackedResult = await runGitChecked(workspaceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ], { signal });
  const untrackedPaths = parseNulPaths(untrackedResult.stdout);
  for (const relative of untrackedPaths) {
    throwIfAborted(signal);
    const source = path.join(workspaceRoot, relative);
    const info = await lstat(source).catch(() => null);
    if (!info) {
      throw new Error(`Untracked path '${relative}' changed while the review snapshot was captured.`);
    }
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`Untracked path '${relative}' is not a regular file or symlink.`);
    }
    await copyRawEntry(source, path.join(snapshotRoot, relative), info, signal);
  }

  // A clean gitlink has no ordinary file representation in the private tree.
  // Preserve its index entry across `git add -A`; changed/deleted/new gitlinks
  // are rejected separately rather than being silently flattened or omitted.
  for (const entry of gitlinks) {
    throwIfAborted(signal);
    await runGitChecked(snapshotRoot, ["update-index", "--skip-worktree", "--", entry.path], { env, signal });
  }
  return { trackedStates, untrackedPaths };
}

async function copyTree(sourceRoot, destinationRoot, signal) {
  throwIfAborted(signal);
  const sourceInfo = await lstat(sourceRoot);
  await mkdir(destinationRoot, { recursive: true, mode: sourceInfo.mode });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    throwIfAborted(signal);
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    const info = await lstat(source);
    if (info.isDirectory()) {
      await copyTree(source, destination, signal);
    } else if (info.isFile() || info.isSymbolicLink()) {
      await copyRawEntry(source, destination, info, signal);
    } else {
      throw new Error(`Path '${source}' has unsupported live file type; review snapshot aborted.`);
    }
  }
  await chmod(destinationRoot, sourceInfo.mode);
  throwIfAborted(signal);
}

async function copyRegularFile(source, destination, signal) {
  throwIfAborted(signal);
  try {
    await pipeline(
      createReadStream(source),
      createWriteStream(destination),
      { signal },
    );
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  throwIfAborted(signal);
}

async function copyRawEntry(source, destination, before, signal) {
  throwIfAborted(signal);
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  if (before.isSymbolicLink()) {
    const target = await readlink(source);
    await symlink(target, destination);
  } else {
    await copyRegularFile(source, destination, signal);
    await chmod(destination, before.mode);
  }
  throwIfAborted(signal);
  const after = await lstat(source).catch(() => null);
  if (!after
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || after.isSymbolicLink() !== before.isSymbolicLink()) {
    throw new Error(`Path '${source}' changed while the review snapshot was captured.`);
  }
}

async function privateTreeManifest(root, signal) {
  const entries = new Map();
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      throwIfAborted(signal);
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        const info = await lstat(absolute);
        entries.set(relative, { type: "directory", mode: info.mode });
        await visit(absolute);
      } else if (entry.isSymbolicLink()) {
        const info = await lstat(absolute);
        entries.set(relative, {
          type: "symlink",
          mode: info.mode,
          target: await readlink(absolute),
        });
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        entries.set(relative, {
          type: "file",
          mode: info.mode,
          size: info.size,
          digest: await digestFile(absolute, signal),
        });
      } else {
        entries.set(relative, { type: "other" });
      }
    }
  };
  await visit(root);
  return entries;
}

async function assertSourceCaptureUnchanged({
  workspaceRoot,
  snapshotRoot,
  capturedTree,
  sourceCapture,
  signal,
}) {
  const currentUntracked = parseNulPaths((await runGitChecked(workspaceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ], { signal })).stdout);
  if (!sameStringSet(currentUntracked, sourceCapture.untrackedPaths)) {
    throw new Error("Untracked paths changed while the review snapshot was captured.");
  }

  for (const [relative, expectedState] of sourceCapture.trackedStates) {
    throwIfAborted(signal);
    const source = path.join(workspaceRoot, relative);
    const info = await lstat(source).catch(() => null);
    if (expectedState === "missing") {
      if (info) {
        throw new Error(`Tracked path '${relative}' changed while the review snapshot was captured.`);
      }
      continue;
    }
    if (expectedState === "directory") {
      if (!info?.isDirectory()) {
        throw new Error(`Tracked path '${relative}' changed while the review snapshot was captured.`);
      }
      continue;
    }
    await assertSourceEntryMatches(source, relative, capturedTree.get(relative), signal);
  }
  for (const relative of sourceCapture.untrackedPaths) {
    throwIfAborted(signal);
    await assertSourceEntryMatches(
      path.join(workspaceRoot, relative),
      relative,
      capturedTree.get(relative),
      signal,
    );
  }

  // The delivered tree is immutable, but compare it once more after reading
  // every live source so a change during this validation pass also fails.
  await assertPrivateTreeUnchanged(snapshotRoot, capturedTree, "The captured snapshot", signal);
}

async function assertSourceEntryMatches(source, relative, captured, signal) {
  throwIfAborted(signal);
  const info = await lstat(source).catch(() => null);
  if (!info || !captured) {
    throw new Error(`Path '${relative}' changed while the review snapshot was captured.`);
  }
  if (captured.type === "file") {
    if (!info.isFile()
      || info.mode !== captured.mode
      || info.size !== captured.size
      || await digestFile(source, signal) !== captured.digest) {
      throw new Error(`Path '${relative}' changed while the review snapshot was captured.`);
    }
    return;
  }
  if (captured.type === "symlink") {
    if (!info.isSymbolicLink()
      || info.mode !== captured.mode
      || await readlink(source) !== captured.target) {
      throw new Error(`Path '${relative}' changed while the review snapshot was captured.`);
    }
    return;
  }
  throw new Error(`Path '${relative}' has unsupported captured file type; review snapshot aborted.`);
}

function sameStringSet(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  const expected = new Set(right);
  return left.every((entry) => expected.has(entry));
}

async function assertPrivateTreeUnchanged(root, capturedTree, subject = "A Git content filter", signal) {
  const after = await privateTreeManifest(root, signal);
  const added = [...after.keys()].find((entry) => !capturedTree.has(entry));
  const removed = [...capturedTree.keys()].find((entry) => !after.has(entry));
  const modified = [...capturedTree.keys()].find((entry) =>
    after.has(entry) && JSON.stringify(after.get(entry)) !== JSON.stringify(capturedTree.get(entry))
  );
  if (added || removed || modified) {
    const detail = added
      ? `created unexpected path '${added}'`
      : removed
        ? `removed captured path '${removed}'`
        : `modified captured path '${modified}'`;
    throw new Error(`${subject} ${detail}; review snapshot aborted.`);
  }
}

async function digestFile(filePath, signal) {
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath, { signal })) {
      throwIfAborted(signal);
      digest.update(chunk);
    }
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  throwIfAborted(signal);
  return digest.digest("hex");
}

async function filteredChangedFiles(privateRoot, env, snapshotRoot, changedFiles, baseOid, signal) {
  const currentPaths = changedFiles.map((file) => file.path);
  if (!currentPaths.length) {
    return [];
  }
  const basePaths = changedFiles.map((file) => file.oldPath ?? file.path);
  const currentAttributes = await filterAttributes(privateRoot, env, currentPaths, "", signal);
  const baseAttributes = await filterAttributes(privateRoot, env, basePaths, baseOid, signal);
  const canonicalEntries = new Map(
    (await readIndexEntries(privateRoot, env, signal)).map((entry) => [entry.path, entry.oid]),
  );
  const results = [];
  for (const file of changedFiles) {
    throwIfAborted(signal);
    const currentFilter = currentAttributes.get(file.path) ?? "";
    const baseFilter = baseAttributes.get(file.oldPath ?? file.path) ?? "";
    const filter = currentFilter && baseFilter && currentFilter !== baseFilter
      ? `${baseFilter} -> ${currentFilter}`
      : currentFilter || baseFilter;
    if (!filter) {
      continue;
    }
    if (file.status === "D") {
      results.push({ path: file.path, status: file.status, filter, lineCount: 0 });
      continue;
    }
    const absolute = path.join(snapshotRoot, file.path);
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile()) {
      continue;
    }
    const rawOid = gitOutputLine((await runGitChecked(privateRoot, [
      "hash-object",
      "--no-filters",
      "--",
      absolute,
    ], { env, signal })).stdout);
    const currentRepresentationMatches = rawOid === canonicalEntries.get(file.path);
    const baseRepresentationMayDiffer = file.status !== "A" && Boolean(baseFilter);
    if (currentRepresentationMatches && !baseRepresentationMayDiffer) {
      continue;
    }
    results.push({
      path: file.path,
      status: file.status,
      filter,
      lineCount: await countFileLines(absolute, signal),
    });
  }
  return results;
}

async function filterAttributes(privateRoot, env, paths, source = "", signal) {
  const input = `${paths.join("\0")}\0`;
  let attributes;
  if (!source) {
    attributes = await runGitChecked(privateRoot, ["check-attr", "-z", "--stdin", "filter"], {
      env,
      input,
      signal,
    });
  } else {
    const indexPath = path.join(path.dirname(env.GIT_INDEX_FILE), `attributes-${randomUUID()}.index`);
    const sourceEnv = { ...env, GIT_INDEX_FILE: indexPath };
    try {
      await runGitChecked(privateRoot, ["read-tree", source], { env: sourceEnv, signal });
      attributes = await runGitChecked(
        privateRoot,
        ["check-attr", "--cached", "-z", "--stdin", "filter"],
        { env: sourceEnv, input, signal },
      );
    } finally {
      await rm(indexPath, { force: true });
      await rm(`${indexPath}.lock`, { force: true });
    }
  }
  const fields = String(attributes.stdout ?? "").split("\0");
  const byPath = new Map();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [file, attribute, value] = fields.slice(index, index + 3);
    if (file && attribute === "filter" && !["", "unspecified", "unset", "set"].includes(value)) {
      byPath.set(file, value);
    }
  }
  return byPath;
}

async function countFileLines(filePath, signal) {
  let bytes = 0;
  let newlines = 0;
  let lastByte = -1;
  try {
    for await (const chunk of createReadStream(filePath, { signal })) {
      throwIfAborted(signal);
      bytes += chunk.length;
      lastByte = chunk[chunk.length - 1];
      for (const byte of chunk) {
        if (byte === 0x0A) {
          newlines += 1;
        }
      }
    }
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  return bytes === 0 ? 0 : newlines + (lastByte === 0x0A ? 0 : 1);
}

async function deletedTrackedPaths(workspaceRoot, signal) {
  const result = await runGitChecked(workspaceRoot, [
    "diff-files",
    "--name-only",
    "--diff-filter=D",
    "--ignore-submodules=none",
    "-z",
    "--",
  ], { signal });
  return new Set(parseNulPaths(result.stdout));
}

function snapshotManifestId(treeOid, manifest, signal) {
  const digest = createHash("sha256");
  digest.update(`tree ${treeOid}\0`);
  for (const [relative, entry] of [...manifest.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    throwIfAborted(signal);
    digest.update(relative);
    digest.update("\0");
    digest.update(JSON.stringify(entry));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function assertCleanSubmodules(workspaceRoot, gitlinks, deletedPaths = new Set(), signal) {
  for (const entry of gitlinks) {
    throwIfAborted(signal);
    if (deletedPaths.has(entry.path)) {
      throw new Error(`Cannot snapshot deleted gitlink '${entry.path}'. Review submodule changes separately.`);
    }
    const submoduleRoot = path.join(workspaceRoot, entry.path);
    const info = await lstat(submoduleRoot).catch(() => null);
    if (!info) {
      continue; // unchanged, uninitialized submodule; the gitlink remains in the index
    }
    if (!info.isDirectory()) {
      throw new Error(`Cannot snapshot changed submodule path '${entry.path}'.`);
    }
    if (!await exists(path.join(submoduleRoot, ".git"))) {
      if ((await readdir(submoduleRoot)).length === 0) {
        continue; // `git submodule deinit` leaves an empty directory
      }
      throw new Error(`Cannot snapshot unavailable submodule '${entry.path}'.`);
    }
    const head = await runCommand({
      bin: "git",
      args: ["-C", submoduleRoot, "rev-parse", "--verify", "HEAD^{commit}"],
    }, { timeoutMs: 10_000, signal });
    throwIfAborted(signal);
    if (head.exitCode !== 0) {
      throw new Error(`Cannot snapshot unavailable submodule '${entry.path}'.`);
    }
    if (head.stdout.trim() !== entry.oid) {
      throw new Error(`Cannot snapshot changed gitlink '${entry.path}': submodule HEAD differs from the index.`);
    }
    const status = await runCommand({
      bin: "git",
      args: [
        "-C",
        submoduleRoot,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
    }, { timeoutMs: 30_000, signal });
    throwIfAborted(signal);
    if (status.exitCode !== 0) {
      throw new Error(`Cannot inspect submodule '${entry.path}': ${status.stderr || status.stdout}`);
    }
    if (status.stdout) {
      throw new Error(`Cannot snapshot dirty or untracked submodule '${entry.path}'.`);
    }
  }
}

async function assertNoChangedGitlinks(privateRoot, env, baseOid, treeOid, signal) {
  const [base, snapshot] = await Promise.all([
    gitlinksForTree(privateRoot, env, baseOid, signal),
    gitlinksForTree(privateRoot, env, treeOid, signal),
  ]);
  const paths = new Set([...base.keys(), ...snapshot.keys()]);
  for (const filePath of paths) {
    if (base.get(filePath) !== snapshot.get(filePath)) {
      throw new Error(`Cannot snapshot changed gitlink '${filePath}'. Review submodule changes separately.`);
    }
  }
}

async function gitlinksForTree(privateRoot, env, treeOid, signal) {
  const result = await runGitChecked(privateRoot, ["ls-tree", "-r", "-z", treeOid, "--"], { env, signal });
  const gitlinks = new Map();
  for (const field of String(result.stdout ?? "").split("\0")) {
    throwIfAborted(signal);
    if (!field) {
      continue;
    }
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(field);
    if (!match) {
      throw new Error("git ls-tree returned an unparseable entry; review snapshot aborted.");
    }
    if (match[1] === "160000") {
      gitlinks.set(match[4], match[3]);
    }
  }
  return gitlinks;
}

function parseNulPaths(stdout) {
  return String(stdout ?? "").split("\0").filter(Boolean);
}

async function probeGitWorkspace(workspaceRoot, signal) {
  throwIfAborted(signal);
  const result = await runCommand({
    bin: "git",
    args: ["-C", workspaceRoot, "rev-parse", "--is-inside-work-tree"],
  }, { timeoutMs: 5_000, signal });
  throwIfAborted(signal);
  if (result.exitCode === 0 && gitOutputLine(result.stdout) === "true") {
    const root = await runGitChecked(workspaceRoot, ["rev-parse", "--show-toplevel"], { signal });
    return { inside: true, root: path.resolve(gitOutputLine(root.stdout)) };
  }
  if (/not a git repository/i.test(`${result.stderr}\n${result.stdout}`)) {
    return { inside: false };
  }
  throw new Error(gitFailureMessage(["rev-parse", "--is-inside-work-tree"], result));
}

async function resolveOptionalHead(workspaceRoot, signal) {
  const result = await runCommand({
    bin: "git",
    args: ["-C", workspaceRoot, "rev-parse", "--verify", "HEAD^{commit}"],
  }, { timeoutMs: 10_000, signal });
  throwIfAborted(signal);
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }
  if (/needed a single revision|unknown revision|ambiguous argument/i.test(`${result.stderr}\n${result.stdout}`)) {
    return "";
  }
  throw new Error(gitFailureMessage(["rev-parse", "--verify", "HEAD^{commit}"], result));
}

async function resolveRequiredBase(workspaceRoot, baseRef, signal) {
  const result = await runCommand({
    bin: "git",
    args: ["-C", workspaceRoot, "rev-parse", "--verify", `${baseRef}^{commit}`],
  }, { timeoutMs: 10_000, signal });
  throwIfAborted(signal);
  if (result.exitCode !== 0) {
    throw new Error(
      `Base ref '${baseRef}' could not be resolved: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.trim();
}

async function runGitChecked(workspaceRoot, args, options = {}) {
  let result;
  try {
    result = await runCommand({
      bin: "git",
      args: ["-C", workspaceRoot, ...args],
    }, {
      timeoutMs: options.timeoutMs ?? 10_000,
      env: options.env,
      input: options.input,
      controller: options.controller,
      signal: options.signal,
    });
  } finally {
    if (options.cleanupProcessGroup && result?.pid) {
      signalProcessTree(result.pid, "SIGTERM");
    }
  }
  throwIfAborted(options.signal);
  if (result.exitCode !== 0) {
    throw new Error(gitFailureMessage(args, result));
  }
  return result;
}

function gitFailureMessage(args, result) {
  const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
  return `git ${args.join(" ")} failed: ${String(detail).trim()}`;
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
      const renamedPath = fields[index++] ?? "";
      if (oldPath && renamedPath) {
        files.push({ status, path: renamedPath, oldPath });
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

function unavailableContext(workspaceRoot, options = {}) {
  return {
    workspaceRoot,
    repoLabel: path.basename(workspaceRoot),
    scope: options.scope ?? "working-tree",
    baseRef: String(options.baseRef ?? ""),
    diffSummary: "Not a git work tree.",
    diff: "",
    gitAvailable: false,
  };
}

function resolveGitPath(workspaceRoot, value) {
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}

function gitOutputLine(value) {
  const output = String(value ?? "");
  if (process.platform === "win32" && output.endsWith("\r\n")) {
    return output.slice(0, -2);
  }
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

function encodeAlternateObjectDirectory(value) {
  // Git accepts a C-quoted path in this delimiter-separated environment value.
  // JSON string escaping is compatible for the path characters Node exposes.
  return JSON.stringify(String(value));
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
