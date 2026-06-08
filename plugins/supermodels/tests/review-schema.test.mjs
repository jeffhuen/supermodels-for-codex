import test from "node:test";
import assert from "node:assert/strict";

import { normalizeStructuredReview, structuredReviewInstructions } from "../scripts/lib/review-schema.mjs";

test("normalizeStructuredReview rejects findings with missing location or evidence fields", () => {
  const invalid = normalizeStructuredReview({
    verdict: "needs-attention",
    summary: "Invalid finding should be rejected.",
    findings: [{
      severity: "high",
      title: "",
      evidence: "",
      impact: "Impact is present.",
      recommendation: "Recommendation is present.",
      file: "",
      line_start: null,
      line_end: null,
      confidence: "high",
    }],
    assumptions: [],
    verification_gaps: [],
  });

  assert.equal(invalid, null);
});

test("normalizeStructuredReview rejects impossible finding line ranges", () => {
  const invalid = normalizeStructuredReview({
    verdict: "needs-attention",
    summary: "Line range should be rejected.",
    findings: [{
      severity: "medium",
      title: "Impossible range",
      evidence: "Line end is before line start.",
      impact: "The location is not actionable.",
      recommendation: "Return a valid range.",
      file: "plugins/supermodels/scripts/lib/review-schema.mjs",
      line_start: 20,
      line_end: 10,
      confidence: "medium",
    }],
    assumptions: [],
    verification_gaps: [],
  });

  assert.equal(invalid, null);
});

test("normalizeStructuredReview rejects findings with empty impact or recommendation", () => {
  const invalid = normalizeStructuredReview({
    verdict: "needs-attention",
    summary: "Missing required actionable details.",
    findings: [{
      severity: "medium",
      title: "Missing detail",
      evidence: "Evidence is present.",
      impact: "",
      recommendation: "",
      file: "plugins/supermodels/scripts/lib/review-schema.mjs",
      line_start: 1,
      line_end: 1,
      confidence: "medium",
    }],
    assumptions: [],
    verification_gaps: [],
  });

  assert.equal(invalid, null);
});

test("structuredReviewInstructions include a severity rubric", () => {
  const instructions = structuredReviewInstructions();

  assert.match(instructions, /critical: security/i);
  assert.match(instructions, /high: likely user-visible/i);
  assert.match(instructions, /medium: plausible/i);
  assert.match(instructions, /low: maintainability/i);
});
