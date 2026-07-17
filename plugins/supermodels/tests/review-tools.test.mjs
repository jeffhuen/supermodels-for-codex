import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { collectGitContext, createReviewSnapshot } from "../scripts/lib/git.mjs";
import {
  COVERAGE_LEDGER_RESERVE,
  boundReadFileResult,
  createReviewTools,
  createSnapshotReviewTools,
  lastNumberedLine,
} from "../scripts/lib/review-tools.mjs";

const execFileAsync = promisify(execFile);

test("createSnapshotReviewTools fails closed without an immutable snapshot", () => {
  assert.throws(
    () => createSnapshotReviewTools({ workspaceRoot: process.cwd() }),
    /immutable review snapshot/i,
  );
});

test("lastNumberedLine returns the last visible line number, or NaN when there is none", () => {
  assert.equal(lastNumberedLine("10: a\n11: b\n12: c"), 12);
  assert.equal(lastNumberedLine("10: a\n11: partial"), 11);
  assert.equal(lastNumberedLine(""), Number.NaN);
  assert.ok(Number.isNaN(lastNumberedLine("no numbers here")));
});

test("boundReadFileResult drops whole content lines and keeps end_line consistent with what remains", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `${i + 1}: const value = ${i};`);
  const result = {
    ok: true,
    path: "src/big.js",
    start_line: 1,
    end_line: 200,
    truncated: false,
    content: lines.join("\n"),
  };
  const cap = Math.floor(Buffer.byteLength(JSON.stringify(result), "utf8") * 0.5);
  const bounded = boundReadFileResult(result, cap);

  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= cap, "serialized result is within the cap");
  assert.equal(bounded.truncated, true, "truncation is flagged");
  assert.ok(bounded.end_line < 200, "end_line was reduced from the original range");
  // end_line equals the last line ACTUALLY present — no stale range past the content.
  const contentLines = bounded.content.split("\n");
  const lastVisible = Number(contentLines[contentLines.length - 1].split(":")[0]);
  assert.equal(bounded.end_line, lastVisible, "end_line matches the last visible content line");
  // Whole lines only — the last line is complete, never a mid-line byte cut.
  assert.match(contentLines[contentLines.length - 1], /^\d+: const value = \d+;$/);
});

