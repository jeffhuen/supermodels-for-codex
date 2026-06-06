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

The plugin does not embed provider API keys or OAuth secrets. Provider CLIs use their own local auth and session storage.

All review and task execution modes run through a dedicated Supermodels worker process. Foreground and live commands wait on that worker, while background commands return the job id immediately. Cancellation is worker-scoped in v1. The worker forwards termination to the direct provider child process it starts, but the plugin does not claim provider-native interrupt or durable provider session ownership.

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
