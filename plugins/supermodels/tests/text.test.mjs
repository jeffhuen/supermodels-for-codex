import test from "node:test";
import assert from "node:assert/strict";

import { decodeUtf8Prefix } from "../scripts/lib/text.mjs";

test("decodeUtf8Prefix drops partial trailing UTF-8 code points", () => {
  const input = Buffer.from("context 😀", "utf8");
  const partialEmojiLength = input.length - 1;

  const decoded = decodeUtf8Prefix(input, partialEmojiLength);

  assert.equal(decoded, "context ");
  assert.doesNotMatch(decoded, /\uFFFD/);
});
