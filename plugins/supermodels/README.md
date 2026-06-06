# Supermodels

Supermodels is a Codex plugin that lets Codex call Claude Code and Google Antigravity for independent review and task delegation.

This directory contains the plugin package. For full installation and usage documentation, see the repository [README](../../README.md).

## Commands

Codex skills:

- `$supermodels:setup`
- `$supermodels:providers`
- `$supermodels:review`
- `$supermodels:adversarial-review`
- `$supermodels:task`
- `$supermodels:status`
- `$supermodels:result`
- `$supermodels:cancel`

Runtime CLI during development:

```bash
node scripts/supermodels.mjs setup
node scripts/supermodels.mjs providers
node scripts/supermodels.mjs review --live
node scripts/supermodels.mjs adversarial-review --live
node scripts/supermodels.mjs task --provider claude "Investigate the failing test"
node scripts/supermodels.mjs status
```

## Provider Requirements

Install and authenticate at least one provider CLI:

```bash
claude auth login
agy
```

If both providers are ready, reviews run both in parallel. If only one provider is ready, reviews use the available provider.

## Data

Job state and provider artifacts are stored outside the repository under the Codex plugin data directory, normally:

```text
~/.codex/plugins/data/supermodels
```

The plugin does not embed provider API keys, provider account credentials, or AGY OAuth client metadata. Reviews reuse local Claude Code and AGY OAuth credentials. Claude tokens refresh through Claude Code's OAuth store; AGY token refresh is delegated to the native `agy` CLI and then reread from the native token store. Direct reviews preload bounded diff, changed-file, and file-snippet context before the first provider call. Antigravity review calls use the reference transport pacing defaults and can be tuned with `SUPERMODELS_ANTIGRAVITY_RPM` and `SUPERMODELS_ANTIGRAVITY_BURST`.

All review and task execution modes run through a dedicated Supermodels worker process. Foreground and live commands wait on that worker, while background commands return the job id immediately. Review cancellation aborts in-process provider HTTP requests through the shared run controller. Task cancellation forwards termination to the provider CLI child process when one is running.

Antigravity write tasks use the installed `agy` CLI's native default write behavior. Use `--write --provider antigravity` only when that native CLI permission model is acceptable.

## Development

Run tests from this directory:

```bash
npm test
```

Or from the repository root:

```bash
node --test plugins/supermodels/tests/*.test.mjs
```

Validate the plugin from the repository root:

```bash
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/supermodels
```

For local development builds only, update the manifest cachebuster before reinstalling from a local marketplace:

```bash
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" plugins/supermodels
```

Release builds should use a plain SemVer manifest version such as `0.1.0`.

## License

MIT.