test("read_file drops an oversized source line instead of exposing a creditable numbered prefix", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-partial-line-"));
  try {
    await writeFile(path.join(workspace, "huge.js"), `${"x".repeat(20_000)}\n`, "utf8");
    const tools = createReviewTools({
      workspaceRoot: workspace,
      maxFileBytes: 128,
      maxToolBytes: 20_000,
    });

    const result = await tools.execute("read_file", {
      path: "huge.js",
      start_line: 1,
      end_line: 1,
    });

    assert.equal(result.truncated, true);
    assert.equal(result.content, "", "no partial `1:` line is exposed as if it were complete");
    assert.equal(result.end_line, 0, "the honest range ends before the unread oversized line");
    assert.ok(Number.isNaN(lastNumberedLine(result.content)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file reserves ledger headroom so result plus a max coverage ledger stays within the cap", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-readfile-reserve-"));
  try {
    // A file far larger than the cap: read_file must bound its serialized result to
    // maxToolBytes MINUS the ledger reserve, leaving room for the coverage_ledger
    // the agent attaches afterward.
    const big = Array.from({ length: 5000 }, (_, i) => `const line${i} = "value ${i}";`).join("\n");
    await writeFile(path.join(workspace, "big.js"), `${big}\n`, "utf8");

    const maxToolBytes = 40_000;
    const tools = createReviewTools({ workspaceRoot: workspace, maxToolBytes, maxFileBytes: 500_000 });
    const result = await tools.execute("read_file", { path: "big.js", start_line: 1, end_line: 5000 });

    const size = Buffer.byteLength(JSON.stringify(result), "utf8");
    assert.ok(size <= maxToolBytes - COVERAGE_LEDGER_RESERVE, `result ${size} left no room for the ledger reserve`);
    // The reserve must cover the FULL attachment envelope, not just the ledger body:
    // attach a ledger whose serialized `,"coverage_ledger":<body>` fills the entire
    // reserve and confirm the combined payload still fits the cap (the v0.2.8 bug was
    // budgeting only the body, so the `,"coverage_ledger":` key overflowed by ~19 B).
    const attach = (body) => Buffer.byteLength(`,"coverage_ledger":${JSON.stringify(body)}`, "utf8");
    const hunks = [];
    const ledger = { enabled: true, highRiskHunks: 99, coveredHighRiskHunks: 0, missingHighRiskHunks: hunks };
    while (attach(ledger) <= COVERAGE_LEDGER_RESERVE) {
      hunks.push({ file: "src/module.mjs", line_start: hunks.length, line_end: hunks.length + 5, reason: "high-risk path" });
    }
    hunks.pop(); // last one that still fits within the reserve
    assert.ok(attach(ledger) <= COVERAGE_LEDGER_RESERVE, "the max ledger attachment fits the reserve");
    const withLedger = Buffer.byteLength(JSON.stringify({ ...result, coverage_ledger: ledger }), "utf8");
    assert.ok(withLedger <= maxToolBytes, `result + max ledger ${withLedger} exceeded cap ${maxToolBytes}`);
    // end_line reflects the truncated content, not the requested 5000.
    assert.equal(result.end_line, lastNumberedLine(result.content), "end_line matches visible content");
    assert.ok(result.end_line < 5000, "end_line was reduced to the visible range");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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

test("read_file refuses to present a partial large newline-free line as complete", async () => {
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
    assert.equal(result.content, "");
    assert.equal(result.end_line, 0);
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

test("search keeps the SERIALIZED result within the cap even for escaping-heavy matches", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-search-cap-"));
  try {
    // Lines dominated by quotes and backslashes: each byte roughly doubles under
    // JSON escaping, so bounding the raw text (the old behavior) overshoots the cap.
    const heavy = `needle ${"\"\\".repeat(200)}`;
    const lines = Array.from({ length: 150 }, () => heavy).join("\n");
    await writeFile(path.join(workspace, "heavy.txt"), `${lines}\n`, "utf8");

    const maxToolBytes = 20_000;
    const tools = createReviewTools({ workspaceRoot: workspace, maxToolBytes });
    const result = await tools.execute("search", { query: "needle" });

    const size = Buffer.byteLength(JSON.stringify(result), "utf8");
    assert.ok(size <= maxToolBytes, `serialized search result ${size} exceeded cap ${maxToolBytes}`);
    assert.equal(result.truncated, true, "truncation is flagged");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("list_files keeps the SERIALIZED result within the cap and never emits a marker as a fake filename", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-listfiles-cap-"));
  try {
    await Promise.all(
      Array.from({ length: 800 }, (_, i) =>
        writeFile(path.join(workspace, `source-file-${String(i).padStart(4, "0")}.txt`), "x\n", "utf8"),
      ),
    );

    const maxToolBytes = 12_000;
    const tools = createReviewTools({ workspaceRoot: workspace, maxToolBytes });
    const result = await tools.execute("list_files", {});

    const size = Buffer.byteLength(JSON.stringify(result), "utf8");
    assert.ok(size <= maxToolBytes, `serialized list_files result ${size} exceeded cap ${maxToolBytes}`);
    assert.equal(result.truncated, true, "truncation is flagged");
    assert.ok(result.files.length > 0 && result.files.length < 800, "the list was bounded");
    for (const file of result.files) {
      assert.ok(!file.includes("truncated"), `a truncation marker leaked in as a filename: ${file}`);
    }
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

test("snapshot review tools preserve trailing whitespace in changed paths", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-context-trailing-path-"));
  let snapshot;
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    const trailingPath = "tail ";
    await writeFile(path.join(workspace, trailingPath), "old\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "initial"]);
    await writeFile(path.join(workspace, trailingPath), "new\n", "utf8");
    snapshot = await createReviewSnapshot({ workspaceRoot: workspace });
    const tools = createSnapshotReviewTools({ workspaceRoot: workspace, snapshot });

    const changed = await tools.execute("list_changed_files");
    const read = await tools.execute("read_file", { path: trailingPath, start_line: 1, end_line: 1 });

    assert(changed.changedFiles.some((file) => file.path === trailingPath));
    assert.equal(read.ok, true);
    assert.equal(read.path, trailingPath);
    assert.equal(read.content, "1: new");
  } finally {
    await snapshot?.dispose();
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

test("list_changed_files retains every entry when the complete result exactly fits the cap", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-list-exact-"));
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    const count = 10;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        writeFile(path.join(workspace, `changed-file-${String(i).padStart(2, "0")}.txt`), "x\n", "utf8"),
      ),
    );

    // Measure the full result under a generous cap, then set the cap to exactly
    // that size: a conservative estimator would drop the last entry; the binary
    // search keeps all of them.
    const generous = await createReviewTools({ workspaceRoot: workspace, maxToolBytes: 1_000_000 }).execute("list_changed_files");
    const exact = Buffer.byteLength(JSON.stringify(generous), "utf8");
    const changed = await createReviewTools({ workspaceRoot: workspace, maxToolBytes: exact }).execute("list_changed_files");

    assert.equal(changed.changedFiles.length, count, "all entries are retained at an exact fit");
    assert.equal(changed.truncated, false, "nothing is dropped at an exact fit");
    assert.ok(Buffer.byteLength(JSON.stringify(changed), "utf8") <= exact, "payload stays within the exact cap");
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

test("get_review_context and get_diff page one immutable diff losslessly with single-use interoperable cursors", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-tools-pages-"));
  let snapshot;
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspace, "large.mjs"), "export const before = true;\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "initial"]);
    const changed = Array.from(
      { length: 2500 },
      (_, index) => `export const value${index} = ${JSON.stringify(`line-${index}-\\\"`)};`,
    ).join("\n");
    await writeFile(path.join(workspace, "large.mjs"), `${changed}\n`, "utf8");

    snapshot = await createReviewSnapshot({ workspaceRoot: workspace });
    const tools = createReviewTools({ snapshot, maxToolBytes: 9_500, maxFileBytes: 2_000 });
    const first = await tools.execute("get_review_context");
    assert.equal(first.ok, true);
    assert.equal(first.complete, false);
    assert.equal(typeof first.next_cursor, "string");

    let rebuilt = first.diff;
    const firstCursor = first.next_cursor;
    let cursor = firstCursor;
    let last;
    while (cursor) {
      last = await tools.execute("get_diff", { cursor });
      assert.ok(Buffer.byteLength(JSON.stringify(last), "utf8") <= 9_500 - COVERAGE_LEDGER_RESERVE);
      rebuilt += last.diff;
      cursor = last.next_cursor;
    }

    assert.equal(last.complete, true);
    assert.equal(rebuilt, snapshot.context.diff);
    await assert.rejects(() => tools.execute("get_diff", { cursor: firstCursor }), /invalid|expired|used/i);

    await writeFile(path.join(workspace, "large.mjs"), "live mutation after snapshot\n", "utf8");
    await writeFile(path.join(workspace, "late.mjs"), "late file\n", "utf8");
    const read = await tools.execute("read_file", { path: "large.mjs", start_line: 1, end_line: 1 });
    const searchResult = await tools.execute("search", { query: "value2499" });
    const listed = await tools.execute("list_files", { query: "late.mjs" });
    assert.match(read.content, /value0/);
    assert.match(searchResult.output, /value2499/);
    assert.deepEqual(listed.files, []);
  } finally {
    await snapshot?.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("list_changed_files pages every NUL-safe changed path and rejects wrong-kind cursors", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "supermodels-review-tools-file-pages-"));
  let snapshot;
  try {
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.email", "test@example.com"]);
    await runGit(workspace, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "initial"]);
    await mkdir(path.join(workspace, "nested"));
    for (let index = 0; index < 180; index += 1) {
      await writeFile(path.join(workspace, "nested", `file-${String(index).padStart(3, "0")}-${"x".repeat(30)}.txt`), `${index}\n`);
    }
    await writeFile(path.join(workspace, "nested", "line\nname.txt"), "odd\n");

    snapshot = await createReviewSnapshot({ workspaceRoot: workspace });
    const maxToolBytes = 8_900;
    const tools = createReviewTools({ snapshot, maxToolBytes });
    const paths = [];
    let cursor;
    let firstDiffCursor;
    do {
      const page = await tools.execute("list_changed_files", cursor ? { cursor } : {});
      assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= maxToolBytes);
      paths.push(...page.changedFiles.map((file) => file.path));
      cursor = page.next_cursor;
      if (!firstDiffCursor) {
        const diffPage = await tools.execute("get_diff");
        firstDiffCursor = diffPage.next_cursor;
      }
    } while (cursor);

    assert.deepEqual(paths, snapshot.changedFiles.map((file) => file.path));
    assert(paths.includes("nested/line\nname.txt"));
    await assert.rejects(
      () => tools.execute("list_changed_files", { cursor: firstDiffCursor }),
      /invalid|wrong|cursor/i,
    );
    const intendedPage = await tools.execute("get_diff", { cursor: firstDiffCursor });
    assert.equal(intendedPage.ok, true, "a wrong-kind attempt must not consume the valid diff cursor");
  } finally {
    await snapshot?.dispose();
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
