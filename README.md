# Supermodels for Codex

*A panel of frontier models that's really, really, ridiculously good at reviewing code.*

![status](https://img.shields.io/badge/status-v0.3.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![built for](https://img.shields.io/badge/built%20for-Codex-111827)

Supermodels is a [Codex](https://github.com/openai/codex) plugin that lets Codex stop reviewing its own homework. Instead of trusting one model to grade its own diff, you can have it hand the work to **Claude Code**, **Google Antigravity**, and **Grok Build**, collect their independent reviews, and — if you want a fight — make them tear into each other's findings before reporting back.

Here's the thing models are bad at admitting: reviewing in the same session you built something in is barely a review at all. The whole story of *why* every choice was made is sitting right there in context, and the model already decided those choices were good — its "self-review" mostly agrees with itself, confidently, and calls it a day.

You'd think a clean session fixes it: start fresh, read the diff cold. It helps — a blank context sheds the running commentary. But it's the same model. Same training, same instincts, same blind spots. If it didn't think to worry about something the first time, a fresh session of the same model won't think to worry about it the second time either. It can shed the context, but not itself.

A *different* model sheds both. Different training, different context window, different opinions about your variable names — and, the part that matters, zero ego in a diff it didn't write. It has no choices to defend and it's blind to different things, so it looks where the original wouldn't. Run two of them and their mistakes don't line up; what one misses, the other tends to catch.

## What it actually does

- **Independent review.** Ask every authenticated, review-capable provider to review your working tree at the same time. They don't see each other's answers, so you get genuinely independent takes — not an echo.
- **Adversarial review.** Same blind first pass, then each model is handed its peer's review and told to *attack* it: unsupported claims, missed bugs, weak evidence, wrong severities, over-engineered fixes. The synthesis preserves the original passes and appends the challenge findings, so support and contradiction remain auditable.
- **Task delegation.** Hand a bounded job ("investigate this failing test", "draft this refactor") to a single provider through its native CLI. Read-only by default; writes only when you explicitly ask.
- **It uses your existing logins.** No API keys to paste, no new accounts. It reuses the OAuth credentials already sitting in your local Claude Code, `agy`, and `grok` installs.
- **Everything is attributed and kept.** Each finding is tagged with who said it, and the accepted provider result is saved to disk alongside its normalized form so you can check the receipts instead of trusting a summary.
- **Findings stay anchored.** Supermodels verifies cited file/line ranges, requires high-risk changed hunks to be read before final submission, and has a structured way to report "this caller should have changed but didn't" without inventing a line for absent code.

Codex stays the agent you're actually talking to. Supermodels is the broker sitting behind it, running the review loop and wrangling the other models.

## A quick look

Inside a Codex session, the skills look like this:

```text
you ▸ $supermodels:review
      → freezes the current diff, then asks every ready provider to review that same snapshot independently
      → returns one synthesized report, each point attributed to Claude, Antigravity, or Grok

you ▸ $supermodels:adversarial-review
      → same blind first pass, then the models challenge each other
      → preserves the attributed first passes and appends each model's challenges, so disputes stay visible

you ▸ $supermodels:task --provider claude "figure out why auth.test.mjs flakes"
      → delegates a single scoped task and streams progress back
```

Or drive the runtime directly during development:

```bash
node plugins/supermodels/scripts/supermodels.mjs review --live
node plugins/supermodels/scripts/supermodels.mjs adversarial-review --live
node plugins/supermodels/scripts/supermodels.mjs task --provider claude "Investigate the failing test"
node plugins/supermodels/scripts/supermodels.mjs status
```

## Install

Add this repo as a Codex plugin marketplace, pinned to the latest release:

```bash
codex plugin marketplace add jeffhuen/supermodels-for-codex --ref v0.3.0
codex plugin add supermodels@supermodels
```

Prefer to live on the edge? Point `--ref` at `main` instead. Either way, **start a fresh Codex session after installing or upgrading** so the new skills and runtime files load.

**Upgrading an existing install?** Re-adding a marketplace with a changed `--ref` fails when it's already registered, so remove it first, then re-add and re-install:

```bash
codex plugin marketplace remove supermodels
codex plugin marketplace add jeffhuen/supermodels-for-codex --ref v0.3.0
codex plugin add supermodels@supermodels
```

Codex caches the installed plugin, so this full sequence — not just bumping `--ref` — is what actually pulls the new version. (Fresh installs skip the `remove` line. If your marketplace has a different name, `codex plugin marketplace list` shows it.)

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

- **Every provider reviews the same frozen evidence.** Before anyone starts, Supermodels captures one private immutable snapshot of the base, diff, tracked files, and untracked files, then revalidates the live sources before accepting it. All first passes, cross-challenges, searches, reads, and citation checks use that snapshot even if the live working tree changes later. Git clean filters run only against a throwaway staging copy; filtered changed files must be read completely, and non-invertible modified/deleted filter evidence is reported as inconclusive rather than silently mis-mapping line coverage. Present `assume-unchanged` or manual `skip-worktree` entries fail closed because Git intentionally hides their state; normal absent sparse-checkout entries remain supported.
- **The model has to prove it looked.** Reviews run through a read-only tool loop (`read_file`, `search`, `get_diff`) with a bounded context packet for orientation *only*. Diff and changed-file responses are losslessly paginated: the byte cap controls page size, not total review size. A conclusive review must consume every diff page; changed-file pages remain lossless, optional discovery because the complete diff is the acceptance evidence.
- **Every citation is checked against the snapshot.** When a finding says `foo.mjs:42-45`, Supermodels proves every cited line from the frozen source (or every cited deleted line from the complete diff) and rejects partial ranges. Hallucinated line numbers don't survive, and a provider response cut off before its native terminal event is never accepted as complete.
- **High-risk changes can't be skipped.** It splits the full diff into hunks and flags the dangerous ones (auth, credentials, migrations, locks, concurrency). Every readable/new-side line must be delivered through `read_file` — one overlapping line is not enough. Pure deletions are proved from the completely consumed diff and its deleted-line citation checks because deleted source cannot be read from the snapshot tree.
- **It can report what's *missing*.** A structured `missing-change` finding lets a model say "this caller should have been updated and wasn't," anchored to real inspected evidence instead of a made-up line for code that isn't there.
- **Adversarial means adversarial.** Each model attacks the *other* model's structured findings and re-checks its own. The synthesis preserves the attributed first passes and appends the challenge results; it does not silently delete a disputed finding, so Codex (and you) can verify which claims held up.
- **Structured, attributed, kept.** Findings come back as validated JSON (verdict, severity, confidence, evidence), tagged with who said it, with the accepted provider result and normalized output written to disk so you can audit the receipts.
- **It fails honest.** A clean verdict requires complete diff pagination and coverage. If an exact page or source range was actually attempted but could not be delivered, the only accepted result is `inconclusive` with the precise missing cursor/file/range and error; skipped evidence cannot masquerade as unavailable evidence.
- **It stays a broker, not a babysitter.** It never owns Claude's, Antigravity's, or Grok's auth or sessions; those stay on the OAuth logins already in your local `claude`, `agy`, and `grok` installs.

Provider transport details, model defaults, and tuning knobs live in the [package README](./plugins/supermodels/README.md).

## Where your stuff lives

Job state and every provider artifact are kept **outside your repo**, under the Codex plugin data directory:

```text
~/.codex/plugins/data/supermodels
```

Each run saves job metadata and progress, the shared bounded context packet, the accepted provider result (under the compatibility `.raw.txt` artifact name), normalized results, and provider stderr. Direct review artifacts contain the validated submitted result, not the provider's full transport stream or internal reasoning. The full ephemeral snapshot and multi-round tool transcript are deliberately not copied into long-lived plugin storage.

## Credentials & privacy

No provider API keys, account credentials, or private/confidential OAuth client secrets are embedded in this plugin. Reviews reuse the OAuth credentials already on your machine — Claude tokens refresh through Claude Code's own store; AGY refresh uses the public, non-confidential installed-app client metadata used by the CLI family and reads your tokens from the native store; Grok tokens refresh through the same OIDC flow `grok login` uses and get read back from `~/.grok/auth.json`.

Supermodels deliberately exposes a **subscription-only** contract for Grok. xAI's CLI also supports `XAI_API_KEY` and external auth providers, but Supermodels reuses your `grok login` subscription session and treats a missing OAuth session as not-ready — it will not fall back to an API key. If you need metered API-key access, that's out of scope by design.

The provider CLIs still do their own thing with their own auth files, sessions, telemetry, and storage. If that matters to you, read their docs — Supermodels doesn't change or hide any of it.

## What's rough (the honest part)

This is `v0.3.0` of a hobby project. It's well-tested and it works on my machine, but you should know the edges:

- **Three providers ship today, still on purpose.** Claude Code, Antigravity, and Grok Build. The internal registry and adapter-owned policies make another built-in provider a bounded adapter addition, but this is deliberately not a dynamic provider SDK, and API-key-only services remain outside the current subscription-login product contract. The Grok review transport uses the chat-proxy surface xAI documents for auth.json tokens; if xAI tightens its client-version gate you'll get an explicit "run `grok update`" error, never silent junk.
- **macOS is the path I live on.** The OAuth/keychain bits are exercised on macOS. Other platforms may have sharp corners I haven't hit yet.
- **Git clean filters are trusted local executable configuration.** They run only against a discardable private copy, so delayed children cannot alter evidence delivered to reviewers, and non-invertible line mappings fail inconclusive. A filter that deliberately writes an absolute path outside its Git worktree is still capable of that external side effect, just as when Git invokes it directly; Supermodels does not provide an OS sandbox for repository/user Git configuration.
- **Claude write tasks are approved per-call by Supermodels' own broker** via Claude Code PreToolUse hooks. The task runs under a read/edit tool allowlist that excludes shell, so `Bash` stays unavailable even if the hook fails (a Claude task has no OS sandbox); within that, only in-workspace edits (canonicalized, symlink-safe) are allowed, and a broken hook denies writes.
- **Antigravity write tasks inherit the `agy` CLI's permission model.** Today that's a read-only `--sandbox` or a broad `--dangerously-skip-permissions` — there's no per-call edit gating like Claude Code's or Grok's. Only pass `--write --provider antigravity` if you're okay with that.
- **Grok write tasks are approved per-call by Supermodels' own broker**, not left to the `grok` CLI's own prompts, with an OS-level workspace sandbox as a backstop underneath.
- **Multi-provider *write* tasks are refused** by design in v1. Writes go to one provider at a time, deliberately.

If you hit something, open an issue — I'd genuinely like to know.

## Development

```bash
cd plugins/supermodels
npm test                 # the full suite (400+ fast unit tests)
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
