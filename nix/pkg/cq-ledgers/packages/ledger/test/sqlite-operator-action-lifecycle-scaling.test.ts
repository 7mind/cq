import { expect, test } from "bun:test";
import { operatorScalingFixture } from "./sqliteLifecycleBoundsScenarios.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_NOW, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

test("sqlite operator-action lifecycle uses keyed row plans", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  try {
    expect((await store.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
    db.query("INSERT INTO groups (ledger, id, title, description) VALUES ('operatorActions', 'M-AMBIENT', '', '')").run();
    for (const id of ["OA1", "OA2"]) {
      db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at)
        VALUES ('operatorActions', ?, 'M-AMBIENT', 'pending', ?, ?, ?)`).run(id, JSON.stringify({
        headline: "operator action", revision: "1", expectedOutputIdentity: "retained-identity", expectedEvidence: ["probe"],
      }), LIFECYCLE_NOW, LIFECYCLE_NOW);
    }
    db.query("CREATE TABLE observed_operator_writes (record_kind TEXT NOT NULL)").run();
    db.query(`CREATE TRIGGER observe_unrelated_operator_insert AFTER INSERT ON items
      WHEN NEW.ledger = 'operatorActions' AND NEW.id = 'OA2'
      BEGIN INSERT INTO observed_operator_writes VALUES ('unrelated action'); END`).run();
    db.query(`CREATE TRIGGER observe_unrelated_operator_update AFTER UPDATE ON items
      WHEN NEW.ledger = 'operatorActions' AND NEW.id = 'OA2'
      BEGIN INSERT INTO observed_operator_writes VALUES ('unrelated action'); END`).run();
    db.query(`CREATE TRIGGER observe_unrelated_operator_claim AFTER UPDATE ON plan_claims
      BEGIN INSERT INTO observed_operator_writes VALUES ('unrelated claim'); END`).run();
    expect(await store.mutateOperatorAction({
      kind: "acknowledge", actionId: "OA1", expectedRevision: 1,
      outputIdentity: "retained-identity", acknowledgedAt: LIFECYCLE_NOW,
    })).toMatchObject({ kind: "acknowledge", state: "acknowledged" });
    expect(db.query("SELECT record_kind FROM observed_operator_writes").all()).toEqual([]);
  } finally { await fixture.dispose(); }
});


test("all operator-action variants have size-independent keys and writes with 20k active plus 20k archived rows [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  expect((await operatorScalingFixture(20_000)).observations).toEqual((await operatorScalingFixture(0)).observations);
}, 30_000);
