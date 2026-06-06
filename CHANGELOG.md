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
- Job state locking, stale lock recovery, cancellation terminality, PID identity checks, and provider process signaling.

### Scope

- v1 supports exactly two providers: Claude Code and Google Antigravity.
- Reviews run one ready provider if only one is configured, or both providers in parallel when both are ready.
- Provider CLIs keep their own auth/session behavior; Supermodels does not embed provider API keys or OAuth secrets.

### Known Limitations

- Cancellation can only signal provider processes whose PIDs have been observed by the orchestrator or recorded in job artifacts. If a provider process is spawned but its PID is never observed or persisted before interruption, that process may need manual cleanup.
- Additional providers such as Grok are intentionally out of scope for `0.1.0`.
