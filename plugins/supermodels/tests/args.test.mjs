import assert from "node:assert/strict";
import test from "node:test";

import {
  parseArgs,
  parseRuntimeArgs,
  resolveProviderIds,
  splitRawArgumentString,
} from "../scripts/lib/args.mjs";

test("parseArgs handles boolean flags, values, aliases, and passthrough", () => {
  const parsed = parseArgs(
    ["review", "--all", "--provider=claude", "-b", "main", "--", "--literal"],
    {
      booleanOptions: ["all"],
      valueOptions: ["provider", "base"],
      aliasMap: { b: "base" },
    },
  );

  assert.deepEqual(parsed.positionals, ["review", "--literal"]);
  assert.deepEqual(parsed.options, {
    all: true,
    provider: "claude",
    base: "main",
  });
});

test("splitRawArgumentString preserves quoted focus text", () => {
  assert.deepEqual(
    splitRawArgumentString("--provider claude \"focus on auth rollback\""),
    ["--provider", "claude", "focus on auth rollback"],
  );
});

test("parseArgs rejects unknown options before passthrough", () => {
  assert.throws(
    () => parseArgs(["--provder", "claude"], { valueOptions: ["provider"] }),
    /unknown option --provder/i,
  );

  const parsed = parseArgs(["--", "--literal-focus"], {});
  assert.deepEqual(parsed.positionals, ["--literal-focus"]);
});

test("parseArgs rejects missing option values when the next token is another flag", () => {
  assert.throws(
    () => parseArgs(["--provider", "--json"], { valueOptions: ["provider"], booleanOptions: ["json"] }),
    /missing value for --provider/i,
  );
  assert.throws(
    () => parseArgs(["-b", "--json"], { valueOptions: ["base"], booleanOptions: ["json"], aliasMap: { b: "base" } }),
    /missing value for -b/i,
  );
});

test("parseRuntimeArgs accepts live review mode", () => {
  const parsed = parseRuntimeArgs(["review", "--live", "--provider", "antigravity", "--context-file", "brief.md"]);
  assert.equal(parsed.options.live, true);
  assert.equal(parsed.options.provider, "antigravity");
  assert.equal(parsed.options["context-file"], "brief.md");
});

test("parseRuntimeArgs rejects the removed --scope option", () => {
  assert.throws(
    () => parseRuntimeArgs(["review", "--scope", "branch"]),
    /unknown option --scope/i,
  );
});

test("resolveProviderIds accepts claude, antigravity, and grok", () => {
  assert.deepEqual(resolveProviderIds({ provider: "claude, antigravity, grok" }), {
    explicit: true,
    requested: ["claude", "antigravity", "grok"],
  });
  assert.deepEqual(resolveProviderIds({ provider: "grok" }), {
    explicit: true,
    requested: ["grok"],
  });
  assert.deepEqual(resolveProviderIds({ all: true }), {
    explicit: false,
    requested: ["claude", "antigravity", "grok"],
  });
  assert.deepEqual(resolveProviderIds({ provider: "CLAUDE-CODE,agy" }), {
    explicit: true,
    requested: ["claude", "antigravity"],
  });
});

test("resolveProviderIds rejects unknown providers", () => {
  assert.throws(
    () => resolveProviderIds({ provider: "claude,not-a-real-provider" }),
    /unsupported provider/i,
  );
});

test("resolveProviderIds fails clearly when defaultAll is disabled without a provider", () => {
  assert.throws(
    () => resolveProviderIds({}, { defaultAll: false }),
    /at least one provider/i,
  );
});

test("parseRuntimeArgs parses grok-exclusive task options", () => {
  const parsed = parseRuntimeArgs([
    "task",
    "--provider", "grok",
    "--best-of-n", "3",
    "--check",
    "--json-schema", '{"type":"object"}',
    "--worktree",
    "do the thing",
  ]);

  assert.equal(parsed.options["best-of-n"], 3);
  assert.equal(parsed.options.check, true);
  assert.deepEqual(parsed.options["json-schema"], { type: "object" });
  assert.equal(parsed.options.worktree, true);
  assert.deepEqual(parsed.positionals, ["do the thing"]);
});

test("parseRuntimeArgs rejects a non-positive-integer --best-of-n", () => {
  assert.throws(
    () => parseRuntimeArgs(["task", "--best-of-n", "abc", "task"]),
    /--best-of-n must be a positive integer/i,
  );
  assert.throws(
    () => parseRuntimeArgs(["task", "--best-of-n", "0", "task"]),
    /--best-of-n must be a positive integer/i,
  );
  assert.throws(
    () => parseRuntimeArgs(["task", "--best-of-n", "1.5", "task"]),
    /--best-of-n must be a positive integer/i,
  );
});

test("parseRuntimeArgs requires --json-schema to be a JSON object", () => {
  // valid JSON but not an object -> rejected at the source, not silently dropped
  assert.throws(
    () => parseRuntimeArgs(["task", "--json-schema", "false", "task"]),
    /--json-schema must be a JSON object/i,
  );
  assert.throws(
    () => parseRuntimeArgs(["task", "--json-schema", "[1,2]", "task"]),
    /--json-schema must be a JSON object/i,
  );
  assert.throws(
    () => parseRuntimeArgs(["task", "--json-schema", "{bad", "task"]),
    /--json-schema must be valid JSON/i,
  );
  const parsed = parseRuntimeArgs(["task", "--json-schema", '{"type":"object"}', "task"]);
  assert.deepEqual(parsed.options["json-schema"], { type: "object" });
});

test("parseRuntimeArgs rejects invalid --json-schema JSON", () => {
  assert.throws(
    () => parseRuntimeArgs(["task", "--json-schema", "{not json", "task"]),
    /--json-schema must be valid json/i,
  );
});

test("parseRuntimeArgs leaves --worktree as a boolean flag", () => {
  const parsed = parseRuntimeArgs(["task", "--worktree=false", "task"]);
  assert.equal(parsed.options.worktree, false);
});
