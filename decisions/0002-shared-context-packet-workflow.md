# Decision: Shared Context Packet Workflow

## Status

Accepted.

## Context

Supermodels review quality depends on providers receiving the same useful context Codex has. A git diff alone is often insufficient: the user may be asking about a recent planning discussion, a committed change, a release decision, a prior failed review, or facts Codex learned while inspecting the repository.

The manual workflow this replaces is: Codex completes work, the user copies Codex's request and response into Claude Code for review, then copies that review back into Codex. The useful part of that workflow is not a special tool; it is the explicit handoff of intent, transcript facts, implementation summary, and repository evidence.

## Decision

Supermodels now compiles a shared context packet for review, adversarial-review, and task runs. The packet is persisted with the job and supplied to providers before they review or act.

The packet contains:

- User intent: command, mode, focus, task text, and write mode.
- Explicit Codex/user context: `--context`, `--context-file`, or a skill-created private brief for recent session context.
- Repository evidence: workspace metadata, diff target, diff summary, changed files, and a bounded diff excerpt.
- Provider plan: requested, selected, and skipped providers.
- Reviewer task instructions that tell providers how to use the packet.

The packet treats supplied context as untrusted background. Providers must still use repository tools before reporting code findings.

No runtime dependency on graphify, MCP, or any other local knowledge system is introduced. If Codex has already learned useful facts from graphify or another local tool, those facts can be summarized into the explicit context brief. Providers should not be expected to run graphify or depend on it being present.

Status and result output expose the packet summary and artifact paths so users can inspect what was handed to providers.

## Deferred C-Phase Work

These Claude Code-style harness ideas remain useful but are intentionally not part of this phase:

- Session transcript replay: first-class JSONL conversation capture and replay into provider review sessions.
- Automatic context compaction: summarize older context when the explicit brief grows too large.
- Context-source plugins: optional adapters that can summarize graphify, Beads, design docs, PR comments, or issue trackers into the same explicit brief format.
- Prompt-cache/context-management hints for providers that expose stable APIs for them.
- Long-output continuation: automatic follow-up turns when a provider hits response limits before a complete structured result.
- Richer result UX: status/result commands that show packet diffs, context provenance, and provider evidence coverage summaries.

## Consequences

- Review/task/adversarial-review share one handoff contract instead of each building context differently.
- The design improves no-diff and already-committed reviews without adding a daemon or provider-specific session server.
- Future context sources can be adopted behind the packet compiler without changing provider adapters or job lifecycle.
