# Provider-Native Runtime Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the fragile provider PID/session ownership model and ship a simpler provider-native Supermodels runtime.

**Architecture:** Keep Claude Code and Antigravity adapters as native CLI runners, but make the broker record provider sessions and artifacts instead of controlling provider lifetime by PID sidecars. Background mode becomes a thin worker wrapper with worker-only cancellation.

**Tech Stack:** Node ESM runtime, Node test runner, installed `claude` CLI, installed `agy` CLI, Codex plugin skills.

---

### Task 1: Delete Provider PID Sidecars And Supervisor

**Files:**
- Delete: `plugins/supermodels/scripts/lib/provider-pids.mjs`
- Delete: `plugins/supermodels/scripts/lib/process-supervisor.mjs`
- Modify: `plugins/supermodels/scripts/lib/process.mjs`
- Modify: `plugins/supermodels/scripts/lib/runtime.mjs`
- Delete: `plugins/supermodels/tests/provider-pids.test.mjs`
- Modify: `plugins/supermodels/tests/process.test.mjs`
- Modify: `plugins/supermodels/tests/runtime.test.mjs`

- [x] Remove `provider-pids.mjs` imports from runtime and cancellation code.
- [x] Remove `supervised` process handoff from `runCommand()`.
- [x] Make `runCommand()` spawn the provider child directly. It may use a process group for timeout cleanup, but the active Supermodels process is the only owner of that child.
- [x] Forward SIGINT/SIGTERM from the active Supermodels process to the active provider child while it is running, and clear signal handlers on close/error.
- [x] Keep timeout SIGTERM/SIGKILL inside `runCommand()` because the runner owns that child directly.
- [x] Update provider adapters so they no longer pass `supervised: true`.
- [x] Delete tests that assert provider sidecar behavior or supervisor handshakes.
- [x] Add tests for direct child signal forwarding and timeout cleanup.

### Task 2: Simplify Broker Job Lifecycle

**Files:**
- Modify: `plugins/supermodels/scripts/lib/runtime.mjs`
- Modify: `plugins/supermodels/scripts/lib/state.mjs`
- Modify: `plugins/supermodels/tests/runtime.test.mjs`
- Modify: `plugins/supermodels/tests/state.test.mjs`

- [x] Keep `runReview()` and `runTask()` responsible for creating jobs, marking them running, executing provider calls, writing artifacts, and finalizing.
- [x] Store only the worker/orchestrator PID on the job record.
- [x] Keep provider `pid` fields as non-authoritative progress metadata only.
- [x] Remove provider PID reconciliation from `getStatus()`.
- [x] Replace status reconciliation with stale-worker handling based only on `job.pid`, `job.pidStartedAt`, and `updatedAt`.
- [x] Keep terminal statuses immutable: `cancelled`, `completed`, `partial`, and `failed`.
- [x] Update tests to assert job status and artifacts, not provider process ownership.

### Task 3: Replace Cancellation With Worker-Only Semantics

**Files:**
- Modify: `plugins/supermodels/scripts/lib/cancellation.mjs`
- Modify: `plugins/supermodels/scripts/supermodels.mjs`
- Modify: `plugins/supermodels/tests/cancellation.test.mjs`
- Modify: `plugins/supermodels/skills/cancel/SKILL.md`
- Modify: `README.md`
- Modify: `plugins/supermodels/README.md`

- [x] Make `cancelJob()` transition queued/running jobs to `cancelled`.
- [x] If the job has a live worker PID, send SIGTERM to that worker.
- [x] Do not signal provider PIDs.
- [x] Do not claim provider-native interrupt.
- [x] Make already-terminal jobs return a no-op result.
- [x] Make cancel output say exactly whether a worker was signaled.
- [x] Update docs and skill text to describe worker cancellation.

### Task 4: Capability-Gate Provider Features

**Files:**
- Modify: `plugins/supermodels/scripts/providers/claude/adapter.mjs`
- Modify: `plugins/supermodels/scripts/providers/antigravity/adapter.mjs`
- Modify: `plugins/supermodels/scripts/lib/runtime.mjs`
- Modify: `plugins/supermodels/scripts/supermodels.mjs`
- Modify: `plugins/supermodels/tests/providers.test.mjs`
- Modify: `plugins/supermodels/tests/runtime.test.mjs`

- [x] Expand provider `capabilities()` to include `adversarialReview`, `writeTask`, `nativeInterrupt`, and `background`.
- [x] Ensure task `--write` requires exactly one provider with `writeTask`.
- [x] Keep `--resume` provider-specific and pass it to Claude `--resume` and Antigravity `--conversation`.
- [x] Capture Antigravity conversation IDs by writing `--log-file` outside the workspace and parsing `Created conversation <uuid>`.
- [x] Parse Antigravity structured JSON by taking the last valid JSON object because resumed print mode may replay earlier conversation output.
- [x] Keep Antigravity log files outside the provider-visible workspace so the agent does not inspect its own runtime log.
- [x] Do not add `rescue` until a provider-native launch/resume/interrupt contract is verified.
- [x] Add tests that capability output is visible in `providers --json`.

### Task 5: Update Public Docs And Skills

**Files:**
- Modify: `README.md`
- Modify: `plugins/supermodels/README.md`
- Modify: `plugins/supermodels/skills/review/SKILL.md`
- Modify: `plugins/supermodels/skills/adversarial-review/SKILL.md`
- Modify: `plugins/supermodels/skills/task/SKILL.md`
- Modify: `plugins/supermodels/skills/status/SKILL.md`
- Modify: `plugins/supermodels/skills/result/SKILL.md`
- Modify: `plugins/supermodels/skills/cancel/SKILL.md`

- [x] State that Supermodels is a reverse `codex-plugin-cc` style broker for Codex.
- [x] State that provider CLIs own their native sessions.
- [x] State that background/cancel is worker-level in v0.1.0.
- [x] Remove stale claims about provider PID tracking or provider-native interrupt.
- [x] Keep progress-update guidance terse.

### Task 6: Verify And Reinstall

**Files:**
- Modify as needed: `plugins/supermodels/.codex-plugin/plugin.json`

- [x] Run `node --test plugins/supermodels/tests/*.test.mjs`.
- [x] Run plugin validation.
- [ ] Reinstall the plugin from the current repo or release ref.
- [ ] Run installed-cache tests.
- [x] Run `$supermodels:setup` equivalent through the source runtime.
- [x] Smoke test live Claude-only review.
- [x] Smoke test live Antigravity-only review.
- [x] Smoke test two-provider live review.
