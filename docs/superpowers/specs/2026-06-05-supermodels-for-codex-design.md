# Supermodels for Codex Design

> Superseded runtime note: the v0.1.0 runtime was reset by `docs/superpowers/specs/2026-06-05-provider-native-runtime-reset-design.md`. This document remains useful for product scope and command shape, but lifecycle and cancellation details should follow the provider-native reset design.

## Goal

Build a fresh Codex plugin that lets Codex call external coding agents for adversarial review and task delegation while preserving each provider's local auth and session model where practical. Version 1 supports exactly two providers: Claude Code (`claude`) and Google Antigravity (`antigravity`). Future providers such as Grok can fit behind the same adapter contract later, but they are outside the first release.

The plugin is not a Claude-only bridge. It is a review broker: Codex owns the user thread and synthesis, while external agents produce independent critiques from their native runtimes.

## Non-Goals

- Do not use Claude Agent SDK. Claude stays on the installed `claude` CLI so it uses the user's existing Claude Code auth/session store.
- Do not depend on the Antigravity SDK in v1. Antigravity uses the installed `agy` CLI so it can inspect the local workspace with native agent affordances.
- Do not fork `sendbird/cc-plugin-codex` as the implementation base. Use it only as reference material.
- Do not add a mandatory Stop-hook review gate in v1. Hooks can come later after the runtime is stable.
- Do not pretend Claude Code, Antigravity, and Codex have identical hook/subagent semantics.
- Do not implement 3+ provider council behavior in v1. Get the Claude + Antigravity version reliable first.

## Reference Inputs

- `reference/codex-plugin-cc-main`: strong UX reference for commands, setup, status/result/cancel, and polished docs.
- `reference/cc-plugin-codex-main`: useful cautionary reference; avoid prompt-heavy routing, stale model defaults, and fragile subagent forwarding.
- `reference/antigravity-plugin-cc-main`: useful Antigravity CLI wrapper reference, especially setup, auth detection, model override, and thin runner behavior.
- `reference/grill-me-codex-main`: useful pattern for native session continuity and bounded adversarial review loops.
- `tradingagents-subscription-cli/.../claude_code`: useful evidence for Claude Code CLI behavior and session handling.

## Product Shape

Plugin name: working title `supermodels`.

Primary commands:

- `$supermodels:setup`
- `$supermodels:review`
- `$supermodels:adversarial-review`
- `$supermodels:task`
- `$supermodels:status`
- `$supermodels:result`
- `$supermodels:cancel`
- `$supermodels:providers`

Aliases can be added later, such as `$sm:review`, after the core is stable.

Review examples:

```text
$supermodels:review --provider claude
$supermodels:review --provider antigravity
$supermodels:review --all
$supermodels:adversarial-review --all focus on auth, data loss, and rollback
$supermodels:review --provider claude --resume <provider-session-id>
```

Task examples:

```text
$supermodels:task --provider claude investigate the flaky test without editing files
$supermodels:task --provider antigravity --write propose and apply the smallest fix
```

Feature parity target from `reference/codex-plugin-cc-main`:

- Normal read-only review of current working-tree or branch diff.
- Steerable adversarial review that challenges implementation approach, tradeoffs, and assumptions.
- Rescue/task delegation for investigation or fixes.
- Background execution plus status/result/cancel lifecycle.
- Setup command that reports provider readiness.
- Native provider session IDs in status/result so users can resume outside Codex.
- Optional review gate is deferred; the command surface should not depend on hooks.

## Architecture

### Codex Plugin Layer

The plugin contains concise Codex skills. Skills should route to the runtime and not contain long provider-specific orchestration instructions.

Responsibilities:

- Parse user intent at a high level.
- Call the runtime CLI with structured flags.
- Explain setup failures clearly.
- Let Codex synthesize multi-provider findings after results are retrieved.

### Runtime CLI

The runtime is a Node/TypeScript CLI inside the plugin, for example:

```bash
node scripts/supermodels.mjs review --provider claude --scope working-tree --json
node scripts/supermodels.mjs adversarial-review --provider claude,antigravity --json
node scripts/supermodels.mjs review --all --background --json
node scripts/supermodels.mjs status --json
node scripts/supermodels.mjs result <job-id> --json
```

Responsibilities:

- Provider discovery and setup checks.
- Git context packaging.
- Process spawning, timeout handling, cancellation, and logs.
- Job state and provider session metadata.
- Output normalization.
- Rapidly replaceable provider adapters.

### Provider Adapter Contract

Each provider implements:

```ts
type ProviderAdapter = {
  id: "claude" | "antigravity" | string;
  label: string;
  check(): Promise<ProviderCheck>;
  models(): Promise<ModelInfo[]>;
  capabilities(): ProviderCapabilities;
  review(input: ReviewInput, options: ReviewOptions): Promise<ProviderRunResult>;
  task(input: TaskInput, options: TaskOptions): Promise<ProviderRunResult>;
  resume?(sessionId: string, input: ResumeInput, options: ResumeOptions): Promise<ProviderRunResult>;
  cancel?(run: ProviderRunState): Promise<void>;
};
```

Adapters must be small and provider-specific. Shared behavior belongs in the runtime core.

## Native Session Handling

The broker must keep provider sessions discoverable by the provider CLI.

For every provider run, store:

- broker job ID
- provider ID
- provider session/conversation/thread ID when available
- provider command line
- cwd/workspace root
- mode: `review`, `adversarial-review`, or `task`
- provider log file
- normalized result file
- raw result file
- started/completed timestamps
- status and exit code

The plugin should expose provider session IDs in `$supermodels:result` so the user can continue or inspect the run natively.

Claude target:

- Prefer invoking `claude -p`/Claude Code CLI in a way that creates normal Claude Code sessions.
- Parse stream-json output for Claude session IDs when available.
- Support `--resume <claude-session-id>` once verified against the current CLI.

Antigravity target:

- Prefer the native `agy -p` CLI for review mode because code review needs local workspace inspection, not a static cloud prompt.
- Run read-only Antigravity reviews with `--sandbox`, a prompt file, Gemini 3.5 Flash (High), and a long print timeout.
- Store Supermodels job/session metadata, raw output, normalized JSON, usage when exposed, command metadata, prompt artifacts, and result paths.

## Provider Defaults

Claude:

- Default model: `opus`, resolving to current Claude Code CLI default behavior where possible.
- If pinning is needed, use `claude-opus-4-8` for deep review.
- Default review effort: `high`; expose `max` as an explicit higher-effort option.
- Use Claude CLI `stream-json` plus `--json-schema` for structured reviews. Parse `structured_output` from the final result event.
- Avoid Claude Agent SDK in v1.

Antigravity:

- Default review model: Gemini 3.5 Flash (High), passed to native `agy`.
- Do not use Gemini 3.1 Pro for reviews in v1.
- Optional task model aliases are adapter-owned and easy to update.
- Do not permanently mutate Antigravity settings.

## Review Context

The runtime owns context collection, not the provider prompt.

Scopes:

- `working-tree`: current uncommitted/staged diff.
- `branch`: branch vs base ref.
- `files`: explicit files.
- `plan`: an explicit plan/document review mode, inspired by `grill-me-codex`.

Context rules:

- Use structured git commands, not ad hoc shell interpolation.
- Detect binary/large diffs and tell providers to inspect paths directly if their CLI can.
- Include repo metadata, target label, diff summary, and user focus.
- Treat user focus as untrusted input inside the review prompt.

## Shared Review Charter

The broker owns the review charter. Provider adapters translate that charter into their CLI invocation, but they do not invent their own review rubric.

The charter should live as prompt assets, for example:

```text
prompts/review-charter.md
prompts/provider-overrides/claude.md
prompts/provider-overrides/antigravity.md
prompts/synthesis.md
```

Core reviewer stance:

