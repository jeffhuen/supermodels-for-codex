---
name: result
description: Read a completed Supermodels job's synthesized result and the paths to its saved provider artifacts — accepted provider result, normalized findings, bounded context packet, and stderr — so the user can audit the retained receipts from each model. The ephemeral snapshot, transport stream, and multi-round tool transcript are not persisted. Use when the user wants to see the outcome of a finished review or task, re-read an earlier job's findings, or check the receipts behind a surprising result. To check whether a job is done or list jobs, use status.
---

# Supermodels Result

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" result "$@"
```

Requires a job ID. Include context packet, accepted-result (`.raw.txt` compatibility name), normalized, and stderr artifact paths when reporting results.
