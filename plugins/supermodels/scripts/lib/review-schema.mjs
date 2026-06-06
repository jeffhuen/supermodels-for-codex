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
  ].join("\n");
}

export function normalizeStructuredReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const verdict = String(value.verdict ?? "").trim();
  if (!VALID_VERDICTS.has(verdict)) {
    return null;
  }

  const findings = Array.isArray(value.findings)
    ? value.findings.map(normalizeStructuredFinding).filter(Boolean)
    : null;
  if (!findings) {
    return null;
  }

  return {
    verdict,
    summary: String(value.summary ?? "").trim(),
    findings,
    assumptions: normalizeStringArray(value.assumptions),
    verification_gaps: normalizeStringArray(value.verification_gaps),
  };
}

export function parseStructuredReviewText(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    return null;
  }

  for (const candidate of structuredJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeStructuredReview(parsed);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export function structuredReviewToFindings(review) {
  const normalized = normalizeStructuredReview(review);
  return normalized?.findings ?? [];
}

function normalizeStructuredFinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const severity = normalizeSeverity(value.severity);
  const confidence = normalizeConfidence(value.confidence);
  if (!VALID_CONFIDENCE.has(confidence)) {
    return null;
  }
  return {
    severity,
    title: String(value.title ?? "").trim(),
    body: String(value.evidence ?? value.title ?? "").trim(),
    evidence: String(value.evidence ?? "").trim(),
    impact: String(value.impact ?? "").trim(),
    recommendation: String(value.recommendation ?? "").trim(),
    file: String(value.file ?? "").trim(),
    line_start: normalizeLine(value.line_start),
    line_end: normalizeLine(value.line_end),
    confidence,
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
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }
  const object = extractFirstJsonObject(text);
  if (object) {
    candidates.push(object);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < text.length; index += 1) {
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
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return "";
}
