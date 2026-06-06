# Supermodels for Codex

Supermodels is a Codex plugin that lets Codex call external coding agents for independent code review and task delegation.

Version 1 supports:

- Claude Code reviews through Claude Code OAuth-backed Messages transport; task delegation through the installed `claude` CLI.
- Google Antigravity reviews through AGY/Code Assist OAuth-backed function calling; task delegation through the installed `agy` CLI.

The plugin acts as a broker. Codex remains the primary agent in the user conversation, while Supermodels owns the review tool loop and provider auth is reused from local Claude Code and AGY installations.

## Why

Strong models still miss issues. Asking a second or third coding agent to review the same working tree can surface different assumptions, stale context, integration risks, and test gaps.

Supermodels is designed for that workflow:

- Run provider reviews from inside Codex.
- Keep provider feedback attributed to Claude Code or Antigravity.
- Preserve raw provider artifacts for inspection.
- Reuse local provider auth instead of embedding provider API keys.
- Support long-running reviews with job state, live progress, status, result, and cancel commands.

## Installation

Add this repository as a Codex plugin marketplace. The stable release channel is pinned to `v0.1.0`:

```bash
codex plugin marketplace add jeffhuen/supermodels-for-codex --ref v0.1.0
```

For development builds from `main`:

```bash
codex plugin marketplace add jeffhuen/supermodels-for-codex --ref main
```

Install the plugin:

```bash
codex plugin add supermodels@supermodels
```

To reinstall from the configured marketplace:

```bash
codex plugin add supermodels@supermodels
```

After installing or upgrading, start a fresh Codex session so updated skills and runtime files are loaded.

## Setup

Install and authenticate at least one provider CLI.

Claude Code:

```bash
claude auth login
```

Antigravity:

```bash
agy
```

Then run the setup skill in Codex:

```text
$supermodels:setup
```

At least one provider must be ready. If both Claude Code and Antigravity are ready, review commands ask both providers in parallel. If only one is ready, Supermodels uses the available provider.

## Commands

Use the plugin skills from Codex:

| Skill | Purpose |
| --- | --- |
| `$supermodels:setup` | Check Node, Git, provider CLI installation, auth state, and plugin data paths. |
| `$supermodels:providers` | Show Claude Code and Antigravity readiness. |
| `$supermodels:review` | Run a normal working-tree review with all ready providers. |
| `$supermodels:adversarial-review` | Run a stricter review focused on bugs, false assumptions, overcomplication, and missing verification. |
| `$supermodels:task` | Delegate a bounded task to one provider. |
| `$supermodels:status` | List jobs or inspect a specific job. |
| `$supermodels:result` | Read a completed job and artifact paths. |
| `$supermodels:cancel` | Cancel a queued or running Supermodels worker job. |

The runtime can also be called directly from the installed plugin cache or from `plugins/supermodels` during development:

```bash
node scripts/supermodels.mjs review --live
node scripts/supermodels.mjs adversarial-review --live
node scripts/supermodels.mjs task --provider claude "Investigate the failing test"
node scripts/supermodels.mjs status
```

## Provider Behavior

### Claude Code

Claude Code reviews use Claude Code OAuth credentials with Anthropic's Messages transport and Supermodels-owned read-only repository tools. Supermodels preloads bounded review context before the first model call, including the diff, changed files, and snippets from changed files, then Claude may request additional tools. Claude subscription/API rate limits are surfaced as provider `rate-limited` results so other provider output is preserved. Task paths use the installed `claude` CLI with constrained permissions. Write tasks are only allowed when explicitly requested with `--write`, and v1 refuses multi-provider write tasks.

### Antigravity

Antigravity reviews use the AGY/Code Assist OAuth credential store and Gemini-style function calling with the same Supermodels-owned read-only repository tools. Supermodels preloads bounded review context before the first Code Assist call, including the diff, changed files, and snippets from changed files, then AGY may request additional read-only tools. Direct review mode defaults to `gemini-2.5-pro`; native `agy` model aliases are still used for task delegation. Code Assist calls use the reference transport pacing defaults and can be tuned with `SUPERMODELS_ANTIGRAVITY_RPM` and `SUPERMODELS_ANTIGRAVITY_BURST`. Rejected-token `401` responses force native AGY refresh before retrying, and macOS keychain read failures do not silently fall back to stale default token files.

Antigravity write tasks use the installed `agy` CLI's native default write behavior. The current `agy` CLI exposes a read-only `--sandbox` mode and a broad `--dangerously-skip-permissions` mode, but not a Claude-style edit allow-list. Use `--write --provider antigravity` only when that native CLI permission model is acceptable.

## Job State and Artifacts

Supermodels stores job state outside the repository under the Codex plugin data directory, normally:

```text
~/.codex/plugins/data/supermodels
```

Each run stores:

- Job metadata and provider progress.
- Prompt/context artifacts when generated.
- Raw provider output.
- Normalized provider results.
- Provider stderr logs.

These artifacts are useful for debugging provider behavior and validating final review summaries.

All review and task execution modes run through a dedicated Supermodels worker process. Foreground and live commands wait on that worker, while background commands return the job id immediately. Review cancellation aborts in-process provider HTTP requests through the shared run controller. Task cancellation is worker-scoped and forwards termination to the provider CLI child process when one is running.

## Data and Privacy

Supermodels does not embed provider API keys, provider account credentials, or AGY OAuth client metadata. Reviews reuse local Claude Code and AGY OAuth credentials. Claude tokens refresh through Claude Code's OAuth store; AGY token refresh is delegated to the native `agy` CLI and then reread from the native token store.

Provider CLIs may use their own local auth files, sessions, telemetry, and data storage. Review Claude Code and Antigravity settings for provider-specific behavior.

## Current Scope

Version 1 intentionally supports only:

- Claude Code
- Google Antigravity

The runtime caps provider orchestration at two providers. Support for additional agents can be added later, but the current implementation prioritizes a maintainable two-provider review workflow.

Supermodels deliberately stays a broker rather than a durable process manager for provider runtimes. Claude Code and Antigravity own their own auth, session storage, and model behavior.

## Development

Run tests:

```bash
cd plugins/supermodels
npm test
```

From the repository root:

```bash
node --test plugins/supermodels/tests/*.test.mjs
```

Validate the plugin:

```bash
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/supermodels
```

For local development builds only, update the plugin cachebuster before reinstalling from a local marketplace:

```bash
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" plugins/supermodels
```

Then reinstall from the configured marketplace:

```bash
codex plugin add supermodels@supermodels
```

## Versioning

Release versions use normal SemVer. The first public release is:

```text
0.1.0
```

During active local development, the plugin manifest may temporarily use a Codex cachebuster suffix:

```text
0.1.0+codex.YYYYMMDDHHMMSS
```

This forces Codex to install a fresh plugin copy while iterating. Remove the cachebuster before tagging a release.

## Repository Layout

```text
.agents/plugins/marketplace.json       Codex marketplace entry
plugins/supermodels/.codex-plugin/     Plugin manifest
plugins/supermodels/skills/            Codex skills
plugins/supermodels/scripts/           Runtime CLI and provider adapters
plugins/supermodels/prompts/           Shared review prompts
plugins/supermodels/tests/             Node test suite
```

## License

MIT. See [LICENSE](./LICENSE).
