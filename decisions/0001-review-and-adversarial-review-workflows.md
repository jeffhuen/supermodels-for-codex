# Decision: Review And Adversarial Review Workflows

## Status

Accepted.

## Context

Supermodels has two review commands that should not collapse into the same behavior:

- `review` should provide independent provider signal without provider-to-provider influence.
- `adversarial-review` should provide a deeper challenge workflow when Claude Code and Antigravity are both available.

Earlier versions treated adversarial review mostly as a stronger prompt. That made it too close to normal review and left the deeper critique burden on Codex synthesis alone.

## Decision

`$supermodels:review` runs a blind independent first pass from each selected provider, then Codex synthesizes attributed results. Providers do not see each other's output in this mode.

`$supermodels:adversarial-review` runs the same blind independent first pass first. If at least two providers return usable structured output, each provider then receives its own first-pass review plus the other provider's review and must challenge the peer review for false positives, missed issues, weak evidence, understated severity, and overcomplication. Codex synthesizes both the first-pass findings and cross-challenge results.

If fewer than two providers return usable structured first-pass output, adversarial review skips cross-challenge and records that limitation in synthesis.

## Consequences

- Normal review remains fast, independent, and easy to interpret.
- Adversarial review is intentionally heavier and may take longer because it runs a second provider phase.
- Provider attribution must be preserved for both first-pass and challenge-pass output.
- The workflow uses the existing provider review agents and read-only repository tools. It does not introduce Bull/Bear personas or a separate app server.
