import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedgerStore } from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { lifecycleScalingFixture } from "./sqliteLifecycleBoundsScenarios.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_NOW, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

test("sqlite plan lifecycle uses keyed row plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-plan-lifecycle-scaling-"));
  const dbPath = join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  const probe = openLedgerDb(dbPath);
  try {
    for (const id of ["G1", "G2"]) {
      await store.createItem("goals", "M-AMBIENT", {
        id,
        status: "clarifying",
        fields: { title: id, description: "keyed lifecycle regression" },
      });
    }
    const claim = (goalId: string) => store.claimPlan({
      goalId,
      purpose: "initial",
      claimRequestId: `request-${goalId}`,
      ownerFenceToken: "A".repeat(43),
      expectedGeneration: null,
      author: "T5542",
      session: "sqlite-plan-lifecycle-scaling",
    });
    expect((await claim("G2")).ok).toBe(true);
    probe.exec(`
      CREATE TABLE observed_lifecycle_writes (record_kind TEXT NOT NULL, goal_id TEXT NOT NULL);
      CREATE TRIGGER observe_unrelated_claim_update AFTER UPDATE ON plan_claims
      WHEN json_extract(NEW.record_json, '$.goalId') = 'G2'
      BEGIN INSERT INTO observed_lifecycle_writes VALUES ('claim', 'G2'); END;
      CREATE TRIGGER observe_unrelated_goal_insert AFTER INSERT ON items
      WHEN NEW.ledger = 'goals' AND NEW.id = 'G2'
      BEGIN INSERT INTO observed_lifecycle_writes VALUES ('goal', 'G2'); END;
      CREATE TRIGGER observe_unrelated_goal_update AFTER UPDATE ON items
      WHEN NEW.ledger = 'goals' AND NEW.id = 'G2'
      BEGIN INSERT INTO observed_lifecycle_writes VALUES ('goal', 'G2'); END;
    `);
    expect((await claim("G1")).ok).toBe(true);
    expect(probe.query("SELECT record_kind, goal_id FROM observed_lifecycle_writes").all()).toEqual([]);
  } finally {
    probe.close();
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});


test("all keyed lifecycle operations retain identical access keys and writes with 20k active, 20k archived and 2k private records [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  expect((await lifecycleScalingFixture(20_000, 2_000)).observations).toEqual((await lifecycleScalingFixture(0, 0)).observations);
}, 30_000);

test("legacy adoption keeps group insertion and item insertion order, not declared or lexical order [T5542]", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  try {
    for (const id of ["M2", "M1"]) {
      db.query("INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', ?, '', '')").run(id);
    }
    for (const [id, group] of [["T10", "M2"], ["T3", "M1"], ["T2", "M2"]]) {
      db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at)
        VALUES ('tasks', ?, ?, 'planned', '{"headline":"legacy"}', ?, ?)`).run(id!, group!, LIFECYCLE_NOW, LIFECYCLE_NOW);
    }
    db.query("UPDATE items SET fields_json = json_set(fields_json, '$.milestones', json(?)) WHERE ledger = 'goals' AND id = 'G1'")
      .run(JSON.stringify(["M1", "M2"]));
    const result = await store.claimPlan(LIFECYCLE_CLAIM_INPUT);
    expect(result).toMatchObject({ ok: true, acknowledgement: {
      adoptedManifest: { milestoneIds: ["M1", "M2"], taskIds: ["T10", "T2", "T3"] },
    } });
  } finally { await fixture.dispose(); }
});

test("prospective allocation skips occupied ids and preserves pre-existing empty group metadata [T5542]", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  try {
    await store.createItem("tasks", "M-AMBIENT", { id: "T1", status: "planned", fields: { headline: "occupied" } });
    db.query("UPDATE ledgers SET item_counter = 0 WHERE name = 'tasks'").run();
    db.query("INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M1', 'retained', 'retained description')").run();
    expect((await store.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
    const result = await store.publishPlanDraft({
      goalId: "G1", claimId: "claim_G1_1", generation: 1,
      ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, operationId: "publish", ...LIFECYCLE_PROVENANCE,
      manifest: {
        milestones: [{ key: "delivery", title: "delivery" }],
        tasks: [
          { key: "first", milestoneKey: "delivery", headline: "first" },
          { key: "second", milestoneKey: "delivery", headline: "second", dependsOn: [{ kind: "draft-task", key: "first" }] },
        ],
      },
    });
    expect(result).toMatchObject({ ok: true, acknowledgement: { manifest: {
      tasks: [{ key: "first", id: "T2" }, { key: "second", id: "T3" }],
    } } });
    expect(store.fetchItem("tasks", "T1").fields.headline).toBe("occupied");
    expect(store.fetchItem("tasks", "T3").fields.dependsOn).toEqual(["tasks:T2"]);
    expect(db.query("SELECT title, description FROM groups WHERE ledger = 'tasks' AND id = 'M1'").get())
      .toEqual({ title: "retained", description: "retained description" });
  } finally { await fixture.dispose(); }
});

test("keyed plan loading rejects a selected orphan row without repairing its missing group [T5542]", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  try {
    db.query("DELETE FROM groups WHERE ledger = 'goals' AND id = 'M-AMBIENT'").run();
    await expect(store.claimPlan(LIFECYCLE_CLAIM_INPUT)).rejects.toThrow("no groups row");
    expect(db.query("SELECT scope FROM plan_claims").all()).toEqual([]);
    expect(db.query("SELECT id FROM groups WHERE ledger = 'goals' AND id = 'M-AMBIENT'").all()).toEqual([]);
  } finally { await fixture.dispose(); }
});
