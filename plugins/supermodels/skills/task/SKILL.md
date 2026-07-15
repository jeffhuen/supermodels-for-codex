---
name: task
description: Delegate one bounded investigation or job to a single provider — Claude Code, Antigravity, or Grok Build — through Supermodels, using its native CLI. Read-only by default (investigate, diagnose, explain, draft a plan); it edits files only when the user explicitly passes --write. Use when the user wants to hand a scoped task to another model — e.g. "figure out why auth.test.mjs flakes", "investigate this stack trace", "have Claude draft this refactor", "get a second model to look into X". This is for a single focused task, not a review of changes — to review a diff use review or adversarial-review.
---

# Supermodels Task

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace, then run:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" task "$@"
```

If the task depends on current-session context, a recent plan, a conversation transcript, or other non-git background, create a concise private context brief file containing only the relevant factual context and pass it with `--context-file <path>`. Include useful facts Codex already learned from local inspection or tools when they are relevant, but do not require providers to have those tools. Keep the positional task text focused on the requested work.

The runtime compiles the task, context brief, provider plan, write mode, and repository evidence into a persisted context packet before calling the provider.

Use `--provider claude`, `--provider antigravity`, or `--provider grok` for write-capable tasks. The runtime refuses multi-provider `--write` in v1 to avoid concurrent edits.

Grok tasks run over ACP (`grok agent stdio`) by default, with full tool-call streaming. Read-only Grok tasks are enforced by Supermodels' own permission broker — write attempts are denied at the broker, not just discouraged by the `grok` CLI's own prompts. `--write --provider grok` tasks are approved per sanctioned edit at that same broker, backed by an OS-level `GROK_SANDBOX` workspace sandbox as a backstop.

Grok also supports one-shot modes no other provider has, run through headless `grok -p` instead of ACP: `--best-of-n <N>` runs N attempts and keeps the best one, and `--check` asks Grok to self-verify its output before returning.

Relay attributed provider output and artifact paths when the run completes. Include native provider session IDs only when the CLI exposes them.
