# Supermodels for Codex

Supermodels is a Codex plugin that lets Codex ask local external coding agents for independent review and task delegation.

Version 1 supports:

- Claude Code through the installed `claude` CLI.
- Google Antigravity through the installed `agy` CLI.

The plugin is a broker. Codex owns the user conversation and final synthesis; Claude Code and Antigravity produce attributed provider results from their native local runtimes.

## Commands

- `supermodels:setup` checks local provider readiness.
- `supermodels:providers` shows provider status.
- `supermodels:review` runs a normal working-tree review.
- `supermodels:adversarial-review` runs a stricter adversarial review.
- `supermodels:task` delegates a focused task to one provider.
- `supermodels:status`, `supermodels:result`, and `supermodels:cancel` manage background jobs.

## Setup

Install and authenticate the provider CLIs you want to use:

```bash
claude auth login
agy
```

Then run:

```bash
node scripts/supermodels.mjs setup
```

At least one provider must be ready. If both are ready, review commands ask both providers in parallel.

## Data and Privacy

Supermodels shells out to local provider CLIs. It does not embed provider API keys or OAuth secrets.

Job state, prompt artifacts, raw provider output, normalized results, and provider logs are written under the Codex plugin data directory, normally:

```text
~/.codex/plugins/data/supermodels
```

Provider CLIs may use their own local auth, session, telemetry, and data storage. Review the Claude Code and Antigravity CLI settings for those behaviors.

## Development

Run the test suite:

```bash
node --test tests/*.test.mjs
```

Validate the plugin:

```bash
python3 /Users/jeffhuen/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

During local iteration, update the manifest cachebuster and reinstall from the repo marketplace:

```bash
python3 /Users/jeffhuen/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py .
codex plugin add supermodels@supermodels-local
```

## License

MIT
