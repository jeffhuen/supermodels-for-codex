---
name: task
description: Delegate a bounded investigation or task to Claude Code or Antigravity through Supermodels.
---

# Supermodels Task

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" task "$@"
```

Use `--provider claude` or `--provider antigravity` for write-capable tasks. The runtime refuses multi-provider `--write` in v1 to avoid concurrent edits.

Relay provider session IDs and artifact paths when the run completes.
