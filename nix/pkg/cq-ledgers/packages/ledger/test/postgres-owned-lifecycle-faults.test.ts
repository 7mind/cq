import { describe, expect, test } from "bun:test";
import { createTrustedWorksetManagementAuthority, createWorksetOwnedGuardedLedger } from "../src/index.js";
import { ownedLifecyclePostgresFixtureWithPool } from "./ownedLifecyclePostgresFixture.js";
import { PostgresStatementFaults } from "./postgresStatementFaults.js";

const INJECTED_STATEMENT = "T5920 injected owned statement failure";
const INJECTED_COMMIT = "T5920 injected owned commit failure";
type OwnedCase = "ownerless" | "owned" | "idea" | "defect";

async function ownedFaultFixture(kind: OwnedCase) {
  const faults = new PostgresStatementFaults(INJECTED_STATEMENT);
  const fixture = await ownedLifecyclePostgresFixtureWithPool((pool) => faults.wrap(pool));
  const { pool, projectKey, store } = fixture;
  let failAt: number | null = null;
  try {
    const guarded = createWorksetOwnedGuardedLedger({ rawStore: store, worksetStore: store.worksetStore(),
      invocationAuthority: createTrustedWorksetManagementAuthority(),
      runOwnedTransaction: async (mutate, context) => {
        if (failAt !== null) faults.armAt(failAt);
        try { return await store.runAtomicOwnedMutation(mutate, context); }
        finally { faults.disarm(); }
      },
    });
    let run: () => Promise<unknown>;
    if (kind === "ownerless") run = () => guarded.owned.createOwnerless({ ledgerId: "milestones", status: "open", fields: { title: "new milestone" } });
    else if (kind === "owned") {
      await store.replaceWorksetRoots(["goals:G1"]);
      run = () => guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "exact-gate-question",
        child: { ledgerId: "questions", status: "open", fields: { question: "selected" } } });
    } else if (kind === "idea") {
      const idea = await guarded.owned.createOwnerless({ ledgerId: "ideas", status: "open", fields: { title: "selected idea" } });
      await store.replaceWorksetRoots([`ideas:${idea.id}`]);
      run = () => guarded.bundles.bootstrapIdeaToGoal({ ideaId: idea.id, goal: { title: "delivery", description: "delivery" }, consumeIdea: true });
    } else {
      const defect = await guarded.owned.createOwnerless({ ledgerId: "defects", status: "open", fields: { headline: "selected defect", severity: "high" } });
      await store.replaceWorksetRoots([`defects:${defect.id}`]);
      run = () => guarded.bundles.bootstrapDefectToFixGoal({ defectId: defect.id, goal: { title: "fix", description: "fix" } });
    }
    const snapshot = async () => ({
      items: [...await pool`SELECT ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE project_key = ${projectKey} ORDER BY ledger, id`],
      groups: [...await pool`SELECT ledger, id, title, description FROM groups WHERE project_key = ${projectKey} ORDER BY ledger, id`],
      counters: [...await pool`SELECT name, item_counter, milestone_counter FROM ledgers WHERE project_key = ${projectKey} ORDER BY name`],
      references: [...await pool`SELECT source_ledger, source_id, field_name, target_ledger, target_id FROM item_references
        WHERE project_key = ${projectKey} ORDER BY source_ledger, source_id, field_name, target_ledger, target_id`],
      claims: [...await pool`SELECT scope, record_json FROM plan_claims WHERE project_key = ${projectKey} ORDER BY scope`],
      operations: [...await pool`SELECT scope, record_json FROM plan_operations WHERE project_key = ${projectKey} ORDER BY scope`],
    });
    return { ...fixture, run, snapshot, arm: (nth: number) => { failAt = nth; } };
  } catch (error) { await fixture.dispose(); throw error; }
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL owned faults [T5920 Behavioral-Active Blackbox-GoodCommunication]", () => {
  for (const kind of ["ownerless", "owned", "idea", "defect"] as const) {
    test(`${kind}: every transaction statement failure preserves public/private rows and cache`, async () => {
      const fixture = await ownedFaultFixture(kind);
      try {
        const before = await fixture.snapshot();
        const cached = fixture.store.snapshot();
        const maximumStatements = 240;
        let rolledBack = 0;
        let committed = false;
        for (let nth = 1; nth <= maximumStatements; nth++) {
          fixture.arm(nth);
          try { await fixture.run(); committed = true; }
          catch (error) { expect((error as Error).message).toBe(INJECTED_STATEMENT); rolledBack++; }
          if (committed) break;
          expect(await fixture.snapshot()).toEqual(before);
          expect(fixture.store.snapshot()).toEqual(cached);
        }
        expect(committed).toBe(true);
        expect(rolledBack).toBeGreaterThan(10);
      } finally { await fixture.dispose(); }
    });

    test(`${kind}: a real deferred COMMIT failure rolls back rows and leaves retry usable`, async () => {
      const fixture = await ownedFaultFixture(kind);
      try {
        const before = await fixture.snapshot();
        const cached = fixture.store.snapshot();
        await fixture.pool.unsafe(`CREATE FUNCTION reject_owned_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION '${INJECTED_COMMIT}'; END $$;
          CREATE CONSTRAINT TRIGGER reject_owned_commit AFTER INSERT ON items DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION reject_owned_commit()`);
        await expect(fixture.run()).rejects.toThrow(INJECTED_COMMIT);
        expect(await fixture.snapshot()).toEqual(before);
        expect(fixture.store.snapshot()).toEqual(cached);
        await fixture.pool.unsafe("DROP TRIGGER reject_owned_commit ON items");
        expect(await fixture.run()).toBeDefined();
      } finally { await fixture.dispose(); }
    });
  }
});
