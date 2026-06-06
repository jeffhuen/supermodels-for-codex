import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const pluginRoot = path.resolve(import.meta.dirname, "..");

test("review skills use one live command instead of manual polling", async () => {
  for (const skill of ["review", "adversarial-review"]) {
    const body = await readFile(path.join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
    assert.match(body, /--live/);
    assert.match(body, /--live -- "\$@"/);
    assert.doesNotMatch(body, /--background/);
    assert.doesNotMatch(body, /watch <job-id>/);
    assert.doesNotMatch(body, /status <job-id>/);
  }
});

test("review skills discourage defensive progress narration", async () => {
  const forbidden = [
    /as the skill requires/i,
    /single Supermodels process/i,
    /one Supermodels process owns/i,
    /process ownership/i,
    /active session/i,
    /keychain/i,
    /transport/i,
    /Since the invocation is bare/i,
    /no added focus text/i,
    /supplied validation focus/i,
  ];

  for (const skill of ["review", "adversarial-review"]) {
    const body = await readFile(path.join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
    assert.match(body, /progress updates terse and concrete/);
    assert.match(body, /Claude Code and Antigravity are both running/);
    assert.match(body, /Do not describe review focus text in progress updates/);
    for (const pattern of forbidden) {
      assert.doesNotMatch(body, pattern);
    }
  }
});

test("review skills do not synthesize focus for bare invocations", async () => {
  for (const skill of ["review", "adversarial-review"]) {
    const body = await readFile(path.join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
    assert.match(body, /bare `\$supermodels:/);
    assert.match(body, /no trailing focus text/);
    assert.match(body, /Do not synthesize focus from prior conversation/);
    assert.match(body, /Only pass focus text that the user explicitly supplied/);
    assert.match(body, /Do not announce that the invocation is bare/);
  }
});

test("review skills preserve provider attribution in final summaries", async () => {
  for (const skill of ["review", "adversarial-review"]) {
    const body = await readFile(path.join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
    assert.match(body, /Preserve provider attribution/);
    assert.match(body, /Claude Code/);
    assert.match(body, /Antigravity/);
    assert.match(body, /Do not flatten provider-specific findings into anonymous feedback/);
  }
});
