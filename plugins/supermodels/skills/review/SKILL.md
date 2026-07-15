---
name: review
description: Get an independent, blind code review of the current changes from a different model — Claude Code, Antigravity, and/or Grok Build — through Supermodels, instead of trusting one model (or the same session that wrote the code) to grade its own diff. Every ready provider reviews the working tree in parallel without seeing the others' answers; findings come back attributed and verified against real file/line evidence. Use when the user wants a second opinion, a fresh pair of eyes, a pre-commit sanity check, or to review committed work against a base branch (--base). For a stricter pass where the models attack each other's findings use adversarial-review; for a single scoped investigation rather than a diff review use task.
---

# Supermodels Review

This skill is invoked as `supermodels:review` or `$supermodels:review`. `$supermodels review` is plain text and will not select this skill.

Resolve the plugin root as the directory two levels above this `SKILL.md`. Keep the shell working directory at the user's current workspace.

Default review runs should use live mode:

```bash
node "$PLUGIN_ROOT/scripts/supermodels.mjs" review --live -- "$@"
```

Let the live command run to completion. Do not start separate `status`, `watch`, or `result` commands unless the live command exits early and explicitly tells you to inspect a job.

Keep user-facing progress updates terse and concrete. Mention provider state only when it changes materially.

Use plain provider-state wording:

- "Claude Code, Antigravity, and Grok Build are all running."
- "Claude Code and Antigravity are both running."
- "Claude Code is running."
- "Antigravity is running."
- "Grok Build is running."
- "Antigravity completed; Claude Code is still running."

Do not mention provider internals in progress updates: no auth details, session IDs, implementation details, internal rationale, or skill-compliance narration. Do not describe review focus text in progress updates.

Default behavior uses all ready v1 providers. Use `--provider claude`, `--provider antigravity`, `--provider grok`, or `--all` to steer provider selection. Pass any remaining text as review focus.

Normal review is a blind independent first-pass workflow. Claude Code, Antigravity, and Grok Build do not see each other's output in this mode; Codex synthesizes attributed provider results after they finish. Do not describe `$supermodels:review` as a provider debate or cross-challenge.

If the user invokes bare `$supermodels:review` with no arguments, run exactly the live review command with no trailing focus text. Do not synthesize focus from prior conversation, previous review findings, build notes, validation history, or your own assumptions. Only pass focus text that the user explicitly supplied after the skill invocation. Do not announce that the invocation is bare or that no focus text was added.

If the user explicitly asks to review current-session context, a recent plan, a just-completed implementation that may already be committed, or other non-git background, create a concise private review brief file containing only the relevant factual context from the current request/session and pass it with `--context-file <path>`. Include useful facts Codex already learned from local inspection or tools when they are relevant, but do not require providers to have those tools. Keep the positional focus short. Do not use this for bare invocations.

The runtime compiles the focus, context brief, provider plan, and repository evidence into a persisted context packet and gives that same packet to each selected provider.

Do not answer from prior context or summarize the plugin build. Run the runtime and then synthesize findings for the user. Lead with concrete bugs and risks; do not treat provider praise as evidence.

Preserve provider attribution in the final summary. Call out whether each material finding came from Claude Code, Antigravity, Grok Build, or more than one. Do not flatten provider-specific findings into anonymous feedback. If you merge duplicate findings, name the contributing providers. Keep weak or disconfirmed provider-specific claims separate from validated findings.
