---
name: cancel
description: Cancel a Supermodels background job for the current workspace.
---

# Supermodels Cancel

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" cancel "$@"
```

Requires a job ID. The runtime marks the job cancelled and sends SIGTERM to the tracked background process when available.
