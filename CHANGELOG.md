# Changelog

## v0.1.0

Initial public release.

### Added

- Codex plugin package for Claude Code and Google Antigravity reviews.
- Skills for setup, providers, review, adversarial review, task, status, result, and cancel.
- Direct review transports for Claude Code OAuth and AGY/Code Assist OAuth, plus native CLI adapters for task delegation.
- Deterministic preloaded review context for Claude Code and Antigravity reviews, including diff, changed files, and bounded snippets from changed files.
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
- Review/task runs check only the requested providers, so an unavailable unrequested provider cannot block a single-provider run.
- Antigravity readiness on macOS prefers the native Keychain token store over stale default token files, while explicit/fake `HOME` credential paths remain hermetic.
- Claude Code OAuth review rate limits are surfaced as provider `rate-limited` results instead of invalid structured output.
- Antigravity rejected-token `401` responses force direct OAuth refresh before retrying the request.
- Claude Code direct reviews prepend the official Claude Code system identity block before Supermodels review instructions.
- Claude Code direct reviews emit Anthropic-compatible `tool_result` blocks without provider-internal helper fields.
- Claude Code credential loading accepts the hex-encoded macOS Keychain payload used by current Claude Code secure storage.
- Claude Code token refresh writes macOS Keychain payloads back in the same hex-encoded form.
- Claude Code readiness now validates the same direct OAuth credentials used by review transport, so stale CLI auth cannot fail mid-review.
- Antigravity OAuth refresh now matches the AGY/TradingAgents credential flow: expired local CLI tokens are refreshed directly through Google's token endpoint and persisted back to the same Keychain or token file.
- Antigravity direct reviews default to Gemini 3.5 Flash High (`gemini-3-flash-preview`) instead of Pro, matching the provider alias table and avoiding avoidable Code Assist Pro quota spikes.
- Antigravity Code Assist tool-call `thoughtSignature` values are preserved across model/tool turns, matching the TradingAgents transport and avoiding missing-signature request rejection.
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
