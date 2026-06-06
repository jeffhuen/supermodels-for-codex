import { readFile, writeFile } from "node:fs/promises";

import { collectGitContext } from "./git.mjs";
import { commandLine } from "./process.mjs";
import { writeProviderPid } from "./provider-pids.mjs";
import { renderReviewPrompt, renderTaskPrompt } from "./prompts.mjs";
import {
  normalizeStructuredReview,
  parseStructuredReviewText,
} from "./review-schema.mjs";
import {
  createJob,
  createState,
  initializeProviderRuns,
  jobPath,
  listJobs,
  readJob,
  updateJob,
  updateProviderRun,
  writeProviderResult,
} from "./state.mjs";

const SUMMARY_LIMIT = 4000;

export function selectProviders(input) {
  const requested = input.requested ?? [];
  const checks = input.checks ?? {};
  const explicit = Boolean(input.explicit);
  const explicitSingleProvider = explicit && requested.length === 1;
  const selected = [];
  const skipped = [];

  for (const provider of requested) {
    const check = checks[provider];
    if (check?.ready) {
      selected.push(provider);
      continue;
    }

    const skippedEntry = {
      provider,
      reason: check?.error
        ? check.error
        : check?.auth === "missing"
          ? "not authenticated"
          : "not ready",
      check,
    };
    if (explicitSingleProvider) {
      throw new Error(`Provider '${provider}' is not ready: ${skippedEntry.reason}`);
    }
    skipped.push(skippedEntry);
  }

  if (selected.length === 0) {
    throw new Error("No requested providers are ready.");
  }

  return {
    selected: selected.slice(0, 2),
    skipped,
  };
}

export function normalizeProviderResult(input) {
  const rawText = String(input.rawText ?? "").trim();
  const stderrSummary = summarizeError(input.stderr);
  const structured = normalizeStructuredReview(input.structured) ?? parseStructuredReviewText(rawText);
  if (structured) {
    return {
      provider: input.provider,
      verdict: structured.verdict,
      summary: structured.summary || summarize(rawText),
      findings: structured.findings,
      assumptions: structured.assumptions,
      verification_gaps: structured.verification_gaps,
      output_valid: true,
      provider_session_id: input.sessionId ?? "",
      raw_result_path: input.rawResultPath ?? "",
    };
  }

  if (input.requireStructured) {
    return {
      provider: input.provider,
      verdict: "invalid-output",
      summary: stderrSummary
        ? `Provider failed before returning structured review output: ${stderrSummary}`
        : "Provider did not return the required structured review JSON. Raw output was preserved for inspection.",
      findings: [],
      assumptions: [],
      verification_gaps: [stderrSummary
        ? "Inspect the provider stderr artifact for the full crash details."
        : "Inspect the raw provider artifact and retry if the provider returned irrelevant CLI/help text."],
      output_valid: false,
      provider_session_id: input.sessionId ?? "",
      raw_result_path: input.rawResultPath ?? "",
    };
  }

  const findings = extractFindings(rawText);
  const verdict = classifyVerdict(rawText, findings);

  return {
    provider: input.provider,
    verdict,
    summary: summarize(rawText),
    findings,
    assumptions: [],
    verification_gaps: [],
    output_valid: true,
    provider_session_id: input.sessionId ?? "",
    raw_result_path: input.rawResultPath ?? "",
  };
}

