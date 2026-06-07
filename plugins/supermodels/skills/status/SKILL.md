---
name: status
description: Check Supermodels background jobs for the current workspace.
---

# Supermodels Status

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" status "$@"
```

Pass a job ID to inspect one job, or omit it to list recent jobs for the workspace.

When present, status output includes the context packet summary so the user can see what kind of context was handed to providers.
