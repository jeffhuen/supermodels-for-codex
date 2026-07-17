export async function awaitAbortable(operation, signal) {
  throwIfAborted(signal);
  const promise = Promise.resolve().then(operation);
  if (!signal) {
    return await promise;
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

export async function withAbortTimeout(operation, timeoutMs, label = "Operation") {
  const controller = new AbortController();
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timed out after ${timeout}ms.`));
  }, timeout);
  try {
    return await awaitAbortable(() => operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(signal?.reason ? String(signal.reason) : "Operation aborted.");
}
