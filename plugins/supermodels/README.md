# Supermodels

Supermodels is a Codex plugin that lets Codex call Claude Code, Google Antigravity, and Grok Build for independent review and task delegation.

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
grok login
```

If multiple providers are ready, reviews run all of them in parallel. If only one provider is ready, reviews use the available provider.

`$supermodels:review` runs blind independent first-pass reviews and then synthesizes attributed results. Providers do not see each other's output in normal review mode.

`$supermodels:adversarial-review` runs the same blind first pass first. When at least two providers return usable structured output, each provider then challenges the peer review(s) before synthesis. If only one usable provider output is available, Supermodels skips cross-challenge and records that limitation.

Review and task context can come from git or from an explicit brief. Use `--base <ref>` for committed changes and `--context-file <path>` or `--context <text>` for non-git background such as a recent planning discussion, implementation summary, or session transcript. Supermodels compiles this into a shared context packet that is persisted with the job and supplied to each selected provider.

## Data

Job state and provider artifacts are stored outside the repository under the Codex plugin data directory, normally:

```text
~/.codex/plugins/data/supermodels
```

The plugin does not embed provider API keys or provider account credentials. Reviews reuse local Claude Code, AGY, and Grok OAuth credentials. Claude tokens refresh through Claude Code's OAuth store; Claude subscription/API rate limits are surfaced as provider `rate-limited` results. AGY token refresh uses the same direct OAuth refresh flow as AGY-compatible clients and persists back to the native token store, including rejected-token `401` retries. Grok tokens refresh through the same OIDC flow `grok login` uses (`POST {issuer}/oauth2/token`) and persist back to `~/.grok/auth.json`. Direct reviews receive a shared context packet plus bounded diff, changed-file, and file-snippet context before the first provider call, but providers still must make distinct meaningful `read_file` or `search` inspections before final review submission. Antigravity review calls default to Gemini 3.5 Flash High (`gemini-3-flash-preview`) and remain model-led after the evidence gate, with aggregate timeout and cancellation as runaway guards. Code Assist calls use the reference transport pacing defaults and can be tuned with `SUPERMODELS_ANTIGRAVITY_CODE_ASSIST_MODEL`, `SUPERMODELS_ANTIGRAVITY_RPM`, and `SUPERMODELS_ANTIGRAVITY_BURST`. Grok reviews go over a direct OAuth transport to xAI's documented CLI chat proxy (`cli-chat-proxy.grok.com`), default to `grok-4.5` at `high` reasoning effort, and get the most generous review byte budget on the panel; an HTTP 426 from the proxy surfaces as an explicit `grok update` error instead of a generic failure. Grok defaults can be tuned with `SUPERMODELS_GROK_MODEL`, `SUPERMODELS_GROK_EFFORT`, `SUPERMODELS_GROK_AUTH_PATH`, and `SUPERMODELS_GROK_RESPONSES_URL`.

All review and task execution modes run through a dedicated Supermodels worker process. Foreground and live commands wait on that worker, while background commands return the job id immediately. Review cancellation aborts in-process provider HTTP requests through the shared run controller. Task cancellation forwards termination to the provider CLI child process when one is running.

Antigravity write tasks use the installed `agy` CLI's native default write behavior. Use `--write --provider antigravity` only when that native CLI permission model is acceptable. Grok tasks run over ACP (`grok agent stdio`) by default; read-only tasks are enforced by Supermodels' own permission broker (write options are denied before the provider can act), `--write --provider grok` tasks are approved per sanctioned edit at that same broker, and the `GROK_SANDBOX` (`read-only`/`workspace`) environment variable is set as an OS-level backstop underneath. `--best-of-n <N>` and `--check` are Grok-exclusive one-shot task modes that run over headless `grok -p` instead of ACP. `--check` is experimental: current Grok CLI releases (0.2.x) can end a `--check` run as `Cancelled` and drop the final answer (verified live), so Supermodels never appends it automatically and only passes it through on explicit request.

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
