const SEVERITY_ENUM = { type: "string", enum: ["critical", "high", "medium", "low"] };
const CONFIDENCE_ENUM = { type: "string", enum: ["high", "medium", "low"] };

export const REVIEW_RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["clean", "needs-attention", "inconclusive"],
    },
    summary: {
      type: "string",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: SEVERITY_ENUM,
          title: { type: "string" },
          evidence: { type: "string" },
          impact: { type: "string" },
          recommendation: { type: "string" },
          confidence: CONFIDENCE_ENUM,
          file: { type: "string" },
          line_start: { type: "integer" },
          line_end: { type: "integer" },
        },
        required: [
          "severity",
          "title",
          "evidence",
          "impact",
          "recommendation",
          "confidence",
          "file",
          "line_start",
          "line_end",
        ],
        additionalProperties: false,
      },
    },
    missing_change_findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: SEVERITY_ENUM,
          title: { type: "string" },
          evidence: { type: "string" },
          impact: { type: "string" },
          recommendation: { type: "string" },
          confidence: CONFIDENCE_ENUM,
          anchor_file: { type: "string" },
          anchor_line: { type: "integer" },
          expected_symbol: { type: "string" },
          searched_for: { type: "string" },
          missing_change_reason: { type: "string" },
        },
        required: [
          "severity",
          "title",
          "evidence",
          "impact",
          "recommendation",
          "confidence",
          "anchor_file",
          "anchor_line",
          "expected_symbol",
          "searched_for",
          "missing_change_reason",
        ],
        additionalProperties: false,
      },
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
    },
    verification_gaps: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "verdict",
    "summary",
    "findings",
    "missing_change_findings",
    "assumptions",
    "verification_gaps",
  ],
  additionalProperties: false,
});

const VALID_VERDICTS = new Set(["clean", "needs-attention", "inconclusive"]);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const WIRE_FIELDS = new Set([
  "verdict",
  "summary",
  "findings",
  "missing_change_findings",
  "assumptions",
  "verification_gaps",
]);
const CODE_FINDING_FIELDS = new Set([
  "severity",
  "title",
  "evidence",
  "impact",
  "recommendation",
  "confidence",
  "file",
  "line_start",
  "line_end",
]);
const MISSING_FINDING_FIELDS = new Set([
  "severity",
  "title",
  "evidence",
  "impact",
  "recommendation",
  "confidence",
  "anchor_file",
  "anchor_line",
  "expected_symbol",
  "searched_for",
  "missing_change_reason",
]);

export function structuredReviewInstructions() {
  return [
    "# Required Structured Result",
    "",
    "Return only a JSON object matching this contract. Do not wrap it in Markdown and do not add prose outside the JSON.",
    "",
    "Required top-level fields:",
    "- verdict: clean | needs-attention | inconclusive",
    "- summary: concise review summary",
    "- findings: array of concrete code findings, ordered by severity; use [] when there are none",
    "- missing_change_findings: array of expected-but-absent changes; use [] when there are none",
    "- assumptions: array of assumptions you relied on",
    "- verification_gaps: array of checks that still need verification",
    "",
    "Each entry in findings must include severity, title, evidence, impact, recommendation, file, line_start, line_end, and confidence.",
    "Each entry in missing_change_findings must include severity, title, evidence, impact, recommendation, anchor_file, anchor_line, expected_symbol, searched_for, missing_change_reason, and confidence; anchor_file:anchor_line must point to inspected repository evidence.",
    "",
    "Severity rubric:",
    "- critical: security breach, data loss, irreversible corruption, or production outage.",
    "- high: likely user-visible regression, broken workflow, or serious correctness issue.",
    "- medium: plausible bug or edge case with bounded impact.",
    "- low: maintainability issue, confusing behavior, test gap, or documentation gap.",
  ].join("\n");
}

export function normalizeStructuredReview(value) {
  return validateStructuredReview(value).review;
}