export function synthesizeProviderResults(results) {
  const lines = ["# Supermodels Review", "", "## Provider Results", ""];
  for (const result of results) {
    const label = providerLabel(result.provider);
    lines.push(`### ${label}`);
    lines.push(`Verdict: ${result.verdict ?? "inconclusive"}`);
    if (result.output_valid === false) {
      lines.push(result.summary ?? "Provider output was invalid.");
    } else if (Array.isArray(result.findings) && result.findings.length) {
      if (result.summary) {
        lines.push(result.summary);
      }
      lines.push("");
      lines.push("Findings:");
      for (const finding of [...result.findings].sort(compareFindings)) {
        const location = formatFindingLocation(finding);
        const confidence = finding.confidence ? `[${finding.confidence} confidence]` : "";
        lines.push(`- [${finding.severity}]${confidence} ${finding.title || finding.body}${location ? ` (${location})` : ""}`);
        pushFindingDetail(lines, "Evidence", finding.evidence || finding.body);
        pushFindingDetail(lines, "Impact", finding.impact);
        pushFindingDetail(lines, "Recommendation", finding.recommendation);
      }
    } else {
      lines.push(`No material findings reported by ${label}.`);
      if (result.summary) {
        lines.push(result.summary);
      }
    }
    if (Array.isArray(result.assumptions) && result.assumptions.length) {
      lines.push("");
      lines.push("Assumptions:");
      for (const assumption of result.assumptions) {
        lines.push(`- ${assumption}`);
      }
    }
    if (Array.isArray(result.verification_gaps) && result.verification_gaps.length) {
      lines.push("");
      lines.push("Verification gaps:");
      for (const gap of result.verification_gaps) {
        lines.push(`- ${gap}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function checkProviders(adapters, options = {}) {
  const entries = await Promise.all(
    Object.entries(adapters).map(async ([id, adapter]) => [id, await adapter.check(options)]),
  );
  return Object.fromEntries(entries);
}

export async function setupProviders(adapters, options = {}) {
  const entries = await Promise.all(
    Object.entries(adapters).map(async ([id, adapter]) => {
      const setup = adapter.setup ? await adapter.setup(options) : { ready: true, changed: false };
      const check = await adapter.check(options);
      return [id, {
        setup,
        check,
      }];
    }),
  );
  return Object.fromEntries(entries);
}

export async function runReview({ adapters, providerSelection, mode, options, focus, workspaceRoot }) {
  const state = createState({
    workspaceRoot,
    dataRoot: options["data-root"],
  });
  const checks = await checkProviders(adapters, { dataRoot: state.dataRoot });
  const providerPlan = selectProviders({
    requested: providerSelection.requested,
    explicit: providerSelection.explicit,
    checks,
  });
  const context = await collectGitContext({
    workspaceRoot,
    scope: options.scope ?? "working-tree",
    baseRef: options.base ?? "",
  });
  const job = options["job-id"]
    ? await readJob(state, options["job-id"])
    : await createJob(state, {
      command: mode,
      mode,
      requestedProviders: providerSelection.requested,
      selectedProviders: providerPlan.selected,
      skippedProviders: providerPlan.skipped,
      background: false,
      focus,
    });
  try {
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "running",
      stage: "calling-providers",
      request: {
        ...current.request,
        selectedProviders: providerPlan.selected,
        skippedProviders: providerPlan.skipped,
      },
    }));
    await initializeProviderRuns(state, job.id, providerPlan.selected);

    let writeQueue = Promise.resolve();
    const enqueueWrite = (operation) => {
      writeQueue = writeQueue.then(operation, operation);
      return writeQueue;
    };
    const providerRuns = await Promise.all(providerPlan.selected.map(async (provider) => {
      const adapter = adapters[provider];
      const check = checks[provider] ?? {};
      const prompt = await renderReviewPrompt({
        mode,
        providerId: provider,
        focus,
        context,
      });
      await enqueueWrite(() => updateProviderRun(state, job.id, provider, {
        status: "running",
        startedAt: new Date().toISOString(),
      }));
      const liveEvents = [];
      const recordStart = createProviderStartRecorder({
        state,
        jobId: job.id,
        job,
        provider,
        enqueueWrite,
      });
      const recordEvent = createProviderEventRecorder({
        state,
        jobId: job.id,
        provider,
        events: liveEvents,
        enqueueWrite,
      });
      const run = await runProviderSafely(provider, () => adapter.review({
        prompt,
        context,
        mode,
        focus,
      }, {
        model: options.model,
        effort: options.effort,
        resume: options.resume,
        bin: check.path || undefined,
        cwd: workspaceRoot,
        promptDir: job.dir,
        dataRoot: state.dataRoot,
        timeoutMs: Number(options.timeout || 0) || undefined,
        onStart: recordStart,
        onEvent: recordEvent,
      }));
      const events = mergeProviderEvents(liveEvents, run.events);
      const normalized = normalizeProviderResult({
        provider,
        rawText: run.rawText,
        stderr: run.stderr,
        sessionId: run.sessionId,
        structured: run.structured,
        requireStructured: true,
      });
      const providerRun = {
        provider,
        status: providerRunStatus(run, normalized),
        exitCode: run.exitCode,
        rawText: run.rawText,
        stderr: run.stderr,
        sessionId: run.sessionId,
        pid: run.pid ?? null,
        commandLine: run.commandLine,
        normalized,
        structured: run.structured ?? null,
        usage: run.usage ?? null,
        events,
        lastEvent: lastProviderEventMessage(events),
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      };
      await enqueueWrite(() => writeProviderResult(state, job.id, providerRun));
      return providerRun;
    }));
    await writeQueue;
    const providerResults = [];
    for (const run of providerRuns) {
      providerResults.push(run.normalized);
    }

    const synthesis = synthesizeProviderResults(providerResults);
    const completed = await updateJob(state, job.id, (current) => finalizeJob(current, providerRuns, synthesis));

    return {
      job: completed,
      checks,
      selected: providerPlan.selected,
      skipped: providerPlan.skipped,
      results: providerResults,
      synthesis: completed.synthesis ?? synthesis,
    };
  } catch (error) {
    await markJobFailedBestEffort(state, job.id, error);
    throw error;
  }
}

export async function runTask({ adapters, providerSelection, options, task, workspaceRoot }) {
  const state = createState({
    workspaceRoot,
    dataRoot: options["data-root"],
  });
  const checks = await checkProviders(adapters, { dataRoot: state.dataRoot });
  const providerPlan = selectProviders({
    requested: providerSelection.requested,
    explicit: providerSelection.explicit,
    checks,
  });
  const job = options["job-id"]
    ? await readJob(state, options["job-id"])
    : await createJob(state, {
      command: "task",
      mode: "task",
      requestedProviders: providerSelection.requested,
      selectedProviders: providerPlan.selected,
      skippedProviders: providerPlan.skipped,
      background: false,
      task,
      write: Boolean(options.write),
    });
  try {
    await updateJob(state, job.id, (current) => ({
      ...current,
      status: "running",
      stage: "calling-providers",
      request: {
        ...current.request,
        selectedProviders: providerPlan.selected,
        skippedProviders: providerPlan.skipped,
      },
    }));
    await initializeProviderRuns(state, job.id, providerPlan.selected);

    let writeQueue = Promise.resolve();
    const enqueueWrite = (operation) => {
      writeQueue = writeQueue.then(operation, operation);
      return writeQueue;
    };
    const providerRuns = await Promise.all(providerPlan.selected.map(async (provider) => {
      const adapter = adapters[provider];
      const check = checks[provider] ?? {};
      const prompt = await renderTaskPrompt({
        providerId: provider,
        task,
        write: Boolean(options.write),
      });
      await enqueueWrite(() => updateProviderRun(state, job.id, provider, {
        status: "running",
        startedAt: new Date().toISOString(),
      }));
      const liveEvents = [];
      const recordStart = createProviderStartRecorder({
        state,
        jobId: job.id,
        job,
        provider,
        enqueueWrite,
      });
      const recordEvent = createProviderEventRecorder({
        state,
        jobId: job.id,
        provider,
        events: liveEvents,
        enqueueWrite,
      });
      const command = await runProviderSafely(provider, () => adapter.task({ mode: "task", prompt, task }, {
        model: options.model,
        effort: options.effort,
        bin: check.path || undefined,
        cwd: workspaceRoot,
        promptDir: job.dir,
        dataRoot: state.dataRoot,
        timeoutMs: Number(options.timeout || 0) || undefined,
        write: Boolean(options.write),
        onStart: recordStart,
        onEvent: recordEvent,
      }));
      const events = mergeProviderEvents(liveEvents, command.events);
      const normalized = normalizeProviderResult({
        provider,
        rawText: command.rawText,
        stderr: command.stderr,
        sessionId: command.sessionId,
        structured: command.structured,
      });
      const providerRun = {
        provider,
        status: providerRunStatus(command, normalized),
        exitCode: command.exitCode,
        rawText: command.rawText,
        stderr: command.stderr,
        sessionId: command.sessionId,
        pid: command.pid ?? null,
        commandLine: command.commandLine,
        normalized,
        structured: command.structured ?? null,
        usage: command.usage ?? null,
        events,
        lastEvent: lastProviderEventMessage(events),
        startedAt: command.startedAt,
        completedAt: command.completedAt,
      };
      await enqueueWrite(() => writeProviderResult(state, job.id, providerRun));
      return providerRun;
    }));
    await writeQueue;
    const providerResults = [];
    for (const run of providerRuns) {
      providerResults.push(run.normalized);
    }

    const synthesis = synthesizeProviderResults(providerResults);
    const completed = await updateJob(state, job.id, (current) => finalizeJob(current, providerRuns, synthesis));

    return {
      job: completed,
      checks,
      selected: providerPlan.selected,
      skipped: providerPlan.skipped,
      results: providerResults,
      synthesis: completed.synthesis ?? synthesis,
    };
  } catch (error) {
    await markJobFailedBestEffort(state, job.id, error);
    throw error;
  }
}

export async function getStatus({ workspaceRoot, dataRoot, jobId }) {
  const state = createState({ workspaceRoot, dataRoot });
  return jobId ? await readJob(state, jobId) : await listJobs(state);
}

export async function markCancelled({ workspaceRoot, dataRoot, jobId }) {
  const state = createState({ workspaceRoot, dataRoot });
  return await updateJob(state, jobId, (job) => ({
    ...job,
    status: "cancelled",
    completedAt: new Date().toISOString(),
  }));
}

export function renderHumanResult(output) {
  const lines = [];
  lines.push(`Supermodels job ${output.job.id}: ${output.job.status}`);
  lines.push(`Selected providers: ${output.selected.join(", ")}`);
  if (output.skipped.length) {
    lines.push(`Skipped providers: ${output.skipped.map((item) => `${item.provider} (${item.reason})`).join(", ")}`);
  }
  lines.push("");
  lines.push(output.synthesis ?? synthesizeProviderResults(output.results ?? []));
  lines.push("");
  lines.push("Provider session IDs:");
  for (const run of Object.values(output.job.providerRuns ?? {})) {
    lines.push(`- ${run.provider}: ${run.sessionId || "not exposed"} (${run.rawResultPath})`);
  }
  return lines.join("\n");
}

export function commandLineForRun(command) {
  return commandLine(command);
}

async function runProviderSafely(provider, operation) {
  try {
    return await operation();
  } catch (error) {
    return {
      provider,
      exitCode: 1,
      failedBeforeOutput: true,
      rawText: `Provider ${provider} failed before producing review output.`,
      stderr: error?.stack || error?.message || String(error),
      sessionId: "",
      commandLine: "",
      events: [{
        type: "error",
        message: error?.message || String(error),
        at: new Date().toISOString(),
      }],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }
}

function createProviderEventRecorder({ state, jobId, provider, events, enqueueWrite }) {
  return (event) => {
    const normalized = normalizeProviderEvent(event);
    events.push(normalized);
    const recent = events.slice(-50);
    enqueueWrite(() => updateProviderRun(state, jobId, provider, {
      events: recent,
      lastEvent: normalized.message,
      usage: normalized.usage ?? undefined,
    }));
  };
}

function createProviderStartRecorder({ state, jobId, job, provider, enqueueWrite }) {
  return (start) => {
    const pid = Number(start?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return;
    }
    writeProviderPid(job, provider, pid);
    enqueueWrite(() => updateProviderRun(state, jobId, provider, { pid }));
  };
}

function normalizeProviderEvent(event) {
  const type = String(event?.type ?? "progress");
  const message = String(event?.message ?? type).trim() || type;
  return {
    type,
    message,
    at: event?.at ?? new Date().toISOString(),
    ...(event?.usage ? { usage: event.usage } : {}),
  };
}

function mergeProviderEvents(...eventGroups) {
  const merged = [];
  const seen = new Set();
  for (const group of eventGroups) {
    for (const event of group ?? []) {
      const normalized = normalizeProviderEvent(event);
      const key = `${normalized.at}|${normalized.type}|${normalized.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(normalized);
    }
  }
  merged.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return merged.slice(-100);
}

function lastProviderEventMessage(events) {
  return events?.length ? events[events.length - 1].message : "";
}

function providerLabel(provider) {
  return {
    claude: "Claude Code",
    antigravity: "Antigravity",
  }[provider] ?? provider;
}

function compareFindings(left, right) {
  return severityRank(left.severity) - severityRank(right.severity);
}

function severityRank(severity) {
  return {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  }[String(severity ?? "").toLowerCase()] ?? 4;
}

function formatFindingLocation(finding) {
  if (!finding?.file) {
    return "";
  }
  if (!finding.line_start) {
    return finding.file;
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `${finding.file}:${finding.line_start}`;
  }
  return `${finding.file}:${finding.line_start}-${finding.line_end}`;
}

function pushFindingDetail(lines, label, value) {
  const text = String(value ?? "").trim();
  if (text) {
    lines.push(`  ${label}: ${text}`);
  }
}

function providerRunStatus(command, normalized) {
  if (command.failedBeforeOutput) {
    return "failed";
  }
  if (normalized?.output_valid === false || normalized?.verdict === "invalid-output") {
    return "invalid-output";
  }
  if ((command.exitCode ?? 0) !== 0) {
    return "failed";
  }
  return "completed";
}

function finalJobStatus(providerRuns) {
  const hasCompleted = providerRuns.some((run) => run.status === "completed");
  const hasProblem = providerRuns.some((run) => run.status === "failed" || run.status === "invalid-output");
  if (hasCompleted && hasProblem) {
    return "partial";
  }
  if (hasProblem) {
    return "failed";
  }
  return "completed";
}

function finalizeJob(current, providerRuns, synthesis) {
  if (current.status === "cancelled") {
    return current;
  }
  return {
    ...current,
    status: finalJobStatus(providerRuns),
    stage: "synthesis-ready",
    completedAt: new Date().toISOString(),
    synthesis,
  };
}

async function markJobFailedBestEffort(state, jobId, error) {
  const message = error?.message || String(error);
  try {
    await updateJob(state, jobId, (current) => markJobFailed(current, message));
    return;
  } catch (writeError) {
    await markJobFailedDirectly(state, jobId, message, writeError).catch(() => {});
  }
}

async function markJobFailedDirectly(state, jobId, message, writeError) {
  const filePath = jobPath(state, jobId);
  const current = JSON.parse(await readFile(filePath, "utf8"));
  const next = markJobFailed(current, message, writeError);
  if (next === current) {
    return;
  }
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

function markJobFailed(current, message, writeError) {
  if (["cancelled", "completed", "failed", "partial"].includes(current.status)) {
    return current;
  }
  const now = new Date().toISOString();
  return {
    ...current,
    status: "failed",
    stage: "failed",
    completedAt: now,
    updatedAt: now,
    error: message,
    ...(writeError ? { failureWriteError: writeError?.message || String(writeError) } : {}),
  };
}

function summarize(rawText) {
  if (!rawText) {
    return "No provider output was captured.";
  }
  const squashed = rawText.replace(/\s+/g, " ").trim();
  return squashed.length > SUMMARY_LIMIT ? `${squashed.slice(0, SUMMARY_LIMIT - 3)}...` : squashed;
}

function summarizeError(stderr) {
  const text = String(stderr ?? "").trim();
  if (!text) {
    return "";
  }
  const firstUsefulLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("at "));
  return summarize(firstUsefulLine || text);
}

function classifyVerdict(rawText, findings) {
  if (findings.length > 0) {
    return "needs-attention";
  }
  if (!rawText) {
    return "inconclusive";
  }
  if (isCleanReview(rawText)) {
    return "clean";
  }
  if (/\b(critical|high|medium|bug|broken|data loss|security|unsafe)\b/i.test(rawText)) {
    return "needs-attention";
  }
  return "inconclusive";
}

function isCleanReview(rawText) {
  const text = rawText.replace(/\s+/g, " ").trim();
  const cleanMatch = text.match(/\b(no|none|not)\b.{0,100}\b(critical|high|medium|bug|bugs|security|data loss|issue|issues|finding|findings|problem|problems|risk|risks)\b.{0,80}\b(found|identified|detected|observed|present|reported)?\b/i)
    ?? text.match(/\b(no actionable findings|no concrete findings|looks clean|appears clean)\b/i);
  if (!cleanMatch) {
    return false;
  }
  const afterCleanStatement = text.slice((cleanMatch.index ?? 0) + cleanMatch[0].length);
  return !/\b(critical|high|medium|bug|broken|data loss|security|unsafe|vulnerability|risk)\b/i.test(afterCleanStatement);
}

function extractFindings(rawText) {
  const findings = [];
  const lines = String(rawText ?? "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?(critical|medium-high|high|medium|low)(?:\*\*)?\s*[:\-\u2013\u2014]\s+(.+?)\s*$/i);
    if (!match) {
      continue;
    }
    const severity = normalizeSeverity(match[1]);
    const body = match[2].trim();
    const location = body.match(/`?([A-Za-z0-9_./-]+):(\d+)`?/);
    findings.push({
      severity,
      title: titleFromBody(body),
      body,
      file: location?.[1] ?? "",
      line_start: location ? Number(location[2]) : null,
      line_end: location ? Number(location[2]) : null,
      confidence: "provider-reported",
      recommendation: "",
    });
  }
  return findings;
}

function normalizeSeverity(value) {
  const severity = String(value ?? "").toLowerCase();
  if (severity === "critical") {
    return "critical";
  }
  if (severity === "high" || severity === "medium-high") {
    return "high";
  }
  if (severity === "medium") {
    return "medium";
  }
  return "low";
}

function titleFromBody(body) {
  const firstSentence = String(body ?? "").split(/(?<=[.!?])\s+/)[0] ?? "";
  return firstSentence.replace(/^`?[A-Za-z0-9_./-]+:\d+`?\s*/, "").trim();
}
