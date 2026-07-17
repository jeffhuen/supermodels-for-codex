import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectGitContext, createReviewSnapshot } from "../scripts/lib/git.mjs";

test("createReviewSnapshot rejects an already-cancelled capture before doing work", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-aborted-snapshot-"));
  const controller = new AbortController();
  controller.abort(new Error("snapshot cancelled by test"));
  try {
    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot, signal: controller.signal }),
      /snapshot cancelled by test/i,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot rejects a base ref outside a Git worktree", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-nongit-base-"));
  try {
    await writeFile(path.join(workspaceRoot, "source.txt"), "live source\n");
    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot, baseRef: "main" }),
      /base ref.*Git worktree/i,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot freezes tracked and nested untracked files without touching the real worktree", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-snapshot-"));
  let snapshot;
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, "tracked.txt"), "base\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);

    await writeFile(path.join(workspaceRoot, "tracked.txt"), "captured\n");
    await mkdir(path.join(workspaceRoot, "nested"));
    const unusual = "line\nname-\u00e9.txt";
    await writeFile(path.join(workspaceRoot, "nested", unusual), "untracked captured\n");
    const statusBefore = git(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

    snapshot = await createReviewSnapshot({ workspaceRoot });

    assert.match(snapshot.id, /^[0-9a-f]{40,64}$/);
    assert.match(snapshot.baseOid, /^[0-9a-f]{40,64}$/);
    assert.equal(snapshot.context.snapshotId, snapshot.id);
    assert.equal(snapshot.context.baseOid, snapshot.baseOid);
    assert.equal(git(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), statusBefore);
    assert.deepEqual(
      snapshot.changedFiles.map((file) => file.path).sort(),
      ["nested/line\nname-\u00e9.txt", "tracked.txt"],
    );

    await writeFile(path.join(workspaceRoot, "tracked.txt"), "live mutation\n");
    await writeFile(path.join(workspaceRoot, "nested", unusual), "live mutation\n");
    await writeFile(path.join(workspaceRoot, "late.txt"), "created after snapshot\n");

    assert.equal(await readFile(path.join(snapshot.root, "tracked.txt"), "utf8"), "captured\n");
    assert.equal(await readFile(path.join(snapshot.root, "nested", unusual), "utf8"), "untracked captured\n");
    await assert.rejects(() => access(path.join(snapshot.root, "late.txt")));

    const root = snapshot.tempRoot;
    await snapshot.dispose();
    snapshot = null;
    await assert.rejects(() => access(root));
  } finally {
    await snapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot fails closed when a Git clean filter fails", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-snapshot-fail-"));
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, "tracked.txt"), "base\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);
    git(workspaceRoot, ["config", "filter.always-fail.clean", "false"]);
    git(workspaceRoot, ["config", "filter.always-fail.required", "true"]);
    await writeFile(path.join(workspaceRoot, ".gitattributes"), "*.bad filter=always-fail\n");
    await writeFile(path.join(workspaceRoot, "broken.bad"), "cannot snapshot\n");

    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot }),
      /git add.*failed|snapshot.*failed/i,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot preserves sparse index semantics but materializes the full tree", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-sparse-snapshot-"));
  let snapshot;
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await mkdir(path.join(workspaceRoot, "visible"));
    await mkdir(path.join(workspaceRoot, "hidden"));
    await writeFile(path.join(workspaceRoot, "visible", "a.txt"), "visible base\n");
    await writeFile(path.join(workspaceRoot, "hidden", "b.txt"), "hidden base\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);
    git(workspaceRoot, ["sparse-checkout", "init", "--cone"]);
    git(workspaceRoot, ["sparse-checkout", "set", "visible"]);
    await writeFile(path.join(workspaceRoot, "visible", "a.txt"), "visible captured\n");

    snapshot = await createReviewSnapshot({ workspaceRoot });

    assert.deepEqual(snapshot.changedFiles, [{ status: "M", path: "visible/a.txt" }]);
    assert.equal(await readFile(path.join(snapshot.root, "visible", "a.txt"), "utf8"), "visible captured\n");
    assert.equal(await readFile(path.join(snapshot.root, "hidden", "b.txt"), "utf8"), "hidden base\n");
    await assert.rejects(() => access(path.join(workspaceRoot, "hidden", "b.txt")));
    await snapshot.dispose();
    snapshot = null;

    git(workspaceRoot, ["update-index", "--skip-worktree", "visible/a.txt"]);
    await rm(path.join(workspaceRoot, "visible", "a.txt"));
    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot }),
      /absent skip-worktree path 'visible\/a\.txt'.*restore the path or clear the index flag/i,
    );
  } finally {
    await snapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot fails closed when a tracked file is replaced by an unsupported live type", {
  skip: process.platform === "win32",
}, async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-fifo-"));
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, "tracked.txt"), "base\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "base"]);
    await rm(path.join(workspaceRoot, "tracked.txt"));
    const fifo = spawnSync("mkfifo", [path.join(workspaceRoot, "tracked.txt")], { encoding: "utf8" });
    assert.equal(fifo.status, 0, fifo.stderr);

    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot }),
      /tracked path 'tracked\.txt'.*unsupported live file type/i,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot invoked from a subdirectory captures repo-root sibling changes", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-subdir-snapshot-"));
  let snapshot;
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await mkdir(path.join(workspaceRoot, "packages", "app"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "packages", "app", "app.txt"), "app\n");
    await writeFile(path.join(workspaceRoot, "sibling.txt"), "base\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);
    await writeFile(path.join(workspaceRoot, "sibling.txt"), "captured sibling\n");

    snapshot = await createReviewSnapshot({ workspaceRoot: path.join(workspaceRoot, "packages", "app") });

    const canonicalRoot = await realpath(workspaceRoot);
    assert.equal(snapshot.workspaceRoot, canonicalRoot);
    assert.equal(snapshot.context.workspaceRoot, canonicalRoot);
    assert.deepEqual(snapshot.changedFiles, [{ status: "M", path: "sibling.txt" }]);
    assert.equal(await readFile(path.join(snapshot.root, "sibling.txt"), "utf8"), "captured sibling\n");
  } finally {
    await snapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot fails closed on filter-created paths without touching the live tree", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-filter-snapshot-"));
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, ".gitignore"), "filter-marker\n");
    await writeFile(path.join(workspaceRoot, ".gitattributes"), "*.mark filter=marker\n");
    await writeFile(path.join(workspaceRoot, "filter-clean.sh"), "#!/bin/sh\ntouch filter-marker\ncat\n");
    await chmod(path.join(workspaceRoot, "filter-clean.sh"), 0o755);
    git(workspaceRoot, ["config", "filter.marker.clean", "./filter-clean.sh"]);
    git(workspaceRoot, ["config", "filter.marker.smudge", "cat"]);
    git(workspaceRoot, ["config", "filter.marker.required", "true"]);
    await writeFile(path.join(workspaceRoot, "sample.mark"), "base\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);
    await rm(path.join(workspaceRoot, "filter-marker"), { force: true });
    await writeFile(path.join(workspaceRoot, "sample.mark"), "captured\n");
    const statusBefore = git(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot }),
      /content filter.*unexpected path 'filter-marker'|filter.*snapshot aborted/i,
    );

    await assert.rejects(() => access(path.join(workspaceRoot, "filter-marker")));
    assert.equal(
      git(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      statusBefore,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot fails closed when a Git filter mutates an existing captured file", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-filter-mutation-"));
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, ".gitattributes"), "*.mark filter=mutator\n");
    await writeFile(path.join(workspaceRoot, "filter-clean.sh"), "#!/bin/sh\nprintf 'evil\\n' > victim.txt\ncat\n");
    await chmod(path.join(workspaceRoot, "filter-clean.sh"), 0o755);
    await writeFile(path.join(workspaceRoot, "sample.mark"), "base\n");
    await writeFile(path.join(workspaceRoot, "victim.txt"), "safe\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);
    git(workspaceRoot, ["config", "filter.mutator.clean", "./filter-clean.sh"]);
    git(workspaceRoot, ["config", "filter.mutator.smudge", "cat"]);
    git(workspaceRoot, ["config", "filter.mutator.required", "true"]);
    await writeFile(path.join(workspaceRoot, "sample.mark"), "captured\n");
    const statusBefore = git(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot }),
      /content filter.*modified captured path 'victim\.txt'|filter.*snapshot aborted/i,
    );

    assert.equal(await readFile(path.join(workspaceRoot, "victim.txt"), "utf8"), "safe\n");
    assert.equal(
      git(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      statusBefore,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot revalidates every live source after capture", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-source-revalidation-"));
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, ".gitattributes"), "*.mark filter=live-mutator\n");
    await writeFile(path.join(workspaceRoot, "sample.mark"), "base\n");
    await writeFile(path.join(workspaceRoot, "victim.txt"), "captured\n");
    await writeFile(path.join(workspaceRoot, "filter-clean.sh"), [
      "#!/bin/sh",
      `printf 'changed during capture\\n' > ${shellQuote(path.join(workspaceRoot, "victim.txt"))}`,
      "cat",
      "",
    ].join("\n"));
    await chmod(path.join(workspaceRoot, "filter-clean.sh"), 0o755);
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "base"]);
    git(workspaceRoot, ["config", "filter.live-mutator.clean", "./filter-clean.sh"]);
    git(workspaceRoot, ["config", "filter.live-mutator.smudge", "cat"]);
    git(workspaceRoot, ["config", "filter.live-mutator.required", "true"]);
    await writeFile(path.join(workspaceRoot, "sample.mark"), "captured change\n");

    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot }),
      /path 'victim\.txt' changed while the review snapshot was captured/i,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot fails when the default HEAD changes during capture", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-head-revalidation-"));
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, ".gitattributes"), "*.mark filter=switch-head\n");
    await writeFile(path.join(workspaceRoot, "sample.mark"), "base\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "base"]);
    const baseOid = git(workspaceRoot, ["rev-parse", "HEAD"]).trim();
    git(workspaceRoot, ["commit", "--allow-empty", "-m", "next"]);
    const nextOid = git(workspaceRoot, ["rev-parse", "HEAD"]).trim();
    git(workspaceRoot, ["checkout", "--detach", baseOid]);
    await writeFile(path.join(workspaceRoot, "switch-head.sh"), [
      "#!/bin/sh",
      `git -C ${shellQuote(workspaceRoot)} update-ref HEAD ${nextOid}`,
      "cat",
      "",
    ].join("\n"));
    await chmod(path.join(workspaceRoot, "switch-head.sh"), 0o755);
    git(workspaceRoot, ["config", "filter.switch-head.clean", "./switch-head.sh"]);
    git(workspaceRoot, ["config", "filter.switch-head.smudge", "cat"]);
    git(workspaceRoot, ["config", "filter.switch-head.required", "true"]);
    await writeFile(path.join(workspaceRoot, "sample.mark"), "captured\n");

    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot }),
      /repository HEAD changed while the review snapshot was captured/i,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot fails when index flags change during capture", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-index-revalidation-"));
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, ".gitattributes"), "*.mark filter=switch-index\n");
    await writeFile(path.join(workspaceRoot, "sample.mark"), "base\n");
    await writeFile(path.join(workspaceRoot, "other.txt"), "stable\n");
    await writeFile(path.join(workspaceRoot, "switch-index.sh"), [
      "#!/bin/sh",
      "unset GIT_INDEX_FILE GIT_WORK_TREE GIT_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
      `git -C ${shellQuote(workspaceRoot)} update-index --assume-unchanged other.txt`,
      "cat",
      "",
    ].join("\n"));
    await chmod(path.join(workspaceRoot, "switch-index.sh"), 0o755);
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "base"]);
    git(workspaceRoot, ["config", "filter.switch-index.clean", "./switch-index.sh"]);
    git(workspaceRoot, ["config", "filter.switch-index.smudge", "cat"]);
    git(workspaceRoot, ["config", "filter.switch-index.required", "true"]);
    await writeFile(path.join(workspaceRoot, "sample.mark"), "captured\n");

    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot }),
      /repository index or sparse-checkout state changed while the review snapshot was captured/i,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot isolates the delivered tree from delayed clean-filter children", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-delayed-filter-"));
  let snapshot;
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, ".gitattributes"), "*.mark filter=delayed\n");
    await writeFile(path.join(workspaceRoot, "filter-clean.sh"), [
      "#!/bin/sh",
      "(sleep 0.1; printf 'late\\n' > victim.txt) >/dev/null 2>&1 &",
      "cat",
      "",
    ].join("\n"));
    await chmod(path.join(workspaceRoot, "filter-clean.sh"), 0o755);
    await writeFile(path.join(workspaceRoot, "sample.mark"), "base\n");
    await writeFile(path.join(workspaceRoot, "victim.txt"), "safe\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);
    git(workspaceRoot, ["config", "filter.delayed.clean", "./filter-clean.sh"]);
    git(workspaceRoot, ["config", "filter.delayed.smudge", "cat"]);
    git(workspaceRoot, ["config", "filter.delayed.required", "true"]);
    await writeFile(path.join(workspaceRoot, "sample.mark"), "captured\n");

    snapshot = await createReviewSnapshot({ workspaceRoot });
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(await readFile(path.join(snapshot.root, "victim.txt"), "utf8"), "safe\n");
    assert.equal(await readFile(path.join(workspaceRoot, "victim.txt"), "utf8"), "safe\n");
  } finally {
    await snapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot fails closed on present private index flags without touching the live index", async (t) => {
  for (const scenario of [
    { option: "--assume-unchanged", label: "assume-unchanged" },
    { option: "--skip-worktree", label: "skip-worktree" },
  ]) {
    await t.test(scenario.label, async () => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-index-flags-"));
      try {
        git(workspaceRoot, ["init"]);
        git(workspaceRoot, ["config", "user.email", "test@example.com"]);
        git(workspaceRoot, ["config", "user.name", "Test User"]);
        await writeFile(path.join(workspaceRoot, "hidden.txt"), "base\n");
        git(workspaceRoot, ["add", "."]);
        git(workspaceRoot, ["commit", "-m", "base"]);
        git(workspaceRoot, ["update-index", scenario.option, "hidden.txt"]);
        await writeFile(path.join(workspaceRoot, "hidden.txt"), "hidden change\n");
        const indexBefore = git(workspaceRoot, ["ls-files", "-v"]);
        assert.equal(git(workspaceRoot, ["status", "--porcelain=v1"]), "");

        await assert.rejects(
          () => createReviewSnapshot({ workspaceRoot }),
          new RegExp(`${scenario.label}.*clear the index flag`, "i"),
        );
        assert.equal(git(workspaceRoot, ["ls-files", "-v"]), indexBefore);
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  }
});

test("createReviewSnapshot classifies an absent non-sparse entry as deleted even if the initial status sample missed it", {
  skip: process.platform === "win32",
}, async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-deletion-race-"));
  const wrapperRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-deletion-wrapper-"));
  const originalPath = process.env.PATH;
  const originalRealGit = process.env.SUPERMODELS_TEST_REAL_GIT;
  const originalState = process.env.SUPERMODELS_TEST_GIT_STATE;
  let snapshot;
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, "victim.txt"), "base\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "base"]);
    await rm(path.join(workspaceRoot, "victim.txt"));

    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const statePath = path.join(wrapperRoot, "first-diff-files-seen");
    await writeFile(path.join(wrapperRoot, "git"), [
      "#!/bin/sh",
      "for arg in \"$@\"; do",
      "  if [ \"$arg\" = diff-files ] && [ ! -e \"$SUPERMODELS_TEST_GIT_STATE\" ]; then",
      "    : > \"$SUPERMODELS_TEST_GIT_STATE\"",
      "    exit 0",
      "  fi",
      "done",
      "exec \"$SUPERMODELS_TEST_REAL_GIT\" \"$@\"",
      "",
    ].join("\n"));
    await chmod(path.join(wrapperRoot, "git"), 0o755);
    process.env.SUPERMODELS_TEST_REAL_GIT = realGit;
    process.env.SUPERMODELS_TEST_GIT_STATE = statePath;
    process.env.PATH = `${wrapperRoot}${path.delimiter}${originalPath}`;

    snapshot = await createReviewSnapshot({ workspaceRoot });

    assert.deepEqual(snapshot.changedFiles, [{ status: "D", path: "victim.txt" }]);
    assert.match(snapshot.context.diff, /^deleted file mode/m);
  } finally {
    process.env.PATH = originalPath;
    restoreEnv("SUPERMODELS_TEST_REAL_GIT", originalRealGit);
    restoreEnv("SUPERMODELS_TEST_GIT_STATE", originalState);
    await snapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(wrapperRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot supports repository roots containing the alternate-path delimiter", {
  skip: process.platform === "win32",
}, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "supermodels-git-delimiter-"));
  const workspaceRoot = path.join(parent, "repo:colon");
  let snapshot;
  try {
    await mkdir(workspaceRoot);
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, "a.txt"), "base\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);
    await writeFile(path.join(workspaceRoot, "a.txt"), "captured\n");

    snapshot = await createReviewSnapshot({ workspaceRoot });

    assert.equal(await readFile(path.join(snapshot.root, "a.txt"), "utf8"), "captured\n");
  } finally {
    await snapshot?.dispose();
    await rm(parent, { recursive: true, force: true });
  }
});

