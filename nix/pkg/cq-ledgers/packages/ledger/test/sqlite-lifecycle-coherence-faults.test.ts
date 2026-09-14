import { expect, test } from "bun:test";
import { claimScopeKey, operationScopeKey } from "../src/store/planLifecycleDump.js";
import { lifecycleCoherenceFixture, registerLifecycleProjectionFaults, type LifecycleProjectionOperation } from "./lifecycleCoherenceFixture.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

type PlanOperation = "claim" | "publish-draft" | "release" | "finalize";

async function preparePlanOperation(fixture: Awaited<ReturnType<typeof lifecycleCoherenceFixture>>, operation: PlanOperation): Promise<LifecycleProjectionOperation> {
  const { store } = fixture;
  const claimKey = `plan_claims:${claimScopeKey("G1", LIFECYCLE_CLAIM_INPUT.claimRequestId)}`;
  if (operation === "claim") return { invoke: () => store.claimPlan(LIFECYCLE_CLAIM_INPUT), documents: ["goals:G1"], privateKeys: [claimKey] };
  expect((await store.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
  const identity = { goalId: "G1", claimId: "claim_G1_1", generation: 1,
    ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, ...LIFECYCLE_PROVENANCE };
  const operationKey = `plan_operations:${operationScopeKey("G1", identity.claimId, 1, operation, operation)}`;
  const publish = { ...identity, operationId: "publish-draft", manifest: {
    milestones: [{ key: "delivery", title: "delivery" }], tasks: [{ key: "task", milestoneKey: "delivery", headline: "task" }],
  } };
  if (operation === "publish-draft") return { invoke: () => store.publishPlanDraft(publish), documents: ["goals:G1", "milestones:M1", "tasks:T1"], privateKeys: [operationKey] };
  if (operation === "release") return {
    invoke: () => store.releasePlanClaim({ ...identity, operationId: operation, kind: "pause", effect: {
      kind: "questions", questions: [{ key: "scope", question: "Choose scope" }],
    } }), documents: ["goals:G1", "questions:Q1"], privateKeys: [claimKey, operationKey],
  };
  expect((await store.publishPlanDraft(publish)).ok).toBe(true);
  await store.createItem("reviews", "M-AMBIENT", { id: "R1", status: "go-ahead", fields: {
    planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 1 }),
  } });
  return { invoke: () => store.finalizePlan({ ...identity, operationId: operation, reviewId: "R1", draftRevision: 1, decision: { headline: "approved" } }),
    documents: ["goals:G1", "milestones:M1", "tasks:T1", "decisions:K1"], privateKeys: [claimKey, operationKey] };
}

for (const operation of ["claim", "publish-draft", "release", "finalize"] as const) {
  registerLifecycleProjectionFaults(`plan ${operation}`, (fixture) => preparePlanOperation(fixture, operation));
}

for (const operation of ["release", "finalize"] as const) {
  test(`${operation} rolls back both private records when the final control key cannot persist [T5547]`, async () => {
    const fixture = await lifecycleCoherenceFixture();
    try {
      const invocation = await preparePlanOperation(fixture, operation);
      const snapshot = () => ["items", "groups", "ledgers", "item_references", "plan_claims", "plan_operations", "coherence_state", "coherence_vector"]
        .map((table) => [table, fixture.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
      const before = snapshot();
      fixture.db.query(`CREATE TRIGGER fail_private_coherence BEFORE INSERT ON coherence_vector
        WHEN NEW.scope = 'control' AND NEW.document_id LIKE 'plan_operations:%'
        BEGIN SELECT RAISE(ABORT, 'injected private coherence failure'); END`).run();
      await expect(invocation.invoke()).rejects.toThrow("injected private coherence failure");
      expect(snapshot()).toEqual(before);
      fixture.db.query("DROP TRIGGER fail_private_coherence").run();
      expect(await invocation.invoke()).toMatchObject({ ok: true });
    } finally { await fixture.dispose(); }
  });
}
