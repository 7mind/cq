import { describe, expect, it } from "bun:test";
import {
  PlanClaimResultSchema,
  PlanFinalizeResultSchema,
  PlanPublishDraftResultSchema,
  PlanReleaseResultSchema,
  WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS,
  createInMemoryWorksetGuardedPlanLifecycleStore,
} from "../src/index.js";

describe("T1967 workset plan lifecycle contract [BA]", () => {
  it("closes the four-operation inventory and shared workset conflict schema", () => {
    expect(WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS).toEqual([
      "claim-plan",
      "publish-plan-draft",
      "release-plan-claim",
      "finalize-plan",
    ]);
    for (const [operation, schema] of [
      ["claim-plan", PlanClaimResultSchema],
      ["publish-plan-draft", PlanPublishDraftResultSchema],
      ["release-plan-claim", PlanReleaseResultSchema],
      ["finalize-plan", PlanFinalizeResultSchema],
    ] as const) {
      expect(
        schema.safeParse({
          ok: false,
          conflict: {
            code: "workset-conflict",
            operation,
            reason: "target-excluded",
            goalId: "G1",
            refs: ["goals:G1"],
            epoch: 2,
          },
        }).success,
      ).toBe(true);
    }
    expect(
      PlanClaimResultSchema.safeParse({
        ok: false,
        conflict: {
          code: "workset-conflict",
          operation: "finalize-plan",
          reason: "target-excluded",
          goalId: "G1",
          refs: ["goals:G1"],
          epoch: 2,
        },
      }).success,
    ).toBe(false);
    expect(
      PlanClaimResultSchema.safeParse({
        ok: false,
        conflict: {
          code: "workset-conflict",
          operation: "claim-plan",
          reason: "target-excluded",
          goalId: "G1",
          refs: ["G1"],
          epoch: 2,
        },
      }).success,
    ).toBe(false);
  });

  it("exposes only guarded mutation and lifecycle capabilities", () => {
    const store = createInMemoryWorksetGuardedPlanLifecycleStore();
    expect(typeof store.claimPlan).toBe("function");
    expect(typeof store.publishPlanDraft).toBe("function");
    expect(typeof store.releasePlanClaim).toBe("function");
    expect(typeof store.finalizePlan).toBe("function");
    for (const raw of [
      "createItem",
      "createMilestone",
      "updateItem",
      "reopenItem",
      "archiveMilestone",
    ]) {
      expect(typeof (store as unknown as Record<string, unknown>)[raw]).toBe("undefined");
    }
  });
});
