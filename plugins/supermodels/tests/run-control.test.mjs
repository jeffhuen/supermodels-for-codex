import assert from "node:assert/strict";
import test from "node:test";

import {
  CANCEL_GRACE_MS,
  PROVIDER_SIGKILL_MS,
  createRunController,
  signalExitCode,
} from "../scripts/lib/run-control.mjs";

test("run controller records cancellation synchronously and notifies listeners once", () => {
  const controller = createRunController();
  const events = [];
  const unsubscribe = controller.onCancel((signal) => {
    events.push([signal, controller.cancelled, controller.signal, Boolean(controller.cancelledAt)]);
  });

  assert.equal(controller.cancelled, false);
  assert.equal(controller.cancel("SIGINT"), true);
  assert.equal(controller.cancel("SIGTERM"), false);
  unsubscribe();

  assert.equal(controller.cancelled, true);
  assert.equal(controller.signal, "SIGINT");
  assert.equal(signalExitCode(controller.signal), 130);
  assert.deepEqual(events, [["SIGINT", true, "SIGINT", true]]);
});

test("run controller exposes cancellation as an AbortSignal", () => {
  const controller = createRunController();

  assert.equal(controller.abortSignal.aborted, false);
  controller.cancel("SIGTERM");

  assert.equal(controller.abortSignal.aborted, true);
  assert.match(String(controller.abortSignal.reason), /cancelled/i);
});

test("signal timing constants keep cancel escalation after provider cleanup", () => {
  assert(PROVIDER_SIGKILL_MS > 0);
  assert(CANCEL_GRACE_MS >= PROVIDER_SIGKILL_MS);
  assert.equal(signalExitCode("SIGTERM"), 143);
});
