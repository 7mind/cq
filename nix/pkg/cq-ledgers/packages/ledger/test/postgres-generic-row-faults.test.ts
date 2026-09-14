import { describe, expect, test } from "bun:test";
import { createWorksetGenericMutationGateway } from "../src/index.js";
import { ownedLifecyclePostgresFixtureWithPool } from "./ownedLifecyclePostgresFixture.js";
import { PostgresStatementFaults } from "./postgresStatementFaults.js";
import { snapshotPostgresLifecycleRows } from "./postgresLifecycleSnapshot.js";

const INJECTED_STATEMENT = "T5923 injected generic statement failure";
const INJECTED_COMMIT = "T5923 injected generic commit failure";
type GenericCase = "create" | "update" | "unarchive" | "terminal-archive" | "milestone-archive" | "finalize-batch";

async function genericFaultFixture(kind: GenericCase) {
  const faults = new PostgresStatementFaults(INJECTED_STATEMENT);
  const fixture = await ownedLifecyclePostgresFixtureWithPool((pool) => faults.wrap(pool));
  const { store } = fixture;
  let failAt: number | null = null;
  try {
    const gateway = createWorksetGenericMutationGateway({ rawStore: store, worksetStore: store.worksetStore(),
      runGenericTransaction: async (mutate, measurement, scope, context) => {
        if (failAt !== null) faults.armAt(failAt);
        try { return await store.runAtomicGenericMutation(mutate, undefined, measurement, scope, context); }
        finally { faults.disarm(); }
      },
    });
    const milestone = await gateway.createMilestone({ title: "generic fault milestone" });
    const task = await gateway.createItem("tasks", milestone.id, { status: "done", fields: { headline: "generic fault task" } });
    let run: () => Promise<unknown>;
    switch (kind) {
      case "create": run = () => gateway.createItem("tasks", milestone.id, { status: "planned", fields: { headline: "created atomically" } }); break;
      case "update": run = () => gateway.updateItem("tasks", task.id, { fields: { headline: "updated atomically" } }); break;
      case "unarchive":
        await gateway.archiveTerminalItems(["tasks"], "prepare archive", "fail-on-active-gate");
        run = () => gateway.unarchiveItem("tasks", milestone.id, task.id); break;
      case "terminal-archive": run = () => gateway.archiveTerminalItems(["tasks"], "archive atomically", "fail-on-active-gate"); break;
      case "milestone-archive":
        await gateway.updateMilestone(milestone.id, { status: "done" });
        run = () => gateway.archiveMilestone(milestone.id, "archive atomically"); break;
      case "finalize-batch": run = () => gateway.executeFinalize([
        { id: "close", action: "close-milestone", targetId: milestone.id, targetStatus: "done" },
        { id: "archive", action: "archive-milestone", targetId: milestone.id, summary: "archive atomically" },
      ]); break;
    }
    return { ...fixture, run, arm: (nth: number) => { failAt = nth; }, snapshot: () => snapshotPostgresLifecycleRows(fixture.pool, fixture.projectKey) };
  } catch (error) { await fixture.dispose(); throw error; }
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL generic row faults [T5923 Behavioral-Active Blackbox-GoodCommunication]", () => {
  for (const kind of ["create", "update", "unarchive", "terminal-archive", "milestone-archive", "finalize-batch"] as const) {
    test(`${kind}: each statement failure preserves active/archive/private/coherence rows and cache`, async () => {
      const fixture = await genericFaultFixture(kind);
      try {
        const before = await fixture.snapshot();
        const cached = fixture.store.snapshot();
        const maximumStatements = 500;
        let failures = 0;
        let committed = false;
        for (let nth = 1; nth <= maximumStatements; nth++) {
          fixture.arm(nth);
          try { await fixture.run(); committed = true; }
          catch (error) { expect((error as Error).message).toBe(INJECTED_STATEMENT); failures++; }
          if (committed) break;
          expect(await fixture.snapshot()).toEqual(before);
          expect(fixture.store.snapshot()).toEqual(cached);
        }
        expect(committed).toBe(true);
        expect(failures).toBeGreaterThan(10);
      } finally { await fixture.dispose(); }
    }, 30_000);
    test(`${kind}: actual deferred COMMIT failure rolls back the entire delta and permits retry`, async () => {
      const fixture = await genericFaultFixture(kind);
      try {
        const before = await fixture.snapshot();
        const cached = fixture.store.snapshot();
        await fixture.pool.unsafe(`CREATE FUNCTION reject_generic_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION '${INJECTED_COMMIT}'; END $$;
          CREATE CONSTRAINT TRIGGER reject_generic_commit AFTER INSERT OR UPDATE OR DELETE ON items DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION reject_generic_commit()`);
        await expect(fixture.run()).rejects.toThrow(INJECTED_COMMIT);
        expect(await fixture.snapshot()).toEqual(before);
        expect(fixture.store.snapshot()).toEqual(cached);
        await fixture.pool.unsafe("DROP TRIGGER reject_generic_commit ON items");
        await fixture.run();
      } finally { await fixture.dispose(); }
    });
  }
});
