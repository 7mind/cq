import { expect, test } from "bun:test";
import { materializeOperatorAction } from "../src/index.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

// expected-failure: tasks:T5545
test.failing("sqlite direct owned lifecycle consumers use keyed row plans", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  try {
    const milestone = await store.createMilestone({ title: "direct owned lifecycle" });
    await store.createItem("tasks", milestone.id, { id: "T1", status: "planned", fields: {
      headline: "selected operator task", description: "CQ-OPERATOR-ACTION v1 keyed-direct. User acts.", ledgerRefs: ["goals:G1"],
    } });
    db.query("INSERT INTO groups (ledger, id, title, description) VALUES ('operatorActions', ?, '', '')").run(milestone.id);
    db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at)
      VALUES ('operatorActions', 'OA90000', ?, 'pending', '{"summary":"unrelated"}', ?, ?)`)
      .run(milestone.id, LIFECYCLE_NOW, LIFECYCLE_NOW);
    db.query("CREATE TABLE observed_direct_owned_writes (item_id TEXT NOT NULL)").run();
    for (const operation of ["INSERT", "UPDATE"]) {
      db.query(`CREATE TRIGGER observe_direct_owned_${operation} AFTER ${operation} ON items
        WHEN NEW.ledger = 'operatorActions' AND NEW.id = 'OA90000'
        BEGIN INSERT INTO observed_direct_owned_writes VALUES (NEW.id); END`).run();
    }
    expect(await materializeOperatorAction(store, {
      taskId: "T1", expectedOutputIdentity: "selected-identity", expectedEvidence: ["probe"], ...LIFECYCLE_PROVENANCE,
    })).toMatchObject({ state: "created" });
    expect(db.query("SELECT item_id FROM observed_direct_owned_writes").all()).toEqual([]);
  } finally { await fixture.dispose(); }
});
