import { describe, expect, test } from "bun:test";
import { DISPATCH_OVERLAY_REGISTRY, validateDispatchInput, validateAgainstSchema, implementWorkerSidecar, implementWorkerStagedOutputSchema } from "@cq/config";
import { cohortRoleEnvelope, cohortRoleMembers } from "./workCohortRoleFixture.js";

function input() {
  const cohort = cohortRoleEnvelope();
  return { cohort, members: cohortRoleMembers(cohort), branch: `implement/cohort-${cohort.intent.intentDigest}`,
    baseCommit: "1".repeat(40), startingCommit: "1".repeat(40), round: 0, validationIntent: "final" };
}

function accepted(value: unknown): boolean {
  return validateDispatchInput({ roleId: "implement-worker", surface: "codex", input: value,
    registry: DISPATCH_OVERLAY_REGISTRY }).accepted;
}

describe("cohort role contracts [Blackbox-Atomic]", () => {
  test("pre-seal worker carries the entire ordered membership without an anchor task", () => {
    expect(accepted(input())).toBe(true);
  });
  test("omitted, copied, reordered, forged or anchored members reject", () => {
    const original = input();
    for (const value of [
      { ...original, taskId: "T701" },
      { ...original, members: original.members.slice(0, 1) },
      { ...original, members: [original.members[0], original.members[0]] },
      { ...original, members: [...original.members].reverse() },
      { ...original, cohort: { ...original.cohort, envelopeDigest: "0".repeat(64) } },
      { ...original, branch: "implement/T701" },
    ]) expect(accepted(value)).toBe(false);
  });
  test("candidate-producing cohort output is staged, never self-attested as a full gate", () => {
    const prepared = input();
    const output = { cohort: prepared.cohort, memberObservations: prepared.members.map((member) => ({
      memberRef: member.memberRef, observation: "Implemented and ready for parent-owned validation" })),
      status: "pass", resultCommit: "3".repeat(40), branch: prepared.branch, actualWorktreePath: "/repo/cohort",
      filesTouched: ["src/service.ts"], checkSummary: "Candidate ready", summary: "Shared implementation",
      baseVerification: { status: "verified", baseCommit: prepared.baseCommit, headCommit: "3".repeat(40),
        relation: "descendant" }, gitReceipts: [] };
    expect(validateAgainstSchema(implementWorkerStagedOutputSchema, output).ok).toBe(true);
    expect(validateAgainstSchema(implementWorkerSidecar.outputSchema, { ...output, gateDurationMs: 1 }).ok).toBe(false);
  });
});
