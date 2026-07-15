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
