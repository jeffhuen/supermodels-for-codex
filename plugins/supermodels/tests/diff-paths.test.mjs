import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDiffGitPathTokens,
  parseUnifiedDiffHeaderPath,
} from "../scripts/lib/diff-paths.mjs";

test("parseDiffGitPathTokens decodes Git octal bytes without mangling literal supplementary characters", () => {
  assert.deepEqual(
    parseDiffGitPathTokens('"a/😀/caf\\303\\251.mjs" "b/😀/caf\\303\\251.mjs"'),
    ["a/😀/café.mjs", "b/😀/café.mjs"],
  );
});

test("parseUnifiedDiffHeaderPath decodes named Git escapes in fallback quoted paths", () => {
  assert.equal(
    parseUnifiedDiffHeaderPath('"a/dir\\tname/caf\\303\\251.mjs"'),
    "a/dir\tname/café.mjs",
  );
});

test("parseDiffGitPathTokens preserves malformed out-of-range octal escapes", () => {
  assert.deepEqual(
    parseDiffGitPathTokens('"a/bad\\777.mjs" "b/bad\\777.mjs"'),
    ["a/bad\\777.mjs", "b/bad\\777.mjs"],
  );
});
