#!/usr/bin/env node
// Minimal scripted ACP agent for tests. Modes via FAKE_ACP_MODE:
//   read (default): one read tool_call, then a message, end_turn
//   write: requests permission for a write; approved -> completes; rejected -> failed + cancelled
//   crash: emits a tool_call, sends session/request_permission, then exits
//     immediately without reading the client's response (simulates the agent
//     dying mid-permission-exchange, e.g. crash or EPIPE regression coverage)
//   linger: like read, but ignores stdin EOF and stays alive until killed
//     (the real `grok agent stdio` does not exit on EOF)
//   redirect: first prompt requests permission for a shell Execute (denied on
//     read-only tasks -> cancelled); a follow-up prompt answers normally
//   unknown-kind: requests permission with a single unrecognized option kind;
//     reports "permission-cancelled" if the client fails closed (cancelled
//     outcome, no optionId) or "permission-unexpectedly-selected" otherwise
//   reject-always: requests permission with only a reject_always option;
//     reports "reject-always-honored" if the client selects it
//   escape: sends an agent->client fs/read_text_file request for a relative
//     path that escapes the workspace root; reports "fs-denied" if the
//     client returns a JSON-RPC error or "fs-leaked" if it returns content
import readline from "node:readline";

const mode = process.env.FAKE_ACP_MODE ?? "read";
if (mode === "linger") {
  setInterval(() => {}, 1_000);
}
let promptCount = 0;
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const update = (sessionId, update_) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: update_ } });
let nextId = 1000;
const pendingPermission = new Map();
const pendingFsRead = new Map();

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session-1" } });
  } else if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    if (mode === "crash") {
      update(sessionId, {
        sessionUpdate: "tool_call", toolCallId: "tc-2", title: "Write `out.txt`",
        rawInput: { target_file: "out.txt" },
      });
      send({
        jsonrpc: "2.0", id: nextId += 1, method: "session/request_permission",
        params: {
          toolCall: { toolCallId: "tc-2", title: "Write `out.txt`" },
          options: [
            { optionId: "allow-edits-session", name: "Yes, always", kind: "allow_always" },
            { optionId: "allow-once", name: "Yes", kind: "allow_once" },
            { optionId: "reject-once", name: "No", kind: "reject_once" },
          ],
        },
      });
      // Die before the client's permission response can be read, so its
      // write lands on a dead/closing pipe (async EPIPE regression coverage).
      process.exit(1);
      return;
    }
    if (mode === "redirect") {
      promptCount += 1;
      if (promptCount === 1) {
        const permissionId = nextId += 1;
        pendingPermission.set(permissionId, sessionId);
        send({
          jsonrpc: "2.0", id: permissionId, method: "session/request_permission",
          params: {
            toolCall: { toolCallId: "tc-2", title: "Execute `find .`" },
            options: [
              { optionId: "allow-once", name: "Yes", kind: "allow_once" },
              { optionId: "reject-once", name: "No", kind: "reject_once" },
            ],
          },
        });
        pendingPermission.set(`${permissionId}:promptId`, msg.id);
      } else {
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "redirected answer" } });
        send({
          jsonrpc: "2.0", id: msg.id,
          result: { stopReason: "end_turn", _meta: { inputTokens: 30, outputTokens: 4, totalTokens: 34 } },
        });
      }
      return;
    }
    if (mode === "unknown-kind") {
      const permissionId = nextId += 1;
      pendingPermission.set(permissionId, sessionId);
      pendingPermission.set(`${permissionId}:promptId`, msg.id);
      pendingPermission.set(`${permissionId}:mode`, "unknown-kind");
      send({
        jsonrpc: "2.0", id: permissionId, method: "session/request_permission",
        params: {
          toolCall: { toolCallId: "tc-3", title: "Do something unusual" },
          options: [
            { optionId: "custom-1", name: "Custom", kind: "custom_manual_review" },
          ],
        },
      });
      return;
    }
    if (mode === "reject-always") {
      const permissionId = nextId += 1;
      pendingPermission.set(permissionId, sessionId);
      pendingPermission.set(`${permissionId}:promptId`, msg.id);
      pendingPermission.set(`${permissionId}:mode`, "reject-always");
      send({
        jsonrpc: "2.0", id: permissionId, method: "session/request_permission",
        params: {
          toolCall: { toolCallId: "tc-4", title: "Do something risky" },
          options: [
            { optionId: "reject-forever", name: "No, never", kind: "reject_always" },
          ],
        },
      });
      return;
    }
    if (mode === "escape") {
      const requestId = nextId += 1;
      pendingFsRead.set(requestId, msg.id);
      send({
        jsonrpc: "2.0", id: requestId, method: "fs/read_text_file",
        params: { sessionId, path: "../../outside.txt" },
      });
      return;
    }
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    update(sessionId, {
      sessionUpdate: "tool_call", toolCallId: "tc-1", title: "read_file",
      rawInput: { target_file: "some/file.txt" },
    });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" });
    if (mode === "write") {
      const permissionId = nextId += 1;
      pendingPermission.set(permissionId, sessionId);
      send({
        jsonrpc: "2.0", id: permissionId, method: "session/request_permission",
        params: {
          toolCall: { toolCallId: "tc-2", title: "Write `out.txt`" },
          options: [
            { optionId: "allow-edits-session", name: "Yes, always", kind: "allow_always" },
            { optionId: "allow-once", name: "Yes", kind: "allow_once" },
            { optionId: "reject-once", name: "No", kind: "reject_once" },
          ],
        },
      });
      pendingPermission.set(`${permissionId}:promptId`, msg.id);
    } else {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "read done" } });
      send({
        jsonrpc: "2.0", id: msg.id,
        result: { stopReason: "end_turn", _meta: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
      });
    }
  } else if (pendingFsRead.has(msg.id)) {
    const promptId = pendingFsRead.get(msg.id);
    const report = msg.error ? "fs-denied" : "fs-leaked";
    update("fake-session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: report } });
    send({
      jsonrpc: "2.0", id: promptId,
      result: { stopReason: "end_turn", _meta: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    });
  } else if (pendingPermission.has(msg.id)) {
    const sessionId = pendingPermission.get(msg.id);
    const promptId = pendingPermission.get(`${msg.id}:promptId`);
    const permMode = pendingPermission.get(`${msg.id}:mode`);
    if (permMode === "unknown-kind") {
      const outcome = msg.result?.outcome ?? {};
      const report = outcome.outcome === "cancelled" && !outcome.optionId
        ? "permission-cancelled"
        : "permission-unexpectedly-selected";
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: report } });
      send({
        jsonrpc: "2.0", id: promptId,
        result: { stopReason: "end_turn", _meta: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      });
      return;
    }
    if (permMode === "reject-always") {
      const optionId = msg.result?.outcome?.optionId ?? "";
      const report = optionId === "reject-forever" ? "reject-always-honored" : "reject-always-not-honored";
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: report } });
      send({
        jsonrpc: "2.0", id: promptId,
        result: { stopReason: "end_turn", _meta: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      });
      return;
    }
    const optionId = msg.result?.outcome?.optionId ?? "";
    if (optionId.startsWith("allow")) {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrote file" } });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn", _meta: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } } });
    } else {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "failed" });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled", _meta: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } } });
    }
  }
});
