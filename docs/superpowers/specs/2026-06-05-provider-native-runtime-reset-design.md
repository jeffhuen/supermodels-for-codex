# Provider-Native Runtime Reset Design

## Problem

Supermodels drifted from its original purpose: let Codex ask Claude Code and Antigravity for independent review. The implementation tried to own external provider sessions through detached processes, PID sidecars, lock heartbeats, stale process reconciliation, and cancellation escalation. That made Supermodels responsible for lifecycle details that belong to provider runtimes.

The repeated cancellation fixes are a symptom of the wrong boundary. Supermodels should broker provider-native sessions and artifacts, not simulate a provider app server with generic PID state.

## Goal

Reset the runtime so v0.1.0 is a small, reliable Codex plugin that:

- Runs Claude Code and Antigravity through their installed native CLIs.
- Preserves provider session/conversation IDs when those CLIs expose them.
- Produces attributed review and task results for Codex to validate.
- Keeps background/status/result as thin Supermodels job wrappers.
- Treats cancel as worker cancellation only, unless a provider-native interrupt API is verified later.

## Non-Goals

- Do not keep provider PID sidecars.
- Do not keep the provider supervisor handshake.
- Do not pretend Supermodels can interrupt provider-native conversations unless the provider exposes that as a scriptable command.
- Do not use the Antigravity Cloud Code OAuth transport for code review.
- Do not use the Claude or Antigravity SDKs in this release.
- Do not add a rescue command until at least one provider-native rescue/task control surface is verified.

## Provider Capabilities

Each adapter declares capabilities in code:

```js
{
  review: true,
  adversarialReview: true,
  task: true,
  writeTask: true,
  resume: true,
  nativeInterrupt: false,
  background: "worker"
}
```

The broker can route commands by capability, and docs must describe capability gaps plainly.

Claude Code currently supports review/task execution through:

- `claude -p`
- `--output-format stream-json`
- `--json-schema`
- `--session-id`, `--resume`, and `--continue`
- tool allowlists and permission modes

Antigravity currently supports review/task execution through:

- `agy -p`
- `--conversation`
- `--continue`
- `--sandbox`
- provider model selection

Antigravity docs also describe conversations, artifacts, plugins, and subagents, but the installed CLI help does not expose a noninteractive background launch or interrupt command. Supermodels should not invent that missing protocol.

## Probe Results

Native CLI probes verified the reset assumptions before implementation:

- Claude Code inspected a temp `sentinel.txt`, returned schema-validated `stream-json`, emitted a session ID, resumed that session with `--resume`, and created a temp file when run with `--permission-mode acceptEdits`.
- Claude Code `stream-json` requires `--verbose`; the current adapter already includes it.
- Antigravity inspected a temp `sentinel.txt`, returned JSON, resumed with `--conversation`, and created a temp file when explicitly run with `--dangerously-skip-permissions`.
- Antigravity print-mode resume can replay previous conversation output before the new answer, so result parsing must prefer the last valid JSON object, not the first JSON object.
- Antigravity does not print a conversation ID on stdout/stderr in the normal path. With `--log-file` outside the workspace, the log includes `Created conversation <uuid>`, which can be parsed safely without exposing the log to the reviewed workspace.
- Putting Antigravity logs inside the workspace can distract the agent into reading its own log. Supermodels must keep provider logs outside the provider-visible working tree or explicitly exclude them from prompts.

## Runtime Architecture

The runtime has three layers:

1. Command layer: parse CLI flags, render human/json output, and start foreground/live/background commands.
2. Broker layer: provider selection, git context, prompt rendering, provider execution, result normalization, and artifact writing.
3. Provider layer: Claude Code and Antigravity CLI adapters.

The broker does not own provider lifetime beyond the direct child process it starts. It records provider sessions when exposed but never uses stale provider PIDs as durable truth.

## Background Jobs

Background mode remains as a thin worker wrapper:

- Parent creates a job file and spawns one detached Node worker.
- Worker owns provider child processes directly.
- Job status stores the worker PID, not provider PID sidecars.
- `status` and `result` read job files and artifacts.
- `cancel` transitions queued/running jobs to cancelled and signals only the worker PID.
- The worker forwards SIGTERM/SIGINT to its active provider child.

If the worker dies before finalizing, `status` may report a stale running job until the job becomes stale by timestamp. This is acceptable for v0.1.0 because it is explicit worker-state handling, not simulated provider session control.

## Foreground And Live Runs

Foreground/live runs should avoid background cancellation machinery. Ctrl+C is handled by the active process runner, which forwards the signal to the current provider child and lets the runtime mark the job cancelled where possible.

Live progress remains best-effort provider event reporting. It should not expose implementation internals in user-facing skill updates.

## State And Artifacts

State remains in the Codex plugin data directory:

```text
~/.codex/plugins/data/supermodels
```

Job files and run artifacts are private:

- directories: `0700`
- files: `0600`

Artifacts:

- raw provider output
- provider stderr
- normalized JSON
- prompt file when required for provider transport
- command metadata

Provider prompt artifacts can remain in the run directory because the run directory is private and artifact inspection is useful for debugging.

## Tests

Keep tests that prove product behavior:

- args and provider selection
- git context safety
- prompt safety
- provider command construction
- structured review parsing/normalization
- state privacy and artifact writing
- foreground/live review/task job behavior
- background worker argument construction
- worker-only cancellation behavior

Delete tests that only defend the old bad premise:

- provider PID sidecar races
- process identity checks for provider PIDs
- stale lock owner-token race reproductions created solely for sidecar cancellation
- supervisor handshake artifact/privacy tests

## Release Criteria

- Source tests pass.
- Installed-cache tests pass after reinstall.
- Plugin validation passes.
- `$supermodels:setup` reports at least one ready provider and no stale Cloud Code/OAuth backend.
- Live review with Claude Code works.
- Live review with Antigravity works.
- Two-provider live review works.
- Background review can be started, watched, and read.
- Cancel only claims worker cancellation, not provider-native interrupt.
