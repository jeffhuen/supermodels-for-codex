---
name: adversarial-review
description: Ask Claude Code and/or Antigravity for a stricter adversarial review focused on bugs, assumptions, overcomplication, and missing verification.
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

If the user invokes bare `$supermodels:adversarial-review` with no arguments, run exactly the live review command with no trailing focus text. Do not synthesize focus from prior conversation, previous review findings, build notes, validation history, or your own assumptions. Only pass focus text that the user explicitly supplied after the skill invocation. Do not announce that the invocation is bare or that no focus text was added.

Do not answer from prior context or summarize the plugin build. Run the runtime and then synthesize provider results critically. Keep false positives and weakly supported claims separate from material findings.

Preserve provider attribution in the final summary. Call out whether each material finding came from Claude Code, Antigravity, or both. Do not flatten provider-specific findings into anonymous feedback. If you merge duplicate findings, name the contributing providers. Keep weak or disconfirmed provider-specific claims separate from validated findings.
