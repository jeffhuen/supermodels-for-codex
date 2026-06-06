export function buildBackgroundChildArgs(input) {
  const args = [
    input.scriptPath,
    input.command,
    ...serializeOptions({
      ...input.options,
      background: false,
      "job-id": input.jobId ?? input.options?.["job-id"],
    }),
  ];
  if (input.positionals?.length) {
    args.push("--", ...input.positionals);
  }
  return args;
}

export function markBackgroundJobRunning(current, pid) {
  if (["cancelled", "completed", "failed", "partial"].includes(current.status)) {
    return current;
  }
  return {
    ...current,
    status: "running",
    pid,
  };
}

export function serializeOptions(options = {}) {
  const args = [];
  for (const [key, value] of Object.entries(options)) {
    if (key === "json") {
      continue;
    }
    if (value === false || value === undefined || value === null || value === "") {
      continue;
    }
    if (value === true) {
      args.push(`--${key}`);
    } else {
      args.push(`--${key}`, String(value));
    }
  }
  return args;
}
