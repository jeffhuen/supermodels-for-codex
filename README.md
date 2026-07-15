# Supermodels for Codex

*A panel of frontier models that's really, really, ridiculously good at reviewing code.*

![status](https://img.shields.io/badge/status-v0.2.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![built for](https://img.shields.io/badge/built%20for-Codex-111827)

Supermodels is a [Codex](https://github.com/openai/codex) plugin that lets Codex stop reviewing its own homework. Instead of trusting one model to grade its own diff, you can have it hand the work to **Claude Code**, **Google Antigravity**, and **Grok Build**, collect their independent reviews, and — if you want a fight — make them tear into each other's findings before reporting back.

Here's the thing models are bad at admitting: reviewing in the same session you built something in is barely a review at all. The whole story of *why* every choice was made is sitting right there in context, and the model already decided those choices were good — its "self-review" mostly agrees with itself, confidently, and calls it a day.

You'd think a clean session fixes it: start fresh, read the diff cold. It helps — a blank context sheds the running commentary. But it's the same model. Same training, same instincts, same blind spots. If it didn't think to worry about something the first time, a fresh session of the same model won't think to worry about it the second time either. It can shed the context, but not itself.

A *different* model sheds both. Different training, different context window, different opinions about your variable names — and, the part that matters, zero ego in a diff it didn't write. It has no choices to defend and it's blind to different things, so it looks where the original wouldn't. Run two of them and their mistakes don't line up; what one misses, the other tends to catch.

## What it actually does

- **Independent review.** Ask every authenticated provider to review your working tree at the same time. They don't see each other's answers, so you get genuinely independent takes — not an echo.
- **Adversarial review.** Same blind first pass, then each model is handed its peer's review and told to *attack* it: unsupported claims, missed bugs, weak evidence, wrong severities, over-engineered fixes. What survives the cross-examination is usually worth your attention.
- **Task delegation.** Hand a bounded job ("investigate this failing test", "draft this refactor") to a single provider through its native CLI. Read-only by default; writes only when you explicitly ask.
- **It uses your existing logins.** No API keys to paste, no new accounts. It reuses the OAuth credentials already sitting in your local Claude Code, `agy`, and `grok` installs.
- **Everything is attributed and kept.** Each finding is tagged with who said it, and the raw provider output is saved to disk so you can check the receipts instead of trusting a summary.
- **Findings stay anchored.** Supermodels verifies cited file/line ranges, requires high-risk changed hunks to be read before final submission, and has a structured way to report "this caller should have changed but didn't" without inventing a line for absent code.

Codex stays the agent you're actually talking to. Supermodels is the broker sitting behind it, running the review loop and wrangling the other models.

## A quick look

Inside a Codex session, the skills look like this:

```text
you ▸ $supermodels:review
      → asks every ready provider to review the current diff, independently
      → returns one synthesized report, each point attributed to Claude, Antigravity, or Grok

you ▸ $supermodels:adversarial-review
      → same blind first pass, then the models challenge each other
      → you get the findings that held up under fire

you ▸ $supermodels:task --provider claude "figure out why auth.test.mjs flakes"
      → delegates a single scoped task and streams progress back
```

Or drive the runtime directly during development:

```bash
node scripts/supermodels.mjs review --live
node scripts/supermodels.mjs adversarial-review --live
node scripts/supermodels.mjs task --provider claude "Investigate the failing test"
node scripts/supermodels.mjs status
```

## Install

Add this repo as a Codex plugin marketplace, pinned to the latest release:

```bash
codex plugin marketplace add jeffhuen/supermodels-for-codex --ref v0.2.0
codex plugin add supermodels@supermodels
```

Prefer to live on the edge? Point `--ref` at `main` instead. Either way, **start a fresh Codex session after installing or upgrading** so the new skills and runtime files load.

## Setup

You need at least one of the three providers installed and logged in. More is better — that's when reviews actually run in parallel and adversarial mode has peers to argue with.

```bash
claude   # Claude Code — sign in if you haven't
agy      # Antigravity — sign in if you haven't
grok     # Grok Build — sign in if you haven't
```

Then, from inside Codex, run:

```text
$supermodels:setup
```

It checks Node, Git, all three provider CLIs, your auth state, and where it'll keep its data. Supermodels uses whichever providers are ready and tells you which ones it skipped and why. The full panel needs all three.

## Commands

All of these are Codex skills (`$`-prefixed):

| Skill | What it does |
| --- | --- |
| `$supermodels:setup` | Health check: Node, Git, provider CLIs, auth, data paths. |
| `$supermodels:providers` | Show which models are ready right now. |
| `$supermodels:review` | Independent blind review from every ready provider, synthesized and attributed. |
| `$supermodels:adversarial-review` | Blind first pass, then the models challenge each other before synthesis. |
| `$supermodels:task` | Delegate one bounded task to one provider. |
| `$supermodels:status` | List jobs, or inspect one in detail. |
| `$supermodels:result` | Read a finished job and its artifact paths. |
| `$supermodels:cancel` | Stop a queued or running job. |

### Reviewing more than the current diff

By default a review looks at your uncommitted changes, but you're not stuck there:

- `--base <ref>` reviews committed work against a base branch or tag.
- `--context-file <path>` or `--context "<text>"` feeds in non-git background — a planning thread, an implementation summary, a release decision, last session's transcript. Supermodels folds it into a shared **context packet** that every provider receives.

The context packet is treated as *untrusted background*, not gospel: the models still have to ground any code finding in real repository evidence before it's accepted.

## How it works

Under the hood it's less "message passer," more "verification harness." Things it does that a plain delegation wrapper doesn't:

- **The model has to prove it looked.** Reviews run through a read-only tool loop (`read_file`, `search`, `get_diff`) with a bounded context packet for orientation *only*. A review can't be submitted until the model has inspected the diff and real files — no opinion phoned in from the summary.
- **Every citation is checked against the source.** When a finding says `foo.mjs:42`, Supermodels re-reads that range from disk and rejects the finding if the line isn't there or doesn't back the claim. Hallucinated line numbers don't survive.
- **High-risk changes can't be skipped.** It splits the diff into hunks, flags the dangerous ones (auth, credentials, migrations, locks, concurrency), and won't accept a final review until those hunks were actually read — off the diff alone, so it works in any repo with no index to build first.
- **It can report what's *missing*.** A structured `missing-change` finding lets a model say "this caller should have been updated and wasn't," anchored to real inspected evidence instead of a made-up line for code that isn't there.
- **Adversarial means adversarial.** Each model attacks the *other* model's structured findings — not its own. Only findings that survive an independent model's cross-examination get reported.
- **Structured, attributed, kept.** Findings come back as validated JSON (verdict, severity, confidence, evidence), tagged with who said it, raw and normalized output written to disk so you can audit the receipts.
- **It fails honest.** Diff too big to fully load? It says so, disables the coverage check, and flags the gap instead of quietly implying it read everything.
- **It stays a broker, not a babysitter.** It never owns Claude's, Antigravity's, or Grok's auth or sessions; those stay on the OAuth logins already in your local `claude`, `agy`, and `grok` installs.

Provider transport details, model defaults, and tuning knobs live in the [package README](./plugins/supermodels/README.md).

## Where your stuff lives

Job state and every provider artifact are kept **outside your repo**, under the Codex plugin data directory:

```text
~/.codex/plugins/data/supermodels
```

Each run saves job metadata and progress, the shared context packet, the prompts, the raw provider output, the normalized results, and provider stderr. When a review says something surprising, you can go read exactly what the model was shown and exactly what it said back.

## Credentials & privacy

No provider API keys, account credentials, or OAuth client secrets are embedded in this plugin. Reviews reuse the OAuth credentials already on your machine — Claude tokens refresh through Claude Code's own store; AGY tokens refresh through the native `agy` flow and get read back from its token store; Grok tokens refresh through the same OIDC flow `grok login` uses and get read back from `~/.grok/auth.json`.

The provider CLIs still do their own thing with their own auth files, sessions, telemetry, and storage. If that matters to you, read their docs — Supermodels doesn't change or hide any of it.

## What's rough (the honest part)

This is `v0.2.0` of a hobby project. It's well-tested and it works on my machine, but you should know the edges:

- **Three providers, still on purpose.** Claude Code, Antigravity, and Grok Build. The Grok review transport uses the chat-proxy surface xAI documents for auth.json tokens; if xAI tightens its client-version gate you'll get an explicit "run `grok update`" error, never silent junk.
- **macOS is the path I live on.** The OAuth/keychain bits are exercised on macOS. Other platforms may have sharp corners I haven't hit yet.
- **Antigravity write tasks inherit the `agy` CLI's permission model.** Today that's a read-only `--sandbox` or a broad `--dangerously-skip-permissions` — there's no Claude-style edit allow-list. Only pass `--write --provider antigravity` if you're okay with that.
- **Grok write tasks are approved per-call by Supermodels' own broker**, not left to the `grok` CLI's own prompts, with an OS-level workspace sandbox as a backstop underneath.
- **Multi-provider *write* tasks are refused** by design in v1. Writes go to one provider at a time, deliberately.

If you hit something, open an issue — I'd genuinely like to know.

## Development

```bash
cd plugins/supermodels
npm test                 # the full suite (a couple hundred fast unit tests)
```

```bash
# from the repo root, if you prefer
node --test plugins/supermodels/tests/*.test.mjs
```

Validate the plugin manifest:

```bash
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/supermodels
```

```text
.agents/plugins/marketplace.json   Codex marketplace entry
plugins/supermodels/.codex-plugin/ Plugin manifest
plugins/supermodels/skills/        Codex skills
plugins/supermodels/scripts/       Runtime CLI + provider adapters
plugins/supermodels/prompts/       Shared review prompts
plugins/supermodels/tests/         Node test suite
```

## License

MIT — see [LICENSE](./LICENSE). Use it, fork it, point it at your worst diff.

---

*If Supermodels catches a bug in your code before a human does, consider dropping a ⭐. It's cheaper than a code review and almost as judgmental.*
