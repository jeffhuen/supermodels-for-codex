# Changelog

## v0.1.0

Initial public release.

### Added

- Codex plugin package for Claude Code and Google Antigravity reviews.
- Skills for setup, providers, review, adversarial review, task, status, result, and cancel.
- Direct review transports for Claude Code OAuth and AGY/Code Assist OAuth, plus native CLI adapters for task delegation.
- Deterministic preloaded review context for Claude Code and Antigravity reviews, including diff, changed files, and bounded snippets from changed files.
- Preloaded review context is treated as orientation only; providers must still perform explicit repository inspection with `read_file` or `search` before final review submission.
- Review tools read requested line ranges with bounded streaming reads instead of loading whole files, so later line ranges and oversized single-line prefixes remain inspectable without memory spikes.
- Deleted files no longer consume changed-file snippet budget for preloaded review context.
- Invalid `--base` refs now fail explicitly before diff or changed-file collection.
- Explicit task context briefs are persisted with worker jobs and included in provider task prompts, so non-git session/planning context reaches delegated tasks.
- `--context-file` truncation is UTF-8 safe and no longer emits replacement characters for partial trailing codepoints.
- Reference-aligned Code Assist request pacing with `SUPERMODELS_ANTIGRAVITY_RPM` and `SUPERMODELS_ANTIGRAVITY_BURST` overrides.
- Live review mode with provider progress, persisted job state, and attributed provider output.
- Structured review parsing, provider artifact preservation, and synthesis with provider attribution.
- Read-only review/task defaults and explicit `--write` handling for bounded task delegation.
- Job state locking, stale lock recovery, terminal job handling, and worker-scoped cancellation.
- Private state/run artifacts and Antigravity prompt artifacts using `0700` directories and `0600` files.
- Background cancel transitions queued/running jobs to cancelled and signals the Supermodels worker when available.
- Active task workers forward `SIGINT`/`SIGTERM` to the current provider CLI child and escalate to `SIGKILL` when it ignores graceful termination; review workers abort in-process provider HTTP requests.
- Foreground/live cancellation now uses a single run controller; provider runners no longer own process-level exit timers and interrupted provider runs preserve signal metadata.
- Provider runs killed by an external signal now report failed unless the Supermodels run controller initiated cancellation.
- Already-terminal jobs, including already-cancelled jobs, are treated as no-ops and are not signaled again.
- Signal finalization preserves already-terminal jobs instead of rewriting them to cancelled.
- Centralized worker cancellation lifecycle handling, with contract tests plus process-level signal regression coverage.
- Foreground, live, and background review/task paths now all execute through the same persisted worker lifecycle instead of mixing direct CLI execution with detached background children.
- Reviews run through a shared Supermodels-owned tool loop, so Claude Code and Antigravity both inspect repository evidence with the same read-only tools before returning structured findings.
- Adversarial review now runs a provider cross-challenge phase after blind first-pass reviews when at least two usable provider outputs are available.
- The shared review loop now enforces one provider-independent completion contract: forced-submit retry margin, stronger clean-verdict evidence, and deterministic handling for mixed `submit_review`/tool-call turns.
- Review/task runs check only the requested providers, so an unavailable unrequested provider cannot block a single-provider run.
- Review commands accept explicit non-git context through `--context` and `--context-file`, and base-ref review context now works for committed changes without requiring a separate scope flag.
- Review, adversarial-review, and task runs now persist a shared context packet with user intent, explicit context, provider selection, and repository evidence; status/result expose the packet summary and artifact paths.
- Provider prompts now receive a lean context packet for orientation only, while canonical focus and diff evidence are rendered once in their dedicated prompt sections; full context packets remain persisted as private artifacts.
- Provider run records now persist direct-review audit metadata, including model, effort/thinking settings, max token budget, rounds, and repository tool usage.
- Context packet diff path parsing handles Git-quoted file paths, and prompt/context truncation is UTF-8 safe for large multibyte input.
- Git diff collection forces standard `a/`/`b/` prefixes and context packets use rename metadata, avoiding advisory changed-file path drift from local Git prefix config or ambiguous unquoted rename paths.
- Review tools reuse the shared Git-quoted path decoder, so `git status`/`git diff --name-status` paths with UTF-8 octal escapes remain readable by providers.
- Antigravity readiness on macOS prefers the native Keychain token store over stale default token files, while explicit/fake `HOME` credential paths remain hermetic.
- Claude Code OAuth review rate limits are surfaced as provider `rate-limited` results instead of invalid structured output.
- Antigravity rejected-token `401` responses force direct OAuth refresh before retrying the request.
- Claude Code direct reviews prepend the official Claude Code system identity block before Supermodels review instructions.
- Claude Code direct reviews request Opus adaptive thinking with a 128k response budget and default `xhigh` effort; explicit `--effort` overrides are still honored.
- Claude Code streamed thinking blocks are preserved across tool turns, so adaptive-thinking reviews keep the context Anthropic requires after tool use.
- Claude Code direct reviews no longer combine adaptive thinking with forced `tool_choice`; required final/inspection turns are enforced by prompt instruction instead.
- The shared review loop is not capped by a low fixed round count by default; provider timeout/cancellation now own runaway protection.
- Review provider timeouts are enforced as aggregate wall-clock budgets across the whole review loop, not just as per-request timeouts.
- The shared review loop rejects final submissions until providers have made enough distinct meaningful file/search inspections, preventing a shallow review from completing only because preloaded context or duplicate tool calls were available.
- Antigravity direct reviews remain model-led after the evidence gate by default; explicit force settings remain available only for controlled tests or overrides.
- Direct reviews now accept parseable structured final text after required evidence is satisfied, and only ask for one structured-conversion turn when a provider ends with unstructured no-tool text.
- Direct review usage is aggregated and emitted across all model turns, so multi-round Claude Code and Antigravity reviews do not look like only the final response consumed tokens.
- Mixed repository tool calls with an invalid `submit_review` now execute the repository tools before returning submit errors, so providers can satisfy evidence requirements in the same turn.
- Antigravity direct reviews request Code Assist dynamic thinking with `thinkingBudget: -1` and a 64k response budget.
- Claude Code direct reviews retry transient Anthropic overloaded stream errors instead of failing the review immediately.
- Antigravity direct reviews honor explicit short Code Assist quota reset windows beyond the fixed retry count, bounded by a retry window.
- Claude Code direct reviews emit Anthropic-compatible `tool_result` blocks without provider-internal helper fields.
- Claude Code streamed tool-call arguments prefer streamed deltas over stale block-start input, avoiding corrupted tool inputs if both shapes appear.
- Claude Code credential loading accepts the hex-encoded macOS Keychain payload used by current Claude Code secure storage.
- Claude Code token refresh writes macOS Keychain payloads back in the same hex-encoded form.
- Claude Code token refresh persists the resolved or returned OAuth scopes instead of re-saving stale empty scope metadata.
- Claude Code readiness now validates the same direct OAuth credentials used by review transport, so stale CLI auth cannot fail mid-review.
- Antigravity OAuth refresh now matches the AGY/TradingAgents credential flow: expired local CLI tokens are refreshed directly through Google's token endpoint and persisted back to the same Keychain or token file.
- Antigravity direct reviews use Gemini 3.5 Flash High (`gemini-3-flash-preview`) as the supported Code Assist review target; unsupported Pro aliases fail loudly instead of silently downgrading or routing to a stub.
- Antigravity Code Assist tool-call `thoughtSignature` values are preserved across model/tool turns, matching the TradingAgents transport and avoiding missing-signature request rejection.
- Antigravity direct reviews now use the Code Assist streaming endpoint, preserve provider function-call ids, include matching function-response ids, and synthesize the first-call thought signature only when Code Assist requires one.
- Antigravity Code Assist request histories now coalesce adjacent same-role turns before sending, matching Gemini-style role alternation expectations for preloaded context and follow-up tool results.
- Antigravity Code Assist responses now validate finality signals and reject empty stopped responses, malformed function-call stops, unexpected tool-call stops, and repeated no-tool continuation churn as review no-progress instead of silently looping.
- Antigravity normal reviews now get a post-evidence submit backstop: after the evidence gate is satisfied and four more model-led rounds pass, the loop forces `submit_review` instead of allowing unbounded additional inspection.
- Structured review acceptance now rejects empty or invalid finding locations/evidence, includes a severity rubric, verifies cited file/line ranges with read-only repository tools, and gives providers one correction turn before returning an inconclusive validation result.
- Structured review validation now rejects empty impact/recommendation fields, returns field-level correction errors, normalizes cited paths during location checks, and keeps inspection-gate nudges separate from the finding/schema correction budget.
- Structured review validation now preserves field-level errors for natural JSON final answers, rejects oversized finding ranges instead of silently truncating them, requires missing current-line findings to match deleted-line diff evidence, handles deleted-line verification for real spaced Git paths, Git octal-quoted UTF-8 paths, and truncated diffs, and stops repeated inspection-gate refusals before the aggregate provider timeout.
- Setup output now mirrors actual readiness for providers without setup hooks, avoiding contradictory provider setup/check status.
- Review failures now include provider-specific readiness reasons when no requested provider can run.
- Human review output now prints failed job errors instead of an empty synthesized review section.
- Antigravity project discovery matches the reference Code Assist behavior: non-auth discovery failures are non-fatal and onboarding polls use the reference bounds.
- Antigravity project discovery only caches non-empty project ids, so a transient project-discovery failure can be retried by later requests.
- Preloaded review context now fails explicitly when changed-file discovery fails, and unreadable snippets no longer satisfy the review inspection gate.
- macOS Antigravity keychain read failures no longer silently fall back to local token files unless a file path is explicitly configured.

### Scope

- v1 supports exactly two providers: Claude Code and Google Antigravity.
- Reviews run one ready provider if only one is configured, or both providers in parallel when both are ready.
- Provider CLIs keep their own auth/session behavior; Supermodels does not embed provider API keys or provider account credentials. AGY token refresh uses the public installed-app OAuth client metadata required by tokens minted for the Antigravity CLI.

### Known Limitations

- Additional providers are intentionally out of scope for `0.1.0`.
- Direct reviews provide the core Claude Code-style tool-call loop, but not full Claude Code harness parity. Incremental streaming, transcript replay, compaction, richer context provenance, and long-output continuation are tracked as v2 catch-up work in `decisions/0003-claude-code-harness-parity-v2.md`.
