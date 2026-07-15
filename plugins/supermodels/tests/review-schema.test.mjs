import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeStructuredReview,
  structuredReviewInstructions,
  REVIEW_RESULT_SCHEMA,
  validateStructuredReview,
} from "../scripts/lib/review-schema.mjs";

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

test("normalizeStructuredReview accepts no-findings text for non-finding verdicts", () => {
  for (const verdict of ["clean", "inconclusive"]) {
    const review = normalizeStructuredReview({
      verdict,
      summary: "No material findings.",
      findings: "none",
      assumptions: [],
      verification_gaps: [],
    });

    assert.equal(review.verdict, verdict);
    assert.deepEqual(review.findings, []);
  }
});

test("normalizeStructuredReview still rejects needs-attention without an array of findings", () => {
  const invalid = normalizeStructuredReview({
    verdict: "needs-attention",
    summary: "Claims a finding without a structured finding array.",
    findings: "none",
    assumptions: [],
    verification_gaps: [],
  });

  assert.equal(invalid, null);
});

test("normalizeStructuredReview accepts missing-change findings anchored to inspected evidence", () => {
  const review = normalizeStructuredReview({
    verdict: "needs-attention",
    summary: "Caller was not updated.",
    findings: [{
      kind: "missing-change",
      severity: "high",
      title: "Caller still invokes the removed contract",
      evidence: "Search for runLegacyThing found the old caller.",
      impact: "The workflow still calls the removed path.",
      recommendation: "Update the caller to invoke runNewThing.",
      anchor_file: "plugins/supermodels/scripts/lib/runtime.mjs",
      anchor_line: 42,
      expected_symbol: "runNewThing",
      searched_for: "runLegacyThing",
      missing_change_reason: "The changed API removed runLegacyThing but this caller was not updated.",
      confidence: "high",
    }],
    assumptions: [],
    verification_gaps: [],
  });

  assert.equal(review.findings[0].kind, "missing-change");
  assert.equal(review.findings[0].file, "plugins/supermodels/scripts/lib/runtime.mjs");
  assert.equal(review.findings[0].line_start, 42);
  assert.equal(review.findings[0].line_end, 42);
  assert.equal(review.findings[0].expected_symbol, "runNewThing");
});

test("structuredReviewInstructions include a severity rubric", () => {
  const instructions = structuredReviewInstructions();

  assert.match(instructions, /critical: security/i);
  assert.match(instructions, /high: likely user-visible/i);
  assert.match(instructions, /medium: plausible/i);
  assert.match(instructions, /low: maintainability/i);
  assert.match(instructions, /missing-change/i);
});

test("REVIEW_RESULT_SCHEMA sets additionalProperties:false on every object (strict-tool-use ready)", () => {
  const offenders = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      if (node.additionalProperties !== false) offenders.push(path || "<root>");
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`);
    }
    if (node.type === "array" && node.items) walk(node.items, `${path}[]`);
    // anyOf/oneOf/allOf branches
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(node[key])) node[key].forEach((b, i) => walk(b, `${path}.${key}[${i}]`));
    }
  };
  walk(REVIEW_RESULT_SCHEMA, "");
  assert.deepEqual(offenders, [], `objects missing additionalProperties:false: ${offenders.join(", ")}`);
});

test("REVIEW_RESULT_SCHEMA still accepts a well-formed review after the audit", () => {
  const ok = validateStructuredReview({
    verdict: "clean",
    summary: "No issues found after inspecting the diff and files.",
    findings: [],
    assumptions: [],
    verification_gaps: [],
  });
  assert.ok(ok.review, JSON.stringify(ok.errors));
});
