import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL operation row locks [T5917 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("postgres operation kernel locks only its declared closure", async () => {
    const fixture = await postgresKeyedFixture();
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
    const worker = new SQL({ url: dsn, connection: { search_path: fixture.schema, lock_timeout: "250ms" } });
    const projectKey = "kernel-lock-scope";
    const store = new PostgresLedgerStore({ pool: worker, projectKey, displayName: projectKey });
    try {
      await store.init();
      await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "selected", description: "selected" } });
      await fixture.pool.begin(async (holder) => {
        const held = await holder`SELECT name FROM ledgers WHERE project_key = ${projectKey} AND name = 'ideas' FOR UPDATE`;
        expect(held).toHaveLength(1);
        try {
          const claim = await store.claimPlan({ goalId: "G1", purpose: "initial", claimRequestId: "request-G1", expectedGeneration: null,
            ownerFenceToken: "A".repeat(43), author: "T5917", session: "keyed-lock-scope" });
          expect(claim.ok).toBe(true);
        } catch (error) {
          const failure = error as { errno?: string; message?: string };
          if (failure.errno === "55P03") console.info("T5917 reproduced: an unrelated ideas counter lock blocks a goal claim (SQLSTATE 55P03)");
          throw error;
        }
      });
    } finally { await store.dispose(); await fixture.dispose(); }
  });
});