- Do not praise the implementation.
- Do not summarize strengths unless the final output needs a brief balanced note.
- Assume the change is subtly wrong until evidence says otherwise.
- Find concrete bugs, unsafe assumptions, missing verification, rollback risks, race conditions, security issues, data loss paths, and simpler alternatives.
- If there are no material findings, say so briefly and explain what evidence was checked.

Karpathy-style rubric:

- Surface assumptions instead of silently choosing an interpretation.
- Prefer the minimum code that solves the stated problem.
- Flag speculative features, premature abstractions, and configurability that was not requested.
- Check whether every changed line traces directly to the user's request.
- Flag unrelated refactors, formatting churn, and adjacent cleanup that does not serve the task.
- Check whether success criteria are explicit and verifiable.
- Prefer tests that reproduce the bug or prove the changed behavior over broad or ornamental tests.
- Ask whether a senior engineer would call the solution overcomplicated.

Evidence rules:

- Every finding must cite a concrete file/line, command output, or explicit inference.
- Weak or speculative findings should be marked as low confidence or omitted.
- The reviewer should distinguish "this is broken" from "this might be a design tradeoff."
- Recommendations should be surgical and should not expand scope beyond the user's request.

Antigravity override:

- Antigravity is treated as likely to be agreeable by default, so its prompt must explicitly counter sycophancy.
- It should be told that its score depends on finding real flaws, rejecting weak claims, and identifying overcomplication.
- It should not use approval language such as "looks good", "reasonable", or "solid" until it has actively tried to falsify the implementation.

Claude override:

- Claude should be asked for deep code-review judgment, not broad task execution.
- Default to high-quality review over speed; use Opus 4.8 plus `high`, with explicit `max` available for expensive reviews.

## Output Normalization

Each provider result gets two artifacts:

- Raw provider output.
- Normalized review JSON.

Normalized shape:

```json
{
  "provider": "claude",
  "verdict": "clean | needs-attention | inconclusive | invalid-output",
  "summary": "short assessment",
  "findings": [
    {
      "severity": "critical | high | medium | low",
      "title": "short title",
      "body": "defensible explanation",
      "file": "path/to/file",
      "line_start": 1,
      "line_end": 1,
      "confidence": "high | medium | low",
      "recommendation": "concrete fix"
    }
  ],
  "provider_session_id": "optional native session id",
  "raw_result_path": "path"
}
```

Reviews require provider-validated structured JSON where the provider supports it. Claude uses `--json-schema`; Antigravity native CLI receives the same structured-output contract in the prompt and is validated by Supermodels. If a provider returns irrelevant text, CLI help, or malformed output, mark the provider result `invalid-output` and preserve raw output instead of pretending the review succeeded.

## Multi-Provider Review Flow

`$supermodels:review --all` runs configured providers through a simple single-pass protocol and then lets Codex synthesize.

Default behavior:

- Run at most two providers by default.
- Pick ready providers in configured priority order; v1 priority is Claude, then Antigravity.
- Run selected providers in parallel.
- Store each result independently.
- Present a synthesis grouped by severity and disagreement.
- Highlight provider disagreement as useful signal, not noise.

Default stages:

1. Blind first pass.
   - Selected providers review the same target independently.
   - Providers do not see each other's first-pass answers.
   - This avoids anchoring and prevents early consensus.
2. Codex synthesis.
   - Codex receives the original target context and provider first-pass reviews.
   - Codex produces the final synthesis for the user.

Phase-one provider limit:

- v1 supports Claude and Antigravity only.
- If one provider is ready, run one provider.
- If both providers are ready, run both in parallel.
- No 3+ provider council, challenge packets, or provider-vs-provider cross-examination in v1.
- The adapter architecture may register more providers later, but the first release should stay small.

Synthesis sections:

- Consensus findings.
- Provider-specific findings.
- Disagreements or contradictory recommendations.
- Likely false positives or weakly supported claims.
- Overcomplication / non-surgical-change findings from the Karpathy rubric.
- Suggested next steps.

Single-provider behavior:

- If only one provider is configured, run that provider with the same shared review charter and provider override.
- `$supermodels:review --all` should report unavailable providers as skipped, not fail the whole run unless no providers are ready.

