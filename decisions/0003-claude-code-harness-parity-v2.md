# Decision: Claude Code Harness Parity Is A v2 Catch-Up Target

## Status

Accepted for v2 planning.

## Context

Supermodels direct reviews now use provider OAuth transports and a shared local tool loop instead of shelling out to `claude -p` or treating providers as single-shot chat endpoints. That gives Claude Code and Antigravity the core agent behavior needed for serious reviews:

- send an explicit message history, system instructions, tools, reasoning settings, and context packet to the provider;
- let the provider emit tool calls;
- execute repository tools locally;
- append tool results back into the conversation;
- stop when the provider returns an accepted final structured review or accepted structured final text.

This matches the important shape of the Claude Code harness, but it is not full Claude Code runtime parity. Claude Code has a larger surrounding agent harness: incremental UI streaming, local JSONL transcripts, resume/session hydration, richer tool and MCP integration, subagents, memory, stop hooks, prompt-cache/context-management controls, auto-compaction, long-output continuation, and more detailed context provenance.

The v0.1.0 goal is reliable provider reviews, not a full reimplementation of Claude Code. However, the manual workflow Supermodels replaces is stronger than a narrow diff reviewer: the user can paste a whole Codex conversation, implementation summary, tool discoveries, and follow-up intent into Claude Code. Supermodels should keep catching up to that experience.

## Decision

Treat full Claude Code harness parity as a v2 catch-up target, not a v0.1.0 release blocker.

Supermodels should keep the provider-agnostic shared review loop as the architectural center. v2 work should selectively adopt Claude Code-style harness capabilities that materially improve review quality or observability without copying the entire Claude Code runtime.

The v2 catch-up backlog is:

- Incremental provider streaming: expose text/thinking/tool-call stream events in live status instead of collecting each provider turn only after completion.
- Session/context replay: persist and replay richer Codex conversation context, implementation summaries, and prior tool discoveries into provider sessions.
- Automatic context compaction: summarize older explicit context when it grows too large while preserving user intent, decisions, inspected files, and findings.
- Long-output continuation: recover when a provider hits output limits before producing a complete structured review.
- Richer context provenance: show what context packet sections, files, searches, and tool results each provider actually used.
- Optional context-source adapters: allow Codex-learned facts from systems such as graphify, Beads, issue trackers, or PR comments to be summarized into the packet without making any of them required provider dependencies.
- Broader safe tool coverage: consider adding more read-only inspection tools where they materially improve provider review depth.

## Non-Goals

- Do not adopt the public Claude Agent SDK for this path.
- Do not return to `claude -p` for review quality.
- Do not make graphify, MCP, or any other local knowledge system a hard dependency.
- Do not copy the full Claude Code harness wholesale unless a specific component is justified and maintainable.
- Do not weaken the current structured review and evidence gates just to mimic Claude Code output shape.

## Consequences

- v0.1.0 remains honest: Supermodels provides the same core tool-call review class, not full Claude Code UX/runtime parity.
- Future reviews should treat missing full-harness features as v2 roadmap items unless they cause concrete v0.1.0 review failure.
- The shared review loop remains small and maintainable while giving v2 a clear direction for quality catch-up.