export function validateStructuredReview(value, options = {}) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { review: null, errors: ["review must be an object"] };
  }
  const strictWire = Boolean(options.strictWire);
  if (strictWire) {
    validateWireObjectFields(value, WIRE_FIELDS, "", errors);
    for (const field of WIRE_FIELDS) {
      if (!Object.hasOwn(value, field)) {
        errors.push(`${field} is required`);
      }
    }
    if (Object.hasOwn(value, "summary") && typeof value.summary !== "string") {
      errors.push("summary must be a string");
    }
    validateWireStringArray(value, "assumptions", errors);
    validateWireStringArray(value, "verification_gaps", errors);
  }

  const verdict = String(value.verdict ?? "").trim();
  if (strictWire && (typeof value.verdict !== "string" || value.verdict !== verdict)) {
    errors.push("verdict must be an exact schema enum string");
  }
  if (!VALID_VERDICTS.has(verdict)) {
    return { review: null, errors: ["verdict must be clean, needs-attention, or inconclusive"] };
  }

  // Two explicit modes, selected by whether the split-array wire is present.
  //
  // Split mode (new strict-native wire): `findings` carries code findings and
  // `missing_change_findings` carries missing-change findings. Kind is forced
  // by the array an item came from, after spreading, so a loose provider cannot
  // override the array's implied kind.
  //
  // Legacy mode (no `missing_change_findings` key): `findings` is a single
  // mixed array and kind is inferred per item. This path is required, not a
  // courtesy: runtime.mjs re-normalizes the already-normalized internal review,
  // whose merged `findings` list carries `kind` and has no
  // `missing_change_findings` key. Inferring kind here (instead of forcing
  // `findings` -> code) keeps normalization idempotent on that second pass.
  const splitMode = strictWire || value.missing_change_findings !== undefined;

  let codeItems;
  let missingItems;
  if (splitMode) {
    if (!Array.isArray(value.findings)) {
      errors.push("findings must be an array");
    }
    if (!Array.isArray(value.missing_change_findings)) {
      errors.push("missing_change_findings must be an array");
    }
    if (errors.length) {
      return { review: null, errors };
    }
    codeItems = value.findings;
    missingItems = value.missing_change_findings;
  } else {
    const rawFindings = normalizeFindingsArray(value.findings, verdict);
    if (!rawFindings) {
      return { review: null, errors: ["findings must be an array"] };
    }
    codeItems = rawFindings;
    missingItems = [];
  }

  // Validate the two arrays separately, before merging, so item errors keep
  // precise paths (findings[i] / missing_change_findings[i]).
  const codeFindings = collectStructuredFindings(codeItems, "findings", errors, {
    forcedKind: splitMode ? "code" : "",
    strictWire,
  });
  const missingFindings = collectStructuredFindings(missingItems, "missing_change_findings", errors, {
    forcedKind: "missing-change",
    strictWire,
  });
  // Merge order: code findings first, then missing-change, preserving input
  // order within each array. No dedup, no ordinals.
  const findings = [...codeFindings, ...missingFindings];

  if (verdict === "needs-attention" && findings.length === 0) {
    errors.push("needs-attention reviews must include at least one valid finding");
  }
  if (verdict === "clean" && findings.length > 0) {
    errors.push("clean reviews must not include findings");
  }
  if (errors.length) {
    return { review: null, errors };
  }

  return {
    review: {
      verdict,
      summary: String(value.summary ?? "").trim(),
      findings,
      assumptions: normalizeStringArray(value.assumptions),
      verification_gaps: normalizeStringArray(value.verification_gaps),
    },
    errors: [],
  };
}

export function validateStructuredReviewWire(value) {
  return validateStructuredReview(value, { strictWire: true });
}

function collectStructuredFindings(items, prefix, errors, options = {}) {
  const findings = [];
  items.forEach((finding, index) => {
    const { finding: normalized, errors: findingErrors } = normalizeStructuredFinding(
      finding,
      `${prefix}[${index}]`,
      options,
    );
    if (findingErrors.length) {
      errors.push(...findingErrors);
      return;
    }
    findings.push(normalized);
  });
  return findings;
}

export function parseStructuredReviewText(rawText) {
  return validateStructuredReviewText(rawText).review;
}

