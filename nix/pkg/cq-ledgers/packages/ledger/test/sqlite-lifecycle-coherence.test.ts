import { expect, test } from "bun:test";
import type { PlanReleaseInput } from "../src/planLifecycle.js";
import { coherenceVersion } from "../src/store/sqlite/connection.js";
import { claimScopeKey, operationScopeKey } from "../src/store/planLifecycleDump.js";
import { lifecycleCoherenceFixture, lifecycleCoherenceGuardedStore } from "./lifecycleCoherenceFixture.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

test("sqlite lifecycle projection applies only exact changed documents", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  try {
    const before = coherenceVersion(db);
    expect((await store.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
    const changes = store.readCoherenceChanges(before);
    expect(changes.version).toBe(before + 1);
    expect(changes.entries.map(({ ledger, documentId, scope, kind }) => ({ ledger, documentId, scope, kind }))).toEqual([
      { ledger: "goals", documentId: "G1", scope: "active", kind: "upsert" },
      { ledger: "goals", documentId: `plan_claims:${claimScopeKey("G1", LIFECYCLE_CLAIM_INPUT.claimRequestId)}`, scope: "control", kind: "upsert" },
    ]);
  } finally { await fixture.dispose(); }
});

for (const guarded of [false, true]) for (const terminal of ["release", "finalize"] as const) {
  test(`claim, publish and ${terminal} share exact public/private keys with a lagging peer (guarded=${guarded}) [T5547 GoodCommunication]`, async () => {
    const fixture = await lifecycleCoherenceFixture();
    const { store, capture } = fixture;
    const guardedStore = lifecycleCoherenceGuardedStore(store);
    const plans = guarded ? guardedStore : store;
    const claimKey = `plan_claims:${claimScopeKey("G1", LIFECYCLE_CLAIM_INPUT.claimRequestId)}`;
    const operationKey = (operation: string) => `plan_operations:${operationScopeKey("G1", "claim_G1_1", 1, operation, operation)}`;
    try {
      if (guarded) await store.replaceWorksetRoots(["goals:G1"]);
      const claimed = await capture(() => plans.claimPlan(LIFECYCLE_CLAIM_INPUT), ["goals:G1"], [claimKey]);
      expect(claimed.ok).toBe(true);
      await capture(() => plans.claimPlan(LIFECYCLE_CLAIM_INPUT), [], []);
      const identity = { goalId: "G1", claimId: "claim_G1_1", generation: 1,
        ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, ...LIFECYCLE_PROVENANCE };
      const publish = { ...identity, operationId: "publish-draft", manifest: {
        milestones: [{ key: "delivery", title: "coherentdelivery" }], tasks: [{ key: "task", milestoneKey: "delivery", headline: "coherenttask" }],
      } };
      const published = await capture(() => plans.publishPlanDraft(publish), ["goals:G1", "milestones:M1", "tasks:T1"], [operationKey("publish-draft")]);
      expect(published.ok).toBe(true);
      expect((await fixture.peer.ftsSearch("coherenttask")).map(({ item }) => item.id)).toEqual(["T1"]);
      await capture(() => plans.publishPlanDraft(publish), [], []);
      if (terminal === "release") {
        const input: PlanReleaseInput = { ...identity, operationId: "release", kind: "pause", effect: {
          kind: "questions", questions: [{ key: "scope", question: "coherentquestion" }],
        } };
        expect((await capture(() => plans.releasePlanClaim(input), ["goals:G1", "questions:Q1"], [claimKey, operationKey("release")])).ok).toBe(true);
        await capture(() => plans.releasePlanClaim(input), [], []);
      } else {
        await guardedStore.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review", child: {
          ledgerId: "reviews", id: "R1", status: "go-ahead", fields: {
            planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 1 }),
          },
        } });
        const input = { ...identity, operationId: "finalize", reviewId: "R1", draftRevision: 1, decision: { headline: "coherentdecision" } };
        expect((await capture(() => plans.finalizePlan(input), ["goals:G1", "milestones:M1", "tasks:T1", "decisions:K1"], [claimKey, operationKey("finalize")])).ok).toBe(true);
        await capture(() => plans.finalizePlan(input), [], []);
      }
    } finally { await fixture.dispose(); }
  });
}

test("admitted owned intake and coordination bundles project only created/consumed documents [T5547]", async () => {
  const fixture = await lifecycleCoherenceFixture();
  const { capture, store } = fixture;
  const guarded = lifecycleCoherenceGuardedStore(store);
  try {
    const idea = await capture(() => guarded.owned.createOwnerless({ ledgerId: "ideas", status: "open", fields: { title: "idea" } }), ["ideas:I1"], []);
    const defect = await capture(() => guarded.owned.createOwnerless({ ledgerId: "defects", status: "open", fields: { headline: "defect", severity: "low" } }), ["defects:D1"], []);
    await store.replaceWorksetRoots(["goals:G1", `ideas:${idea.id}`, `defects:${defect.id}`]);
    await capture(() => guarded.bundles.bootstrapIdeaToGoal({ ideaId: idea.id, consumeIdea: true, goal: { title: "idea goal", description: "derived" } }), ["ideas:I1", "goals:G3"], []);
    const fix = { defectId: defect.id, goal: { title: "fix goal", description: "derived" } };
    await capture(() => guarded.bundles.bootstrapDefectToFixGoal(fix), ["goals:G4"], []);
    await capture(() => guarded.bundles.bootstrapDefectToFixGoal(fix), [], []);
    await capture(() => guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "exact-gate-question", child: {
      ledgerId: "questions", status: "open", fields: { question: "Choose scope" },
    } }), ["questions:Q1"], []);
  } finally { await fixture.dispose(); }
});
