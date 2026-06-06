import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectGitContext } from "../scripts/lib/git.mjs";

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
    assert.match(context.diffSummary, /1 untracked file/);
    assert.match(context.diff, /diff --git a\/plugins\/supermodels\.mjs b\/plugins\/supermodels\.mjs/);
    assert.match(context.diff, /\+export const pluginName = 'supermodels';/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("collectGitContext omits oversized unreadable untracked files before reading", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-large-"));
  try {
    git(workspaceRoot, ["init"]);
    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\n");
    git(workspaceRoot, ["add", "README.md"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    const largePath = path.join(workspaceRoot, "large-untracked.txt");
    await writeFile(largePath, "x".repeat(250_000));
    await chmod(largePath, 0o000);

    const context = await collectGitContext({ workspaceRoot });

    assert.match(context.diff, /large-untracked\.txt/);
    assert.match(context.diff, /untracked context byte budget reached/);
    assert.doesNotMatch(context.diff, /could not read file/);
  } finally {
    await chmod(path.join(workspaceRoot, "large-untracked.txt"), 0o600).catch(() => {});
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("collectGitContext omits untracked symlinks instead of following outside the workspace", async () => {
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
    assert.match(context.diff, /not a regular file/);
    assert.doesNotMatch(context.diff, /outside-workspace-secret/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("collectGitContext omits untracked files swapped to symlinks before read", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "supermodels-git-symlink-race-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "supermodels-outside-race-"));
  try {
    git(workspaceRoot, ["init"]);
    await writeFile(path.join(workspaceRoot, "README.md"), "tracked\n");
    git(workspaceRoot, ["add", "README.md"]);
    git(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    const racedPath = path.join(workspaceRoot, "race.txt");
    const outsidePath = path.join(outsideRoot, "secret.txt");
    await writeFile(racedPath, "initial safe content\n");
    await writeFile(outsidePath, "outside-workspace-secret\n");

    let swapped = false;
    const context = await collectGitContext({
      workspaceRoot,
      beforeReadUntrackedFile: async (file, absolute) => {
        if (file !== "race.txt" || swapped) {
          return;
        }
        swapped = true;
        await unlink(absolute);
        await symlink(outsidePath, absolute);
      },
    });

    assert.equal(swapped, true);
    assert.match(context.diff, /race\.txt/);
    assert.match(context.diff, /file changed while reading/);
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
