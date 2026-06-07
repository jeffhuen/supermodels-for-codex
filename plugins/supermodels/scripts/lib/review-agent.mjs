import { REVIEW_RESULT_SCHEMA, normalizeStructuredReview } from "./review-schema.mjs";

const DEFAULT_REVIEW_POLICY = Object.freeze({
  maxRounds: Number.POSITIVE_INFINITY,
  forceAfterRounds: Number.POSITIVE_INFINITY,
  antigravityForceAfterSatisfiedRounds: 8,
  claudeMaxTokens: 128_000,
  antigravityMaxTokens: 64_000,
  claudeThinking: Object.freeze({ type: "adaptive", display: "summarized" }),
  claudeEffort: null,
  antigravityThinkingBudget: -1,
  minInspection: Object.freeze({
    diff: true,
    fileOrSearch: true,
    explicitFileOrSearchToolCalls: 2,
    cleanExplicitFileOrSearchToolCalls: 2,
  }),
  forceInspectionTools: false,
});

export async function runReviewAgent(options = {}) {
  const {
    provider = "provider",
    transport,
    tools,
    brief = "",
    focus = "",
    mode = "review",
    model,
    preloadTools = [],
    controller = null,
    timeoutMs,
    onEvent,
  } = options;
  const maxTokens = options.maxTokens ?? providerMaxTokens(provider);
  const maxRounds = options.maxRounds ?? DEFAULT_REVIEW_POLICY.maxRounds;
  const forceAfterRounds = options.forceAfterRounds
    ?? (options.maxRounds === undefined
      ? DEFAULT_REVIEW_POLICY.forceAfterRounds
      : Math.max(1, maxRounds - 1));
  const forceAfterSatisfiedRounds = options.forceAfterSatisfiedRounds
    ?? providerForceAfterSatisfiedRounds(provider);
  const minInspection = {
    ...DEFAULT_REVIEW_POLICY.minInspection,
    ...(options.minInspection ?? {}),
  };
  const forceInspectionTools = options.forceInspectionTools ?? DEFAULT_REVIEW_POLICY.forceInspectionTools;
  if (!transport?.messages) {
    throw new Error("runReviewAgent requires a transport with messages(body, options).");
  }
  if (!tools?.execute) {
    throw new Error("runReviewAgent requires tools with execute(name, input, options).");
  }

  const abort = createAbort(controller);
  const messages = [{
    role: "user",
    content: [{ type: "text", text: initialPrompt({ provider, brief, focus, mode }) }],
  }];
  const toolUsage = {};
  const inspection = {
    diff: false,
    fileOrSearch: false,
    explicitFileOrSearchToolCalls: 0,
    explicitFileOrSearchTargets: [],
    explicitFileOrSearchTargetSet: new Set(),
  };
  const schemas = [
    ...(tools.schemas ?? []),
    submitReviewToolSchema(),
  ];
  const reviewStartedAt = Date.now();
  let inspectionSatisfiedAtRound = null;
  const reasoningOptions = providerReasoningOptions(provider, options);

  try {
    if (preloadTools.length) {
      const preloaded = [];
      for (const name of preloadTools) {
        throwIfCancelled(controller);
        let result;
        try {
          result = await tools.execute(name, {}, {
            controller,
            signal: abort.signal,
          });
        } catch (error) {
          result = {
            ok: false,
            error: error?.message || String(error),
          };
        }
        throwIfCancelled(controller);
        toolUsage[name] = (toolUsage[name] ?? 0) + 1;
        updateInspection(inspection, name, result);
        preloaded.push({ tool: name, result });
        onEvent?.({
          type: "tool_call",
          message: `${provider} preloaded ${name}`,
          at: new Date().toISOString(),
        });
      }
      messages.push({
        role: "user",
        content: [{
          type: "text",
          text: preloadedEvidenceMessage(preloaded),
        }],
      });
    }

    for (let round = 1; round <= maxRounds; round += 1) {
      throwIfCancelled(controller);
      const satisfied = inspectionSatisfied(inspection, minInspection);
      if (satisfied && inspectionSatisfiedAtRound === null) {
        inspectionSatisfiedAtRound = round;
      }
      const shouldForceSubmit = satisfied
        && (
          round >= forceAfterRounds
          || (
            Number.isFinite(forceAfterSatisfiedRounds)
            && inspectionSatisfiedAtRound !== null
            && round - inspectionSatisfiedAtRound >= forceAfterSatisfiedRounds
          )
        );
      const forcedInspectionTool = forceInspectionTools
        ? nextForcedInspectionTool(inspection, minInspection)
        : "";
      const toolChoice = forcedInspectionTool
        ? { type: "tool", name: forcedInspectionTool }
        : shouldForceSubmit
          ? { type: "tool", name: "submit_review" }
          : null;
      const requestMessages = cloneMessages(messages);
      const forcedToolChoice = toolChoice && supportsForcedToolChoice(provider, reasoningOptions)
        ? toolChoice
        : null;
      if (shouldForceSubmit) {
        requestMessages.push(finalInstruction());
      } else if (toolChoice && !forcedToolChoice) {
        requestMessages.push(forcedToolInstruction(toolChoice.name));
      }

      onEvent?.({
        type: "progress",
        message: `${provider} review round ${round}`,
        at: new Date().toISOString(),
      });
      const response = await transport.messages({
        model,
        max_tokens: maxTokens,
        system: providerSystemInstructions(provider),
        messages: requestMessages,
        tools: schemas,
        ...reasoningOptions,
        ...(forcedToolChoice ? { tool_choice: forcedToolChoice } : {}),
      }, {
        signal: abort.signal,
        timeoutMs: remainingReviewTimeoutMs(timeoutMs, reviewStartedAt, provider),
      });
      throwIfCancelled(controller);

      if (Array.isArray(response.content) && response.content.length) {
        messages.push({ role: "assistant", content: response.content });
      } else if (response.text) {
        messages.push({ role: "assistant", content: [{ type: "text", text: response.text }] });
      }

      const toolCalls = response.tool_calls ?? [];
      if (!toolCalls.length) {
        messages.push({
          role: "user",
          content: [{
            type: "text",
            text: "No tool call was made. Continue the review with repository tools, then call submit_review when complete.",
          }],
        });
        continue;
      }

      const submitCall = toolCalls.find((call) => call.name === "submit_review");
      if (submitCall) {
        const executedResults = new Map();
        for (const call of toolCalls) {
          if (call.name === "submit_review") {
            continue;
          }
          executedResults.set(call.id, await executeToolCall({
            call,
            tools,
            controller,
            abort,
            inspection,
            toolUsage,
            onEvent,
            provider,
          }));
        }

        const submitted = handleSubmittedReview(submitCall, inspection, minInspection);
        if (submitted.done) {
          return {
            ...submitted.review,
            toolUsage,
            rounds: round,
            usage: response.usage ?? null,
            reviewConfig: reviewConfigMetadata({
              provider,
              model,
              maxTokens,
              reasoningOptions,
              rounds: round,
              toolUsage,
            }),
          };
        }

        const toolResults = [];
        for (const call of toolCalls) {
          if (call.id === submitCall.id) {
            toolResults.push(submitted.toolResult);
            continue;
          }
          toolResults.push(executedResults.get(call.id) ?? {
            type: "tool_result",
            tool_use_id: call.id,
            content: JSON.stringify({
              ok: false,
              error: "Additional submit_review calls skipped because another submit_review was already processed.",
            }),
          });
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      const toolResults = [];
      for (const call of toolCalls) {
        toolResults.push(await executeToolCall({
          call,
          tools,
          controller,
          abort,
          inspection,
          toolUsage,
          onEvent,
          provider,
        }));
      }

      if (toolResults.length) {
        messages.push({ role: "user", content: toolResults });
      }
    }
  } finally {
    abort.cleanup();
  }

  throw new Error(`Review did not complete after ${maxRounds} rounds.`);
}

async function executeToolCall({ call, tools, controller, abort, inspection, toolUsage, onEvent, provider }) {
  let result;
  try {
    result = await tools.execute(call.name, call.input ?? {}, {
      controller,
      signal: abort.signal,
    });
  } catch (error) {
    result = {
      ok: false,
      error: error?.message || String(error),
    };
  }
  throwIfCancelled(controller);
  toolUsage[call.name] = (toolUsage[call.name] ?? 0) + 1;
  updateInspection(inspection, call.name, result, call.input ?? {});
  onEvent?.({
    type: "tool_call",
    message: `${provider} used ${call.name}`,
    at: new Date().toISOString(),
  });
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: JSON.stringify(result),
  };
}

function providerReasoningOptions(provider, options = {}) {
  if (provider === "claude") {
    const thinking = options.thinking ?? DEFAULT_REVIEW_POLICY.claudeThinking;
    const requestedEffort = options.effort ?? DEFAULT_REVIEW_POLICY.claudeEffort;
    const effort = requestedEffort === "cli-default" ? null : requestedEffort;
    return {
      ...(thinking ? { thinking } : {}),
      ...(effort ? { output_config: { effort } } : {}),
    };
  }
  if (provider === "antigravity") {
    const budget = options.thinkingBudget ?? DEFAULT_REVIEW_POLICY.antigravityThinkingBudget;
    const parsed = Number(budget);
    return Number.isFinite(parsed) ? { thinkingBudget: parsed } : {};
  }
  return {};
}

function reviewConfigMetadata({ provider, model, maxTokens, reasoningOptions, rounds, toolUsage }) {
  const config = {
    provider,
    model: model ?? "",
    maxTokens,
    rounds,
    toolUsage: { ...(toolUsage ?? {}) },
  };
  if (provider === "claude") {
    config.thinking = reasoningOptions.thinking ?? null;
    config.effort = reasoningOptions.output_config?.effort ?? "";
  }
  if (provider === "antigravity") {
    config.thinkingBudget = reasoningOptions.thinkingBudget ?? null;
  }
  return config;
}

function supportsForcedToolChoice(provider, reasoningOptions = {}) {
  return !(provider === "claude" && reasoningOptions.thinking);
}

function providerMaxTokens(provider) {
  if (provider === "claude") {
    return DEFAULT_REVIEW_POLICY.claudeMaxTokens;
  }
  if (provider === "antigravity") {
    return DEFAULT_REVIEW_POLICY.antigravityMaxTokens;
  }
  return DEFAULT_REVIEW_POLICY.antigravityMaxTokens;
}

function providerForceAfterSatisfiedRounds(provider) {
  if (provider === "antigravity") {
    return DEFAULT_REVIEW_POLICY.antigravityForceAfterSatisfiedRounds;
  }
  return Number.POSITIVE_INFINITY;
}

function remainingReviewTimeoutMs(timeoutMs, startedAt, provider) {
  if (!Number.isFinite(timeoutMs)) {
    return timeoutMs;
  }
  const remaining = Math.ceil(timeoutMs - (Date.now() - startedAt));
  if (remaining <= 0) {
    throw new Error(`${provider} review timed out before completion after ${timeoutMs}ms.`);
  }
  return remaining;
}

function handleSubmittedReview(call, inspection, minInspection) {
  const visibleInspection = visibleInspectionState(inspection);
  if (!inspectionSatisfied(inspection, minInspection)) {
    const requiredExplicitCalls = Number(minInspection.explicitFileOrSearchToolCalls ?? 0);
    return {
      done: false,
      toolResult: {
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify({
          ok: false,
          error: requiredExplicitCalls > 0
            ? `submit_review refused: inspect the diff and use read_file or search on at least ${requiredExplicitCalls} relevant files/search targets before submitting final findings.`
            : "submit_review refused: inspect the diff and at least one relevant file or search result before submitting final findings.",
          inspection: visibleInspection,
        }),
      },
    };
  }
  const normalized = normalizeStructuredReview(call.input);
  if (!normalized) {
    return {
      done: false,
      toolResult: {
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify({
          ok: false,
          error: "submit_review input did not match the review schema. Retry with all required fields.",
        }),
      },
    };
  }
  if (normalized.verdict === "clean" && !cleanInspectionSatisfied(inspection, minInspection)) {
    return {
      done: false,
      toolResult: {
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify({
          ok: false,
          error: "submit_review refused: clean verdict requires more repository inspection. Use read_file or search on at least two relevant files/search targets before returning clean.",
          inspection: visibleInspection,
          required: {
            cleanExplicitFileOrSearchToolCalls: minInspection.cleanExplicitFileOrSearchToolCalls,
          },
        }),
      },
    };
  }
  return { done: true, review: normalized };
}

function inspectionSatisfied(inspection, required) {
  const requiredExplicitCalls = Number(required.explicitFileOrSearchToolCalls ?? 0);
  return (!required.diff || inspection.diff)
    && (!required.fileOrSearch || inspection.fileOrSearch)
    && distinctInspectionCount(inspection) >= requiredExplicitCalls;
}

function nextForcedInspectionTool(inspection, required) {
  if (required.diff && !inspection.diff) {
    return "get_diff";
  }
  if (required.fileOrSearch && !inspection.fileOrSearch) {
    return "search";
  }
  if (distinctInspectionCount(inspection) < Number(required.explicitFileOrSearchToolCalls ?? 0)) {
    return "search";
  }
  return "";
}

function updateInspection(inspection, name, result, input = {}) {
  if (!result?.ok) {
    return;
  }
  if (name === "get_review_context") {
    inspection.diff ||= Boolean(result.diff || result.diffSummary);
    return;
  }
  if (name === "get_diff") {
    inspection.diff = true;
  }
  if (["read_file", "search"].includes(name)) {
    const target = inspectionTargetKey(name, result, input);
    if (!target || !resultHasInspectionContent(name, result)) {
      return;
    }
    inspection.fileOrSearch = true;
    if (!inspection.explicitFileOrSearchTargetSet.has(target)) {
      inspection.explicitFileOrSearchTargetSet.add(target);
      inspection.explicitFileOrSearchTargets.push(target);
      inspection.explicitFileOrSearchToolCalls = inspection.explicitFileOrSearchTargets.length;
    }
  }
}

function cleanInspectionSatisfied(inspection, required) {
  const requiredExplicitCalls = Number(required.cleanExplicitFileOrSearchToolCalls ?? 0);
  return distinctInspectionCount(inspection) >= requiredExplicitCalls;
}

function distinctInspectionCount(inspection) {
  return inspection.explicitFileOrSearchTargets?.length
    ?? inspection.explicitFileOrSearchToolCalls
    ?? 0;
}

function visibleInspectionState(inspection) {
  return {
    diff: Boolean(inspection.diff),
    fileOrSearch: Boolean(inspection.fileOrSearch),
    explicitFileOrSearchToolCalls: distinctInspectionCount(inspection),
    explicitFileOrSearchTargets: inspection.explicitFileOrSearchTargets ?? [],
  };
}

function resultHasInspectionContent(name, result) {
  if (name === "read_file") {
    return Boolean(String(result.content ?? "").trim());
  }
  if (name === "search") {
    const output = String(result.output ?? "").trim();
    if (output && output !== "(no matches)") {
      return true;
    }
    return Array.isArray(result.matches) && result.matches.length > 0;
  }
  return true;
}

function inspectionTargetKey(name, result, input) {
  if (name === "read_file") {
    const filePath = String(result.path ?? input.path ?? "").trim();
    if (!filePath) {
      return "";
    }
    const start = Number(result.start_line ?? input.start_line ?? 1);
    const end = Number(result.end_line ?? input.end_line ?? start);
    return `${name}:${filePath}:${Number.isFinite(start) ? start : 1}:${Number.isFinite(end) ? end : start}`;
  }
  if (name === "search") {
    const query = String(result.query ?? input.query ?? "").trim().replace(/\s+/g, " ");
    return query ? `${name}:${query}` : "";
  }
  return "";
}

function submitReviewToolSchema() {
  return {
    name: "submit_review",
    description: "Submit the final structured review after inspecting repository evidence.",
    input_schema: REVIEW_RESULT_SCHEMA,
  };
}

function initialPrompt({ provider, brief, focus, mode }) {
  const modeLabel = mode === "adversarial-review" ? "adversarial production review" : "production code review";
  const lines = [
    `Perform a serious ${modeLabel} of the current workspace as ${provider}.`,
    "",
    "You have read-only repository tools. Use them. Do not submit a final review until you have inspected the diff and used read_file or search on at least two relevant files/search targets.",
    "If you intend to return verdict clean, you must first use read_file or search on at least two relevant files/search targets. A shallow clean verdict will be rejected.",
    "",
    "Review rules:",
    "- Prefer concrete bugs, regressions, security issues, lifecycle races, and missing verification.",
    "- Cite file paths and line numbers from inspected files.",
    "- Treat user-provided prior findings as hypotheses, not facts.",
    "- If evidence is missing, put that in verification_gaps instead of inventing a finding.",
    "- Do not report vague concerns, stylistic preferences, or issues that are already covered by tests unless the tests are insufficient.",
    "",
    "Suggested flow:",
    "1. Start from the preloaded review context when present, otherwise call get_review_context.",
    "2. Search/read the most relevant files and tests if the preloaded snippets are insufficient.",
    "3. Cross-check findings against tests or adjacent code.",
    "4. Call submit_review with the final structured review.",
    "",
    "User focus:",
    focus?.trim() || "No extra focus provided.",
  ];
  if (brief?.trim()) {
    lines.push(
      "",
      "# Supermodels Review Brief",
      "Treat this brief as steering context, not as a substitute for tool inspection.",
      brief.trim(),
    );
  }
  return lines.join("\n");
}

function providerSystemInstructions(provider) {
  if (provider === "claude") {
    return [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "You are Claude Code reviewing for Codex. Be concrete, skeptical, and evidence-driven." },
    ];
  }
  if (provider === "antigravity") {
    return [{
      type: "text",
      text: "You are Antigravity reviewing for Codex. Use broad systems judgment, but ground every claim in inspected repository evidence.",
    }];
  }
  return [{
    type: "text",
    text: `You are ${provider} reviewing for Codex. Make every claim concrete and falsifiable.`,
  }];
}

