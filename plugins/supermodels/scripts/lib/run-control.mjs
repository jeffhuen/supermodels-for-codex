export const PROVIDER_SIGKILL_MS = 1000;
export const CANCEL_GRACE_MS = 1500;

export function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

export function createRunController() {
  let cancelled = false;
  let signal = null;
  let cancelledAt = null;
  const listeners = new Set();
  const abortController = new AbortController();

  return {
    get cancelled() {
      return cancelled;
    },
    get signal() {
      return signal;
    },
    get cancelledAt() {
      return cancelledAt;
    },
    get abortSignal() {
      return abortController.signal;
    },
    cancel(nextSignal) {
      if (cancelled) {
        return false;
      }
      cancelled = true;
      signal = nextSignal;
      cancelledAt = new Date().toISOString();
      abortController.abort(new Error(`Run cancelled by ${nextSignal || "request"}.`));
      for (const listener of [...listeners]) {
        try {
          listener(nextSignal);
        } catch {
          // Cancellation listeners are best-effort process cleanup hooks.
        }
      }
      return true;
    },
    onCancel(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
