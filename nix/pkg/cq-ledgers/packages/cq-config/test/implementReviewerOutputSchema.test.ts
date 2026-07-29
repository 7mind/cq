/**
 * T895 — evidence-carrying implement-reviewer outputSchema.
 *
 * Mirrors T894's implement-worker test shape on the reviewer side: verifies
 * the acceptance clauses directly against the compiled Ajv schema (not a
 * hand-rolled re-implementation of the rule) — `gateReRan` and
 * `resultCommitVerified` are always required, `gateDurationMs` is required
 * IFF `gateReRan` is `true` (a REAL conditional, not an unconditionally
 * required field), and `additionalProperties: false` is preserved. The
 * negative-direction case is the discriminating one: `gateReRan: false` with
 * NO `gateDurationMs` must be ACCEPTED, so an always-required
 * misimplementation of `gateDurationMs` would fail this suite even though it
 * would pass every other clause.
 */
import { describe, expect, test } from "bun:test";
import { implementReviewerSidecar, validateAgainstSchema } from "@cq/config";

/** A minimal valid verdict payload with gateReRan=true (so gateDurationMs is required). */
function baseVerdictPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "T895",
    verdict: "approve",
    criticism: [],
    questions: [],
    defects: [],
    rationale: "The conditional gateDurationMs requirement matches T894's precedent.",
    gateReRan: true,
    resultCommitVerified: true,
    gateDurationMs: 4567,
    ...overrides,
  };
}

describe("T895 implement-reviewer outputSchema", () => {
  // --- gateReRan / resultCommitVerified always required -----------------------

  test("missing gateReRan fails Ajv", () => {
    const payload = baseVerdictPayload();
    delete payload.gateReRan;
    const result = validateAgainstSchema(implementReviewerSidecar.outputSchema, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.params.missingProperty === "gateReRan")).toBe(true);
    }
  });

  test("missing resultCommitVerified fails Ajv", () => {
    const payload = baseVerdictPayload();
    delete payload.resultCommitVerified;
    const result = validateAgainstSchema(implementReviewerSidecar.outputSchema, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.params.missingProperty === "resultCommitVerified")).toBe(true);
    }
  });

  // --- a fully valid verdict passes --------------------------------------------

  test("a complete verdict with gateReRan=true, resultCommitVerified=true, and gateDurationMs passes", () => {
    const result = validateAgainstSchema(implementReviewerSidecar.outputSchema, baseVerdictPayload());
    expect(result.ok).toBe(true);
  });

  // --- gateDurationMs required iff gateReRan=true ------------------------------

  test("gateReRan=true without gateDurationMs and no gateReRanReason fails Ajv", () => {
    const payload = baseVerdictPayload();
    delete payload.gateDurationMs;
    expect("gateReRanReason" in payload).toBe(false);
    const result = validateAgainstSchema(implementReviewerSidecar.outputSchema, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.params.missingProperty === "gateDurationMs")).toBe(true);
    }
  });

  // --- NEGATIVE DIRECTION: gateReRan=false, no gateDurationMs => ACCEPTED ------

  test("gateReRan=false with NO gateDurationMs is ACCEPTED", () => {
    const payload = baseVerdictPayload({ gateReRan: false, resultCommitVerified: false });
    delete payload.gateDurationMs;
    expect("gateDurationMs" in payload).toBe(false);
    const result = validateAgainstSchema(implementReviewerSidecar.outputSchema, payload);
    expect(result.ok).toBe(true);
  });

  test("gateReRan=false may still carry an optional gateReRanReason", () => {
    const payload = baseVerdictPayload({
      gateReRan: false,
      resultCommitVerified: false,
      gateReRanReason: "The worktree was already discarded by the time review started.",
    });
    delete payload.gateDurationMs;
    const result = validateAgainstSchema(implementReviewerSidecar.outputSchema, payload);
    expect(result.ok).toBe(true);
  });

  // --- additionalProperties still false ----------------------------------------

  test("an unknown top-level key is rejected", () => {
    const result = validateAgainstSchema(
      implementReviewerSidecar.outputSchema,
      baseVerdictPayload({ notARealField: "should be rejected" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.keyword === "additionalProperties")).toBe(true);
    }
  });
});
