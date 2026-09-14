import { describe, expect, test } from "bun:test";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL keyed plan lifecycle [T5918 Behavioral-Active Blackbox-GoodCommunication]", () => {
  // expected-failure: tasks:T5918
  test.failing("postgres plan lifecycle uses keyed row plans", async () => {
    const fixture = await postgresKeyedFixture();
    const projectKey = "plan-private-write-scope";
    const store = new PostgresLedgerStore({ pool: fixture.pool, projectKey, displayName: projectKey });
    const claim = (goalId: string) => store.claimPlan({ goalId, purpose: "initial", claimRequestId: `request-${goalId}`,
      expectedGeneration: null, ownerFenceToken: "A".repeat(43), author: "T5918", session: "keyed-private-writes" });
    try {
      await store.init();
      for (const id of ["G1", "G2"]) await store.createItem("goals", "M-AMBIENT", {
        id, status: "clarifying", fields: { title: id, description: id },
      });
      expect((await claim("G2")).ok).toBe(true);
      const before = await fixture.pool`SELECT scope, record_json, xmin::text AS version FROM plan_claims
        WHERE project_key = ${projectKey} AND goal_id = 'G2'`;
      expect(before).toHaveLength(1);
      expect((await claim("G1")).ok).toBe(true);
      const after = await fixture.pool`SELECT scope, record_json, xmin::text AS version FROM plan_claims
        WHERE project_key = ${projectKey} AND goal_id = 'G2'`;
      expect(after[0].record_json).toBe(before[0].record_json);
      if (after[0].version !== before[0].version) console.info("T5918 reproduced: claiming G1 rewrites G2's unchanged private claim row");
      expect(after[0].version).toBe(before[0].version);
    } finally { await store.dispose(); await fixture.dispose(); }
  });
});