export function validateStructuredReviewText(rawText, options = {}) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    return { review: null, errors: [], parsed: false };
  }

  let parsed = false;
  let errors = [];
  for (const candidate of structuredJsonCandidates(text)) {
    try {
      const value = JSON.parse(candidate);
      parsed = true;
      const validation = validateStructuredReview(value, options);
      if (validation.review) {
        return { ...validation, parsed: true };
      }
      if (!errors.length && validation.errors.length) {
        errors = validation.errors;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return { review: null, errors, parsed };
}

export function structuredReviewToFindings(review) {
  const normalized = normalizeStructuredReview(review);
  return normalized?.findings ?? [];
}

function normalizeStructuredFinding(value, prefix = "finding", options = {}) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { finding: null, errors: [`${prefix} must be an object`] };
  }
  const strictWire = Boolean(options.strictWire);
  const forcedKind = options.forcedKind || "";
  if (strictWire) {
    validateWireObjectFields(
      value,
      forcedKind === "missing-change" ? MISSING_FINDING_FIELDS : CODE_FINDING_FIELDS,
      prefix,
      errors,
    );
  }
  const severity = normalizeSeverity(value.severity);
  const confidence = normalizeConfidence(value.confidence);
  const title = String(value.title ?? "").trim();
  const evidence = String(value.evidence ?? "").trim();
  const impact = String(value.impact ?? "").trim();
  const recommendation = String(value.recommendation ?? "").trim();
  const kind = forcedKind || normalizeFindingKind(value.kind);
  const missingChange = kind === "missing-change";
  const anchorFile = String(value.anchor_file ?? "");
  const anchorLine = normalizeLine(value.anchor_line);
  const file = missingChange ? anchorFile : String(value.file ?? "");
  const lineStart = missingChange ? anchorLine : normalizeLine(value.line_start);
  const lineEnd = missingChange ? anchorLine : normalizeLine(value.line_end);
  const expectedSymbol = String(value.expected_symbol ?? "").trim();
  const searchedFor = String(value.searched_for ?? "").trim();
  const missingChangeReason = String(value.missing_change_reason ?? "").trim();
  if (strictWire) {
    if (!VALID_SEVERITIES.has(String(value.severity ?? ""))) {
      errors.push(`${prefix}.severity must be critical, high, medium, or low`);
    }
    if (!VALID_CONFIDENCE.has(String(value.confidence ?? ""))) {
      errors.push(`${prefix}.confidence must be high, medium, or low`);
    }
    const stringFields = missingChange
      ? ["title", "evidence", "impact", "recommendation", "anchor_file", "expected_symbol", "searched_for", "missing_change_reason"]
      : ["title", "evidence", "impact", "recommendation", "file"];
    for (const field of stringFields) {
      if (typeof value[field] !== "string") {
        errors.push(`${prefix}.${field} must be a string`);
      }
    }
    const integerFields = missingChange
      ? ["anchor_line"]
      : ["line_start", "line_end"];
    for (const field of integerFields) {
      if (typeof value[field] !== "number" || !Number.isInteger(value[field])) {
        errors.push(`${prefix}.${field} must be an integer`);
      }
    }
  }
  if (!title) {
    errors.push(`${prefix}.title must be non-empty`);
  }
  if (!evidence) {
    errors.push(`${prefix}.evidence must be non-empty`);
  }
  if (!impact) {
    errors.push(`${prefix}.impact must be non-empty`);
  }
  if (!recommendation) {
    errors.push(`${prefix}.recommendation must be non-empty`);
  }
  if (!file) {
    errors.push(`${prefix}.${missingChange ? "anchor_file" : "file"} must be non-empty`);
  }
  if (!lineStart) {
    errors.push(`${prefix}.${missingChange ? "anchor_line" : "line_start"} must be a positive integer`);
  }
  if (!missingChange && !lineEnd) {
    errors.push(`${prefix}.line_end must be a positive integer`);
  }
  if (lineStart && lineEnd && lineEnd < lineStart) {
    errors.push(`${prefix}.line_end must be greater than or equal to line_start`);
  }
  if (missingChange && !expectedSymbol) {
    errors.push(`${prefix}.expected_symbol must be non-empty`);
  }
  if (missingChange && !searchedFor) {
    errors.push(`${prefix}.searched_for must be non-empty`);
  }
  if (missingChange && !missingChangeReason) {
    errors.push(`${prefix}.missing_change_reason must be non-empty`);
  }
  if (errors.length) {
    return { finding: null, errors };
  }
  return {
    finding: {
      kind,
      severity,
      title,
      body: evidence,
      evidence,
      impact,
      recommendation,
      file,
      line_start: lineStart,
      line_end: lineEnd,
      ...(missingChange
        ? {
          anchor_file: anchorFile,
          anchor_line: anchorLine,
          expected_symbol: expectedSymbol,
          searched_for: searchedFor,
          missing_change_reason: missingChangeReason,
        }
        : {}),
      confidence,
    },
    errors: [],
  };
}

function validateWireObjectFields(value, allowed, prefix, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      errors.push(`${prefix ? `${prefix}.` : ""}${field} is not allowed`);
    }
  }
}

function validateWireStringArray(value, field, errors) {
  if (!Object.hasOwn(value, field)) {
    return;
  }
  if (!Array.isArray(value[field])) {
    errors.push(`${field} must be an array`);
    return;
  }
  value[field].forEach((item, index) => {
    if (typeof item !== "string") {
      errors.push(`${field}[${index}] must be a string`);
    }
  });
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}

function normalizeFindingsArray(value, verdict) {
  if (Array.isArray(value)) {
    return value;
  }
  if (verdict === "needs-attention") {
    return null;
  }
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return [];
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /^(none|n\/a|not applicable|no(?: material| actionable| concrete)? findings?)$/i.test(text)) {
    return [];
  }
  return null;
}

function normalizeSeverity(value) {
  const severity = String(value ?? "").toLowerCase().trim();
  if (severity === "medium-high") {
    return "high";
  }
  if (["blocker", "blocking", "showstopper", "severe"].includes(severity)) {
    return "high";
  }
  return VALID_SEVERITIES.has(severity) ? severity : "medium";
}

function normalizeConfidence(value) {
  const confidence = String(value ?? "").toLowerCase().trim();
  return VALID_CONFIDENCE.has(confidence) ? confidence : "medium";
}

function normalizeFindingKind(value) {
  return String(value ?? "").toLowerCase().trim() === "missing-change"
    ? "missing-change"
    : "code";
}

function normalizeLine(value) {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : null;
}

function structuredJsonCandidates(text) {
  const candidates = [text];
  const fenced = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    fenced.push(match[1].trim());
  }
  candidates.push(...fenced.reverse());
  candidates.push(...extractJsonObjects(text).reverse());
  return [...new Set(candidates.filter(Boolean))];
}

function extractJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let inString = false;
  let escaping = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (character === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}
