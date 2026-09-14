import { describe, expect, test } from "bun:test";
import { operatorActionPostgresFixture, operatorActionPostgresFixtureWithPool } from "./operatorActionPostgresFixture.js";
import { OPERATOR_ACTION_ROWS, OPERATOR_REVISE } from "./operatorActionLifecycleContract.js";
import { PostgresStatementFaults } from "./postgresStatementFaults.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL operator faults [T5919 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("every statement failure rolls back the action/task/handoff set before cache publication", async () => {
    const injected = "T5919 injected statement failure";
    const faults = new PostgresStatementFaults(injected);
    const fixture = await operatorActionPostgresFixtureWithPool(OPERATOR_ACTION_ROWS, (pool) => faults.wrap(pool));
    const snapshot = async () => [...await fixture.pool`SELECT ledger, id, status, fields_json, updated_at, author, session FROM items
      WHERE project_key = ${fixture.projectKey} ORDER BY ledger, id`];
    try {
      const before = await snapshot();
      const maxStatements = 80;
      let rolledBack = 0;
      let completed = false;
      for (let nth = 1; nth <= maxStatements; nth++) {
        faults.armAt(nth);
        try { await fixture.mutate(OPERATOR_REVISE); completed = true; }
        catch (error) { expect((error as Error).message).toBe(injected); rolledBack++; }
        finally { faults.disarm(); }
        if (completed) break;
        expect(await snapshot()).toEqual(before);
        for (const row of OPERATOR_ACTION_ROWS) expect(fixture.fetch(row.ledgerId, row.item.id)).toEqual(row.item);
      }
      expect(rolledBack).toBeGreaterThan(6);
      expect(completed).toBe(true);
      expect(fixture.fetch("operatorActions", "OA1").fields.revision).toBe("2");
    } finally { await fixture.dispose(); }
  });

  test("a deferred constraint failure at COMMIT rolls back all three rows and leaves exact retry usable", async () => {
    const fixture = await operatorActionPostgresFixture(OPERATOR_ACTION_ROWS);
    try {
      const before = [...await fixture.pool`SELECT ledger, id, status, fields_json, updated_at FROM items WHERE project_key = ${fixture.projectKey} ORDER BY ledger, id`];
      await fixture.pool.unsafe(`CREATE FUNCTION reject_operator_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'T5919 injected commit failure'; END $$;
        CREATE CONSTRAINT TRIGGER reject_operator_commit AFTER UPDATE ON items DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (NEW.ledger = 'operatorActions') EXECUTE FUNCTION reject_operator_commit()`);
      await expect(fixture.mutate(OPERATOR_REVISE)).rejects.toThrow("T5919 injected commit failure");
      expect([...await fixture.pool`SELECT ledger, id, status, fields_json, updated_at FROM items WHERE project_key = ${fixture.projectKey} ORDER BY ledger, id`]).toEqual(before);
      for (const row of OPERATOR_ACTION_ROWS) expect(fixture.fetch(row.ledgerId, row.item.id)).toEqual(row.item);
      await fixture.pool.unsafe("DROP TRIGGER reject_operator_commit ON items");
      expect(await fixture.mutate(OPERATOR_REVISE)).toMatchObject({ kind: "revise", action: { fields: { revision: "2" } } });
    } finally { await fixture.dispose(); }
  });
});
