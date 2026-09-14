import { describe, expect, test } from "bun:test";
import { materializeOperatorAction } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { DIRECT_OPERATOR_INPUT, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL direct owned rows [T5921 Behavioral-Active Blackbox-GoodCommunication]", () => {
  // expected-failure: tasks:T5921
  test.failing("postgres direct owned lifecycle consumers use keyed row plans", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const { store, pool, projectKey } = fixture;
    try {
      await seedDirectOwnedTasks(store);
      const first = await materializeOperatorAction(store, DIRECT_OPERATOR_INPUT);
      const task = store.fetchItem("tasks", "T1");
      await store.createItem("tasks", task.milestoneId, { id: "T2", status: "planned", fields: task.fields });
      const before = await pool`SELECT xmin::text AS version, fields_json FROM items
        WHERE project_key = ${projectKey} AND ledger = 'operatorActions' AND id = ${first.action.id}`;
      expect(before).toHaveLength(1);
      expect(await materializeOperatorAction(store, { ...DIRECT_OPERATOR_INPUT, taskId: "T2" })).toMatchObject({ state: "created", action: { id: "OA2" } });
      const after = await pool`SELECT xmin::text AS version, fields_json FROM items
        WHERE project_key = ${projectKey} AND ledger = 'operatorActions' AND id = ${first.action.id}`;
      expect(after[0].fields_json).toBe(before[0].fields_json);
      if (after[0].version !== before[0].version) console.info("T5921 reproduced: materializing OA2 rewrites unrelated OA1");
      expect(after[0].version).toBe(before[0].version);
    } finally { await fixture.dispose(); }
  });
});
