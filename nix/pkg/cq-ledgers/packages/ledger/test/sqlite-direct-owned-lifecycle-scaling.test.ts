import { expect, test } from "bun:test";
import { materializeOperatorAction, supersedeOperatorAction } from "../src/index.js";
import { directCompletionRecord } from "./directOwnedLifecycleContract.js";
import { directOwnedScalingFixture } from "./sqliteLifecycleBoundsScenarios.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

test("sqlite direct owned lifecycle consumers use keyed row plans", async () => {
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


test("direct materialization, supersession and protected completion retain access/write scopes with 20k active plus 20k archived rows [T5545]", async () => {
  const completion = await directCompletionRecord();
  expect((await directOwnedScalingFixture(20_000, completion)).observations).toEqual((await directOwnedScalingFixture(0, completion)).observations);
}, 30_000);

test("operator supersession probes materialization only inside its write transaction [T5545]", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  try {
    const milestone = await fixture.store.createMilestone({ title: "atomic supersession" });
    await fixture.store.createItem("tasks", milestone.id, { id: "T1", status: "planned", fields: {
      headline: "operator task", description: "CQ-OPERATOR-ACTION v1 atomic-supersede. User acts.", ledgerRefs: ["goals:G1"],
    } });
    const transactionOnly = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "fetchItem") return () => { throw new Error("out-of-transaction supersession probe"); };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await supersedeOperatorAction(transactionOnly, {
      actionId: "OA1", expectedRevision: 1, reason: "superseded", supersededAt: LIFECYCLE_NOW, ...LIFECYCLE_PROVENANCE,
    })).toMatchObject({ task: { status: "abandoned" } });
  } finally { await fixture.dispose(); }
});
