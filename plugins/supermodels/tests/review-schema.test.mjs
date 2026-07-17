import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeStructuredReview,
  structuredReviewInstructions,
  REVIEW_RESULT_SCHEMA,
  validateStructuredReview,
  validateStructuredReviewWire,
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

test("structuredReviewInstructions describe the two arrays and severity rubric", () => {
  const instructions = structuredReviewInstructions();

  assert.match(instructions, /critical: security/i);
  assert.match(instructions, /high: likely user-visible/i);
  assert.match(instructions, /medium: plausible/i);
  assert.match(instructions, /low: maintainability/i);
  assert.match(instructions, /missing_change_findings/);
});

test("REVIEW_RESULT_SCHEMA is strict-native: additionalProperties:false, no anyOf, complete required", () => {
  const offenders = [];
  const conditionals = [];
  const incompleteRequired = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (node[key] !== undefined) conditionals.push(`${path || "<root>"}.${key}`);
    }
    if (node.type === "object") {
      if (node.additionalProperties !== false) offenders.push(path || "<root>");
      const required = new Set(node.required ?? []);
      for (const name of Object.keys(node.properties ?? {})) {
        if (!required.has(name)) incompleteRequired.push(`${path || "<root>"}.${name}`);
      }
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`);
    }
    if (node.type === "array" && node.items) walk(node.items, `${path}[]`);
  };
  walk(REVIEW_RESULT_SCHEMA, "");
  assert.deepEqual(offenders, [], `objects missing additionalProperties:false: ${offenders.join(", ")}`);
  assert.deepEqual(conditionals, [], `strict tool use forbids anyOf/oneOf/allOf: ${conditionals.join(", ")}`);
  assert.deepEqual(incompleteRequired, [], `every property must be listed in required under strict: ${incompleteRequired.join(", ")}`);
});

test("REVIEW_RESULT_SCHEMA still accepts a well-formed two-array review after the audit", () => {
  const ok = validateStructuredReview({
    verdict: "clean",
    summary: "No issues found after inspecting the diff and files.",
    findings: [],
    missing_change_findings: [],
    assumptions: [],
    verification_gaps: [],
  });
  assert.ok(ok.review, JSON.stringify(ok.errors));
});

test("validateStructuredReviewWire enforces the strict provider wire without weakening internal normalization", () => {
  const missing = validateStructuredReviewWire({
    verdict: "clean",
    summary: "Missing the second findings array.",
    findings: [],
    assumptions: [],
    verification_gaps: [],
  });
  assert.equal(missing.review, null);
  assert.match(missing.errors.join("\n"), /missing_change_findings is required/);

  const extra = validateStructuredReviewWire({
    ...newWireReview({ verdict: "clean" }),
    unexpected: true,
  });
  assert.equal(extra.review, null);
  assert.match(extra.errors.join("\n"), /unexpected is not allowed/);

  const invalidEnum = validateStructuredReviewWire(newWireReview({
    findings: [{ ...codeFinding("bad enums"), severity: "severe", confidence: "certain" }],
  }));
  assert.equal(invalidEnum.review, null);
  assert.match(invalidEnum.errors.join("\n"), /severity must be critical, high, medium, or low/);
  assert.match(invalidEnum.errors.join("\n"), /confidence must be high, medium, or low/);

  // Internal normalization stays backward-compatible and idempotent.
  assert.ok(normalizeStructuredReview({
    verdict: "clean",
    summary: "Legacy internal shape.",
    findings: [],
    assumptions: [],
    verification_gaps: [],
  }));
});

test("validateStructuredReviewWire rejects extra finding fields", () => {
  const { review, errors } = validateStructuredReviewWire(newWireReview({
    findings: [{ ...codeFinding("extra"), kind: "code" }],
  }));
  assert.equal(review, null);
  assert.match(errors.join("\n"), /findings\[0\]\.kind is not allowed/);
});

test("validateStructuredReviewWire rejects coerced schema primitives", () => {
  const numericString = validateStructuredReviewWire(newWireReview({
    findings: [{ ...codeFinding("string line"), line_start: "10" }],
  }));
  assert.equal(numericString.review, null);
  assert.match(numericString.errors.join("\n"), /line_start must be an integer/);

  const booleanLine = validateStructuredReviewWire(newWireReview({
    findings: [{ ...codeFinding("boolean line"), line_start: true }],
  }));
  assert.equal(booleanLine.review, null);
  assert.match(booleanLine.errors.join("\n"), /line_start must be an integer/);

  const paddedVerdict = validateStructuredReviewWire(newWireReview({ verdict: " clean " }));
  assert.equal(paddedVerdict.review, null);
  assert.match(paddedVerdict.errors.join("\n"), /exact schema enum string/);
});

test("validateStructuredReview accepts a clean new-wire review with both arrays empty", () => {
  const { review, errors } = validateStructuredReview({
    verdict: "clean",
    summary: "No issues.",
    findings: [],
    missing_change_findings: [],
    assumptions: [],
    verification_gaps: [],
  });
  assert.deepEqual(errors, []);
  assert.ok(review);
  assert.deepEqual(review.findings, []);
  assert.equal("missing_change_findings" in review, false);
});

test("validateStructuredReview merges a code-only new-wire review", () => {
  const review = normalizeStructuredReview(newWireReview({
    findings: [codeFinding("only code")],
  }));

  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0].kind, "code");
  assert.equal(review.findings[0].file, "plugins/supermodels/scripts/lib/runtime.mjs");
  assert.equal("missing_change_findings" in review, false);
});

test("validateStructuredReview merges a missing-only new-wire review", () => {
  const review = normalizeStructuredReview(newWireReview({
    missing_change_findings: [missingFinding("only missing")],
  }));

  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0].kind, "missing-change");
  assert.equal(review.findings[0].file, "plugins/supermodels/scripts/lib/runtime.mjs");
  assert.equal(review.findings[0].line_start, 42);
  assert.equal(review.findings[0].line_end, 42);
  assert.equal(review.findings[0].expected_symbol, "runNewThing");
});

test("validateStructuredReview merges code findings before missing-change findings", () => {
  const review = normalizeStructuredReview(newWireReview({
    findings: [codeFinding("first code"), codeFinding("second code")],
    missing_change_findings: [missingFinding("first missing")],
  }));

  assert.equal(review.findings.length, 3);
  assert.deepEqual(review.findings.map((f) => f.kind), ["code", "code", "missing-change"]);
  assert.deepEqual(review.findings.map((f) => f.title), ["first code", "second code", "first missing"]);
  assert.equal("missing_change_findings" in review, false);
});

test("validateStructuredReview normalizes a legacy mixed findings array (kind inferred, no split key)", () => {
  const review = normalizeStructuredReview({
    verdict: "needs-attention",
    summary: "Legacy mixed array.",
    findings: [
      codeFinding("legacy code"),
      { ...missingFinding("legacy missing"), kind: "missing-change" },
    ],
    assumptions: [],
    verification_gaps: [],
  });

  assert.equal(review.findings.length, 2);
  assert.deepEqual(review.findings.map((f) => f.kind), ["code", "missing-change"]);
  assert.equal(review.findings[1].expected_symbol, "runNewThing");
  assert.equal("missing_change_findings" in review, false);
});

test("validateStructuredReview normalization is idempotent for the internal shape", () => {
  const first = normalizeStructuredReview(newWireReview({
    verdict: "needs-attention",
    summary: "Idempotency across the runtime re-normalization.",
    findings: [codeFinding("code one")],
    missing_change_findings: [missingFinding("missing one")],
    assumptions: ["assumed a thing"],
    verification_gaps: ["a gap"],
  }));
  const second = normalizeStructuredReview(first);

  assert.ok(first);
  assert.equal(first.findings.length, 2);
  assert.deepEqual(second, first);
});

test("validateStructuredReview rejects a null missing_change_findings with the array error", () => {
  const { review, errors } = validateStructuredReview({
    verdict: "clean",
    summary: "Bad missing array.",
    findings: [],
    missing_change_findings: null,
    assumptions: [],
    verification_gaps: [],
  });

  assert.equal(review, null);
  assert.deepEqual(errors, ["missing_change_findings must be an array"]);
});

test("validateStructuredReview rejects a string missing_change_findings (no legacy coercion in split mode)", () => {
  const { review, errors } = validateStructuredReview({
    verdict: "clean",
    summary: "Bad missing array.",
    findings: [],
    missing_change_findings: "none",
    assumptions: [],
    verification_gaps: [],
  });

  assert.equal(review, null);
  assert.deepEqual(errors, ["missing_change_findings must be an array"]);
});

test("validateStructuredReview rejects a non-array findings in split mode (no legacy coercion)", () => {
  const { review, errors } = validateStructuredReview({
    verdict: "clean",
    summary: "Bad findings array.",
    findings: "none",
    missing_change_findings: [],
    assumptions: [],
    verification_gaps: [],
  });

  assert.equal(review, null);
  assert.deepEqual(errors, ["findings must be an array"]);
});

test("validateStructuredReview rejects needs-attention with both arrays empty", () => {
  const { review, errors } = validateStructuredReview(newWireReview({
    verdict: "needs-attention",
    summary: "No findings at all.",
    findings: [],
    missing_change_findings: [],
  }));

  assert.equal(review, null);
  assert.deepEqual(errors, ["needs-attention reviews must include at least one valid finding"]);
});

test("validateStructuredReview rejects contradictory clean reviews with findings", () => {
  const { review, errors } = validateStructuredReviewWire(newWireReview({
    verdict: "clean",
    findings: [codeFinding("contradictory finding")],
  }));

  assert.equal(review, null);
  assert.match(errors.join("\n"), /clean reviews must not include findings/);
});

test("validateStructuredReview keeps the findings[i] path for a bad code finding", () => {
  const { review, errors } = validateStructuredReview(newWireReview({
    verdict: "needs-attention",
    summary: "Bad code finding path.",
    findings: [codeFinding("ok"), { ...codeFinding("bad"), line_start: 20, line_end: 10 }],
    missing_change_findings: [],
  }));

  assert.equal(review, null);
  assert.ok(
    errors.some((e) => /findings\[1\]\.line_end must be greater than or equal to line_start/.test(e)),
    JSON.stringify(errors),
  );
});

test("validateStructuredReview keeps the missing_change_findings[i] path for a bad missing finding", () => {
  const { review, errors } = validateStructuredReview(newWireReview({
    verdict: "needs-attention",
    summary: "Bad missing finding path.",
    findings: [],
    missing_change_findings: [{ ...missingFinding("bad"), expected_symbol: "" }],
  }));

  assert.equal(review, null);
  assert.ok(
    errors.some((e) => /missing_change_findings\[0\]\.expected_symbol must be non-empty/.test(e)),
    JSON.stringify(errors),
  );
});

test("validateStructuredReview forces code kind on findings items even if they claim missing-change", () => {
  const review = normalizeStructuredReview(newWireReview({
    verdict: "needs-attention",
    summary: "Forced kind by array.",
    findings: [{ ...codeFinding("mislabeled"), kind: "missing-change" }],
    missing_change_findings: [],
  }));

  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0].kind, "code");
  assert.equal(review.findings[0].file, "plugins/supermodels/scripts/lib/runtime.mjs");
  assert.equal("expected_symbol" in review.findings[0], false);
});

function newWireReview(overrides = {}) {
  return {
    verdict: "needs-attention",
    summary: "Structured review.",
    findings: [],
    missing_change_findings: [],
    assumptions: [],
    verification_gaps: [],
    ...overrides,
  };
}

function codeFinding(title = "Code finding") {
  return {
    severity: "medium",
    title,
    evidence: "Evidence for the code finding.",
    impact: "Impact of the code finding.",
    recommendation: "Fix the code finding.",
    file: "plugins/supermodels/scripts/lib/runtime.mjs",
    line_start: 10,
    line_end: 12,
    confidence: "medium",
  };
}

function missingFinding(title = "Missing change finding") {
  return {
    severity: "high",
    title,
    evidence: "Search found the stale caller.",
    impact: "The caller still invokes the removed contract.",
    recommendation: "Update the caller to invoke runNewThing.",
    anchor_file: "plugins/supermodels/scripts/lib/runtime.mjs",
    anchor_line: 42,
    expected_symbol: "runNewThing",
    searched_for: "runLegacyThing",
    missing_change_reason: "The changed API removed runLegacyThing but this caller was not updated.",
    confidence: "high",
  };
}
