# Decision: Grok Build As A Third Review And Task Provider

## Status

Accepted.

## Context

Supermodels shipped v0.1.x with a hard two-provider cap: Claude Code and Google Antigravity. `decisions/0001` and `decisions/0003` both frame that cap as a deliberate v1 scope choice, not an architectural ceiling — the shared review loop, context packet, and provider-agnostic tool contract were built to add a third panel member without redesigning the harness.

Grok Build (xAI) is that third member. It carries a different constraint than the first two: subscription-only auth. There is no API key path — Supermodels reuses the OAuth credentials already written by `grok login` and never embeds or requests a Grok API key, matching the no-embedded-credentials posture Supermodels already holds for Claude Code and Antigravity.

Before committing to a transport shape, the integration was probed against three candidate surfaces: the headless one-shot CLI (`grok -p`), the Agent Client Protocol session (`grok agent stdio`), and a direct OAuth call to the same chat-proxy endpoint the `grok` CLI itself calls. Each candidate was verified against a live `grok login` session before being adopted.

## Decision

**Reviews use a direct OAuth Responses transport**, not `grok -p` and not a wrapped CLI call. This gives Grok reviews the same shape Claude Code and Antigravity reviews already have: an explicit message history, tool schemas, and reasoning settings sent directly to the provider, with Supermodels' own local read-only tool loop (`read_file`, `search`, `get_diff`) executing tool calls and feeding results back. That harness parity is what keeps blind-review integrity intact — the same citation verification, high-risk coverage ledger, and inspection gating that apply to Claude Code and Antigravity apply to Grok unchanged, instead of Grok getting a weaker or differently-shaped review contract.

**Tasks use ACP** (`grok agent stdio`) instead of headless mode, for two reasons: observability and permissions. ACP streams individual tool-call events over JSON-RPC/stdio, so task progress can show what Grok is actually doing turn by turn. Headless `-p --output-format streaming-json` only emits coarse `text`/`thought`/`end` events with no per-tool-call granularity, which was confirmed against a live run before ACP was chosen as the primary task transport. ACP also lets Supermodels enforce permissions itself: `session/request_permission` requests are intercepted by Supermodels' own broker rather than left to the `grok` CLI's own approval UI, matching how task permissions are already enforced for Claude Code. Read-only tasks bias the broker toward rejecting write options; `--write` tasks bias it toward approving the sanctioned edit option. The `GROK_SANDBOX` (`read-only` / `workspace`) environment variable rides along underneath as an OS-level sandbox backstop, not as the primary permission mechanism.

**Grok-exclusive one-shot modes use headless `grok -p`.** `--best-of-n <N>`, `--check` (self-verification), and `--json-schema` are one-shot CLI flags with no ACP or Responses-API equivalent, so they stay on the headless path as additive, Grok-only task modes rather than becoming the default transport for ordinary tasks. Live verification found that grok 0.2.101's `--check` verifier can end the turn as `Cancelled` and swallow the final answer regardless of sandbox profile or output format, so `--check` is passed through only on explicit request (never auto-appended) and is documented as experimental until fixed upstream.

## Verified Facts

- **Token store**: `~/.grok/auth.json`, an OIDC credential envelope (`key`, `refresh_token`, `expires_at`, `oidc_issuer`, `oidc_client_id`). Refresh is a direct `POST {issuer}/oauth2/token` (default issuer `https://auth.x.ai`) with `grant_type=refresh_token`, persisted back to the same file.
- **Chat proxy**: `https://cli-chat-proxy.grok.com/v1/responses` — a surface xAI itself documents for `auth.json`-authenticated clients, called with the same `x-xai-token-auth`, `x-grok-client-version`, `x-grok-client-identifier: grok-shell`, and `user-agent: grok-shell/<version>` headers the reference CLI sends.
- **Version gate**: an HTTP 426 response from the chat proxy is surfaced as an explicit `run \`grok update\`` error, not a generic failure — the same honest-failure posture as the existing `run \`grok login\`` auth error.
- **Responses API with function tools**: verified working under subscription auth — tool schemas translate to `type: "function"` with `name`/`description`/`parameters`, `tool_choice` maps to `{ type: "function", name }`, and `reasoning_effort` maps to `reasoning.effort`. Default model is `grok-4.5` at `high` effort; its ~500K context window lets Grok run the most generous review byte budgets on the panel (240,000/160,000 tool/file bytes, double the shared review-tools defaults), so large diffs truncate on Grok last.
- **ACP tool-call/permission streaming**: verified live against `grok agent stdio` — tool-call and permission-request events stream over JSON-RPC/stdio and are intercepted by Supermodels' own permission broker before the CLI's own UI sees them.
- **Headless `-p --output-format streaming-json`**: confirmed to have no per-tool-call event granularity (only `text`/`thought`/`end`), which is why it was rejected as the primary task transport and kept only for the one-shot exclusives.
- **Server-side web search**: never requested in reviews. No `web_search`-type tool is included in the Responses tool schema Supermodels builds, so Grok reviews stay grounded in the same local, read-only repository tool loop as Claude Code and Antigravity instead of citing live web content the coverage ledger and citation checker can't verify.

## Consequences

- The provider cap is raised from two to three. Adversarial review's cross-challenge phase now pairs each first-pass review against up to two peers instead of one, so `decisions/0001`'s "at least two usable outputs" cross-challenge threshold stays correct but the ceiling changes.
- The chat-proxy surface is a documented-but-evolving surface, not a stable published API. The 426 version-gate failure mode is the intended contract for that evolution: if xAI tightens the client-version check, Grok reviews fail with an explicit `grok update` instruction instead of silently returning junk or a confusing generic error.
- Grok tasks have no resume in v1 — an ACP session dies with its process, matching the adapter's `resume: false` capability. This is the same category of gap `decisions/0003` already tracks as v2 catch-up work for the other providers, now inherited by Grok as well.
- Grok's larger review byte budgets are model-specific tuning (a `grok-4.5` context-window fact), not a change to the shared review-tools library defaults that Claude Code and Antigravity still use.
