import { expect, test } from "bun:test";
import type { PlanFinalizeInput, PlanPublishDraftInput, PlanReleaseInput } from "../src/planLifecycle.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_NOW, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

for (const operation of ["claim", "publish", "release", "finalize"] as const) {
  test(`${operation} rolls back public rows, allocations, private records and coherence on private persistence failure [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const fixture = await sqlitePlanLifecycleFixture();
    const { store, db } = fixture;
    try {
      const identity = {
        goalId: "G1", claimId: "claim_G1_1", generation: 1,
        ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, ...LIFECYCLE_PROVENANCE,
      };
      const publish: PlanPublishDraftInput = {
        ...identity, operationId: "publish", manifest: {
          milestones: [{ key: "delivery", title: "delivery" }],
          tasks: [{ key: "implementation", milestoneKey: "delivery", headline: "implementation" }],
        },
      };
      const release: PlanReleaseInput = {
        ...identity, operationId: "release", kind: "pause",
        effect: { kind: "questions", questions: [{ key: "decision", question: "Choose the requirement" }] },
      };
      const finalize: PlanFinalizeInput = {
        ...identity, operationId: "finalize", reviewId: "R1", draftRevision: 1,
        decision: { headline: "approved" },
      };
      if (operation !== "claim") expect((await store.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
      if (operation === "finalize") {
        expect((await store.publishPlanDraft(publish)).ok).toBe(true);
        db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at)
          VALUES ('reviews', 'R1', 'M-AMBIENT', 'go-ahead', ?, ?, ?)`).run(JSON.stringify({
          headline: "approved", planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 1 }),
        }), LIFECYCLE_NOW, LIFECYCLE_NOW);
      }
      const snapshot = () => ["items", "groups", "ledgers", "item_references", "plan_claims", "plan_operations", "coherence_vector"]
        .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
      const before = snapshot();
      const invoke = () => {
        switch (operation) {
          case "claim": return store.claimPlan(LIFECYCLE_CLAIM_INPUT);
          case "publish": return store.publishPlanDraft(publish);
          case "release": return store.releasePlanClaim(release);
          case "finalize": return store.finalizePlan(finalize);
        }
      };
      const privateTable = operation === "claim" ? "plan_claims" : "plan_operations";
      db.query(`CREATE TRIGGER fail_selected_lifecycle_write BEFORE INSERT ON ${privateTable}
        BEGIN SELECT RAISE(ABORT, 'injected lifecycle persistence failure'); END`).run();
      await expect(invoke()).rejects.toThrow("injected lifecycle persistence failure");
      expect(snapshot()).toEqual(before);
      db.query("DROP TRIGGER fail_selected_lifecycle_write").run();
      await store.dispose();
      await store.init();
      expect(snapshot()).toEqual(before);
      expect(await invoke()).toMatchObject({ ok: true, replayed: false });
      expect(await invoke()).toMatchObject({ ok: true, replayed: true });
    } finally { await fixture.dispose(); }
  });
}
