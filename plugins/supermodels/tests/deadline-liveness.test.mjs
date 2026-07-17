import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("awaited review deadlines keep a handle-less CLI alive until they reject", async () => {
  const moduleUrl = (relativePath) => pathToFileURL(path.resolve(import.meta.dirname, relativePath)).href;
  const script = `
    import { withAbortTimeout } from ${JSON.stringify(moduleUrl("../scripts/lib/abort.mjs"))};
    import { runReviewAgent } from ${JSON.stringify(moduleUrl("../scripts/lib/review-agent.mjs"))};
    import { ClaudeOAuthMessagesTransport } from ${JSON.stringify(moduleUrl("../scripts/providers/claude/messages-transport.mjs"))};
    import { GrokOAuthResponsesTransport } from ${JSON.stringify(moduleUrl("../scripts/providers/grok/responses-transport.mjs"))};
    import { AntigravityCodeAssistTransport } from ${JSON.stringify(moduleUrl("../scripts/providers/antigravity/code-assist-transport.mjs"))};

    const never = () => new Promise(() => {});
    const expectDeadline = async (label, operation) => {
      try {
        await operation();
        throw new Error(label + " unexpectedly completed");
      } catch (error) {
        if (!/timed out|timeout|deadline|aborted/i.test(String(error?.message ?? error))) {
          throw error;
        }
      }
    };

    await expectDeadline("abort helper", () => withAbortTimeout(never, 30, "liveness probe"));
    await expectDeadline("review loop", () => runReviewAgent({
      provider: "probe",
      transport: { messages: never },
      tools: { schemas: [], execute: async () => ({ ok: true }) },
      timeoutMs: 30,
    }));

    const credentials = { accessToken: never, identity: async () => ({}) };
    await expectDeadline("claude transport", () => new ClaudeOAuthMessagesTransport({ credentials })
      .messages({ model: "probe", messages: [] }, { timeoutMs: 30 }));
    await expectDeadline("grok transport", () => new GrokOAuthResponsesTransport({
      credentials,
      clientVersion: "probe",
    }).messages({ model: "probe", messages: [] }, { timeoutMs: 30 }));
    await expectDeadline("antigravity transport", () => new AntigravityCodeAssistTransport({
      credentials,
      projectId: "probe",
    }).messages({ model: "probe", messages: [] }, { timeoutMs: 30 }));

    process.stdout.write("all-deadlines-fired\\n");
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 5_000,
  });
  assert.equal(stdout.trim(), "all-deadlines-fired");
});
