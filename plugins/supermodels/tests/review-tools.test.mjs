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
