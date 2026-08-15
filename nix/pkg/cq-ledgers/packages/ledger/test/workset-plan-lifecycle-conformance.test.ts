import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  QUESTIONS_LEDGER,
  WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS,
  createInMemoryWorksetGuardedPlanLifecycleStore,
  createTrustedWorksetManagementAuthority,
  readCanonicalOwnership,
} from "../src/index.js";

describe("T1988 plan-lifecycle conformance [Behavioral-Active Blackbox-Atomic]", () => {
  test("routes every plan operation through one closed guarded inventory", () => {
    expect(WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS).toEqual([
      "claim-plan",
      "publish-plan-draft",
      "release-plan-claim",
      "finalize-plan",
    ]);
  });

  test("releases one selected goal into an exact owned question without sibling leakage", async () => {
    const store = createInMemoryWorksetGuardedPlanLifecycleStore({
      invocationAuthority: createTrustedWorksetManagementAuthority(),
    });
    await store.init();
    try {
      await store.owned.createOwnerless({
        ledgerId: GOALS_LEDGER,
        milestoneId: MILESTONES_AMBIENT_ID,
        id: "G1988",
        status: "clarifying",
        fields: { title: "selected", description: "selected" },
      });
      await store.owned.createOwnerless({
        ledgerId: GOALS_LEDGER,
        milestoneId: MILESTONES_AMBIENT_ID,
        id: "G1989",
        status: "clarifying",
        fields: { title: "sibling", description: "sibling" },
      });
      await store.setRoots(["goals:G1988"]);
      const claim = await store.claimPlan({
        goalId: "G1988",
        purpose: "initial",
        claimRequestId: "t1988-release-claim",
        ownerFenceToken: "t1988-release-owner-01",
        expectedGeneration: null,
        author: "T1988",
      });
      if (!claim.ok) throw new Error("claim failed");
      const release = await store.releasePlanClaim({
        kind: "pause",
        goalId: "G1988",
        claimId: claim.acknowledgement.claimId,
        generation: claim.acknowledgement.generation,
        operationId: "t1988-release",
        ownerFenceToken: claim.acknowledgement.ownerFenceToken,
        effect: {
          kind: "questions",
          questions: [{ key: "scope", question: "Which exact scope?" }],
        },
        author: "T1988",
      });
      if (!release.ok) throw new Error("release failed");
      const question = release.acknowledgement.questions[0];
      if (question === undefined) throw new Error("question allocation missing");
      expect(readCanonicalOwnership(store.fetchItem(QUESTIONS_LEDGER, question.id))).toEqual({
        ownerRef: "goals:G1988",
        edgeKind: "exact-gate-question",
      });
      expect(store.fetchItem(GOALS_LEDGER, "G1989").status).toBe("clarifying");
      expect(store.activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });
});

describe("T1988 durable plan shared-contract registration [Contract-Active Whitebox-Atomic]", () => {
  test("keeps the unchanged shared runner registered for every durable backend", async () => {
    for (const backend of ["fs", "git", "sqlite", "postgres"] as const) {
      const source = await readFile(
        join(import.meta.dir, `workset-plan-lifecycle-${backend}.test.ts`),
        "utf8",
      );
      expect(source, backend).toContain("registerWorksetPlanLifecycleContract");
    }
  });
});
