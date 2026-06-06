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
- Provider process supervisor handshake so provider CLIs do not start until a signalable supervisor PID has been recorded.
- Private supervisor handoff files that avoid serialized env/prompt leakage and are removed after provider startup.
- Private state/run artifacts and Antigravity prompt artifacts using `0700` directories and `0600` files.
- Cancel escalation from `SIGTERM` to `SIGKILL` for provider processes that ignore graceful termination.
- Foreground/live aborts exclude the current orchestrator process, re-read job state before escalation, and verify recorded PID start signatures before `SIGKILL`.

### Scope

- v1 supports exactly two providers: Claude Code and Google Antigravity.
- Reviews run one ready provider if only one is configured, or both providers in parallel when both are ready.
- Provider CLIs keep their own auth/session behavior; Supermodels does not embed provider API keys or OAuth secrets.

### Known Limitations

- Additional providers such as Grok are intentionally out of scope for `0.1.0`.
