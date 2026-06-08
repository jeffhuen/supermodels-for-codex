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
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
          title: { type: "string" },
          evidence: { type: "string" },
          impact: { type: "string" },
          recommendation: { type: "string" },
          file: { type: "string" },
          line_start: { type: "integer" },
          line_end: { type: "integer" },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
        },
        required: [
          "severity",
          "title",
          "evidence",
          "impact",
          "recommendation",
          "file",
          "line_start",
          "line_end",
          "confidence",
        ],
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
    "assumptions",
    "verification_gaps",
  ],
});

const VALID_VERDICTS = new Set(["clean", "needs-attention", "inconclusive"]);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

export function structuredReviewInstructions() {
  return [
    "# Required Structured Result",
    "",
    "Return only a JSON object matching this contract. Do not wrap it in Markdown and do not add prose outside the JSON.",
    "",
    "Required top-level fields:",
    "- verdict: clean | needs-attention | inconclusive",
    "- summary: concise review summary",
    "- findings: array of concrete findings, ordered by severity",
    "- assumptions: array of assumptions you relied on",
    "- verification_gaps: array of checks that still need verification",
    "",
    "Each finding must include severity, title, evidence, impact, recommendation, file, line_start, line_end, and confidence.",
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

export function validateStructuredReview(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { review: null, errors: ["review must be an object"] };
  }

  const verdict = String(value.verdict ?? "").trim();
  if (!VALID_VERDICTS.has(verdict)) {
    return { review: null, errors: ["verdict must be clean, needs-attention, or inconclusive"] };
  }

  if (!Array.isArray(value.findings)) {
    return { review: null, errors: ["findings must be an array"] };
  }
  const findings = [];
  value.findings.forEach((finding, index) => {
    const { finding: normalized, errors: findingErrors } = normalizeStructuredFinding(finding, `findings[${index}]`);
    if (findingErrors.length) {
      errors.push(...findingErrors);
      return;
    }
    findings.push(normalized);
  });
  if (verdict === "needs-attention" && findings.length === 0) {
    errors.push("needs-attention reviews must include at least one valid finding");
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

export function parseStructuredReviewText(rawText) {
  return validateStructuredReviewText(rawText).review;
}

export function validateStructuredReviewText(rawText) {
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
      const validation = validateStructuredReview(value);
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

function normalizeStructuredFinding(value, prefix = "finding") {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { finding: null, errors: [`${prefix} must be an object`] };
  }
  const severity = normalizeSeverity(value.severity);
  const confidence = normalizeConfidence(value.confidence);
  const title = String(value.title ?? "").trim();
  const evidence = String(value.evidence ?? "").trim();
  const impact = String(value.impact ?? "").trim();
  const recommendation = String(value.recommendation ?? "").trim();
  const file = String(value.file ?? "").trim();
  const lineStart = normalizeLine(value.line_start);
  const lineEnd = normalizeLine(value.line_end);
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
    errors.push(`${prefix}.file must be non-empty`);
  }
  if (!lineStart) {
    errors.push(`${prefix}.line_start must be a positive integer`);
  }
  if (!lineEnd) {
    errors.push(`${prefix}.line_end must be a positive integer`);
  }
  if (lineStart && lineEnd && lineEnd < lineStart) {
    errors.push(`${prefix}.line_end must be greater than or equal to line_start`);
  }
  if (errors.length) {
    return { finding: null, errors };
  }
  return {
    finding: {
      severity,
      title,
      body: evidence,
      evidence,
      impact,
      recommendation,
      file,
      line_start: lineStart,
      line_end: lineEnd,
      confidence,
    },
    errors: [],
  };
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
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