test("createReviewSnapshot preserves a repository root ending in whitespace", {
  skip: process.platform === "win32",
}, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "supermodels-git-space-root-"));
  const workspaceRoot = path.join(parent, "repo ");
  let snapshot;
  try {
    await mkdir(workspaceRoot);
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, "a.txt"), "base\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);
    await writeFile(path.join(workspaceRoot, "a.txt"), "captured\n");

    snapshot = await createReviewSnapshot({ workspaceRoot });

    assert.equal(snapshot.workspaceRoot, await realpath(workspaceRoot));
    assert.equal(await readFile(path.join(snapshot.root, "a.txt"), "utf8"), "captured\n");
  } finally {
    await snapshot?.dispose();
    await rm(parent, { recursive: true, force: true });
  }
});

test("createReviewSnapshot preserves relative symlinks and their captured targets", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-relative-link-"));
  let snapshot;
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await mkdir(path.join(workspaceRoot, "links"));
    await writeFile(path.join(workspaceRoot, "target.txt"), "captured target\n");
    await symlink("../target.txt", path.join(workspaceRoot, "links", "current.txt"));
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);

    snapshot = await createReviewSnapshot({ workspaceRoot });
    await rm(path.join(workspaceRoot, "links", "current.txt"));
    await symlink("../other.txt", path.join(workspaceRoot, "links", "current.txt"));
    await writeFile(path.join(workspaceRoot, "target.txt"), "live mutation\n");

    assert.equal(await readlink(path.join(snapshot.root, "links", "current.txt")), "../target.txt");
    assert.equal(await readFile(path.join(snapshot.root, "target.txt"), "utf8"), "captured target\n");
  } finally {
    await snapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot keeps relative symlinks verbatim outside Git worktrees", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-filesystem-relative-link-"));
  let snapshot;
  try {
    await mkdir(path.join(workspaceRoot, "links"));
    await writeFile(path.join(workspaceRoot, "target.txt"), "captured target\n");
    await symlink("../target.txt", path.join(workspaceRoot, "links", "current.txt"));

    snapshot = await createReviewSnapshot({ workspaceRoot });

    assert.equal(await readlink(path.join(snapshot.root, "links", "current.txt")), "../target.txt");
    assert.equal(await readFile(path.join(snapshot.root, "links", "current.txt"), "utf8"), "captured target\n");
  } finally {
    await snapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot dereferences a non-Git workspace root symlink without following nested symlinks", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "supermodels-filesystem-root-link-"));
  const workspaceRoot = path.join(parent, "workspace");
  const linkedRoot = path.join(parent, "workspace-link");
  let snapshot;
  try {
    await mkdir(workspaceRoot);
    await mkdir(path.join(workspaceRoot, "links"));
    await writeFile(path.join(workspaceRoot, "captured.txt"), "captured\n");
    await symlink("../captured.txt", path.join(workspaceRoot, "links", "current.txt"));
    await symlink(workspaceRoot, linkedRoot);

    snapshot = await createReviewSnapshot({ workspaceRoot: linkedRoot });
    await writeFile(path.join(workspaceRoot, "captured.txt"), "live mutation\n");

    assert.equal((await lstat(snapshot.root)).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(snapshot.root, "captured.txt"), "utf8"), "captured\n");
    assert.equal(await readlink(path.join(snapshot.root, "links", "current.txt")), "../captured.txt");
  } finally {
    await snapshot?.dispose();
    await rm(parent, { recursive: true, force: true });
  }
});

