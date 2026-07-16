import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { collectGitContext } from "../scripts/lib/git.mjs";
import { createReviewTools, truncateObject } from "../scripts/lib/review-tools.mjs";

const execFileAsync = promisify(execFile);

test("truncateObject flags diffTruncated only when the diff itself is shortened, not when snippets overflow", () => {
  const smallDiff = "diff --git a/x b/x\n@@ -1 +1 @@\n+one changed line\n";
  // Context exceeds the cap because of a huge file snippet, but the diff is tiny.
  const overByCoverage = truncateObject(
    { diff: smallDiff, fileSnippets: [{ path: "x", content: "S".repeat(8000) }] },
    1200,
  );
  assert.equal(overByCoverage.truncated, true, "context is truncated (snippets overflow the cap)");
  assert.equal(overByCoverage.diffTruncated, false, "but the diff itself was not shortened");
  assert.equal(overByCoverage.diff, smallDiff, "diff is byte-identical to the input");

  // A genuinely oversized diff IS flagged as diffTruncated.
  const bigDiff = "D".repeat(8000);
  const overByDiff = truncateObject({ diff: bigDiff, fileSnippets: [] }, 1200);
  assert.equal(overByDiff.diffTruncated, true, "an oversized diff is flagged as diffTruncated");
  assert.ok(overByDiff.diff.length < bigDiff.length, "the diff was actually shortened");
});

test("truncateObject preserves the full diff when dropping snippets alone brings the payload under the cap", () => {
  const cap = 4000;
  const diff = `diff --git a/x b/x\n@@ -1,120 +1,120 @@\n${"+a changed line of code\n".repeat(120)}`;
  // The diff is over 55% of the cap (where the old order truncated it) but under
  // the full cap, so after dropping the oversized snippet it fits whole.
  assert.ok(Buffer.byteLength(diff, "utf8") > cap * 0.55, "diff exceeds the old 55% pre-trim bound");
  assert.ok(Buffer.byteLength(diff, "utf8") < cap, "but the full diff fits under the cap");
  const result = truncateObject({ diff, fileSnippets: [{ path: "big", content: "S".repeat(9000) }] }, cap);
  assert.equal(result.truncated, true, "context is truncated (the snippet overflowed)");
  assert.equal(result.diffTruncated, false, "the full diff fits after dropping snippets, so it is not truncated");
  assert.equal(result.diff, diff, "the full diff is preserved");
});

test("truncateObject bounds the changedFiles array and keeps the payload under the cap while preserving a fitting diff", () => {
  const cap = 8000;
  const diff = `diff --git a/x b/x\n@@ -1,120 +1,120 @@\n${"+a changed line of code\n".repeat(120)}`;
  const changedFiles = Array.from({ length: 2000 }, (_, i) => ({ status: "??", path: `untracked/file-${i}.txt` }));
  const result = truncateObject({ ok: true, diff, changedFiles, fileSnippets: [] }, cap);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= cap, "serialized payload stays within the cap");
  assert.ok(result.changedFiles.length < 2000, "excess changedFiles entries are dropped");
  assert.ok(result.changedFilesOmitted > 0, "the omitted count is recorded");
  assert.equal(result.diffTruncated, false, "the fitting diff is not truncated");
  assert.equal(result.diff, diff, "the full diff is preserved (coverage stays enabled)");
  // No over-drop: the kept set fills the budget — appending several more entries
  // would exceed the cap, proving it did not stop at a small fraction.
  const padded = {
    ...result,
    changedFiles: [
      ...result.changedFiles,
      ...Array.from({ length: 5 }, (_, i) => ({ status: "??", path: `untracked/extra-${i}.txt` })),
    ],
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(padded), "utf8") > cap,
    "appending more entries exceeds the cap — the budget was filled (no over-drop)",
  );
});

test("truncateObject retains changed files after trimming an oversized diff instead of dropping them all", () => {
  const cap = 6000;
  // The diff ALONE exceeds the cap, so it must be trimmed. The old drop-then-trim
  // order cleared the entire changed-files list first (packing it against the full
  // diff) and never restored the entries into the space the diff-trim then freed.
  const diff = "D".repeat(9000);
  const changedFiles = Array.from({ length: 40 }, (_, i) => ({ status: "M", path: `src/mod-${i}.ts` }));
  const result = truncateObject({ ok: true, diff, changedFiles, fileSnippets: [] }, cap);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= cap, "serialized payload stays within the hard cap");
  assert.equal(result.diffTruncated, true, "the oversized diff was trimmed");
  assert.ok(result.changedFiles.length > 0, "some changed files survive the diff trim (not all dropped)");
  assert.equal(
    result.changedFiles.length + (result.changedFilesOmitted ?? 0),
    40,
    "kept + omitted accounts for every changed file",
  );
});

