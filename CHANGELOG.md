# Changelog

## Unreleased

### Changed

- Follow-up corrections to the v0.3.3 timing tests after review flagged two remaining overclaims and a regression (test-only; folded here rather than cut as a separate public patch):
  - **Credential deadline** now uses `mock.timers` with a credential-start barrier, asserting the check is still pending at 29 ms virtual and resolves at exactly 30 ms — proving the timing behavior, not just `withAbortTimeout`'s echoed message text (a decoupling regression could print `30ms` while scheduling 10 s and still pass a text assertion).
  - **Process-tree timeout** test is now documented as robust-by-margin, not deterministic: testing an autonomous timeout inherently races the tree's own setup, so a generous timeout plus real-pid confirmation is reliable but not causal.
  - Fixed a cleanup regression — the process-tree test now kills the infinite grandchild in `finally` so a failed kill assertion cannot leave an orphan process.

## v0.3.3

### Changed

- Corrected the residual timing-test defects that v0.3.2's determinism pass missed — each the same root error: synchronizing on a **correlated observation** instead of a **causal guarantee**. (Found by review of v0.3.2 plus a 250× hard-loop of the subprocess suite; the earlier 30× validation was too shallow to surface ~1% races.)
  - **Subprocess cancellation** (two tests) emitted `ready` *before* installing the SIGTERM handler, so an abort could land SIGTERM before the handler existed and terminate the child with SIGTERM instead of the expected SIGKILL (~1%). The handler is now installed *before* `ready`, so `ready` causally guarantees it is in place.
  - **Timeout terminates the process tree** used a 100 ms timeout that raced the tree's own setup, occasionally letting the grandchild escape. The timeout is now generous enough that the tree is established first under realistic scheduling, and the grandchild's real pid confirms the kill reached it (robust by margin — see Unreleased for why this is not fully causal).
  - **Credential deadline** asserted only that *a* timeout fired — which an ignored `30 ms` option (falling back to the `10 s` default) would also satisfy. It was tightened to assert `withAbortTimeout`'s echoed message (`timed out after 30ms`) — better, but still a text proxy for the timing behavior (replaced with a virtual-clock boundary assertion in Unreleased).
  - **Stale-lock** polled for lock-file existence before backdating its mtime, racing the token write that resets the mtime. It now signals from *inside* the lock updater, which cannot run until the token is written — a causal guarantee the lock is fully held.
  - Corrected a comment claiming a FIFO read exercises the timeout path; it exercises the non-regular-file rejection (general timeout behavior is covered by the `withAbortTimeout` tests).
- No runtime behavior change (test-only).

## v0.3.2

### Changed

