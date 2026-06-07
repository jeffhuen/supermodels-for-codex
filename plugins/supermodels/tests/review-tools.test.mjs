import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createReviewTools } from "../scripts/lib/review-tools.mjs";

const execFileAsync = promisify(execFile);

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
