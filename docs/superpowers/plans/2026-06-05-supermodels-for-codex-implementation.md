# Supermodels For Codex Implementation Plan

## Scope

Build the first working Codex plugin for `supermodels`. Version 1 supports Claude Code and Antigravity only. If one provider is ready, review with one provider. If both are ready, review with both in parallel. Future 3+ provider council behavior is deferred.

## Success Criteria

- Repo-local Codex plugin manifest and marketplace entry exist.
- Runtime CLI supports `setup`, `providers`, `review`, `adversarial-review`, `task`, `status`, `result`, and `cancel`.
- Claude and Antigravity adapters are isolated and testable without live auth.
- Claude review mode uses installed `claude` with stream-json, session capture, read-only tools, and native `--json-schema` output.
- Antigravity review mode uses the installed native `agy` CLI, with prompt-file transport, sandboxed read-only reviews, Gemini 3.5 Flash High, and Supermodels-side structured JSON validation.
- Shared review prompts include the adversarial/Karpathy review charter and provider overrides.
- Job state lives outside the repo under `~/.codex/plugins/data/supermodels`.
- Tests cover argument parsing, prompt rendering, provider checks/parsers, state, and one-or-two provider selection.
- Normal tests do not require live Claude or Antigravity.

## Tasks

1. Scaffold plugin files.
   - Create `.codex-plugin/plugin.json`, repo marketplace wiring, package metadata, scripts, prompts, skills, and tests directories.
   - Verify with plugin validation.

2. Write runtime tests first.
   - Add Node test files for args, prompt rendering, provider parser/check behavior, state, and provider selection.
   - Run tests and confirm they fail before implementation exists.

3. Implement runtime core.
   - Add argument parsing, command dispatch, git context collection, prompt rendering, state paths, job lifecycle, provider selection, and output formatting.
   - Verify with unit tests.

4. Implement provider adapters.
   - Add Claude CLI adapter with setup check, review/task invocation, stream-json progress, `--json-schema`, native structured output parsing, and session parsing.
   - Add native Antigravity `agy` adapter with setup check, model alias handling, prompt-file transport, sandboxed read-only review mode, task invocation, and structured review validation.

5. Implement skill wrappers.
   - Add Codex skills that route to the runtime CLI for setup/providers/review/adversarial-review/task/status/result/cancel.
   - Keep skill instructions concise so provider behavior remains in code and prompt assets.

6. Final verification.
   - Run `node --test plugins/supermodels/tests/*.test.mjs`.
   - Run `python3 /Users/jeffhuen/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/supermodels`.
   - Run `node plugins/supermodels/scripts/supermodels.mjs setup --json`.

## Deferred

- Hooks and stop gates.
- Provider-vs-provider cross-examination.
- Grok or any third provider.
- Claude Agent SDK.
- Antigravity SDK hard dependency.
- Public-provider API keys for v1 review routing.
- Repo-local saved reports.
