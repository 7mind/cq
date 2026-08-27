import { describe, expect, test } from "bun:test";
import {
  D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
  HISTORICAL_IMPLEMENTATION_FIXTURES,
  deriveHistoricalImplementationAuditTaskRefs,
  type HistoricalImplementationSourceObservation,
} from "../src/index.js";

function observationsFor(
  key: keyof typeof HISTORICAL_IMPLEMENTATION_FIXTURES,
): HistoricalImplementationSourceObservation[] {
  const fixture = HISTORICAL_IMPLEMENTATION_FIXTURES[key];
  return [
    ...fixture.expectedTaskRefs.map((taskRef, index) => ({
      taskRef,
      status: "done",
      resultCommit:
        fixture.requiredResultCommits[
          taskRef as keyof typeof fixture.requiredResultCommits
        ] ?? String(index + 1).repeat(40),
      ownLedgerRef: taskRef,
      ownerRefs: [fixture.rule.defectRef],
      ownerEdgeRef: fixture.rule.defectRef,
      finalizedManifestDigest: fixture.rule.finalizedManifestDigest,
    })),
    {
      taskRef: "tasks:T9990",
      status: "done",
      resultCommit: "9".repeat(40),
      ownLedgerRef: "tasks:T9990",
      ownerRefs: [fixture.rule.defectRef, "defects:D999"],
      ownerEdgeRef: fixture.rule.defectRef,
      finalizedManifestDigest: fixture.rule.finalizedManifestDigest,
    },
    {
      taskRef: "tasks:T9991",
      status: "done",
      resultCommit: null,
      ownLedgerRef: "tasks:T9991",
      ownerRefs: [fixture.rule.defectRef],
      ownerEdgeRef: fixture.rule.defectRef,
      finalizedManifestDigest: fixture.rule.finalizedManifestDigest,
    },
  ];
}

describe("trusted historical implementation fixture rules [BA]", () => {
  test("derives the complete D303, D340, and D343 Git cohorts from source observations", () => {
    for (const key of ["D303", "D340", "D343"] as const) {
      const fixture = HISTORICAL_IMPLEMENTATION_FIXTURES[key];
      expect(deriveHistoricalImplementationAuditTaskRefs(observationsFor(key), fixture.rule)).toEqual(
        fixture.expectedTaskRefs,
      );
    }
  });

  test("discovers the D340 guarded-rebase contribution and its exact result commit", () => {
    const fixture = HISTORICAL_IMPLEMENTATION_FIXTURES.D340;
    expect(deriveHistoricalImplementationAuditTaskRefs(observationsFor("D340"), fixture.rule)).toContain(
      "tasks:T2151",
    );
    expect(fixture.requiredResultCommits["tasks:T2151"]).toBe(
      "5dee782ebd6a0b2c743286c0f19752801944bac5",
    );
  });

  test("retains R1419 abstention provenance and leaves T2229 exclusively external", () => {
    expect(HISTORICAL_IMPLEMENTATION_FIXTURES.D303.reviewRefs["tasks:T2109"]).toBe(
      "reviews:R1419",
    );
    expect(HISTORICAL_IMPLEMENTATION_FIXTURES.D303.abstentionReviewRefs).toEqual([
      "reviews:R1419",
    ]);
    expect(HISTORICAL_IMPLEMENTATION_FIXTURES.D343.excludedExternalEffects).toEqual({
      "tasks:T2229": "operatorActions:OA2229",
    });
  });

  test("binds activation to finalized draft keys rather than predecessor task literals", () => {
    expect(D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE).toEqual({
      manifestId: "d347-implementation-evidence-activation-v1",
      goalRef: "goals:G176",
      evidenceTaskKey: "t-evidence",
      auditTaskKey: "t-historical-evidence",
      activationTaskKey: "t-activate-evidence",
    });
    expect(JSON.stringify(D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE)).not.toMatch(/T[0-9]+/u);
  });
});
