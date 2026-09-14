import { expect, test } from "bun:test";
import { assertSqliteAccessContract, type SqliteAccessRecord } from "../src/index.js";
import type { OperatorActionLifecycleMutation, OperatorActionLifecycleMutationResult } from "../src/store/operatorActionLifecycle.js";
import { claimScopeKey } from "../src/store/planLifecycleDump.js";
import { lifecycleClaim } from "./lifecycleRowRepositoryContract.js";
import { OPERATOR_ACKNOWLEDGE, OPERATOR_ACTION_ROWS, OPERATOR_COMPLETE, OPERATOR_EVIDENCE, OPERATOR_REVISE, OPERATOR_SUPERSEDE } from "./operatorActionLifecycleContract.js";
import { operatorActionSqliteFixture } from "./operatorActionSqliteFixture.js";
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

async function operatorScalingFixture(unrelatedRows: number) {
  const secondAction = OPERATOR_ACTION_ROWS.map(({ ledgerId, item }) => ({ ledgerId, item: {
    ...item, id: item.id.replace(/1$/, "2"),
    fields: { ...item.fields, ...(ledgerId === "operatorActions" ? { taskRef: "tasks:T2" } : {}) },
  } }));
  const fixture = await operatorActionSqliteFixture([...OPERATOR_ACTION_ROWS, ...secondAction]);
  const { db, accesses } = fixture;
  const observed: { result: OperatorActionLifecycleMutationResult; accesses: SqliteAccessRecord[] }[] = [];
  const capture = async (mutation: OperatorActionLifecycleMutation, itemKeys: readonly string[], writes: readonly string[]) => {
    accesses.length = 0;
    const result = await fixture.mutate(mutation);
    for (const access of accesses) assertSqliteAccessContract(access);
    expect(accesses.filter(({ table }) => table.startsWith("plan_") || table === "archived_items")).toEqual([]);
    expect(accesses.filter(({ table, mode }) => table === "items" && mode === "read").flatMap(({ rowKeys }) => rowKeys).sort()).toEqual([...itemKeys].sort());
    expect(accesses.filter(({ table, mode }) => table === "items" && mode === "write").flatMap(({ rowKeys }) => rowKeys).sort()).toEqual([...writes].sort());
    observed.push({ result, accesses: structuredClone(accesses) });
  };
  try {
    db.transaction(() => {
      db.query("INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M-unrelated', '', '')").run();
      db.query(`INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at)
        VALUES ('tasks', 'M-archive', '', '', 'done', ?)`).run(LIFECYCLE_NOW);
      const active = db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at)
        VALUES ('tasks', ?, 'M-unrelated', 'planned', '{"headline":"unrelated"}', ?, ?)`);
      const archived = db.query(`INSERT INTO archived_items (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at)
        VALUES ('tasks', 'M-archive', ?, 'M-archive', 'done', '{"headline":"unrelated"}', ?, ?)`);
      const privateClaim = db.query("INSERT INTO plan_claims (scope, record_json) VALUES (?, ?)");
      for (let index = 0; index < unrelatedRows; index += 1) {
        active.run(`T${100000 + index}`, LIFECYCLE_NOW, LIFECYCLE_NOW);
        archived.run(`T${200000 + index}`, LIFECYCLE_NOW, LIFECYCLE_NOW);
        if (index < 2_000) {
          const claim = lifecycleClaim(`G${10000 + index}`);
          privateClaim.run(claimScopeKey(claim.goalId, claim.claimRequestId), JSON.stringify(claim));
        }
      }
    })();
    const actionOnly = ["operatorActions:OA1"];
    const revised = [...actionOnly, "tasks:T1", "handoffs:HO1"];
    await capture({ ...OPERATOR_ACKNOWLEDGE, outputIdentity: "wrong" }, actionOnly, []);
    await capture(OPERATOR_ACKNOWLEDGE, actionOnly, actionOnly);
    await capture({ ...OPERATOR_EVIDENCE, evidence: { ...OPERATOR_EVIDENCE.evidence, exitCode: 1 } }, actionOnly, actionOnly);
    await capture(OPERATOR_REVISE, revised, revised);
    await capture({ ...OPERATOR_ACKNOWLEDGE, expectedRevision: 2, outputIdentity: "identity-2" }, actionOnly, actionOnly);
    await capture({ ...OPERATOR_EVIDENCE, expectedRevision: 2, evidence: { ...OPERATOR_EVIDENCE.evidence, command: "probe-2", outputIdentity: "identity-2" } }, actionOnly, actionOnly);
    await capture({ ...OPERATOR_COMPLETE, expectedRevision: 2 }, [...actionOnly, "tasks:T1"], [...actionOnly, "tasks:T1"]);
    await capture({ ...OPERATOR_SUPERSEDE, actionId: "OA2" }, ["operatorActions:OA2", "tasks:T2"], ["operatorActions:OA2", "tasks:T2"]);
    await capture({ ...OPERATOR_SUPERSEDE, actionId: "OA2" }, ["operatorActions:OA2", "tasks:T2"], []);
    return observed;
  } finally { await fixture.dispose(); }
}

test("all operator-action variants have size-independent keys and writes with 20k active plus 20k archived rows [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  expect(await operatorScalingFixture(20_000)).toEqual(await operatorScalingFixture(0));
}, 30_000);
