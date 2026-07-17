import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_DEFINITIONS,
  PROVIDER_IDS,
  challengeRunId,
  createProviderAdapters,
  providerLabel,
  resolveProviderId,
} from "../scripts/providers/registry.mjs";

test("provider registry exposes ordered, frozen provider-local definitions", () => {
  assert.deepEqual(PROVIDER_IDS, ["claude", "antigravity", "grok"]);
  assert(Object.isFrozen(PROVIDER_DEFINITIONS));
  assert(Object.isFrozen(PROVIDER_IDS));
  for (const provider of PROVIDER_DEFINITIONS) {
    assert(Object.isFrozen(provider));
    assert(Object.isFrozen(provider.aliases));
    assert.equal(typeof provider.create, "function");
  }
});

test("provider registry resolves canonical IDs and aliases", () => {
  assert.equal(resolveProviderId("claude"), "claude");
  assert.equal(resolveProviderId(" CLAUDE-CODE "), "claude");
  assert.equal(resolveProviderId("agy"), "antigravity");
  assert.equal(resolveProviderId("GROK"), "grok");
  assert.equal(resolveProviderId("not-a-provider"), "");
});

test("provider registry supplies CLI labels, including challenge runs", () => {
  assert.equal(providerLabel("claude"), "Claude Code");
  assert.equal(providerLabel("antigravity"), "Google Antigravity");
  assert.equal(providerLabel("grok"), "Grok Build");
  assert.equal(
    providerLabel("grok-challenge-claude-antigravity"),
    "Grok Build challenging Claude Code, Google Antigravity",
  );
  assert.equal(providerLabel("future-provider"), "future-provider");
  assert.equal(
    providerLabel(challengeRunId("claude", ["kimi-k3", "deepseek-v3"])),
    "Claude Code challenging kimi-k3, deepseek-v3",
  );
});

test("provider registry constructs every registered adapter", () => {
  const adapters = createProviderAdapters();
  assert.deepEqual(Object.keys(adapters), PROVIDER_IDS);
  for (const id of PROVIDER_IDS) {
    assert.equal(adapters[id].id, id);
    assert.equal(adapters[id].label, providerLabel(id));
    assert.equal(typeof adapters[id].check, "function");
  }
});
