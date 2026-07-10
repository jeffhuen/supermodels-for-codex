---
name: adversarial-review
description: Get a stricter, adversarial code review through Supermodels: Claude Code and Antigravity each do a blind first pass, then challenge each other's findings — attacking unsupported claims, missed bugs, weak evidence, wrong severities, and over-engineered fixes — so only findings that survive cross-examination are reported. Use when the user wants to pressure-test or red-team a change, is about to ship something risky, distrusts an earlier review, or asks to "tear it apart" or find everything wrong with a diff. Best with both providers ready so they can actually cross-examine. For a plain independent review use review; for a single scoped investigation use task.
---

# Supermodels Adversarial Review

This skill is invoked as `supermodels:adversarial-review` or `$supermodels:adversarial-review`.

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace.

Default adversarial reviews should use live mode:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" adversarial-review --live -- "$@"
```

Let the live command run to completion. Do not start separate `status`, `watch`, or `result` commands unless the live command exits early and explicitly tells you to inspect a job.

Keep user-facing progress updates terse and concrete. Mention provider state only when it changes materially.

Use plain provider-state wording:

- "Claude Code and Antigravity are both running."
- "Claude Code is running."
- "Antigravity is running."
- "Antigravity completed; Claude Code is still running."

Do not mention provider internals in progress updates: no auth details, session IDs, implementation details, internal rationale, or skill-compliance narration. Do not describe review focus text in progress updates.

Default behavior uses all ready v1 providers. Pass focus text after flags, for example `focus on auth, data loss, and rollback`.

Adversarial review is a two-phase workflow when at least two providers return usable structured output. Providers first run blind independent reviews. Then each provider receives its own first-pass output plus the peer output and challenges unsupported claims, missed bugs, weak evidence, severity mistakes, and overcomplicated recommendations. If fewer than two usable outputs are available, the runtime skips the cross-challenge phase and records that limitation.

If the user invokes bare `$supermodels:adversarial-review` with no arguments, run exactly the live review command with no trailing focus text. Do not synthesize focus from prior conversation, previous review findings, build notes, validation history, or your own assumptions. Only pass focus text that the user explicitly supplied after the skill invocation. Do not announce that the invocation is bare or that no focus text was added.

If the user explicitly asks to adversarially review current-session context, a recent plan, a just-completed implementation that may already be committed, or other non-git background, create a concise private review brief file containing only the relevant factual context from the current request/session and pass it with `--context-file <path>`. Include useful facts Codex already learned from local inspection or tools when they are relevant, but do not require providers to have those tools. Keep the positional focus short. Do not use this for bare invocations.

The runtime compiles the focus, context brief, provider plan, repository evidence, and cross-challenge task into a persisted context packet and gives that same packet to each selected provider.

Do not answer from prior context or summarize the plugin build. Run the runtime and then synthesize provider results critically. Keep false positives and weakly supported claims separate from material findings.

Preserve provider attribution in the final summary. Call out whether each material finding came from Claude Code, Antigravity, or both. Do not flatten provider-specific findings into anonymous feedback. If you merge duplicate findings, name the contributing providers. Keep weak or disconfirmed provider-specific claims separate from validated findings.
