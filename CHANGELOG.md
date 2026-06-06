# Changelog

## v0.1.0

Initial public release.

### Added

- Codex plugin package for Claude Code and Google Antigravity reviews.
- Skills for setup, providers, review, adversarial review, task, status, result, and cancel.
- Native CLI adapters for `claude` and `agy`.
- Live review mode with provider progress, persisted job state, and attributed provider output.
- Structured review parsing, provider artifact preservation, and synthesis with provider attribution.
- Read-only review/task defaults and explicit `--write` handling for bounded task delegation.
- Job state locking, stale lock recovery, terminal job handling, and worker-scoped cancellation.
- Private state/run artifacts and Antigravity prompt artifacts using `0700` directories and `0600` files.
- Background cancel transitions queued/running jobs to cancelled and signals the Supermodels worker when available.
- Active workers and foreground/live runs forward `SIGINT`/`SIGTERM` to the current direct provider child and escalate to `SIGKILL` when it ignores graceful termination.
- Already-terminal jobs, including already-cancelled jobs, are treated as no-ops and are not signaled again.
- Centralized worker cancellation lifecycle handling, with contract tests plus process-level signal regression coverage.

### Scope

- v1 supports exactly two providers: Claude Code and Google Antigravity.
- Reviews run one ready provider if only one is configured, or both providers in parallel when both are ready.
- Provider CLIs keep their own auth/session behavior; Supermodels does not embed provider API keys or OAuth secrets.

### Known Limitations

- Additional providers are intentionally out of scope for `0.1.0`.
