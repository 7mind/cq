import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { PostgresLedgerStore } from "../src/index.js";
import { genericPostgresFixture, genericPostgresSurface } from "./genericPostgresFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL generic lock scope [T5923 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("an unrelated item and counter lock do not block an ordinary update; the exact target lock does", async () => {
    const fixture = await genericPostgresFixture();
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
    const worker = new PostgresLedgerStore({ pool: new SQL({ url: dsn, connection: { search_path: fixture.schema, lock_timeout: "250ms" } }),
      projectKey: fixture.projectKey, displayName: fixture.projectKey });
    try {
      for (const id of ["Q1", "Q2"]) await fixture.generic.createItem("questions", "M-AMBIENT", { id, status: "open", fields: { question: id } });
      await worker.init();
      const generic = genericPostgresSurface(worker);
      await fixture.pool.begin(async (holder) => {
        await holder`SELECT 1 FROM items WHERE project_key = ${fixture.projectKey} AND ledger = 'questions' AND id = 'Q2' FOR UPDATE`;
        await holder`SELECT 1 FROM ledgers WHERE project_key = ${fixture.projectKey} AND name = 'ideas' FOR UPDATE`;
        expect((await generic.updateItem("questions", "Q1", { fields: { question: "unblocked" } })).fields.question).toBe("unblocked");
      });
      await fixture.pool.begin(async (holder) => {
        await holder`SELECT 1 FROM items WHERE project_key = ${fixture.projectKey} AND ledger = 'questions' AND id = 'Q1' FOR UPDATE`;
        await expect(generic.updateItem("questions", "Q1", { fields: { question: "blocked" } })).rejects.toMatchObject({ errno: "55P03" });
      });
      expect(worker.fetchItem("questions", "Q1").fields.question).toBe("unblocked");
    } finally { await worker.dispose(); await fixture.dispose(); }
  });
});
