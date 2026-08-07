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
import {
  IMPLEMENT_REVIEWER_PHASE_EXHAUSTION_CRITICISM,
  implementReviewerSidecar,
  validateAgainstSchema,
} from "@cq/config";

const SHA = "c".repeat(40);
const BASE = "d".repeat(40);

function verifiedResultCommitEvidence(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "verified",
    resultCommit: SHA,
    branchTip: SHA,
    ...overrides,
  };
}

function verifiedBaseAncestry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "verified",
    relation: "descendant",
    baseCommit: BASE,
    resultCommit: SHA,
    mergeBase: BASE,
    ...overrides,
  };
}

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
    resultCommitEvidence: verifiedResultCommitEvidence(),
    baseAncestry: verifiedBaseAncestry(),
    gateDurationMs: 4567,
    ...overrides,
  };
}

describe("T895 implement-reviewer outputSchema", () => {
  test("the final input schema requires all three server-bound phase values [BA]", () => {
    const input = {
      taskId: "T1696",
      acceptance: "The reviewer consumes one absolute phase window.",
      worktreePath: "/tmp/wt-T1696",
      branch: "implement/T1696",
      baseCommit: "e".repeat(40),
      workerResult: { resultCommit: null, checkSummary: "failed", filesTouched: [] },
      round: 1,
      responseStoreNow: "2026-08-03T10:02:00.000Z",
      gateCompleteBy: "2026-08-03T10:01:00.000Z",
      synthesisStoreReserveMs: 60_000,
    };
    expect(validateAgainstSchema(implementReviewerSidecar.inputSchema, input).ok).toBe(true);
    for (const field of [
      "responseStoreNow",
      "gateCompleteBy",
      "synthesisStoreReserveMs",
    ] as const) {
      const missing = { ...input };
      delete missing[field];
      const result = validateAgainstSchema(implementReviewerSidecar.inputSchema, missing);
      expect(result.ok, field).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((error) => error.params.missingProperty === field)).toBe(true);
      }
    }
    expect(
      validateAgainstSchema(implementReviewerSidecar.inputSchema, {
        ...input,
        synthesisStoreReserveMs: 59_999,
      }).ok,
    ).toBe(false);
  });

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
      expect(result.errors.some((e) => e.params.missingProperty === "resultCommitVerified")).toBe(
        true,
      );
    }
  });

  // --- a fully valid verdict passes --------------------------------------------

  test("a complete verdict with gateReRan=true, resultCommitVerified=true, and gateDurationMs passes", () => {
    const result = validateAgainstSchema(
      implementReviewerSidecar.outputSchema,
      baseVerdictPayload(),
    );
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
    const payload = baseVerdictPayload({
      verdict: "disapprove",
      criticism: ["gate not re-run; evidence incomplete"],
      gateReRan: false,
      resultCommitVerified: false,
      resultCommitEvidence: {
        status: "unresolvable",
        reason: "worktree-unresolvable",
        resultCommit: null,
        branchTip: null,
      },
      baseAncestry: {
        status: "unresolvable",
        reason: "result-commit-missing",
        baseCommit: null,
        resultCommit: null,
        mergeBase: null,
      },
    });
    delete payload.gateDurationMs;
    expect("gateDurationMs" in payload).toBe(false);
    const result = validateAgainstSchema(implementReviewerSidecar.outputSchema, payload);
    expect(result.ok).toBe(true);
  });

  test("gateReRan=false may still carry an optional gateReRanReason", () => {
    const payload = baseVerdictPayload({
      verdict: "disapprove",
      criticism: ["worktree gone before review"],
      gateReRan: false,
      resultCommitVerified: false,
      gateReRanReason: "The worktree was already discarded by the time review started.",
      resultCommitEvidence: {
        status: "unresolvable",
        reason: "worktree-unresolvable",
        resultCommit: null,
        branchTip: null,
      },
      baseAncestry: {
        status: "unresolvable",
        reason: "result-commit-missing",
        baseCommit: null,
        resultCommit: null,
        mergeBase: null,
      },
    });
    delete payload.gateDurationMs;
    const result = validateAgainstSchema(implementReviewerSidecar.outputSchema, payload);
    expect(result.ok).toBe(true);
  });

  test("a disapproval must carry criticism or questions [BA]", () => {
    const empty = validateAgainstSchema(
      implementReviewerSidecar.outputSchema,
      baseVerdictPayload({ verdict: "disapprove" }),
    );
    expect(empty.ok).toBe(false);
    expect(
      validateAgainstSchema(
        implementReviewerSidecar.outputSchema,
        baseVerdictPayload({ verdict: "disapprove", criticism: ["actionable defect"] }),
      ).ok,
    ).toBe(true);
    expect(
      validateAgainstSchema(
        implementReviewerSidecar.outputSchema,
        baseVerdictPayload({ verdict: "disapprove", questions: ["Which contract applies?"] }),
      ).ok,
    ).toBe(true);
  });

  test("all three phase-exhaustion evidence tuples satisfy the sidecar [BA]", () => {
    const common = {
      verdict: "disapprove",
      criticism: [IMPLEMENT_REVIEWER_PHASE_EXHAUSTION_CRITICISM],
      rationale: IMPLEMENT_REVIEWER_PHASE_EXHAUSTION_CRITICISM,
    };
    const preVerification = baseVerdictPayload({
      ...common,
      gateReRan: false,
      resultCommitVerified: false,
      gateReRanReason: "phase-budget-exhausted-before-result-commit-verification",
    });
    delete preVerification.gateDurationMs;
    const preGate = baseVerdictPayload({
      ...common,
      gateReRan: false,
      resultCommitVerified: true,
      gateReRanReason: "phase-budget-exhausted-before-gate-start",
    });
    delete preGate.gateDurationMs;
    const inGate = baseVerdictPayload({
      ...common,
      gateReRan: true,
      resultCommitVerified: true,
      gateDurationMs: 2_345,
    });
    delete inGate.gateReRanReason;

    for (const payload of [preVerification, preGate, inGate]) {
      expect(validateAgainstSchema(implementReviewerSidecar.outputSchema, payload).ok).toBe(true);
    }
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