- Reworked the deadline, timeout, cancellation, and lock tests to reduce their reliance on real wall-clock time (the earlier suite had rare timing flakes a single pass could not surface). **This pass was incomplete — the residual races and a weakened assertion it left behind are corrected in v0.3.3.** Specifically: pure deadline logic is driven by a virtual clock (node's built-in `mock.timers`, zero new deps); the lock staleness decision is extracted into a pure `isLockStale(now, mtime, staleLockMs)` function with a deterministic unit test; the stale-lock and subprocess-cancellation integration tests are gated on real state signals — a backdated lock mtime, a subprocess readiness line — instead of fixed `sleep()`s; and the remaining timing-integration tests assert the *outcome* under a per-test `{ timeout }` hang-guard rather than a brittle elapsed-time stopwatch. No runtime behavior change — `isLockStale` is a behavior-identical extraction of the existing staleness check.

## v0.3.1

### Fixed

- Deleted clean-filter/LFS files no longer receive a phantom `1-1` current-file coverage range that forced the reviewer to attempt an impossible `read_file` on deleted source before an `inconclusive` verdict was accepted. No high-risk readable hunk is created for `status: D` or `lineCount: 0`; the correct non-invertible-filter-mapping gap is still disclosed. It already failed closed — this removes wasted rounds/tokens and imprecise evidence modeling, not a bypass.
- `readGrokClientVersion` now degrades to "no version" on a slow, blocking, or non-regular source instead of throwing. The Grok client version is optional metadata, but the timeout throw could propagate out of `resolveClientVersion` — which feeds a live review request and does not catch — aborting the request. Timeout now returns `""` like every other failure path, and callers fall back to a default version.

### Changed

- Hardened six timing-fragile liveness/deadline tests whose tight wall-clock bounds could flake under load (subprocess-spawn and timer jitter), intermittently masking a real pass/fail behind "one test failed." Each deadline-enforcement guarantee is still asserted precisely (rejection, timeout error, or readiness state); only the secondary "did-not-hang" wall-clock proxies were given generous margins, and one 20 ms deadline-vs-transport race gap was widened to 950 ms.

## v0.3.0

### Added

- Reviews now run against one immutable snapshot captured and source-revalidated before the first provider starts. The same snapshot, base commit, diff, files, and untracked content are shared by every blind pass and cross-challenge; repository tools cannot drift to later working-tree edits. Snapshot creation uses private Git objects/index state, preserves actual working content (including LFS-style filtered files and symlinks), and runs Git clean filters only against a discardable staging copy so delayed filter children cannot mutate delivered evidence. It fails closed on source changes during capture, unresolved index entries, present `assume-unchanged`/manual `skip-worktree` entries, changed/dirty submodules, private-tree filter mutations, Git failures, or `--base` outside a Git worktree; absent sparse-checkout entries remain supported. Copying, hashing, filters, Git children, and tree walks share one cancellation/timeout signal, with a 20-minute default snapshot bound when `--timeout` is omitted.
- `get_diff`, `get_review_context`, and `list_changed_files` now use opaque, snapshot-bound pagination. The per-response byte cap is a page size rather than an information-loss boundary: providers must follow every diff `next_cursor`, and the optional changed-file discovery pages also reconstruct the immutable file list exactly.
- Providers are registered through one static provider registry (`id`, aliases, label, factory) with capability-aware selection. Each adapter owns its flat review policy (reasoning, token budget, strict submission, caching, forced-tool support, backstop, system instructions, and audit metadata), so adding another built-in provider no longer requires provider-ID branches in the shared review harness.

### Changed

- A review can be conclusive only after every immutable diff page is consumed and every readable/new-side high-risk hunk is fully covered by delivered `read_file` ranges. Pure deletions are proved from the complete diff and deleted-line citation verification because deleted source cannot be read from the snapshot tree. One-line overlap no longer credits an entire readable hunk. Files transformed by Git clean filters require complete raw-file inspection; modified/deleted filtered evidence carries an explicit non-invertible-mapping gap instead of claiming a lossless clean review. If the exact required page or source range is attempted but unavailable, only an `inconclusive` verdict is accepted and Supermodels appends the precise missing cursor/file/range and error; skipped pages, wrong cursors, and unattempted reads remain fail-closed.
- Provider completion is normalized at each transport boundary and enforced before any submitted review is accepted. Claude `max_tokens`, missing stop reasons, or missing terminal `message_stop`; Antigravity non-`STOP` finishes; and Grok incomplete/failed/missing response status now produce `inconclusive`. A partial clean submission can no longer pass merely because a tool call survived truncation, and evidence returned by sibling tools cannot justify a submission authored in the same model turn.
- Provider wire output is validated strictly for exact fields and primitive types across tool submissions and natural JSON finals. Contradictory `clean` results with findings and coerced values such as string line numbers are rejected, while the existing normalized internal review shape remains backward-compatible.
- Each provider review phase now uses one wall-clock budget across all of its model rounds, transport retries/refreshes, project discovery, repository tools, citation verification, and subprocess-backed searches. Readiness credential probes are separately bounded, awaited work is abortable, and all three direct transports preserve one absolute per-call deadline across retries.
- Ready providers are selected by the capability required for the requested operation (`review`, `adversarialReview`, `task`, or `writeTask`), with no hidden three-provider slice.
- Removed the unused `--scope` CLI surface. Reviews have one explicit scope contract: the working tree, optionally compared with `--base <ref>`.

### Fixed

- Git discovery now checks every command exit status, uses full untracked discovery and NUL-delimited status/name parsing, and surfaces failures instead of silently returning an empty or partial review context.
- Oversized single source lines expose no partial numbered line and therefore cannot earn high-risk coverage. Finding verification now proves every cited current or deleted line, and deleted-line evidence uses the full immutable diff rather than a truncated page.
- Snapshot creation no longer renormalizes unchanged tracked files, base-revision attributes work on older Git versions without `check-attr --source`, and live source/HEAD/index state (including hidden index flags and submodules) is revalidated before acceptance. Sparse exclusions are proved with Git's `check-rules` support and fail closed when that proof is unavailable; deleted gitlinks, forced diff color, renamed filtered files, delimiter-containing paths, and trailing-whitespace paths retain exact evidence. Pagination avoids repeatedly serializing the entire remaining giant diff/file list.
- Provider readiness is isolated per adapter and fail-closed: one broken provider no longer aborts healthy peers, executable discovery runs in a bounded killable probe and accepts only regular executable files, every native CLI must pass its version sanity check, and OAuth/version-cache reads are bounded. Setup no longer runs Antigravity readiness twice or ignores an injected credential source.
- Review, credential, and direct-transport deadline timers remain referenced until their awaited operation settles. A handle-less hung promise can no longer let the CLI exit before its timeout fires.

## v0.2.10

### Fixed

- The preloaded-evidence message is now bounded to the model-visible cap. The preload path capped the `get_review_context` result, then pretty-printed and wrapped it into a message without re-checking the final size — pretty-printing (`JSON.stringify(…, null, 2)`) multiplied structure-heavy evidence up to ~2.4x, so a ~112 KB capped result could reach ~225–272 KB in the delivered preload, silently exceeding the advertised hard cap. The evidence is now serialized compactly, and the assembled message is bounded to `maxToolBytes` (trimming the embedded results if needed). Coverage is unaffected: the hunk ledger is built from the full diff and reads — not the embedded diff — credit coverage.

## v0.2.9

### Fixed

- Coverage can no longer be credited against content that the final cap trims away. The coverage-ledger reserve budgeted only the ledger body, not the `,"coverage_ledger":` envelope key, so at a full budget the attached payload exceeded the cap by ~the key length — and the final cap then trimmed `read_file` content *after* high-risk hunk coverage had already been credited from the pre-trim content, letting a hunk beyond the delivered content be marked covered. The reserve now budgets the full serialized ledger envelope, and `read_file` content is finalized (with its `end_line` resynced) before coverage is recorded from it, so coverage always reflects the content the model actually received.

## v0.2.8

### Fixed

- `read_file` no longer reports a line range past the content the model actually received. The shared budgeter could trim a `read_file` result's content while leaving `end_line` unchanged, and both high-risk hunk coverage and citation verification trust `end_line` — so a hunk beyond the visible content could be credited as inspected and a clean verdict accepted (a verification-gate bypass). `read_file` now bounds its content by whole lines and resets `end_line` to the last line that survives; coverage credits only lines proven present in the returned content, failing closed when a read returns no verifiable content lines.
- The model-visible tool result can no longer exceed the byte cap. The dispatcher capped the tool result, but the review agent then attached a `coverage_ledger` before serialization, pushing the payload over (a 120,000-byte cap returned 120,104). Ledger-bearing tools (`get_diff`, `get_review_context`, `read_file`) now reserve headroom for the ledger, the ledger is bounded to that reserve, and a final serialized-cap guarantee covers any residual at every cap size.
- The coverage-critical diff is no longer over-trimmed to reserve space for changed-file metadata. Reclamation reserved a fixed 15% of the cap for the changed-files list, so a payload one byte over could shed ~18 KB of diff to retain hundreds of file entries. The diff now has strict priority: it is trimmed only when it alone exceeds the cap, and then fills the budget while the lower-priority file list yields (its omitted count still reported).

## v0.2.7

### Fixed

- Every review tool's result now passes through one shared budgeter that enforces the byte cap on the FINAL serialized JSON (after escaping), so no tool can exceed it. `search` and `list_files` previously bounded their raw text before JSON wrapping, so escaping-heavy output overshot the cap — a 120 KB cap could return a 150–240 KB payload — and `list_files` could surface the truncation marker as a phantom filename. Both now return their full result and are bounded by the shared budgeter, which drops whole trailing entries (no phantom filename) or trims a string field to the largest prefix that fits.
- Reclamation now takes only the bytes actually required — binary-search / largest-fitting trims instead of fixed fractions or coarse geometric steps. Previously an oversized diff was cut in 20% steps (compounded by a geometric text trimmer, turning a near-1-byte overflow into a roughly 30% cut), file snippets were crushed to a fixed 35%/N of the whole cap regardless of the real overflow, and the changed-files packer used a conservative estimate that dropped an entry even at an exact fit. The diff, snippets, and changed-files list now each reclaim to the largest form that fits, and the shared text trimmer slices precisely rather than in geometric steps.

## v0.2.6

### Fixed

- The review-tool payload cap is now a genuine hard cap across every payload component, enforced without over-dropping. Previously `truncateObject` never bounded the changed-files list, so a repository with many untracked or changed files could return a payload over the byte cap and unnecessarily disable high-risk hunk coverage enforcement (and show the coverage-degraded banner) even when the diff itself fit. The changed-files list is now bounded in a single O(n) pass, and reclamation is ordered so the coverage-critical diff is sized first and the changed-files list is re-packed into whatever budget the diff leaves — so a very large diff no longer drops the entire changed-files list (it previously cleared the list, then trimmed the diff, and never restored the entries into the freed space). The `list_changed_files` tool shares one hard-cap packer that fills both its structured array and its text rendering from the same retained set, using the full budget instead of a fixed fraction, so it can neither exceed the cap nor drop entries that would have fit.

## v0.2.5

### Fixed

- Review-tool context truncation now trims and drops file snippets before truncating the diff, so a complete diff that fits once snippets are reclaimed is kept whole. Previously the diff was cut first, which unnecessarily disabled high-risk hunk coverage enforcement (and showed the coverage-degraded banner) even when the full diff would have fit under the cap. Diff truncation is also now detected by exact content comparison rather than byte length, fixing a false negative possible under very small custom caps.

## v0.2.4

### Fixed

- High-risk hunk coverage enforcement is no longer disabled — and the "coverage degraded" banner no longer shown — when only file snippets are truncated while the diff itself is complete. The review tools now track diff truncation separately from context truncation, so the coverage guarantee is reported as lost only when the diff (which the hunk ledger is built from) is actually truncated.
- Corrected the upgrade instructions: re-adding a marketplace with a changed `--ref` fails when it is already registered, so upgrading requires `codex plugin marketplace remove` first, then re-add and re-install.

## v0.2.3

### Fixed

- Denied `NotebookEdit` calls now report their target path. The permission-denied event reads `notebook_path` (not only `file_path`), so a denied notebook edit no longer surfaces as a bare "claude denied NotebookEdit" with no location — matching the task-permission policy, which already gated on either field.

### Changed

- When a review's diff exceeds the review-tool cap and high-risk hunk coverage enforcement is disabled, the resulting coverage-degraded gap is now shown as a prominent banner directly under the provider verdict, instead of being buried at the bottom of the verification-gaps list. A review that has lost its coverage guarantee now says so up front.
- Documented that upgrading an existing install requires re-running `codex plugin add supermodels@supermodels`; bumping the marketplace `--ref` alone leaves the previously installed version cached.

## v0.2.2

### Changed

- Claude reviews now submit their final structured review via strict tool use, so the submission is schema-shape valid without spending a correction round. This required a strict-native review-result schema: findings are split into two all-required arrays — `findings` for code findings and `missing_change_findings` for expected-but-absent changes — because the Anthropic Messages API rejects strict tool use on the previous `anyOf` schema. The review is identical internally (one merged findings list), and the semantic evidence gates (non-empty impact/recommendation/evidence, citations, high-risk coverage) plus the parse-and-correct loop remain the net for everything strict does not enforce.
- Claude reviews cache the stable request prefix (tool schemas, system persona, preloaded review context) across the multi-round review loop, so later rounds read it from cache instead of re-billing it. Claude-only; Grok and Antigravity are unchanged.
- Claude task delegation is now gated per-call by Supermodels' own permission broker via Claude Code PreToolUse hooks, keeping the full Claude Code task harness. The available tools are bounded to a mode-appropriate `--tools` allowlist (read tools for read-only tasks, read+edit for `--write`, never shell), and within that the hook decides each call: reads allowed; `--write` edits approved only when the canonicalized (symlink-safe) path is inside the workspace; everything else denied. `Bash` is excluded from the allowlist entirely — a Claude task has no OS sandbox, and because `--permission-mode dontAsk` auto-allows read-only shell, bounding the tool set (not the hook) is what actually contains shell. The broker's settings are the sole permission authority (`--setting-sources ""`); a missing, crashing, malformed, or timed-out hook denies writes (fail closed, never `bypassPermissions`), and shell stays unavailable regardless of hook health. Denied calls are recorded in the job's provider events.

## v0.2.1

Corrective release for issues found in an independent review of v0.2.0.

### Fixed

- Grok reviews are now bounded by the same finite post-evidence backstop as Antigravity, in both first-pass and adversarial modes. An unbounded Grok review could previously run 10+ tool rounds and ~1.5M tokens (and again in the challenge phase), risking subscription/rate-limit exhaustion.
- Foreground `review`/`task` runs now exit nonzero when the job ends `failed` or `partial`, so CI and scripts no longer read a failed review as a pass.
- Transport retries now share one absolute per-call deadline instead of each re-arming a fresh full timeout, so a review can't run far past its timeout budget. Fixed in both the Grok Responses and Claude Messages transports.
- A run whose provider ended its own turn as cancelled (e.g. Grok's headless `--check`) with only partial output is now recorded as `cancelled`, not `completed`.
- The Grok ACP client-side file read canonicalizes the path (an in-workspace symlink can no longer serve a file from outside the workspace), rejects non-regular files, and bounds the read so a huge file can't exhaust worker memory.
- `--json-schema` must be a JSON object (a degenerate value like `false` is rejected at parse time instead of being silently dropped); `--worktree` is boolean (Grok auto-names the worktree; a name no longer leaks into the task prompt).
- Version metadata is consistent at `0.2.1` across the plugin manifest and the npm package; `usage()` and the task skill now list the Grok-only flags.

### Changed

- The `--write` task documentation now states accurately that Grok write tasks auto-approve the operations Grok requests (including shell commands), with the OS-level workspace sandbox as the actual containment boundary — not an edit-only classifier.
- The subscription-only Grok auth contract (reuse `grok login`; do not fall back to `XAI_API_KEY`) is documented and locked with a readiness test.

## v0.2.0

### Added

- Grok Build (xAI) as a third review and task provider, using your existing `grok login` subscription credentials — no API keys.
- Grok reviews run the full verification harness (read-only tool loop, inspection gating, citation verification, high-risk coverage ledger) over a direct OAuth transport to xAI's documented CLI chat proxy, with automatic OIDC token refresh and honest `grok login` / `grok update` errors.
- Grok task delegation runs over ACP (`grok agent stdio`) with full tool-call streaming and supermodels-enforced permissions: read-only tasks deny every write/execute request at the broker; `--write` tasks auto-approve the operations Grok requests (including shell commands, not only edits), with the OS-level workspace sandbox as the actual containment boundary.
- Grok-exclusive one-shot task modes: `--best-of-n <N>` and self-verifying `--check` runs via headless `grok --prompt-file` (`--check` is experimental — current Grok CLI releases can cancel the run and truncate output, so it is only passed through on explicit request).
- Reviews and adversarial reviews now run up to three providers; each adversarial first pass is cross-examined by two independent peers.

### Changed

- Provider cap raised from two to three; docs, skills, and setup guidance now cover Grok Build.

## v0.1.1

### Added

- Review acceptance now builds a portable high-risk diff hunk coverage ledger from `get_diff` / `get_review_context` and refuses final submissions until each high-risk readable hunk is inspected with `read_file`.
- Structured review findings now support `kind: "missing-change"` for absence bugs, anchored to an inspected file/line plus the expected symbol, searched evidence, and missing-change rationale.
- When a truncated diff disables the coverage ledger, review acceptance now appends an attributed (`Supermodels:`) `verification_gaps` entry so the disabled coverage is disclosed instead of reading as full coverage.

### Changed

- Human review synthesis renders missing-change finding details, and provider prompts explicitly tell reviewers to inspect coverage-ledger gaps and anchor absence findings to real evidence.

### Fixed

- Forced `submit_review` no longer engages while the coverage ledger still has unread high-risk hunks. Because a forced `tool_choice` cannot call `read_file` (the only thing that clears a gap), the previous behavior could trap Antigravity normal reviews in repeated inspection refusals and end as a false `inconclusive`.

## v0.1.0

Initial public release.

### Added

- Codex plugin package for Claude Code and Google Antigravity reviews.
- Skills for setup, providers, review, adversarial review, task, status, result, and cancel.
- Direct review transports for Claude Code OAuth and AGY/Code Assist OAuth, plus native CLI adapters for task delegation.
- Deterministic preloaded review context for Claude Code and Antigravity reviews, including diff, changed files, and bounded snippets from changed files.
- Preloaded review context is treated as orientation only; providers must still perform explicit repository inspection with `read_file` or `search` before final review submission.
- Review tools read requested line ranges with bounded streaming reads instead of loading whole files, so later line ranges and oversized single-line prefixes remain inspectable without memory spikes.
- Deleted files no longer consume changed-file snippet budget for preloaded review context.
- Invalid `--base` refs now fail explicitly before diff or changed-file collection.
- Explicit task context briefs are persisted with worker jobs and included in provider task prompts, so non-git session/planning context reaches delegated tasks.
- `--context-file` truncation is UTF-8 safe and no longer emits replacement characters for partial trailing codepoints.
- Reference-aligned Code Assist request pacing with `SUPERMODELS_ANTIGRAVITY_RPM` and `SUPERMODELS_ANTIGRAVITY_BURST` overrides.
- Live review mode with provider progress, persisted job state, and attributed provider output.
- Structured review parsing, provider artifact preservation, and synthesis with provider attribution.
- Read-only review/task defaults and explicit `--write` handling for bounded task delegation.
- Job state locking, stale lock recovery, terminal job handling, and worker-scoped cancellation.
- Private state/run artifacts and Antigravity prompt artifacts using `0700` directories and `0600` files.
- Background cancel transitions queued/running jobs to cancelled and signals the Supermodels worker when available.
- Active task workers forward `SIGINT`/`SIGTERM` to the current provider CLI child and escalate to `SIGKILL` when it ignores graceful termination; review workers abort in-process provider HTTP requests.
- Foreground/live cancellation now uses a single run controller; provider runners no longer own process-level exit timers and interrupted provider runs preserve signal metadata.
- Provider runs killed by an external signal now report failed unless the Supermodels run controller initiated cancellation.
- Already-terminal jobs, including already-cancelled jobs, are treated as no-ops and are not signaled again.
- Signal finalization preserves already-terminal jobs instead of rewriting them to cancelled.
- Centralized worker cancellation lifecycle handling, with contract tests plus process-level signal regression coverage.
- Foreground, live, and background review/task paths now all execute through the same persisted worker lifecycle instead of mixing direct CLI execution with detached background children.
- Reviews run through a shared Supermodels-owned tool loop, so Claude Code and Antigravity both inspect repository evidence with the same read-only tools before returning structured findings.
- Adversarial review now runs a provider cross-challenge phase after blind first-pass reviews when at least two usable provider outputs are available.
- The shared review loop now enforces one provider-independent completion contract: forced-submit retry margin, stronger clean-verdict evidence, and deterministic handling for mixed `submit_review`/tool-call turns.
- Review/task runs check only the requested providers, so an unavailable unrequested provider cannot block a single-provider run.
- Review commands accept explicit non-git context through `--context` and `--context-file`, and base-ref review context now works for committed changes without requiring a separate scope flag.
- Review, adversarial-review, and task runs now persist a shared context packet with user intent, explicit context, provider selection, and repository evidence; status/result expose the packet summary and artifact paths.
- Provider prompts now receive a lean context packet for orientation only, while canonical focus and diff evidence are rendered once in their dedicated prompt sections; full context packets remain persisted as private artifacts.
- Provider run records now persist direct-review audit metadata, including model, effort/thinking settings, max token budget, rounds, and repository tool usage.
- Context packet diff path parsing handles Git-quoted file paths, and prompt/context truncation is UTF-8 safe for large multibyte input.
- Git diff collection forces standard `a/`/`b/` prefixes and context packets use rename metadata, avoiding advisory changed-file path drift from local Git prefix config or ambiguous unquoted rename paths.
- Review tools reuse the shared Git-quoted path decoder, so `git status`/`git diff --name-status` paths with UTF-8 octal escapes remain readable by providers.
- Review file reads stop retaining excess text from large newline-free lines once the output budget is consumed.
- Antigravity Keychain refresh persistence prompts through stdin instead of passing the OAuth envelope as a process argument.
- Antigravity Keychain refresh persistence handles early stdin close errors without uncaught `EPIPE` stream failures.
- Claude Code direct reviews reject content-less successful SSE streams with an explicit empty-response error.
- Watch/live timing flags now reject invalid non-positive or non-finite second values before polling.
- Antigravity readiness on macOS prefers the native Keychain token store over stale default token files, while explicit/fake `HOME` credential paths remain hermetic.
- Claude Code OAuth review rate limits are surfaced as provider `rate-limited` results instead of invalid structured output.
- Antigravity rejected-token `401` responses force direct OAuth refresh before retrying the request.
- Claude Code direct reviews prepend the official Claude Code system identity block before Supermodels review instructions.
- Claude Code direct reviews request Opus adaptive thinking with a 128k response budget and default `xhigh` effort; explicit `--effort` overrides are still honored.
- Claude Code streamed thinking blocks are preserved across tool turns, so adaptive-thinking reviews keep the context Anthropic requires after tool use.
- Claude Code direct reviews no longer combine adaptive thinking with forced `tool_choice`; required final/inspection turns are enforced by prompt instruction instead.
- The shared review loop is not capped by a low fixed round count by default; provider timeout/cancellation now own runaway protection.
- Review provider timeouts are enforced as aggregate wall-clock budgets across the whole review loop, not just as per-request timeouts.
- The shared review loop rejects final submissions until providers have made enough distinct meaningful file/search inspections, preventing a shallow review from completing only because preloaded context or duplicate tool calls were available.
- Antigravity direct reviews remain model-led after the evidence gate by default; explicit force settings remain available only for controlled tests or overrides.
- Direct reviews now accept parseable structured final text after required evidence is satisfied, and only ask for one structured-conversion turn when a provider ends with unstructured no-tool text.
- Direct review usage is aggregated and emitted across all model turns, so multi-round Claude Code and Antigravity reviews do not look like only the final response consumed tokens.
- Mixed repository tool calls with an invalid `submit_review` now execute the repository tools before returning submit errors, so providers can satisfy evidence requirements in the same turn.
- Antigravity direct reviews request Code Assist dynamic thinking with `thinkingBudget: -1` and a 64k response budget.
- Claude Code direct reviews retry transient Anthropic overloaded stream errors instead of failing the review immediately.
- Antigravity direct reviews honor explicit short Code Assist quota reset windows beyond the fixed retry count, bounded by a retry window.
- Claude Code direct reviews emit Anthropic-compatible `tool_result` blocks without provider-internal helper fields.
- Claude Code streamed tool-call arguments prefer streamed deltas over stale block-start input, avoiding corrupted tool inputs if both shapes appear.
- Claude Code credential loading accepts the hex-encoded macOS Keychain payload used by current Claude Code secure storage.
- Claude Code token refresh writes macOS Keychain payloads back in the same hex-encoded form.
- Claude Code token refresh persists the resolved or returned OAuth scopes instead of re-saving stale empty scope metadata.
- Claude Code readiness now validates the same direct OAuth credentials used by review transport, so stale CLI auth cannot fail mid-review.
- Antigravity OAuth refresh now matches the AGY/TradingAgents credential flow: expired local CLI tokens are refreshed directly through Google's token endpoint and persisted back to the same Keychain or token file.
- Antigravity direct reviews use Gemini 3.5 Flash High (`gemini-3-flash-preview`) as the supported Code Assist review target; unsupported Pro aliases fail loudly instead of silently downgrading or routing to a stub.
- Antigravity Code Assist tool-call `thoughtSignature` values are preserved across model/tool turns, matching the TradingAgents transport and avoiding missing-signature request rejection.
- Antigravity direct reviews now use the Code Assist streaming endpoint, preserve provider function-call ids, include matching function-response ids, and synthesize the first-call thought signature only when Code Assist requires one.
- Antigravity Code Assist request histories now coalesce adjacent same-role turns before sending, matching Gemini-style role alternation expectations for preloaded context and follow-up tool results.
- Antigravity Code Assist responses now validate finality signals and reject empty stopped responses, malformed function-call stops, unexpected tool-call stops, and repeated no-tool continuation churn as review no-progress instead of silently looping.
- Antigravity normal reviews now get a post-evidence submit backstop: after the evidence gate is satisfied and four more model-led rounds pass, the loop forces `submit_review` instead of allowing unbounded additional inspection.
- Structured review acceptance now rejects empty or invalid finding locations/evidence, includes a severity rubric, verifies cited file/line ranges with read-only repository tools, and gives providers one correction turn before returning an inconclusive validation result.
- Structured review validation now rejects empty impact/recommendation fields, returns field-level correction errors, normalizes cited paths during location checks, and keeps inspection-gate nudges separate from the finding/schema correction budget.
- Structured review validation now preserves field-level errors for natural JSON final answers, rejects oversized finding ranges instead of silently truncating them, requires missing current-line findings to match deleted-line diff evidence, handles deleted-line verification for real spaced Git paths, Git octal-quoted UTF-8 paths, and truncated diffs, and stops repeated inspection-gate refusals before the aggregate provider timeout.
- Setup output now mirrors actual readiness for providers without setup hooks, avoiding contradictory provider setup/check status.
- Review failures now include provider-specific readiness reasons when no requested provider can run.
- Human review output now prints failed job errors instead of an empty synthesized review section.
- Antigravity project discovery matches the reference Code Assist behavior: non-auth discovery failures are non-fatal and onboarding polls use the reference bounds.
- Antigravity project discovery only caches non-empty project ids, so a transient project-discovery failure can be retried by later requests.
- Preloaded review context now fails explicitly when changed-file discovery fails, and unreadable snippets no longer satisfy the review inspection gate.
- macOS Antigravity keychain read failures no longer silently fall back to local token files unless a file path is explicitly configured.

### Scope

- v1 supports exactly two providers: Claude Code and Google Antigravity.
- Reviews run one ready provider if only one is configured, or both providers in parallel when both are ready.
- Provider CLIs keep their own auth/session behavior; Supermodels does not embed provider API keys or provider account credentials. AGY token refresh uses the public installed-app OAuth client metadata required by tokens minted for the Antigravity CLI.

### Known Limitations

- Additional providers are intentionally out of scope for `0.1.0`.
- Direct reviews provide the core Claude Code-style tool-call loop, but not full Claude Code harness parity. Incremental streaming, transcript replay, compaction, richer context provenance, and long-output continuation are tracked as v2 catch-up work.
