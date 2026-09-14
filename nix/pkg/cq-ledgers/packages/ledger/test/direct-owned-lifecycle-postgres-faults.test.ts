import { describe, expect, test } from "bun:test";
import { materializeOperatorAction, recordProtectedImplementationCompletion, supersedeOperatorAction } from "../src/index.js";
import { ownedLifecyclePostgresFixtureWithPool } from "./ownedLifecyclePostgresFixture.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";
import { PostgresStatementFaults } from "./postgresStatementFaults.js";
import { snapshotPostgresLifecycleRows } from "./postgresLifecycleSnapshot.js";

const INJECTED_STATEMENT = "T5921 injected direct statement failure";
const INJECTED_COMMIT = "T5921 injected direct commit failure";
type DirectCase = "materialize" | "supersede-materialized" | "supersede-absent" | "completion";

async function directFaultFixture(kind: DirectCase) {
  const faults = new PostgresStatementFaults(INJECTED_STATEMENT);
  const fixture = await ownedLifecyclePostgresFixtureWithPool((pool) => faults.wrap(pool));
  const { pool, projectKey, store } = fixture;
  try {
    await seedDirectOwnedTasks(store);
    const completion = await directCompletionRecord();
    if (kind === "supersede-materialized") await materializeOperatorAction(store, DIRECT_OPERATOR_INPUT);
    const run = () => kind === "materialize" ? materializeOperatorAction(store, DIRECT_OPERATOR_INPUT)
      : kind === "completion" ? recordProtectedImplementationCompletion(store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE)
        : supersedeOperatorAction(store, DIRECT_SUPERSEDE_INPUT);
    const snapshot = () => snapshotPostgresLifecycleRows(pool, projectKey);
    return { ...fixture, faults, run, snapshot };
  } catch (error) { await fixture.dispose(); throw error; }
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL direct lifecycle faults [T5921 Behavioral-Active Blackbox-GoodCommunication]", () => {
  for (const kind of ["materialize", "supersede-materialized", "supersede-absent", "completion"] as const) {
    test(`${kind}: every transaction statement failure preserves the complete public/private state and cache`, async () => {
      const fixture = await directFaultFixture(kind);
      try {
        const before = await fixture.snapshot();
        const cached = fixture.store.snapshot();
        const maximumStatements = 240;
        let rolledBack = 0;
        let committed = false;
        for (let nth = 1; nth <= maximumStatements; nth++) {
          fixture.faults.armAt(nth);
          try { await fixture.run(); committed = true; }
          catch (error) { expect((error as Error).message).toBe(INJECTED_STATEMENT); rolledBack++; }
          finally { fixture.faults.disarm(); }
          if (committed) break;
          expect(await fixture.snapshot()).toEqual(before);
          expect(fixture.store.snapshot()).toEqual(cached);
        }
        expect(committed).toBe(true);
        expect(rolledBack).toBeGreaterThan(5);
        const after = await fixture.snapshot();
        await fixture.run();
        expect(await fixture.snapshot()).toEqual(after);
      } finally { await fixture.dispose(); }
    });
    test(`${kind}: a real COMMIT failure rolls back its entire set and preserves exact retry`, async () => {
      const fixture = await directFaultFixture(kind);
      try {
        const before = await fixture.snapshot();
        const cached = fixture.store.snapshot();
        await fixture.pool.unsafe(`CREATE FUNCTION reject_direct_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION '${INJECTED_COMMIT}'; END $$;
          CREATE CONSTRAINT TRIGGER reject_direct_commit AFTER INSERT OR UPDATE ON items DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION reject_direct_commit()`);
        await expect(fixture.run()).rejects.toThrow(INJECTED_COMMIT);
        expect(await fixture.snapshot()).toEqual(before);
        expect(fixture.store.snapshot()).toEqual(cached);
        await fixture.pool.unsafe("DROP TRIGGER reject_direct_commit ON items");
        await fixture.run();
        const after = await fixture.snapshot();
        await fixture.run();
        expect(await fixture.snapshot()).toEqual(after);
      } finally { await fixture.dispose(); }
    });
  }
});