function finalInstruction() {
  return {
    role: "user",
    content: [{
      type: "text",
      text: "Submit the final structured review with the evidence you have. If you found no concrete bugs but have not used read_file or search on at least two relevant files/search targets, return verdict inconclusive and explain the remaining verification gaps instead of clean.",
    }],
  };
}

function forcedToolInstruction(name) {
  return {
    role: "user",
    content: [{
      type: "text",
      text: `Call the ${name} tool now. Do not submit a final review until this required repository inspection is complete.`,
    }],
  };
}

function preloadedEvidenceMessage(preloaded) {
  return [
    "Codex preloaded the following repository evidence before the provider call. Treat it as tool output and ground the review in it. You may call additional repository tools if this evidence is insufficient.",
    "",
    JSON.stringify({ preloaded }, null, 2),
  ].join("\n");
}

function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages));
}

function createAbort(controller) {
  const abortController = new AbortController();
  const unsubscribe = controller?.onCancel?.(() => {
    abortController.abort(new Error("Review cancelled."));
  }) ?? (() => {});
  if (controller?.cancelled) {
    abortController.abort(new Error("Review cancelled."));
  }
  return {
    signal: abortController.signal,
    cleanup: unsubscribe,
  };
}

function throwIfCancelled(controller) {
  if (controller?.cancelled) {
    throw new Error(`Review cancelled by ${controller.signal ?? "signal"}.`);
  }
}