test("createReviewSnapshot retains actual LFS-style working content after canonical clean filtering", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-lfs-snapshot-"));
  let snapshot;
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, ".gitattributes"), "*.asset filter=pointer\n");
    await writeFile(
      path.join(workspaceRoot, "pointer-clean.mjs"),
      "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(`pointer:${Buffer.byteLength(s)}\\n`));\n",
    );
    git(workspaceRoot, ["config", "filter.pointer.clean", "node ./pointer-clean.mjs"]);
    git(workspaceRoot, ["config", "filter.pointer.smudge", "cat"]);
    git(workspaceRoot, ["config", "filter.pointer.required", "true"]);
    await writeFile(path.join(workspaceRoot, "payload.asset"), "base actual bytes\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "initial"]);
    await writeFile(path.join(workspaceRoot, "payload.asset"), "captured actual bytes are longer\n");

    snapshot = await createReviewSnapshot({ workspaceRoot });

    assert.equal(
      await readFile(path.join(snapshot.root, "payload.asset"), "utf8"),
      "captured actual bytes are longer\n",
    );
    assert.match(snapshot.context.diff, /pointer:33/);
    assert.deepEqual(snapshot.filteredFiles, [{
      path: "payload.asset",
      status: "M",
      filter: "pointer",
      lineCount: 1,
    }]);
  } finally {
    await snapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot retains deleted base-filter evidence without check-attr --source", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-deleted-filter-"));
  const wrapperRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-wrapper-"));
  let snapshot;
  const originalPath = process.env.PATH;
  const originalRealGit = process.env.SUPERMODELS_TEST_REAL_GIT;
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, ".gitattributes"), "*.asset filter=pointer\n");
    await writeFile(
      path.join(workspaceRoot, "pointer-clean.mjs"),
      "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write('POINTER\\n'));\n",
    );
    git(workspaceRoot, ["config", "filter.pointer.clean", "node ./pointer-clean.mjs"]);
    git(workspaceRoot, ["config", "filter.pointer.smudge", "cat"]);
    git(workspaceRoot, ["config", "filter.pointer.required", "true"]);
    await writeFile(path.join(workspaceRoot, "payload.asset"), "SECRET REAL CONTENT\n");
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "filtered base"]);
    await rm(path.join(workspaceRoot, ".gitattributes"));
    await rm(path.join(workspaceRoot, "payload.asset"));

    if (process.platform !== "win32") {
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      await writeFile(path.join(wrapperRoot, "git"), [
        "#!/bin/sh",
        "for arg in \"$@\"; do",
        "  case \"$arg\" in --source=*) echo 'check-attr --source is unavailable' >&2; exit 129;; esac",
        "done",
        "exec \"$SUPERMODELS_TEST_REAL_GIT\" \"$@\"",
        "",
      ].join("\n"));
      await chmod(path.join(wrapperRoot, "git"), 0o755);
      process.env.SUPERMODELS_TEST_REAL_GIT = realGit;
      process.env.PATH = `${wrapperRoot}${path.delimiter}${originalPath}`;
    }

    snapshot = await createReviewSnapshot({ workspaceRoot });

    assert.match(snapshot.context.diff, /-POINTER/);
    assert.deepEqual(snapshot.filteredFiles, [{
      path: "payload.asset",
      status: "D",
      filter: "pointer",
      lineCount: 0,
    }]);
  } finally {
    process.env.PATH = originalPath;
    restoreEnv("SUPERMODELS_TEST_REAL_GIT", originalRealGit);
    await snapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(wrapperRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot retains base-filter evidence across a rename", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-renamed-filter-"));
  let snapshot;
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(workspaceRoot, ".gitattributes"), "old.txt filter=prefix\n");
    await writeFile(
      path.join(workspaceRoot, "prefix-clean.mjs"),
      "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(`CANON:${s}`));\n",
    );
    git(workspaceRoot, ["config", "filter.prefix.clean", "node ./prefix-clean.mjs"]);
    git(workspaceRoot, ["config", "filter.prefix.smudge", "cat"]);
    git(workspaceRoot, ["config", "filter.prefix.required", "true"]);
    await writeFile(
      path.join(workspaceRoot, "old.txt"),
      Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
    );
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "filtered base"]);
    git(workspaceRoot, ["mv", "old.txt", "new.txt"]);
    await rm(path.join(workspaceRoot, ".gitattributes"));

    snapshot = await createReviewSnapshot({ workspaceRoot });

    const renamed = snapshot.changedFiles.find((file) => file.path === "new.txt");
    assert.deepEqual(renamed, { status: "R", path: "new.txt", oldPath: "old.txt" });
    assert.deepEqual(snapshot.filteredFiles, [{
      path: "new.txt",
      status: "R",
      filter: "prefix",
      lineCount: 100,
    }]);
  } finally {
    await snapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createReviewSnapshot fails closed for dirty or untracked submodule content", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-submodule-parent-"));
  const childRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-submodule-child-"));
  let cleanSnapshot;
  try {
    git(childRoot, ["init"]);
    git(childRoot, ["config", "user.email", "test@example.com"]);
    git(childRoot, ["config", "user.name", "Test User"]);
    await writeFile(path.join(childRoot, "child.txt"), "base\n");
    git(childRoot, ["add", "."]);
    git(childRoot, ["commit", "-m", "initial"]);

    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Test User"]);
    git(workspaceRoot, ["-c", "protocol.file.allow=always", "submodule", "add", childRoot, "deps/child"]);
    git(workspaceRoot, ["commit", "-am", "add submodule"]);
    git(workspaceRoot, ["submodule", "deinit", "-f", "deps/child"]);
    cleanSnapshot = await createReviewSnapshot({ workspaceRoot });
    assert.equal(cleanSnapshot.changedFiles.length, 0, "an unchanged uninitialized gitlink is allowed");
    await cleanSnapshot.dispose();
    cleanSnapshot = null;
    git(workspaceRoot, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "deps/child"]);
    await rm(path.join(workspaceRoot, "deps", "child"), { recursive: true, force: true });
    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot }),
      /cannot snapshot deleted gitlink 'deps\/child'/i,
    );
    git(workspaceRoot, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--force", "deps/child"]);
    await writeFile(path.join(workspaceRoot, "deps", "child", "untracked.txt"), "not represented by gitlink\n");

    await assert.rejects(
      () => createReviewSnapshot({ workspaceRoot }),
      /submodule.*dirty|submodule.*untracked|cannot snapshot.*submodule/i,
    );
  } finally {
    await cleanSnapshot?.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(childRoot, { recursive: true, force: true });
  }
});

