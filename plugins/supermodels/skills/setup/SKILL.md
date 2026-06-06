---
name: setup
description: Check Supermodels runtime readiness, provider CLI installation, auth state, git, and data directory paths.
---

# Supermodels Setup

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" setup "$@"
```

Use `--json` when structured output will help. Report provider readiness plainly and include install/auth hints from the runtime output.

Setup is the readiness gate for this plugin. It checks Claude Code through the installed `claude` CLI and checks Antigravity through the installed `agy` CLI plus local Antigravity/Gemini auth. Do not invent or print auth values in the conversation.