test("truncateObject enforces the hard cap when only the diff must be trimmed, and detects it by content", () => {
  const cap = 400;
  const diff = "x".repeat(2000); // far larger than the cap, no snippets/changedFiles to reclaim
  const result = truncateObject({ diff }, cap);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= cap, "serialized payload stays within the hard cap");
  assert.equal(result.diffTruncated, true, "the trimmed diff is flagged (content comparison)");
  assert.notEqual(result.diff, diff, "the diff content was changed");
});

test("truncateObject never loops forever and stays hard-capped even for a pathological tiny cap", () => {
  // Cap below the truncation-marker size: the diff cannot shrink to fit, so it is
  // dropped to empty rather than looping forever; the loop terminates.
  const result = truncateObject({ diff: "x".repeat(50) }, 8);
  assert.equal(result.diffTruncated, true, "the diff was truncated/dropped");
  assert.equal(result.diff, "", "an unfittable diff is dropped to empty");
});

test("read_file returns numbered bounded slices inside workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-tools-"));
  try {
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "sample.js"), "one\ntwo\nthree\n", "utf8");
    const tools = createReviewTools({ workspaceRoot: workspace });

    const result = await tools.execute("read_file", {
      path: "src/sample.js",
      start_line: 2,
      end_line: 3,
    });

    assert.equal(result.ok, true);
    assert.equal(result.path, "src/sample.js");
    assert.equal(result.content, "2: two\n3: three");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file rejects path traversal and symlink escapes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-tools-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-outside-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));
    const tools = createReviewTools({ workspaceRoot: workspace });

    const traversal = await tools.execute("read_file", { path: "../secret.txt" });
    const symlinkResult = await tools.execute("read_file", { path: "link.txt" });

    assert.equal(traversal.ok, false);
    assert.match(traversal.error, /outside workspace/i);
    assert.equal(symlinkResult.ok, false);
    assert.match(symlinkResult.error, /not a regular file|outside workspace/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("read_file can read later line ranges from large files without prefix-only truncation", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-tools-large-"));
  try {
    await mkdir(path.join(workspace, "src"));
    const lines = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n");
    await writeFile(path.join(workspace, "src", "large.txt"), `${lines}\n`, "utf8");
    const tools = createReviewTools({ workspaceRoot: workspace, maxFileBytes: 200 });

    const result = await tools.execute("read_file", {
      path: "src/large.txt",
      start_line: 4500,
      end_line: 4502,
    });

    assert.equal(result.ok, true);
    assert.match(result.content, /4500: line 4500/);
    assert.match(result.content, /4502: line 4502/);
    assert.doesNotMatch(result.content, /line 1/);
    assert.equal(result.truncated, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file returns a bounded prefix for a large newline-free line", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-tools-long-line-"));
  try {
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "minified.js"), "x".repeat(200_000), "utf8");
    const tools = createReviewTools({ workspaceRoot: workspace, maxFileBytes: 80 });

    const result = await tools.execute("read_file", {
      path: "src/minified.js",
      start_line: 1,
      end_line: 1,
    });

    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.match(result.content, /^1: x+/);
    assert(result.content.length > 10);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search returns bounded line matches", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-tools-"));
  try {
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "a.js"), "alpha\nneedle here\n", "utf8");
    await writeFile(path.join(workspace, "src", "b.js"), "needle there\nomega\n", "utf8");
    const tools = createReviewTools({ workspaceRoot: workspace });

    const result = await tools.execute("search", { query: "needle" });

    assert.equal(result.ok, true);
    assert.match(result.output, /src\/a\.js:2:needle here/);
    assert.match(result.output, /src\/b\.js:1:needle there/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("get_review_context returns diff, changed files, and bounded file snippets", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-context-"));
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "app.mjs"), "export const value = 1;\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "initial"]);
    await writeFile(path.join(workspace, "src", "app.mjs"), "export const value = 2;\n", "utf8");
    await writeFile(path.join(workspace, "src", "new.mjs"), "export const created = true;\n", "utf8");
    const tools = createReviewTools({ workspaceRoot: workspace });

    const result = await tools.execute("get_review_context");

    assert.equal(result.ok, true);
    assert.match(result.diff, /export const value = 2/);
    assert(result.changedFiles.some((file) => file.path === "src/app.mjs"));
    assert(result.changedFiles.some((file) => file.path === "src/new.mjs"));
    assert(result.fileSnippets.some((snippet) => {
      return snippet.path === "src/app.mjs" && snippet.content.includes("1: export const value = 2;");
    }));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("get_review_context decodes Git-quoted UTF-8 changed file paths", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-context-quoted-path-"));
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspace, "café.txt"), "old\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "initial"]);
    await writeFile(path.join(workspace, "café.txt"), "new\n", "utf8");

    const tools = createReviewTools({ workspaceRoot: workspace });
    const context = await tools.execute("get_review_context");
    const changed = await tools.execute("list_changed_files");

    assert(context.changedFiles.some((file) => file.path === "café.txt"));
    assert(changed.changedFiles.some((file) => file.path === "café.txt"));
    assert(context.fileSnippets.some((snippet) => {
      return snippet.path === "café.txt" && snippet.content.includes("1: new");
    }));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("get_review_context uses base refs for committed changes on clean working trees", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-context-base-"));
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "app.mjs"), "export const value = 1;\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "initial"]);
    await writeFile(path.join(workspace, "src", "app.mjs"), "export const value = 2;\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "change"]);

    const tools = createReviewTools({ workspaceRoot: workspace, baseRef: "HEAD^" });
    const context = await tools.execute("get_review_context");
    const changed = await tools.execute("list_changed_files");

    assert.equal(context.ok, true);
    assert.match(context.diff, /export const value = 2/);
    assert(context.changedFiles.some((file) => file.path === "src/app.mjs"));
    assert(context.fileSnippets.some((snippet) => {
      return snippet.path === "src/app.mjs" && snippet.content.includes("1: export const value = 2;");
    }));
    assert.match(changed.output, /M\s+src\/app\.mjs/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("list_changed_files stays under maxToolBytes with thousands of untracked files and keeps output consistent with the kept array", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-list-cap-"));
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    // Untracked files must live at the repo root: `git status --short` collapses
    // a wholly-untracked subdirectory into a single line, which would not exercise
    // the many-file bounding path.
    const count = 600;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        writeFile(
          path.join(workspace, `generated-source-file-${String(i).padStart(4, "0")}.txt`),
          "x\n",
          "utf8",
        ),
      ),
    );

    const maxToolBytes = 8000;
    const tools = createReviewTools({ workspaceRoot: workspace, maxToolBytes });
    const changed = await tools.execute("list_changed_files");

    // Hard cap: the serialized payload never exceeds the byte budget, even though
    // the full file list is many times larger than the cap.
    const size = Buffer.byteLength(JSON.stringify(changed), "utf8");
    assert(size <= maxToolBytes, `payload ${size} exceeded cap ${maxToolBytes}`);

    // Truncation is signalled and the omitted count accounts for every dropped file.
    assert.equal(changed.truncated, true);
    assert(changed.changedFilesOmitted > 0);
    assert(changed.changedFiles.length > 0);
    assert.equal(changed.changedFiles.length + changed.changedFilesOmitted, count);

    // output/structured consistency is exact: the two views are packed together,
    // so `output` is precisely the retained array rendered line-for-line — no
    // partial lines, no marker, no entry in one view but not the other.
    const expectedOutput = changed.changedFiles
      .map((file) => `${file.status.padEnd(2)} ${file.path}`)
      .join("\n");
    assert.equal(changed.output, expectedOutput);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("list_changed_files does not over-drop: a file list that fits under the cap is kept whole", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-list-nodrop-"));
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    const count = 40;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        writeFile(
          path.join(workspace, `generated-source-file-${String(i).padStart(4, "0")}.txt`),
          "x\n",
          "utf8",
        ),
      ),
    );

    // The structured array alone exceeds 45% of this cap (where the old fixed
    // split would have dropped entries), but the combined payload fits whole.
    const maxToolBytes = 4000;
    const tools = createReviewTools({ workspaceRoot: workspace, maxToolBytes });
    const changed = await tools.execute("list_changed_files");

    const arrayBytes = Buffer.byteLength(JSON.stringify(changed.changedFiles), "utf8");
    assert.ok(arrayBytes > maxToolBytes * 0.45, "the array alone exceeds the old 45% array budget");
    const size = Buffer.byteLength(JSON.stringify(changed), "utf8");
    assert.ok(size <= maxToolBytes, `payload ${size} exceeded cap ${maxToolBytes}`);
    assert.equal(changed.changedFiles.length, count, "every file that fits under the cap is retained");
    assert.equal(changed.truncated, false, "nothing was truncated");
    assert.equal(changed.changedFilesOmitted, undefined, "no omission is reported");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("get_review_context with base refs includes staged and unstaged tracked changes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-context-base-working-"));
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "staged.mjs"), "export const staged = 1;\n", "utf8");
    await writeFile(path.join(workspace, "src", "unstaged.mjs"), "export const unstaged = 1;\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "initial"]);
    await writeFile(path.join(workspace, "src", "staged.mjs"), "export const staged = 2;\n", "utf8");
    await runGit(workspace, ["add", "src/staged.mjs"]);
    await writeFile(path.join(workspace, "src", "unstaged.mjs"), "export const unstaged = 2;\n", "utf8");

    const tools = createReviewTools({ workspaceRoot: workspace, baseRef: "HEAD" });
    const context = await tools.execute("get_review_context");
    const changed = await tools.execute("list_changed_files");

    assert.match(context.diff, /export const staged = 2/);
    assert.match(context.diff, /export const unstaged = 2/);
    assert(changed.changedFiles.some((file) => file.path === "src/staged.mjs"));
    assert(changed.changedFiles.some((file) => file.path === "src/unstaged.mjs"));
    assert(context.fileSnippets.some((snippet) => {
      return snippet.path === "src/staged.mjs" && snippet.content.includes("1: export const staged = 2;");
    }));
    assert(context.fileSnippets.some((snippet) => {
      return snippet.path === "src/unstaged.mjs" && snippet.content.includes("1: export const unstaged = 2;");
    }));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("get_review_context lists deleted files without noisy snippet errors", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-context-delete-"));
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "deleted.mjs"), "export const deleted = true;\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "initial"]);
    await rm(path.join(workspace, "src", "deleted.mjs"));

    const tools = createReviewTools({ workspaceRoot: workspace, baseRef: "HEAD" });
    const context = await tools.execute("get_review_context");

    assert(context.changedFiles.some((file) => file.status === "D" && file.path === "src/deleted.mjs"));
    assert(!context.fileSnippets.some((snippet) => snippet.path === "src/deleted.mjs"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("get_review_context does not let deleted files consume readable snippet budget", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-context-delete-budget-"));
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    await mkdir(path.join(workspace, "src"));
    for (let index = 0; index < 6; index += 1) {
      await writeFile(path.join(workspace, "src", `a-deleted-${index}.mjs`), `export const deleted${index} = true;\n`, "utf8");
    }
    await writeFile(path.join(workspace, "src", "z-modified.mjs"), "export const modified = 1;\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "initial"]);
    for (let index = 0; index < 6; index += 1) {
      await rm(path.join(workspace, "src", `a-deleted-${index}.mjs`));
    }
    await writeFile(path.join(workspace, "src", "z-modified.mjs"), "export const modified = 2;\n", "utf8");

    const tools = createReviewTools({ workspaceRoot: workspace, baseRef: "HEAD" });
    const context = await tools.execute("get_review_context");

    assert(context.changedFiles.filter((file) => file.status === "D").length >= 6);
    assert(context.fileSnippets.some((snippet) => {
      return snippet.path === "src/z-modified.mjs" && snippet.content.includes("1: export const modified = 2;");
    }));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("git context and review tools reject invalid base refs consistently", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-context-bad-base-"));
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspace, "app.mjs"), "export const value = 1;\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "initial"]);

    const tools = createReviewTools({ workspaceRoot: workspace, baseRef: "missing-ref" });
    await assert.rejects(
      () => collectGitContext({ workspaceRoot: workspace, baseRef: "missing-ref" }),
      /base ref 'missing-ref' could not be resolved/i,
    );
    await assert.rejects(
      () => tools.execute("list_changed_files"),
      /base ref 'missing-ref' could not be resolved/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("get_review_context surfaces git status failures instead of returning incomplete context", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-context-not-git-"));
  try {
    const tools = createReviewTools({ workspaceRoot: workspace });

    await assert.rejects(
      () => tools.execute("get_review_context"),
      /git status failed/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool commands observe cancellation before shelling out", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-tools-cancel-"));
  try {
    const controller = { cancelled: true };
    const tools = createReviewTools({ workspaceRoot: workspace, controller });

    await assert.rejects(
      () => tools.execute("search", { query: "anything" }),
      /cancelled/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function runGit(cwd, args) {
  await execFileAsync("git", args, { cwd });
}