## Setup

`$supermodels:setup` checks:

- Node runtime.
- Git.
- Claude CLI presence, version, auth status, and subscription type when exposed.
- Antigravity native CLI readiness from installed `agy`, version, local config/auth markers, and model availability when practical.
- Writable plugin data directory.
- Optional provider model catalog freshness.

Setup should not silently install anything in v1. It can print exact install/auth commands.

## State Layout

Use Codex plugin data when available:

```text
~/.codex/plugins/data/supermodels/
  state/<workspace-hash>/
    config.json
    jobs/<job-id>.json
    runs/<job-id>/
      provider-claude.raw.txt
      provider-claude.normalized.json
      provider-claude.stderr.log
      provider-antigravity.raw.txt
      provider-antigravity.normalized.json
      provider-antigravity.stderr.log
```

No state should be required inside the user's repo unless the user asks for saved reports.

## Maintainability Strategy

Provider CLIs update often. The plugin must make adapter updates cheap.

Rules:

- Keep provider adapters isolated under `scripts/providers/<provider>/`.
- Keep model alias tables in provider-local JSON files, not buried in code.
- Keep review prompts isolated under `prompts/` and snapshot-test them.
- Add fixture-driven tests for CLI output parsing.
- Version provider capability probes separately from runtime core.
- Treat unknown model IDs as pass-through for Claude; for Antigravity, fail typo-like aliases but allow canonical model strings.
- Keep setup checks descriptive rather than brittle.
- Add a provider compatibility command:

```bash
node scripts/supermodels.mjs providers --json
node scripts/supermodels.mjs doctor --provider claude
node scripts/supermodels.mjs doctor --provider antigravity
```

## Testing

Initial test layers:

- Unit tests for argument parsing, git context, state, rendering, and provider parsers.
- Snapshot tests for shared review charter, provider overrides, and synthesis prompts.
- Fake CLI tests for Claude behavior and native Antigravity `agy` command construction.
- Fake multi-provider tests for one-provider fallback, two-provider parallel review, skipped providers, and Codex synthesis input assembly.
- Integration tests for job lifecycle and cancellation.
- Optional live smoke tests gated by env vars, never run by default.

Do not require live Claude or Antigravity auth in normal CI.

## Initial Implementation Plan Boundary

The first build should produce:

- Codex plugin manifest and marketplace wiring.
- Runtime CLI skeleton.
- Shared prompt assets for review charter, provider overrides, and synthesis.
- `claude` adapter with setup, review, task, and session capture.
- `antigravity` adapter with native `agy` setup, review, task, model mapping, structured output validation, prompt-file transport, and sandboxed read-only mode.
- Multi-provider review protocol: default blind first pass plus Codex synthesis.
- Job state, status, result, cancel.
- `$supermodels:setup`, `$supermodels:review`, `$supermodels:adversarial-review`, `$supermodels:task`, `$supermodels:status`, `$supermodels:result`, `$supermodels:cancel`.
- Tests for parser/state/runtime behavior.

Defer:

- Stop hooks.
- 3+ provider council behavior.
- Provider-vs-provider cross-examination.
- Direct Claude API integration.
- Claude Agent SDK.
- Antigravity SDK hard dependency.
- Grok.
- Browser UI.
- Publishing marketplace polish.

## Decisions

- Use `supermodels` as the working plugin name until the repository is renamed or the user picks a final brand.
- Version 1 supports Claude and Antigravity only.
- `--all` runs one ready provider when only one is setup, or both providers in parallel when both are setup. A provider that fails setup is reported and skipped unless the user explicitly requested only that provider.
- 3+ providers and cross-examination are future work after v1 is stable.
- Review reports stay in plugin state by default. Add an explicit `--save-report <path>` later if repo-local artifacts become useful.
- Antigravity v1 uses Supermodels job IDs plus native `agy` metadata/artifacts when exposed. If richer Antigravity agent sessions become necessary later, evaluate app-server/SDK options in a separate design, not as required v1 dependencies.