test("collectGitContext includes untracked files in working-tree reviews", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-"));
  try {
    git(workspaceRoot, ["init"]);
    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\n");
    git(workspaceRoot, ["add", "README.md"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    await mkdir(path.join(workspaceRoot, "plugins"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "plugins", "supermodels.mjs"), "export const pluginName = 'supermodels';\n");

    const context = await collectGitContext({ workspaceRoot });

    assert.equal(context.gitAvailable, true);
    assert.match(context.diffSummary, /1 file changed/);
    assert.match(context.diff, /diff --git a\/plugins\/supermodels\.mjs b\/plugins\/supermodels\.mjs/);
    assert.match(context.diff, /\+export const pluginName = 'supermodels';/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("collectGitContext diff summary matches staged diff body", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-staged-summary-"));
  try {
    git(workspaceRoot, ["init"]);
    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\n");
    git(workspaceRoot, ["add", "README.md"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\nstaged\n");
    git(workspaceRoot, ["add", "README.md"]);

    const context = await collectGitContext({ workspaceRoot });

    assert.match(context.diff, /^\+staged$/m);
    assert.match(context.diffSummary, /1 file changed/);
    assert.doesNotMatch(context.diffSummary, /No diff summary available/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("collectGitContext forces standard diff prefixes despite local git config", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-prefixes-"));
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "diff.noprefix", "true"]);
    git(workspaceRoot, ["config", "diff.srcPrefix", "old/"]);
    git(workspaceRoot, ["config", "diff.dstPrefix", "new/"]);
    await mkdir(path.join(workspaceRoot, "my b"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "my b", "file.txt"), "one\n");
    git(workspaceRoot, ["add", "my b/file.txt"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    await writeFile(path.join(workspaceRoot, "my b", "file.txt"), "two\n");

    const context = await collectGitContext({ workspaceRoot });

    assert.match(context.diff, /diff --git a\/my b\/file\.txt b\/my b\/file\.txt/);
    assert.doesNotMatch(context.diff, /diff --git my b\/file\.txt my b\/file\.txt/);
    assert.doesNotMatch(context.diff, /diff --git old\/my b\/file\.txt new\/my b\/file\.txt/);
    assert.match(context.diffSummary, /1 file changed/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("collectGitContext disables configured diff color so coverage parsers see stable markers", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-no-color-"));
  try {
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "color.ui", "always"]);
    await writeFile(path.join(workspaceRoot, "auth.mjs"), "export const token = 'old';\n");
    git(workspaceRoot, ["add", "auth.mjs"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    await writeFile(path.join(workspaceRoot, "auth.mjs"), "export const token = 'new';\n");

    const context = await collectGitContext({ workspaceRoot });

    assert.match(context.diff, /^diff --git /m);
    assert.match(context.diff, /^@@ /m);
    assert.doesNotMatch(context.diff, /\u001b\[/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("collectGitContext uses base refs for committed changes without requiring branch scope", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-base-"));
  try {
    git(workspaceRoot, ["init"]);
    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\n");
    git(workspaceRoot, ["add", "README.md"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\ncommitted\n");
    git(workspaceRoot, ["add", "README.md"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "change"]);

    const context = await collectGitContext({ workspaceRoot, baseRef: "HEAD^" });

    assert.equal(context.baseRef, "HEAD^");
    assert.match(context.diffSummary, /1 file changed/);
    assert.match(context.diff, /^\+committed$/m);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("collectGitContext with base ref includes uncommitted tracked changes", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-base-working-"));
  try {
    git(workspaceRoot, ["init"]);
    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\n");
    git(workspaceRoot, ["add", "README.md"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\nworking\n");

    const context = await collectGitContext({ workspaceRoot, baseRef: "HEAD" });

    assert.match(context.diffSummary, /1 file changed/);
    assert.match(context.diff, /^\+working$/m);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("collectGitContext captures large untracked files instead of silently omitting evidence", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-large-"));
  try {
    git(workspaceRoot, ["init"]);
    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\n");
    git(workspaceRoot, ["add", "README.md"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    const largePath = path.join(workspaceRoot, "large-untracked.txt");
    await writeFile(largePath, `sentinel-start\n${"x".repeat(250_000)}\nsentinel-end\n`);

    const context = await collectGitContext({ workspaceRoot });

    assert.match(context.diff, /large-untracked\.txt/);
    assert.match(context.diff, /sentinel-start/);
    assert.match(context.diff, /sentinel-end/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("collectGitContext records an untracked symlink without dereferencing outside content", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-symlink-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "supermodels-outside-"));
  try {
    git(workspaceRoot, ["init"]);
    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\n");
    git(workspaceRoot, ["add", "README.md"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    const outsidePath = path.join(outsideRoot, "secret.txt");
    await writeFile(outsidePath, "outside-workspace-secret\n");
    await symlink(outsidePath, path.join(workspaceRoot, "outside-link.txt"));

    const context = await collectGitContext({ workspaceRoot });

    assert.match(context.diff, /outside-link\.txt/);
    assert.doesNotMatch(context.diff, /outside-workspace-secret/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
