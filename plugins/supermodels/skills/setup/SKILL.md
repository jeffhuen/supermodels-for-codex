---
name: setup
description: Check whether Supermodels is ready to run — Node and Git, all three provider CLIs (Claude Code, Antigravity, and Grok Build), their auth/login state, and the data directory paths — and report which providers are usable and why any are skipped. Use when setting up Supermodels for the first time, after installing or upgrading it, when a review fails or a provider seems unavailable, or when the user asks "is Supermodels ready" or "why isn't Antigravity working". To just list which providers are ready right now without the full health check, use providers.
---

# Supermodels Setup

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" setup "$@"
```

Use `--json` when structured output will help. Report provider readiness plainly and include install/auth hints from the runtime output.

Setup is the readiness gate for this plugin. It checks Claude Code through the installed `claude` CLI, Antigravity through the installed `agy` CLI plus local Antigravity/Gemini auth, and Grok Build through the installed `grok` CLI plus `grok login` OAuth state. Do not invent or print auth values in the conversation.
