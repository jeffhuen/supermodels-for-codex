import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createReviewTools } from "../scripts/lib/review-tools.mjs";

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
