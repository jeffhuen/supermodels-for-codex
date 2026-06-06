---
name: result
description: Read a completed Supermodels job result and provider artifacts.
---

# Supermodels Result

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" result "$@"
```

Requires a job ID. Include raw and normalized artifact paths when reporting results.
