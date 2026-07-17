import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { collectGitContext } from "../scripts/lib/git.mjs";
import {
  COVERAGE_LEDGER_RESERVE,
  boundReadFileResult,
  createReviewTools,
  lastNumberedLine,
  truncateObject,
} from "../scripts/lib/review-tools.mjs";

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

test("truncateObject gives the coverage-critical diff strict priority over the changed-files list", () => {
  const cap = 6000;
  // The diff ALONE exceeds the cap, so it must be trimmed. It has strict priority:
  // it fills the budget and the lower-priority file list yields entirely (no fixed
  // reserve carving bytes out of the diff), with the omitted count still reported.
  const diff = "D".repeat(9000);
  const changedFiles = Array.from({ length: 40 }, (_, i) => ({ status: "M", path: `src/mod-${i}.ts` }));
  const result = truncateObject({ ok: true, diff, changedFiles, fileSnippets: [] }, cap);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= cap, "serialized payload stays within the hard cap");
  assert.equal(result.diffTruncated, true, "the oversized diff was trimmed");
  assert.ok(Buffer.byteLength(result.diff, "utf8") > cap * 0.8, "the diff fills the budget (strict priority)");
  assert.equal(result.changedFiles.length, 0, "the lower-priority file list yields to the diff");
  assert.equal(result.changedFilesOmitted, 40, "every omitted file is still counted");
});

test("truncateObject sheds a few files, not the diff, when a payload is only a little over", () => {
  // A small overflow should drop a handful of changed-file entries and leave the
  // coverage-critical diff untouched — the old 15% reserve trimmed ~18 KB of diff
  // to keep files even when dropping a few entries would have sufficed.
  const cap = 20_000;
  const diff = "D".repeat(10_000);
  const changedFiles = Array.from({ length: 260 }, (_, i) => ({ status: "M", path: `src/module-${i}.ts` }));
  const full = { ok: true, diff, changedFiles, fileSnippets: [] };
  const overBy = Buffer.byteLength(JSON.stringify(full), "utf8") - cap;
  assert.ok(overBy > 0, "the payload is over the cap");
  const result = truncateObject(full, cap);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= cap, "serialized payload is within the cap");
  assert.equal(result.diff, diff, "the diff is untouched (only the file list was reduced)");
  assert.equal(result.diffTruncated, false, "the diff was not trimmed");
  assert.ok(result.changedFilesOmitted > 0, "some files were dropped to fit");
  assert.ok(result.changedFiles.length >= 260 * 0.9, `kept only ${result.changedFiles.length}/260 — dropped far more than the overflow required`);
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

test("truncateObject trims an oversized diff by only the bytes required, not a coarse fraction", () => {
  // A diff whose payload lands just over the cap should lose ~the overflow, not
  // ~20%+ (the old 0.8 step compounded by truncateText's geometric shrink turned
  // a 1-byte overflow into a ~30% cut).
  const cap = 120_000;
  const base = Buffer.byteLength(JSON.stringify({ ok: true, diff: "", truncated: true, diffTruncated: false }), "utf8");
  const diffBytes = cap - base + 200; // 200 bytes over the cap
  const diff = "d".repeat(diffBytes);
  const result = truncateObject({ ok: true, diff }, cap);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= cap, "serialized payload is within the cap");
  assert.equal(result.diffTruncated, true, "the diff was trimmed");
  // Minimal reclaim: at most a small multiple of the 200-byte overflow is lost.
  const kept = Buffer.byteLength(result.diff, "utf8");
  assert.ok(kept >= diffBytes - 1000, `diff kept ${kept} of ${diffBytes} — reclaimed far more than required`);
});

test("truncateObject trims snippets by only the bytes required, not a fixed 35%/n fraction", () => {
  // A payload a few hundred bytes over the cap should shave a few hundred bytes
  // off the snippets — not crush every snippet to 35%/n of the whole cap.
  const cap = 120_000;
  const snippetContent = "s".repeat(20_000);
  const fileSnippets = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.js`, content: snippetContent, truncated: false }));
  const totalSnippetBytes = 5 * 20_000;
  // diff sized so the whole payload is ~500 bytes over the cap.
  const base = Buffer.byteLength(JSON.stringify({ ok: true, diff: "", fileSnippets, truncated: true, diffTruncated: false }), "utf8");
  const diff = "d".repeat(cap - base + 500);
  const result = truncateObject({ ok: true, diff, fileSnippets }, cap);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= cap, "serialized payload is within the cap");
  assert.equal(result.diff, diff, "the fitting diff is preserved (only snippets were reclaimed)");
  const keptSnippetBytes = result.fileSnippets.reduce((sum, s) => sum + Buffer.byteLength(s.content, "utf8"), 0);
  // The old 35%/n rule would cap each of 5 snippets at 0.35*cap/5 = 8400 bytes
  // (42000 total). Minimal reclaim keeps far more.
  assert.ok(keptSnippetBytes > totalSnippetBytes - 5000, `kept ${keptSnippetBytes} of ${totalSnippetBytes} snippet bytes — over-dropped`);
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
