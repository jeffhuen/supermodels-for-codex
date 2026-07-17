import {
  REVIEW_RESULT_SCHEMA,
  validateStructuredReviewText,
  validateStructuredReview,
} from "./review-schema.mjs";
import {
  parseDiffGitPathTokens,
  parseUnifiedDiffHeaderPath,
  stripGitSidePrefix,
} from "./diff-paths.mjs";
import { COVERAGE_LEDGER_RESERVE, enforceSerializedCap, lastNumberedLine } from "./review-tools.mjs";

const DEFAULT_REVIEW_POLICY = Object.freeze({
  maxRounds: Number.POSITIVE_INFINITY,
  forceAfterRounds: Number.POSITIVE_INFINITY,
  forceAfterSatisfiedRounds: Number.POSITIVE_INFINITY,
  maxNoToolContinuationRounds: 4,
  claudeMaxTokens: 128_000,
  antigravityMaxTokens: 64_000,
  grokMaxTokens: 64_000,
  grokEffort: "high",
  claudeThinking: Object.freeze({ type: "adaptive", display: "summarized" }),
  claudeEffort: null,
  antigravityThinkingBudget: -1,
  maxReviewCorrectionAttempts: 1,
  maxInspectionRefusals: 4,
  minInspection: Object.freeze({
    diff: true,
    fileOrSearch: true,
    explicitFileOrSearchToolCalls: 2,
    cleanExplicitFileOrSearchToolCalls: 2,
  }),
  forceInspectionTools: false,
});
const POST_EVIDENCE_INSPECTION_ROUNDS = 4;
const MAX_FINDING_LOCATION_LINES = 200;
const MAX_COVERAGE_GAPS = 12;
export const COVERAGE_TRUNCATED_GAP = "Supermodels: high-risk hunk coverage enforcement was disabled because the review-tool diff was truncated; some changed hunks may not have been inspected. Re-run with a narrower --base scope or smaller diff to restore coverage checks.";
const HIGH_RISK_PATH_RE = /(^|\/)(auth|oauth|session|sessions|token|tokens|credential|credentials|secret|secrets|password|permission|permissions|policy|policies|security|csrf|migration|migrations|schema|db|database|billing|payment|payments|worker|queue|lock|locks|signal|signals|cancel|cancellation)(\/|\.|-|_|$)/i;
const HIGH_RISK_DIFF_RE = /\b(auth|oauth|session|token|secret|password|permission|policy|csrf|sql|migration|schema|drop|delete|destroy|truncate|unlink|lock|mutex|race|concurrent|parallel|signal|cancel|timeout|retry|process\.env|keychain)\b/i;

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
  const forceAfterRounds = options.forceAfterRounds ?? DEFAULT_REVIEW_POLICY.forceAfterRounds;
  const forceAfterSatisfiedRounds = options.forceAfterSatisfiedRounds
    ?? providerForceAfterSatisfiedRounds(provider, mode);
  const minInspection = {
    ...DEFAULT_REVIEW_POLICY.minInspection,
    ...(options.minInspection ?? {}),
  };
  const forceInspectionTools = options.forceInspectionTools ?? DEFAULT_REVIEW_POLICY.forceInspectionTools;
  const maxNoToolContinuationRounds = options.maxNoToolContinuationRounds
    ?? DEFAULT_REVIEW_POLICY.maxNoToolContinuationRounds;
  const maxReviewCorrectionAttempts = options.maxReviewCorrectionAttempts
    ?? DEFAULT_REVIEW_POLICY.maxReviewCorrectionAttempts;
  const maxInspectionRefusals = options.maxInspectionRefusals
    ?? DEFAULT_REVIEW_POLICY.maxInspectionRefusals;
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
    readRanges: [],
    coverage: createCoverageState(),
  };
  const schemas = [
    ...(tools.schemas ?? []),
    submitReviewToolSchema({ strict: providerStrictSubmit(provider) }),
  ];
  const reviewStartedAt = Date.now();
  let inspectionSatisfiedAtRound = null;
  let cumulativeUsage = null;
  let structuredConversionRequested = false;
  let noToolContinuationRounds = 0;
  let reviewCorrectionAttempts = 0;
  let inspectionRefusals = 0;
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
          text: preloadedEvidenceMessage(preloaded, Number(tools?.maxToolBytes) || Number.POSITIVE_INFINITY),
        }],
      });
    }

    // The prompt (messages[0]) plus the optional preloaded-evidence turn
    // (messages[1]) form the stable prefix that never changes across rounds:
    // length 1 with no preload, 2 with preload. Anchor a cache breakpoint at its
    // end (index stablePrefixEnd - 1) so a round that appends many content blocks
    // cannot push the evidence prefix outside the API's lookback window from the
    // rolling breakpoint and force it to be reprocessed.
    // Always in-range (1 without preload, 2 with) and `messages` only grows, so
    // the helper's stable anchor never falls off the end of the array.
    const stablePrefixEnd = messages.length;

    for (let round = 1; round <= maxRounds; round += 1) {
      throwIfCancelled(controller);
      const satisfied = inspectionSatisfied(inspection, minInspection);
      if (satisfied && inspectionSatisfiedAtRound === null) {
        inspectionSatisfiedAtRound = round;
      }
      const hasCoverageGaps = coverageGapsForInspection(inspection).length > 0;
      const shouldForceSubmit = satisfied
        && !hasCoverageGaps
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
      let requestBody = {
        model,
        max_tokens: maxTokens,
        system: providerSystemInstructions(provider),
        messages: requestMessages,
        tools: schemas,
        ...reasoningOptions,
        ...(forcedToolChoice ? { tool_choice: forcedToolChoice } : {}),
      };
      if (providerCacheControl(provider)) {
        requestBody = withReviewCacheBreakpoints(requestBody, stablePrefixEnd);
      }
      const response = await transport.messages(requestBody, {
        signal: abort.signal,
        timeoutMs: remainingReviewTimeoutMs(timeoutMs, reviewStartedAt, provider),
        onEvent,
      });
      cumulativeUsage = mergeUsage(cumulativeUsage, response.usage);
      if (response.usage) {
        onEvent?.({
          type: "usage",
          message: `${provider} review usage ${formatUsageSummary(cumulativeUsage)}`,
          usage: cumulativeUsage,
          at: new Date().toISOString(),
        });
      }
      throwIfCancelled(controller);

      if (Array.isArray(response.content) && response.content.length) {
        messages.push({ role: "assistant", content: response.content });
      } else if (response.text) {
        messages.push({ role: "assistant", content: [{ type: "text", text: response.text }] });
      }

      const toolCalls = response.tool_calls ?? [];
      if (!toolCalls.length) {
        const finalText = responseText(response);
        const naturalReviewValidation = validateStructuredReviewText(finalText);
        const naturalReview = naturalReviewValidation.review;
        if (naturalReview) {
          const accepted = await acceptStructuredReview(naturalReview, inspection, minInspection, {
            tools,
            controller,
            abort,
          });
          if (accepted.done) {
            return {
              ...accepted.review,
              toolUsage,
              rounds: round,
              usage: cumulativeUsage,
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
          const countsAsReviewCorrection = consumesReviewCorrection(accepted.error);
          if (countsAsReviewCorrection && reviewCorrectionAttempts >= maxReviewCorrectionAttempts) {
            return inconclusiveRejectedStructuredReview(accepted.error, {
              toolUsage,
              rounds: round,
              usage: cumulativeUsage,
              provider,
              model,
              maxTokens,
              reasoningOptions,
            });
          }
          if (countsAsReviewCorrection) {
            reviewCorrectionAttempts += 1;
          } else if (consumesInspectionRefusal(accepted.error)) {
            inspectionRefusals += 1;
            if (inspectionRefusals >= maxInspectionRefusals) {
              return inconclusiveRepeatedInspectionRefusals(accepted.error, {
                toolUsage,
                rounds: round,
                usage: cumulativeUsage,
                provider,
                model,
                maxTokens,
                reasoningOptions,
              });
            }
          }
          messages.push({
            role: "user",
            content: [{
              type: "text",
              text: naturalReviewRejectionInstruction(accepted.error),
            }],
          });
          continue;
        }

        if (naturalReviewValidation.parsed && inspectionSatisfied(inspection, minInspection)) {
          const error = structuredReviewValidationError(naturalReviewValidation.errors);
          if (reviewCorrectionAttempts >= maxReviewCorrectionAttempts) {
            return inconclusiveRejectedStructuredReview(error, {
              toolUsage,
              rounds: round,
              usage: cumulativeUsage,
              provider,
              model,
              maxTokens,
              reasoningOptions,
            });
          }
          reviewCorrectionAttempts += 1;
          messages.push({
            role: "user",
            content: [{
              type: "text",
              text: naturalReviewRejectionInstruction(error),
            }],
          });
          continue;
        }

        if (inspectionSatisfied(inspection, minInspection)) {
          if (structuredConversionRequested) {
            return {
              ...inconclusiveUnstructuredFinalReview(finalText),
              toolUsage,
              rounds: round,
              usage: cumulativeUsage,
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
          structuredConversionRequested = true;
          messages.push(structuredConversionInstruction(finalText));
          continue;
        }

        noToolContinuationRounds += 1;
        if (
          Number.isFinite(maxNoToolContinuationRounds)
          && noToolContinuationRounds >= maxNoToolContinuationRounds
        ) {
          throw new Error(`${provider} made no repository-inspection progress after ${noToolContinuationRounds} no-tool turns.`);
        }
        messages.push({
          role: "user",
          content: [{
            type: "text",
            text: "No tool call was made. Continue the review with repository tools, then call submit_review when complete.",
          }],
        });
        continue;
      }
      noToolContinuationRounds = 0;

      const submitCall = toolCalls.find((call) => call.name === "submit_review");
      if (submitCall) {
        const executedResults = new Map();
        const inspectionBeforeTools = inspectionProgressKey(inspection);
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
        if (inspectionProgressKey(inspection) !== inspectionBeforeTools) {
          inspectionRefusals = 0;
        }

        const submitted = await handleSubmittedReview(submitCall, inspection, minInspection, {
          tools,
          controller,
          abort,
        });
        if (submitted.done) {
          return {
            ...submitted.review,
            toolUsage,
            rounds: round,
            usage: cumulativeUsage,
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
        const countsAsReviewCorrection = consumesReviewCorrection(submitted.error);
        if (countsAsReviewCorrection && reviewCorrectionAttempts >= maxReviewCorrectionAttempts) {
          return inconclusiveRejectedStructuredReview(submitted.error, {
            toolUsage,
            rounds: round,
            usage: cumulativeUsage,
            provider,
            model,
            maxTokens,
            reasoningOptions,
          });
        }
        if (countsAsReviewCorrection) {
          reviewCorrectionAttempts += 1;
        } else if (consumesInspectionRefusal(submitted.error)) {
          inspectionRefusals += 1;
          if (inspectionRefusals >= maxInspectionRefusals) {
            return inconclusiveRepeatedInspectionRefusals(submitted.error, {
              toolUsage,
              rounds: round,
              usage: cumulativeUsage,
              provider,
              model,
              maxTokens,
              reasoningOptions,
            });
          }
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
      const inspectionBeforeTools = inspectionProgressKey(inspection);
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
        if (inspectionProgressKey(inspection) !== inspectionBeforeTools) {
          inspectionRefusals = 0;
        }
        messages.push({ role: "user", content: toolResults });
      }
    }
  } finally {
    abort.cleanup();
  }

  throw new Error(`Review did not complete after ${maxRounds} rounds.`);
}

// Keep read_file's end_line honest after any content trim: never past the last
// line actually present in the delivered content.
function syncReadFileEndLine(result) {
  const visibleEnd = lastNumberedLine(result?.content);
  if (Number.isFinite(visibleEnd)) {
    result.end_line = Math.min(Number(result.end_line ?? visibleEnd), visibleEnd);
  }
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
  const cap = Number(tools?.maxToolBytes);
  // read_file coverage is recorded from result.content by updateInspection, so the
  // content it will actually deliver must be FINAL before that runs: bound it to
  // the ledger-reserved budget and resync end_line to the last delivered line. This
  // stops the cap guarantee below from ever trimming evidence out from under
  // already-recorded coverage.
  if (Number.isFinite(cap) && call.name === "read_file" && result?.ok !== false) {
    enforceSerializedCap(result, Math.max(0, cap - COVERAGE_LEDGER_RESERVE));
    syncReadFileEndLine(result);
  }
  updateInspection(inspection, call.name, result, call.input ?? {});
  // Hard guarantee that the MODEL-VISIBLE payload (result + the coverage_ledger just
  // attached — whose FULL serialized envelope is bounded to the reserve) stays within
  // the cap. A no-op at realistic caps; a backstop only for caps below the reserve,
  // where read_file content is already empty and no coverage was recorded.
  if (Number.isFinite(cap)) {
    enforceSerializedCap(result, cap);
    if (call.name === "read_file" && result?.ok !== false) {
      syncReadFileEndLine(result);
    }
  }
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
  if (provider === "grok") {
    const requested = options.effort ?? DEFAULT_REVIEW_POLICY.grokEffort;
    const effort = requested === "cli-default" ? null : requested;
    return effort ? { reasoning_effort: effort } : {};
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
  if (provider === "grok") {
    config.effort = reasoningOptions.reasoning_effort ?? "";
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
  if (provider === "grok") {
    return DEFAULT_REVIEW_POLICY.grokMaxTokens;
  }
  return DEFAULT_REVIEW_POLICY.antigravityMaxTokens;
}

function providerStrictSubmit(provider) {
  return provider === "claude";
}

function providerCacheControl(provider) {
  return provider === "claude";
}

// Annotate a cloned request with up to three cache_control breakpoints:
//   1. the last system block (caches the tools + system prefix; the identity
//      block system[0] stays uncached),
//   2. the END of the stable initial prefix (index stablePrefixEnd - 1: the
//      preloaded-evidence turn, or the prompt when nothing was preloaded), so the
//      evidence prefix keeps a fixed breakpoint that survives long rounds, and
//   3. the last block of the latest array-content message (rolled per round).
// Breakpoints 2 and 3 dedup when they land on the same message (e.g. round 1
// before any tool rounds). Copy-not-mutate: the caller's stored `messages` are
// never mutated. At most 3 breakpoints, well within the API's budget of 4.
function withReviewCacheBreakpoints(request, stablePrefixEnd = 1) {
  const system = Array.isArray(request.system) ? request.system.map((b) => ({ ...b })) : request.system;
  if (Array.isArray(system) && system.length) {
    system[system.length - 1] = { ...system[system.length - 1], cache_control: { type: "ephemeral" } };
  }
  const messages = (request.messages ?? []).map((m) => ({ ...m }));

  const hasArrayContent = (index) =>
    index >= 0 && index < messages.length
    && Array.isArray(messages[index].content) && messages[index].content.length > 0;

  // Rolling breakpoint: the last message with array content.
  let rollingIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (hasArrayContent(i)) {
      rollingIndex = i;
      break;
    }
  }

  // Stable evidence anchor: the last block of the message ending the initial prefix.
  const stableIndex = stablePrefixEnd - 1;
  const targets = new Set();
  if (hasArrayContent(stableIndex)) {
    targets.add(stableIndex);
  }
  if (rollingIndex >= 0) {
    targets.add(rollingIndex);
  }

  for (const index of targets) {
    const copy = messages[index].content.map((b) => ({ ...b }));
    copy[copy.length - 1] = { ...copy[copy.length - 1], cache_control: { type: "ephemeral" } };
    messages[index] = { ...messages[index], content: copy };
  }
  return { ...request, system, messages };
}

function providerForceAfterSatisfiedRounds(provider, mode) {
  if (provider === "antigravity" && mode === "review") {
    // Gemini/AGY can keep inspecting after enough evidence. Leave several
    // model-led rounds after the gate, then ask for the structured verdict.
    return POST_EVIDENCE_INSPECTION_ROUNDS;
  }
  if (provider === "grok") {
    // grok-4.5 keeps inspecting on large diffs and, without a bound, has run
    // 10+ rounds and ~1.5M tokens in a single first pass (and again in the
    // challenge phase). Cap both first-pass and adversarial runs with the same
    // post-evidence backstop so a review can't exhaust the subscription.
    return POST_EVIDENCE_INSPECTION_ROUNDS;
  }
  return DEFAULT_REVIEW_POLICY.forceAfterSatisfiedRounds;
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

function mergeUsage(total, next) {
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    return total;
  }
  const merged = total && typeof total === "object" && !Array.isArray(total)
    ? { ...total }
    : {};
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const previous = typeof merged[key] === "number" && Number.isFinite(merged[key])
        ? merged[key]
        : 0;
      merged[key] = previous + value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = mergeUsage(merged[key], value);
    } else if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function formatUsageSummary(usage) {
  if (!usage || typeof usage !== "object") {
    return "updated";
  }
  const entries = [
    ["input", usage.input_tokens],
    ["output", usage.output_tokens],
    ["total", usage.total_tokens],
    ["thinking", usage.output_tokens_details?.thinking_tokens],
  ].filter(([, value]) => typeof value === "number" && Number.isFinite(value));
  return entries.length
    ? entries.map(([label, value]) => `${label}=${value}`).join(" ")
    : "updated";
}

async function handleSubmittedReview(call, inspection, minInspection, verification) {
  const validation = validateStructuredReview(call.input);
  const normalized = validation.review;
  if (!normalized) {
    const error = structuredReviewValidationError(validation.errors);
    return {
      done: false,
      error,
      toolResult: {
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(error),
      },
    };
  }
  const accepted = await acceptStructuredReview(normalized, inspection, minInspection, verification);
  if (!accepted.done) {
    return {
      done: false,
      error: accepted.error,
      toolResult: {
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(accepted.error),
      },
    };
  }
  return accepted;
}

function consumesReviewCorrection(error) {
  return error?.correction_kind === "review-validation";
}

function consumesInspectionRefusal(error) {
  return error?.correction_kind === "inspection";
}

function structuredReviewValidationError(errors) {
  return {
    ok: false,
    error: "submit_review input did not match the review schema. Retry with the listed fields fixed.",
    correction_kind: "review-validation",
    validation_errors: Array.isArray(errors) && errors.length
      ? errors
      : ["review must match the structured review schema"],
  };
}

async function acceptStructuredReview(review, inspection, minInspection, verification = {}) {
  const visibleInspection = visibleInspectionState(inspection);
  if (!inspectionSatisfied(inspection, minInspection)) {
    const requiredExplicitCalls = Number(minInspection.explicitFileOrSearchToolCalls ?? 0);
    return {
      done: false,
      error: {
        ok: false,
        correction_kind: "inspection",
        error: requiredExplicitCalls > 0
          ? `submit_review refused: inspect the diff and use read_file or search on at least ${requiredExplicitCalls} relevant files/search targets before submitting final findings.`
          : "submit_review refused: inspect the diff and at least one relevant file or search result before submitting final findings.",
        inspection: visibleInspection,
      },
    };
  }
  const coverageGaps = coverageGapsForInspection(inspection);
  if (coverageGaps.length) {
    return {
      done: false,
      error: {
        ok: false,
        correction_kind: "inspection",
        error: "submit_review refused: inspect each high-risk changed hunk with read_file before submitting final findings.",
        inspection: visibleInspection,
        coverage_gaps: coverageGaps,
      },
    };
  }
  const findingLocationErrors = await verifyFindingLocations(review, verification);
  if (findingLocationErrors.length) {
    return {
      done: false,
      error: {
        ok: false,
        correction_kind: "review-validation",
        error: "submit_review refused: one or more finding locations could not be verified against repository files.",
        findings: findingLocationErrors,
      },
    };
  }
  if (review.verdict === "clean" && !cleanInspectionSatisfied(inspection, minInspection)) {
    return {
      done: false,
      error: {
        ok: false,
        correction_kind: "inspection",
        error: "submit_review refused: clean verdict requires more repository inspection. Use read_file or search on at least two relevant files/search targets before returning clean.",
        inspection: visibleInspection,
        required: {
          cleanExplicitFileOrSearchToolCalls: minInspection.cleanExplicitFileOrSearchToolCalls,
        },
      },
    };
  }
  return { done: true, review: withCoverageVerificationGaps(review, inspection) };
}

function withCoverageVerificationGaps(review, inspection) {
  const coverage = inspection?.coverage;
  if (!coverage?.diffTruncated || coverage?.enabled) {
    return review;
  }
  const gaps = Array.isArray(review.verification_gaps) ? review.verification_gaps : [];
  if (gaps.includes(COVERAGE_TRUNCATED_GAP)) {
    return review;
  }
  return { ...review, verification_gaps: [...gaps, COVERAGE_TRUNCATED_GAP] };
}

async function verifyFindingLocations(review, { tools, controller, abort } = {}) {
  if (!Array.isArray(review.findings) || review.findings.length === 0) {
    return [];
  }
  if (!tools?.execute) {
    return [];
  }
  const errors = [];
  let diffInfo;
  let diffLoaded = false;
  const getDiffInfo = async () => {
    if (diffLoaded) {
      return diffInfo;
    }
    diffLoaded = true;
    try {
      const result = await tools.execute("get_diff", {}, {
        controller,
        signal: abort?.signal,
      });
      diffInfo = {
        text: result?.ok ? String(result.diff ?? "") : "",
        truncated: Boolean(result?.ok && result?.truncated),
      };
    } catch {
      diffInfo = { text: "", truncated: false };
    }
    throwIfCancelled(controller);
    return diffInfo;
  };
  for (const finding of review.findings) {
    const file = String(finding.file ?? "").trim();
    const start = Number(finding.line_start);
    const end = Number(finding.line_end);
    if (!file || !Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
      errors.push({
        title: finding.title || "(untitled)",
        file,
        line_start: finding.line_start ?? null,
        line_end: finding.line_end ?? null,
        error: "finding location is missing or invalid",
      });
      continue;
    }
    if (end - start + 1 > MAX_FINDING_LOCATION_LINES) {
      errors.push({
        title: finding.title || "(untitled)",
        file,
        line_start: start,
        line_end: end,
        error: `finding range spans more than ${MAX_FINDING_LOCATION_LINES} lines; cite a narrower range`,
      });
      continue;
    }
    const requestedEnd = end;
    let result;
    try {
      result = await tools.execute("read_file", {
        path: file,
        start_line: start,
        end_line: requestedEnd,
      }, {
        controller,
        signal: abort?.signal,
      });
    } catch (error) {
      result = {
        ok: false,
        error: error?.message || String(error),
      };
    }
    throwIfCancelled(controller);
    const returnedPath = String(result?.path ?? "").trim();
    if (!result?.ok) {
      errors.push({
        title: finding.title || "(untitled)",
        file,
        line_start: start,
        line_end: end,
        error: `finding location could not be verified: ${result?.error || "no readable content at the cited line"}`,
      });
      continue;
    }
    if (comparableReviewPath(returnedPath) !== comparableReviewPath(file)) {
      errors.push({
        title: finding.title || "(untitled)",
        file,
        line_start: start,
        line_end: end,
        error: `finding location could not be verified: read_file returned ${returnedPath || "(no path)"} for ${file}`,
      });
      continue;
    }
    const returnedEnd = Number(result?.end_line ?? requestedEnd);
    const hasCurrentLineContent = String(result.content ?? "").trim()
      && Number.isInteger(returnedEnd)
      && returnedEnd >= start;
    if (hasCurrentLineContent) {
      continue;
    }
    const diff = await getDiffInfo();
    if (!diffHasDeletedLineCoverage(diff.text, file, start, end)) {
      if (diff.truncated) {
        continue;
      }
      errors.push({
        title: finding.title || "(untitled)",
        file,
        line_start: start,
        line_end: end,
        error: "finding location could not be verified: no current content and no matching deleted-line diff",
      });
    }
  }
  return errors;
}

function comparableReviewPath(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
}

function diffHasDeletedLineCoverage(diffText, file, start, end) {
  const target = comparableReviewPath(file);
  let currentFileMatches = false;
  let pendingOldPath = "";
  let oldLine = null;
  let newLine = null;
  for (const line of String(diffText ?? "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const paths = parseDiffGitPathTokens(line.slice("diff --git ".length));
      const oldPath = normalizeDiffPath(paths[0] ?? "");
      const newPath = normalizeDiffPath(paths[1] ?? "");
      currentFileMatches = oldPath === target || newPath === target;
      pendingOldPath = "";
      oldLine = null;
      newLine = null;
      continue;
    }
    if (!Number.isInteger(oldLine) || !Number.isInteger(newLine)) {
      if (line.startsWith("--- ")) {
        pendingOldPath = normalizeDiffPath(parseUnifiedDiffHeaderPath(line.slice(4)));
        continue;
      }
      if (line.startsWith("+++ ")) {
        const newPath = normalizeDiffPath(parseUnifiedDiffHeaderPath(line.slice(4)));
        currentFileMatches = currentFileMatches
          || pendingOldPath === target
          || newPath === target;
        continue;
      }
    }
    if (!currentFileMatches) {
      continue;
    }
    const hunk = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      continue;
    }
    if (!Number.isInteger(oldLine) || !Number.isInteger(newLine)) {
      continue;
    }
    if (line.startsWith("-")) {
      if (oldLine >= start && oldLine <= end) {
        return true;
      }
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      newLine += 1;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      oldLine += 1;
      newLine += 1;
    }
  }
  return false;
}

function normalizeDiffPath(value) {
  return comparableReviewPath(stripGitSidePrefix(value));
}

function createCoverageState() {
  return {
    enabled: false,
    diffTruncated: false,
    highRiskHunks: [],
    coveredHunkIds: new Set(),
  };
}

function updateCoverageFromDiff(inspection, result) {
  const diff = String(result?.diff ?? "");
  if (!result?.ok || !diff.trim()) {
    return;
  }
  const previousCovered = inspection.coverage?.coveredHunkIds ?? new Set();
  const coverage = coverageLedgerFromDiff(diff, {
    // Prefer the diff-specific truncation signal (get_review_context sets it via
    // truncateObject); fall back to `result.truncated` for get_diff, where the
    // diff is the only payload so the flags coincide. This keeps snippet-only
    // truncation from falsely disabling high-risk hunk coverage.
    truncated: Boolean(result.diffTruncated ?? result.truncated),
    previousCovered,
  });
  inspection.coverage = coverage;
  for (const range of inspection.readRanges ?? []) {
    markCoverageRange(coverage, range);
  }
  result.coverage_ledger = boundCoverageLedger(visibleCoverageState(coverage));
}

function markCoverageFromRead(inspection, result, input = {}) {
  const file = comparableReviewPath(result.path ?? input.path);
  const start = Number(result.start_line ?? input.start_line ?? 1);
  const reportedEnd = Number(result.end_line ?? input.end_line ?? start);
  // Credit coverage only for lines actually present in the returned content — the
  // last visible `N:` line — never the reported end_line alone, which a downstream
  // truncation could leave pointing past what the model can see (a coverage-gate
  // bypass). Absent verifiable content lines, credit nothing (fail closed).
  const visibleEnd = lastNumberedLine(result.content);
  const end = Number.isFinite(visibleEnd) ? Math.min(reportedEnd, visibleEnd) : NaN;
  if (!file || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return;
  }
  const range = { file, start, end };
  inspection.readRanges ??= [];
  inspection.readRanges.push(range);
  const coverage = inspection.coverage;
  if (!coverage?.enabled || !coverage.highRiskHunks.length) {
    return;
  }
  markCoverageRange(coverage, range);
  result.coverage_ledger = boundCoverageLedger(visibleCoverageState(coverage));
}

function markCoverageRange(coverage, range) {
  if (!coverage?.enabled || !coverage.highRiskHunks.length) {
    return;
  }
  for (const hunk of coverage.highRiskHunks) {
    if (hunk.file === range.file && rangesOverlap(range.start, range.end, hunk.line_start, hunk.line_end)) {
      coverage.coveredHunkIds.add(hunk.id);
    }
  }
}

function coverageGapsForInspection(inspection) {
  const coverage = inspection.coverage;
  if (!coverage?.enabled) {
    return [];
  }
  return coverage.highRiskHunks
    .filter((hunk) => !coverage.coveredHunkIds.has(hunk.id))
    .slice(0, MAX_COVERAGE_GAPS)
    .map(({ id: _id, ...hunk }) => hunk);
}

// Keep the attached coverage_ledger within its reserved headroom by dropping
// trailing hint hunks if a pathological path/reason list would exceed it. Dropping
// hints never weakens the gate: coverage is enforced server-side from the full
// hunk set (coverageGapsForInspection), not from what the ledger displays.
function boundCoverageLedger(ledger) {
  // Budget the FULL serialized attachment — the `,"coverage_ledger":` envelope key
  // plus the value — not just the value, so attaching it to a result already bounded
  // to (cap - reserve) can never push the payload over the cap and force a later trim
  // (which would invalidate coverage already recorded from the pre-trim content).
  const attachedBytes = (candidate) =>
    Buffer.byteLength(`,"coverage_ledger":${JSON.stringify(candidate)}`, "utf8");
  if (attachedBytes(ledger) <= COVERAGE_LEDGER_RESERVE) {
    return ledger;
  }
  const bounded = { ...ledger, missingHighRiskHunks: [...(ledger.missingHighRiskHunks ?? [])] };
  while (bounded.missingHighRiskHunks.length && attachedBytes(bounded) > COVERAGE_LEDGER_RESERVE) {
    bounded.missingHighRiskHunks.pop();
  }
  return bounded;
}

function visibleCoverageState(coverage) {
  if (!coverage?.enabled) {
    return {
      enabled: false,
      diffTruncated: Boolean(coverage?.diffTruncated),
    };
  }
  const gaps = coverageGapsForInspection({ coverage });
  return {
    enabled: true,
    highRiskHunks: coverage.highRiskHunks.length,
    coveredHighRiskHunks: coverage.coveredHunkIds.size,
    missingHighRiskHunks: gaps,
  };
}

function coverageLedgerFromDiff(diffText, { truncated = false, previousCovered = new Set() } = {}) {
  const coverage = createCoverageState();
  coverage.diffTruncated = truncated;
  if (truncated) {
    return coverage;
  }
  coverage.enabled = true;
  let currentFile = "";
  let currentHunk = null;
  let hunkIndex = 0;

  const pushHunk = () => {
    if (!currentHunk) {
      return;
    }
    const risk = highRiskHunkReason(currentHunk.file, currentHunk.changedText);
    if (risk && currentHunk.newCount > 0) {
      const lineStart = currentHunk.newStart;
      const lineEnd = currentHunk.newStart + currentHunk.newCount - 1;
      const id = `${currentHunk.file}:${lineStart}-${lineEnd}:${hunkIndex}`;
      hunkIndex += 1;
      coverage.highRiskHunks.push({
        id,
        file: currentHunk.file,
        line_start: lineStart,
        line_end: lineEnd,
        reason: risk,
      });
      if (previousCovered.has(id)) {
        coverage.coveredHunkIds.add(id);
      }
    }
    currentHunk = null;
  };

  for (const line of String(diffText ?? "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      pushHunk();
      const paths = parseDiffGitPathTokens(line.slice("diff --git ".length));
      currentFile = normalizeDiffPath(paths[1] ?? paths[0] ?? "");
      continue;
    }
    if (line.startsWith("--- ")) {
      const oldPath = diffHeaderPath(line.slice(4));
      if (!currentFile) {
        currentFile = oldPath;
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = diffHeaderPath(line.slice(4));
      if (newPath) {
        currentFile = newPath;
      }
      continue;
    }
    const hunk = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunk) {
      pushHunk();
      currentHunk = {
        file: currentFile,
        newStart: Number(hunk[3]),
        newCount: hunk[4] === undefined ? 1 : Number(hunk[4]),
        changedText: "",
      };
      continue;
    }
    if (!currentHunk) {
      continue;
    }
    if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) {
      currentHunk.changedText += `${line.slice(1)}\n`;
    }
  }
  pushHunk();
  return coverage;
}

function diffHeaderPath(value) {
  const file = normalizeDiffPath(parseUnifiedDiffHeaderPath(value));
  return file === "/dev/null" || file === "dev/null" ? "" : file;
}

function highRiskHunkReason(file, changedText) {
  // ponytail: heuristic risk ledger; add LSP/graph impact only when this proves too blunt.
  if (HIGH_RISK_PATH_RE.test(file)) {
    return "high-risk path";
  }
  const match = String(changedText ?? "").match(HIGH_RISK_DIFF_RE);
  return match ? `changed text matches '${match[0]}'` : "";
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA <= endB && startB <= endA;
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
    updateCoverageFromDiff(inspection, result);
    return;
  }
  if (name === "get_diff") {
    inspection.diff = true;
    updateCoverageFromDiff(inspection, result);
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
    if (name === "read_file") {
      markCoverageFromRead(inspection, result, input);
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
    coverage: visibleCoverageState(inspection.coverage),
  };
}

function inspectionProgressKey(inspection) {
  return JSON.stringify(visibleInspectionState(inspection));
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

function submitReviewToolSchema({ strict = false } = {}) {
  return {
    name: "submit_review",
    description: "Submit the final structured review after inspecting repository evidence.",
    input_schema: REVIEW_RESULT_SCHEMA,
    ...(strict ? { strict: true } : {}),
  };
}

function initialPrompt({ provider, brief, focus, mode }) {
  const modeLabel = mode === "adversarial-review" ? "adversarial production review" : "production code review";
  const briefText = brief?.trim() || "";
  const focusText = focus?.trim() || "";
  const lines = [
    `Perform a serious ${modeLabel} of the current workspace as ${provider}.`,
    "",
    "You have read-only repository tools. Use them. Do not submit a final review until you have inspected the diff and used read_file or search on at least two relevant files/search targets.",
    "If get_diff or get_review_context returns a coverage_ledger with missingHighRiskHunks, use read_file on each listed file/line range before submitting.",
    "If you intend to return verdict clean, you must first use read_file or search on at least two relevant files/search targets. A shallow clean verdict will be rejected.",
    "",
    "Review rules:",
    "- Prefer concrete bugs, regressions, security issues, lifecycle races, and missing verification.",
    "- Cite file paths and line numbers from inspected files.",
    "- For a bug caused by a missing change elsewhere, put it in missing_change_findings anchored to inspected evidence instead of inventing a line for absent code.",
    "- Treat user-provided prior findings as hypotheses, not facts.",
    "- If evidence is missing, put that in verification_gaps instead of inventing a finding.",
    "- Do not report vague concerns, stylistic preferences, or issues that are already covered by tests unless the tests are insufficient.",
    "- Severity rubric: critical means security breach, data loss, irreversible corruption, or production outage; high means likely user-visible regression, broken workflow, or serious correctness issue; medium means plausible bug or bounded edge case; low means maintainability, test, or documentation gap.",
    "",
    "Suggested flow:",
    "1. Start from the preloaded review context when present, otherwise call get_review_context.",
    "2. Search/read the most relevant files and tests if the preloaded snippets are insufficient.",
    "3. Read every high-risk hunk named by coverage_ledger.",
    "4. Cross-check findings against tests or adjacent code.",
    "5. Call submit_review with the final structured review.",
  ];
  if (!briefText || (focusText && !briefText.includes(focusText))) {
    lines.push(
      "",
      "User focus:",
      focusText || "No extra focus provided.",
    );
  }
  if (briefText) {
    lines.push(
      "",
      "# Supermodels Review Brief",
      "Treat this brief as steering context, not as a substitute for tool inspection.",
      briefText,
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
  if (provider === "grok") {
    return [{
      type: "text",
      text: "You are Grok Build reviewing for Codex. Be direct and adversarial toward the diff, but ground every claim in inspected repository evidence.",
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
      text: "Submit the final structured review with the evidence you have. If coverage_ledger still has missingHighRiskHunks, read those hunks before submitting. If you found no concrete bugs but have not used read_file or search on at least two relevant files/search targets, return verdict inconclusive and explain the remaining verification gaps instead of clean.",
    }],
  };
}

function structuredConversionInstruction(finalText) {
  return {
    role: "user",
    content: [{
      type: "text",
      text: [
        "You appear to have finished the review without a tool call.",
        "Convert your final answer into the required structured review now.",
        "Prefer calling submit_review. If you cannot call a tool, return only a JSON object matching the review schema.",
        "Do not perform additional repository inspection unless you need new evidence.",
        "",
        "Your final answer to convert:",
        finalText?.trim() || "(empty)",
      ].join("\n"),
    }],
  };
}

function naturalReviewRejectionInstruction(error) {
  return [
    "Your final structured review could not be accepted yet.",
    "Address this validation result, then submit the final structured review again.",
    "",
    JSON.stringify(error, null, 2),
  ].join("\n");
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

function preloadedEvidenceMessage(preloaded, maxBytes = Number.POSITIVE_INFINITY) {
  const header = "Codex preloaded the following repository evidence before the provider call. Treat it as tool output and ground the review in it. You may call additional repository tools if this evidence is insufficient.";
  // Compact, never pretty-printed: indentation multiplies the size (up to ~2.4x on
  // structure-heavy evidence) with no parsing benefit and would break the cap.
  const build = (items) => `${header}\n\n${JSON.stringify({ preloaded: items })}`;
  if (Buffer.byteLength(build(preloaded), "utf8") <= maxBytes) {
    return build(preloaded);
  }
  // The model-visible preload exceeds the cap: bound each embedded result to a
  // share of the budget (after the fixed header/envelope) so the whole MESSAGE
  // fits, not just the tool result the dispatcher already capped. Coverage is
  // unaffected — the hunk ledger was already built from the full diff, and reads
  // (not the embedded diff) credit coverage.
  const envelope = Buffer.byteLength(
    build(preloaded.map((entry) => ({ tool: entry.tool, result: null }))),
    "utf8",
  );
  const perResult = Math.max(0, Math.floor((maxBytes - envelope) / Math.max(1, preloaded.length)));
  const bounded = preloaded.map((entry) => ({
    tool: entry.tool,
    result: enforceSerializedCap({ ...entry.result }, perResult),
  }));
  return build(bounded);
}

function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages));
}

function responseText(response) {
  const fromText = String(response?.text ?? "").trim();
  if (fromText) {
    return fromText;
  }
  if (!Array.isArray(response?.content)) {
    return "";
  }
  return response.content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function inconclusiveUnstructuredFinalReview(finalText) {
  const text = String(finalText ?? "").trim();
  const summary = text
    ? `Provider ended without structured review output: ${limitSummary(text)}`
    : "Provider ended without structured review output.";
  return {
    verdict: "inconclusive",
    summary,
    findings: [],
    assumptions: [],
    verification_gaps: [
      "Provider ended after a structured-conversion prompt without returning parseable structured review JSON.",
    ],
  };
}

function inconclusiveRejectedStructuredReview(error, metadata) {
  const detail = limitSummary(JSON.stringify(error), 1000);
  const summary = `Provider structured review could not be accepted after correction: ${limitSummary(JSON.stringify(error))}`;
  return {
    verdict: "inconclusive",
    summary,
    findings: [],
    assumptions: [],
    verification_gaps: [
      "Provider returned structured review output that failed Supermodels validation after the allowed correction attempts.",
      detail,
    ],
    toolUsage: metadata.toolUsage,
    rounds: metadata.rounds,
    usage: metadata.usage,
    reviewConfig: reviewConfigMetadata({
      provider: metadata.provider,
      model: metadata.model,
      maxTokens: metadata.maxTokens,
      reasoningOptions: metadata.reasoningOptions,
      rounds: metadata.rounds,
      toolUsage: metadata.toolUsage,
    }),
  };
}

function inconclusiveRepeatedInspectionRefusals(error, metadata) {
  const summary = `Provider structured review could not be accepted after repeated inspection requirements: ${limitSummary(JSON.stringify(error))}`;
  return {
    verdict: "inconclusive",
    summary,
    findings: [],
    assumptions: [],
    verification_gaps: [
      "Provider repeatedly submitted a final review before completing required repository inspection.",
      limitSummary(JSON.stringify(error)),
    ],
    toolUsage: metadata.toolUsage,
    rounds: metadata.rounds,
    usage: metadata.usage,
    reviewConfig: reviewConfigMetadata({
      provider: metadata.provider,
      model: metadata.model,
      maxTokens: metadata.maxTokens,
      reasoningOptions: metadata.reasoningOptions,
      rounds: metadata.rounds,
      toolUsage: metadata.toolUsage,
    }),
  };
}

function limitSummary(text, maxLength = 300) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}...`
    : normalized;
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
