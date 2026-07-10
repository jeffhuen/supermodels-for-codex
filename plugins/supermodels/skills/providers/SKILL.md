---
name: providers
description: Show which Supermodels review providers are ready right now — Claude Code and Antigravity — including install and auth state, so the user knows whether reviews will run on one model or the full panel. Use when the user asks which models or providers are available, whether both are logged in, or why a review only used one provider. For a fuller readiness check that also covers Node, Git, and data paths, use setup.
---

# Supermodels Providers

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" providers "$@"
```

Use this before reviews when provider readiness is uncertain.
