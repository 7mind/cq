import { describe, expect, test } from "bun:test";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";
import { PostgresStatementFaults } from "./postgresStatementFaults.js";
import type { PlanClaimInput, PlanPublishDraftInput } from "../src/planLifecycle.js";

type PlanFaultCase = "claim" | "publish" | "release" | "finalize";
const INJECTED_STATEMENT = "T5918 injected plan statement failure";
const INJECTED_COMMIT = "T5918 injected plan commit failure";

async function planFaultFixture(kind: PlanFaultCase) {
  const fixture = await postgresKeyedFixture();
  const projectKey = "plan-fault-fixture";
  const faults = new PostgresStatementFaults(INJECTED_STATEMENT);
  const store = new PostgresLedgerStore({ pool: faults.wrap(fixture.pool), projectKey, displayName: projectKey,
    now: () => "2026-09-14T00:00:00.000Z" });
  const provenance = { author: "T5918", session: "plan-faults" };
  const input: PlanClaimInput = { goalId: "G1", purpose: "initial", claimRequestId: "initial", expectedGeneration: null,
    ownerFenceToken: "A".repeat(43), ...provenance };
  const dispose = async () => { await store.dispose(); await fixture.dispose(); };
  try {
    await store.init();
    await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "fault target", description: "selected" } });
    let run: () => Promise<unknown> = () => store.claimPlan(input);
    if (kind !== "claim") {
      const claimed = await store.claimPlan(input);
      if (!claimed.ok) throw new Error("fault fixture claim conflicted");
      const identity = { goalId: "G1", claimId: claimed.acknowledgement.claimId, generation: 1, ownerFenceToken: input.ownerFenceToken, ...provenance };
      const publish: PlanPublishDraftInput = { ...identity, operationId: "publish", manifest: {
        milestones: [{ key: "delivery", title: "delivery" }], tasks: [{ key: "work", milestoneKey: "delivery", headline: "work" }],
      } };
      if (kind === "publish") run = () => store.publishPlanDraft(publish);
      else if (kind === "release") run = () => store.releasePlanClaim({ ...identity, operationId: "release", kind: "pause",
        effect: { kind: "questions", questions: [{ key: "requirements", question: "which behavior?" }] } });
      else {
        const published = await store.publishPlanDraft(publish);
        if (!published.ok) throw new Error("fault fixture publication conflicted");
        await store.createItem("reviews", "M-AMBIENT", { id: "R1", status: "go-ahead", fields: {
          planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 1 }),
        } });
        run = () => store.finalizePlan({ ...identity, operationId: "finalize", reviewId: "R1", draftRevision: 1, decision: { headline: "approved" } });
      }
    }
    const snapshot = async () => ({
      items: [...await fixture.pool`SELECT ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE project_key = ${projectKey} ORDER BY ledger, id`],
      groups: [...await fixture.pool`SELECT ledger, id, title, description FROM groups WHERE project_key = ${projectKey} ORDER BY ledger, id`],
      counters: [...await fixture.pool`SELECT name, item_counter, milestone_counter FROM ledgers WHERE project_key = ${projectKey} ORDER BY name`],
      claims: [...await fixture.pool`SELECT scope, record_json FROM plan_claims WHERE project_key = ${projectKey} ORDER BY scope`],
      operations: [...await fixture.pool`SELECT scope, record_json FROM plan_operations WHERE project_key = ${projectKey} ORDER BY scope`],
      references: [...await fixture.pool`SELECT source_ledger, source_id, field_name, target_ledger, target_id FROM item_references
        WHERE project_key = ${projectKey} ORDER BY source_ledger, source_id, field_name, target_ledger, target_id`],
    });
    return { ...fixture, store, projectKey, faults, run, snapshot, dispose };
  } catch (error) { await dispose(); throw error; }
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL native plan faults [T5918 Behavioral-Active Blackbox-GoodCommunication]", () => {
  for (const kind of ["claim", "publish", "release", "finalize"] as const) {
    test(`${kind}: every statement boundary preserves the complete public/private state on rollback`, async () => {
      const fixture = await planFaultFixture(kind);
      try {
        const before = await fixture.snapshot();
        const cached = fixture.store.snapshot();
        const maxStatements = 160;
        let rolledBack = 0;
        let committed = false;
        for (let nth = 1; nth <= maxStatements; nth++) {
          fixture.faults.armAt(nth);
          try { expect(await fixture.run()).toMatchObject({ ok: true }); committed = true; }
          catch (error) { expect((error as Error).message).toBe(INJECTED_STATEMENT); rolledBack++; }
          finally { fixture.faults.disarm(); }
          if (committed) break;
          expect(await fixture.snapshot()).toEqual(before);
          expect(fixture.store.snapshot()).toEqual(cached);
        }
        expect(committed).toBe(true);
        expect(rolledBack).toBeGreaterThan(5);
        const after = await fixture.snapshot();
        expect(await fixture.run()).toMatchObject({ ok: true, replayed: true });
        expect(await fixture.snapshot()).toEqual(after);
      } finally { await fixture.dispose(); }
    });

    test(`${kind}: an actual COMMIT failure rolls back its rows and allows an exact retry`, async () => {
      const fixture = await planFaultFixture(kind);
      try {
        const before = await fixture.snapshot();
        const cached = fixture.store.snapshot();
        await fixture.pool.unsafe(`CREATE FUNCTION reject_plan_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION '${INJECTED_COMMIT}'; END $$;
          CREATE CONSTRAINT TRIGGER reject_plan_commit AFTER UPDATE ON items DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (NEW.ledger = 'goals') EXECUTE FUNCTION reject_plan_commit()`);
        await expect(fixture.run()).rejects.toThrow(INJECTED_COMMIT);
        expect(await fixture.snapshot()).toEqual(before);
        expect(fixture.store.snapshot()).toEqual(cached);
        await fixture.pool.unsafe("DROP TRIGGER reject_plan_commit ON items");
        expect(await fixture.run()).toMatchObject({ ok: true, replayed: false });
      } finally { await fixture.dispose(); }
    });
  }
});
