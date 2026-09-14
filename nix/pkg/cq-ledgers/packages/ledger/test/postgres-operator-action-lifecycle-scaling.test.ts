import { describe, expect, test } from "bun:test";
import { operatorActionPostgresFixture } from "./operatorActionPostgresFixture.js";
import { OPERATOR_ACKNOWLEDGE, OPERATOR_ACTION_ROWS } from "./operatorActionLifecycleContract.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL keyed operator lifecycle [T5919 Behavioral-Active Blackbox-GoodCommunication]", () => {
  // expected-failure: tasks:T5919
  test.failing("postgres operator-action lifecycle uses keyed row plans", async () => {
    const action = OPERATOR_ACTION_ROWS[0]!;
    const fixture = await operatorActionPostgresFixture([...OPERATOR_ACTION_ROWS, { ...action, item: { ...action.item, id: "OA2" } }]);
    try {
      const before = await fixture.pool`SELECT xmin::text AS version, fields_json FROM items
        WHERE project_key = ${fixture.projectKey} AND ledger = 'operatorActions' AND id = 'OA2'`;
      expect(before).toHaveLength(1);
      expect(await fixture.mutate(OPERATOR_ACKNOWLEDGE)).toMatchObject({ kind: "acknowledge", state: "acknowledged" });
      const after = await fixture.pool`SELECT xmin::text AS version, fields_json FROM items
        WHERE project_key = ${fixture.projectKey} AND ledger = 'operatorActions' AND id = 'OA2'`;
      expect(after[0].fields_json).toBe(before[0].fields_json);
      if (after[0].version !== before[0].version) console.info("T5919 reproduced: acknowledging OA1 rewrites unchanged OA2");
      expect(after[0].version).toBe(before[0].version);
    } finally { await fixture.dispose(); }
  });
});
