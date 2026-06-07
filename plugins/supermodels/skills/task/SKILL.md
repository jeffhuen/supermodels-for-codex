---
name: task
description: Delegate a bounded investigation or task to Claude Code or Antigravity through Supermodels.
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
