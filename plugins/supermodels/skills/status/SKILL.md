---
name: status
description: List and inspect Supermodels background jobs for the current workspace — what's queued, running, or finished, with progress. Use when the user asks whether a review or task is done yet, what jobs are in flight, or to check on a run started earlier. To read the full result and saved artifacts of a finished job use result; to stop a job use cancel.
---

# Supermodels Status

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" status "$@"
```

Pass a job ID to inspect one job, or omit it to list recent jobs for the workspace.

When present, status output includes the context packet summary so the user can see what kind of context was handed to providers.
