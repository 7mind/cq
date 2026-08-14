import {
  GOALS_LEDGER,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  type PlanClaimInput,
  type PlanFinalizeInput,
  type PlanPublishDraftInput,
  type PlanReleaseInput,
  type WorksetPlanLifecycleMutationKind,
} from "../src/index.js";

export const EXCLUDED_CLAIM: PlanClaimInput = {
  goalId: "G1",
  purpose: "initial",
  expectedGeneration: null,
  claimRequestId: "t1981-excluded-claim",
  ownerFenceToken: "t1981_owner_fence_token_0001",
  author: "t1981",
  session: "t1981-transport",
};

const EXCLUDED_OPERATION = {
  goalId: "G1",
  claimId: "claim-G1-1",
  generation: 1,
  ownerFenceToken: EXCLUDED_CLAIM.ownerFenceToken,
  author: EXCLUDED_CLAIM.author,
  session: EXCLUDED_CLAIM.session,
} as const;

export const EXCLUDED_PUBLISH: PlanPublishDraftInput = {
  ...EXCLUDED_OPERATION,
  operationId: "t1981-excluded-publish",
  manifest: {
    milestones: [{ key: "delivery", title: "Excluded delivery" }],
    tasks: [{ key: "task", milestoneKey: "delivery", headline: "Excluded task" }],
  },
};

export const EXCLUDED_RELEASE: PlanReleaseInput = {
  kind: "abandon",
  goalId: EXCLUDED_OPERATION.goalId,
  claimId: EXCLUDED_OPERATION.claimId,
  generation: EXCLUDED_OPERATION.generation,
  operationId: "t1981-excluded-release",
  reason: "excluded recovery",
  author: EXCLUDED_OPERATION.author,
  session: EXCLUDED_OPERATION.session,
};

export const EXCLUDED_FINALIZE: PlanFinalizeInput = {
  ...EXCLUDED_OPERATION,
  operationId: "t1981-excluded-finalize",
  reviewId: "R1",
  draftRevision: 1,
  decision: { headline: "Excluded decision" },
};

export const EXCLUDED_PLAN_CASES = [
  { tool: "claim_plan", operation: "claim-plan", input: EXCLUDED_CLAIM },
  {
    tool: "publish_plan_draft",
    operation: "publish-plan-draft",
    input: EXCLUDED_PUBLISH,
  },
  {
    tool: "release_plan_claim",
    operation: "release-plan-claim",
    input: EXCLUDED_RELEASE,
  },
  { tool: "finalize_plan", operation: "finalize-plan", input: EXCLUDED_FINALIZE },
] as const;

export function excludedPlanResult<T extends WorksetPlanLifecycleMutationKind>(operation: T) {
  return {
    ok: false as const,
    conflict: {
      code: "workset-conflict" as const,
      operation,
      reason: "target-excluded" as const,
      goalId: "G1",
      refs: ["goals:G1"],
      epoch: 1,
    },
  };
}

export async function seedExcludedPlanStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  for (const goalId of ["G1", "G2"] as const) {
    await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: goalId,
      status: "clarifying",
      fields: { title: goalId, description: `${goalId} description` },
      author: "t1981",
      session: "t1981-transport",
    });
  }
  await store.worksetStore().setRoots(["goals:G2"]);
  return store;
}

export function textPayload(result: unknown): string {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("plan lifecycle transport returned no text payload");
  }
  return first.text;
}
