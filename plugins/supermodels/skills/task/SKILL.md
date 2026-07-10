---
name: task
description: Delegate one bounded investigation or job to a single provider — Claude Code or Antigravity — through Supermodels, using its native CLI. Read-only by default (investigate, diagnose, explain, draft a plan); it edits files only when the user explicitly passes --write. Use when the user wants to hand a scoped task to another model — e.g. "figure out why auth.test.mjs flakes", "investigate this stack trace", "have Claude draft this refactor", "get a second model to look into X". This is for a single focused task, not a review of changes: to review a diff use review or adversarial-review.
---

# Supermodels Task

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" task "$@"
```

If the task depends on current-session context, a recent plan, a conversation transcript, or other non-git background, create a concise private context brief file containing only the relevant factual context and pass it with `--context-file <path>`. Include useful facts Codex already learned from local inspection or tools when they are relevant, but do not require providers to have those tools. Keep the positional task text focused on the requested work.

The runtime compiles the task, context brief, provider plan, write mode, and repository evidence into a persisted context packet before calling the provider.

Use `--provider claude` or `--provider antigravity` for write-capable tasks. The runtime refuses multi-provider `--write` in v1 to avoid concurrent edits.

Relay attributed provider output and artifact paths when the run completes. Include native provider session IDs only when the CLI exposes them.
