---
name: cancel
description: Stop a queued or running Supermodels background job for the current workspace. Use when the user wants to abort a review or task that's in progress or waiting — e.g. it's taking too long, was started by mistake, or is no longer needed. To see which jobs are running before cancelling, use status.
---

# Supermodels Cancel

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" cancel "$@"
```

Requires a job ID. The runtime marks the job cancelled and signals the Supermodels background worker when available. Provider CLIs keep ownership of their own native sessions.
