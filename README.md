# Supermodels for Codex

Supermodels is a Codex plugin that lets Codex call external coding agents for independent code review and task delegation.

Version 1 supports:

- Claude Code through the installed `claude` CLI.
- Google Antigravity through the installed `agy` CLI.

The plugin acts as a broker. Codex remains the primary agent in the user conversation, while provider CLIs run locally, preserve their own auth/session behavior, and return attributed results for Codex to validate and synthesize.

## Why

Strong models still miss issues. Asking a second or third coding agent to review the same working tree can surface different assumptions, stale context, integration risks, and test gaps.

Supermodels is designed for that workflow:

- Run provider reviews from inside Codex.
- Keep provider feedback attributed to Claude Code or Antigravity.
- Preserve raw provider artifacts for inspection.
- Use native local CLIs instead of embedding provider API keys.
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
| `$supermodels:cancel` | Cancel a Supermodels background worker job. |

The runtime can also be called directly from the installed plugin cache or from `plugins/supermodels` during development:

```bash
node scripts/supermodels.mjs review --live
node scripts/supermodels.mjs adversarial-review --live
node scripts/supermodels.mjs task --provider claude "Investigate the failing test"
node scripts/supermodels.mjs status
```

## Provider Behavior

### Claude Code

Claude Code runs through the installed `claude` CLI. Review and read-only task paths use constrained permissions. Write tasks are only allowed when explicitly requested with `--write`, and v1 refuses multi-provider write tasks.

### Antigravity

Antigravity runs through the installed `agy` CLI. Review mode defaults to Gemini 3.5 Flash High through Antigravity's model naming. Read-only paths use sandboxed execution where supported by the CLI.

## Job State and Artifacts

Supermodels stores job state outside the repository under the Codex plugin data directory, normally:

```text
~/.codex/plugins/data/supermodels
```

Each run stores:

- Job metadata and provider progress.
- Prompt artifacts.
- Raw provider output.
- Normalized provider results.
- Provider stderr logs.

These artifacts are useful for debugging provider behavior and validating final review summaries.

Background cancellation is worker-scoped in v1. Supermodels owns the worker process and the direct provider child process it starts for the duration of a job. It records provider session IDs and artifacts when the CLIs expose them, but it does not claim provider-native interrupt or durable provider session ownership.

## Data and Privacy

Supermodels shells out to local provider CLIs. It does not embed provider API keys, OAuth client secrets, or provider account credentials.

Provider CLIs may use their own local auth files, sessions, telemetry, and data storage. Review Claude Code and Antigravity settings for provider-specific behavior.

## Current Scope

Version 1 intentionally supports only:

- Claude Code
- Google Antigravity

The runtime caps provider orchestration at two providers. Support for additional agents can be added later, but the current implementation prioritizes a maintainable two-provider review workflow.

Supermodels deliberately stays a broker rather than a durable process manager for provider runtimes. Claude Code and Antigravity own their own auth, session storage, model behavior, and deeper interruption semantics.

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
python3 /Users/jeffhuen/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/supermodels
```

For local development builds only, update the plugin cachebuster before reinstalling from a local marketplace:

```bash
python3 /Users/jeffhuen/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py plugins/supermodels
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
docs/                                  Design notes and implementation plans
```

## License

MIT. See [LICENSE](./LICENSE).
