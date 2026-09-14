import { describe, expect, test } from "bun:test";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL normalized reference edges [T5916 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("preserves unchanged edges and maintains exact active/archive membership", async () => {
    const fixture = await postgresKeyedFixture();
    const { pool } = fixture;
    const projectKey = "reference-fixture";
    const store = new PostgresLedgerStore({ pool, projectKey, displayName: projectKey });
    try {
      await store.init();
      const milestone = await store.createMilestone({ title: "reference fixture" });
      await store.createItem("tasks", milestone.id, { id: "T1", status: "planned", fields: { headline: "target" } });
      await store.createItem("tasks", milestone.id, { id: "T2", status: "planned", fields: {
        headline: "dependent", dependsOn: ["tasks:T1"], ledgerRefs: ["goals:G1"],
      } });
      const edges = () => pool<Array<{ field_name: string; target_ledger: string; target_id: string; identity: string }>>`
        SELECT field_name, target_ledger, target_id, xmin::text || ':' || ctid::text AS identity
        FROM item_references WHERE project_key = ${projectKey} AND source_ledger = 'tasks' AND source_id = 'T2'
        ORDER BY field_name, target_ledger, target_id
      `;
      const before = [...await edges()];
      expect(before.map(({ field_name }) => field_name)).toEqual(["dependsOn", "ledgerRefs"]);
      await store.updateItem("tasks", "T2", { fields: { headline: "changed text" } });
      expect([...await edges()]).toEqual(before);
      await store.updateItem("tasks", "T2", { fields: { ledgerRefs: [] } });
      expect([...await edges()]).toEqual([before[0]!]);
      await store.updateItem("tasks", "T1", { status: "done" });
      await store.updateItem("tasks", "T2", { status: "done" });
      await store.updateMilestone(milestone.id, { status: "done" });
      await store.archiveMilestone(milestone.id, "done");
      expect([...await edges()]).toEqual([]);
      await store.unarchiveItem("tasks", milestone.id, "T2");
      expect((await edges()).map(({ field_name, target_ledger, target_id }) => ({ field_name, target_ledger, target_id })))
        .toEqual([{ field_name: "dependsOn", target_ledger: "tasks", target_id: "T1" }]);
    } finally { await store.dispose(); await fixture.dispose(); }
  });

  test("scalar ownership edges are tenant-isolated and duplicate references are normalized", async () => {
    const fixture = await postgresKeyedFixture();
    const { pool } = fixture;
    try {
      for (const projectKey of ["one", "two"]) {
        await pool`INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})`;
        await pool`INSERT INTO ledgers VALUES (${projectKey}, 'tasks', '{}', 0, 0)`;
        await pool`
          INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at)
          VALUES (${projectKey}, 'tasks', 'T1', 'M1', 'planned', ${JSON.stringify({
            worksetOwnerRef: "goals:G1", dependsOn: ["tasks:T2", "tasks:T2"], sourceRefs: ["free text", 42],
          })}, 'now', 'now')
        `;
      }
      const read = () => pool<Array<{ project_key: string; field_name: string }>>`
        SELECT project_key, field_name FROM item_references ORDER BY project_key, field_name
      `;
      expect([...await read()]).toEqual([
        { project_key: "one", field_name: "dependsOn" }, { project_key: "one", field_name: "worksetOwnerRef" },
        { project_key: "two", field_name: "dependsOn" }, { project_key: "two", field_name: "worksetOwnerRef" },
      ]);
      await pool`DELETE FROM items WHERE project_key = 'one' AND ledger = 'tasks' AND id = 'T1'`;
      expect([...await read()]).toEqual([
        { project_key: "two", field_name: "dependsOn" }, { project_key: "two", field_name: "worksetOwnerRef" },
      ]);
    } finally { await fixture.dispose(); }
  });
});
