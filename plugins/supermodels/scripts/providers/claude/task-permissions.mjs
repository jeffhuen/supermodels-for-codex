import fs from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Single source of truth for the task tool names. The broker hook policy (below)
// and the CLI `--tools` availability allowlist (adapter.mjs buildClaudeCommand)
// both derive from these arrays so the coarse availability bound and the
// per-call path-scoping can never drift apart. Bash is intentionally absent from
// both: with no OS sandbox on Claude tasks, shell voids path-gating.
export const READ_TASK_TOOL_NAMES = ["Read", "Grep", "Glob", "LS", "NotebookRead"];
export const EDIT_TASK_TOOL_NAMES = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const READ_TOOLS = new Set(READ_TASK_TOOL_NAMES);
const EDIT_TOOLS = new Set(EDIT_TASK_TOOL_NAMES);

function canonicalWithinCwd(cwd, filePath) {
  if (!filePath) return false;
  let root;
  try { root = fs.realpathSync(path.resolve(cwd)); } catch { root = path.resolve(cwd); }
  // realpath the deepest existing ancestor of the target, then re-append the tail.
  let probe = path.resolve(root, filePath);
  const tail = [];
  for (;;) {
    try { probe = fs.realpathSync(probe); break; }
    catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;         // filesystem root, unresolvable
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
  const resolved = tail.length ? path.join(probe, ...tail) : probe;
  return resolved === root || resolved.startsWith(root + path.sep);
}

export function claudeTaskPermissionDecision({ toolName, toolInput = {}, cwd }, policy = {}) {
  const write = Boolean(policy.write);
  if (READ_TOOLS.has(toolName)) return { decision: "allow", reason: "read-only tool" };
  if (toolName === "Bash") {
    // No OS sandbox on Claude tasks: shell voids path-gating. Deny in both modes.
    return { decision: "deny", reason: "shell is not permitted (no sandbox)" };
  }
  if (EDIT_TOOLS.has(toolName)) {
    if (!write) return { decision: "deny", reason: "read-only task: edits are not permitted" };
    const target = toolInput.file_path ?? toolInput.notebook_path;
    if (!canonicalWithinCwd(cwd, target)) return { decision: "deny", reason: "path outside workspace" };
    return { decision: "allow", reason: "sanctioned in-workspace edit" };
  }
  return { decision: "deny", reason: "unrecognized tool (fail closed)" };
}

// Generates the broker's isolated PreToolUse hook: a self-contained 0755 node
// script that evaluates `claudeTaskPermissionDecision` on the CLI's stdin and
// prints the decision contract, plus a 0600 settings file registering it as a
// PreToolUse matcher ".*". Per the B0 verification on CLI 2.1.209 the hook is a
// bare `command` STRING pointing at the 0755 script (temp paths are space-free).
// `--permission-mode dontAsk` is fail-closed for *writes* (a broken hook still
// denies a Write), so no `permissions` baseline is emitted here. It is NOT
// fail-closed for read-only shell — `Bash` is contained separately by the
// `--tools` allowlist in buildClaudeCommand, not by these settings. The script
// imports the policy module by file: URL so the single source of truth resolves
// robustly across Node versions.
export async function writeClaudeTaskHook({ dir, cwd, write }) {
  await mkdir(dir, { recursive: true });
  const policyModule = path.join(HERE, "task-permissions.mjs");
  const hookScriptPath = path.join(dir, "claude-approve.mjs");
  const script = `#!/usr/bin/env node
import { claudeTaskPermissionDecision } from ${JSON.stringify(pathToFileURL(policyModule).href)};
let raw = ""; process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let msg = {}; try { msg = JSON.parse(raw); } catch {}
  const { decision, reason } = claudeTaskPermissionDecision(
    { toolName: msg.tool_name, toolInput: msg.tool_input, cwd: ${JSON.stringify(cwd)} },
    { write: ${write ? "true" : "false"} },
  );
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  }));
});
`;
  await writeFile(hookScriptPath, script, { mode: 0o755 });
  const settingsPath = path.join(dir, "settings.json");
  const settings = {
    hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: hookScriptPath }] }] },
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { settingsPath, hookScriptPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
