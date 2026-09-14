import { expect, test } from "bun:test";
import { lifecycleCoherenceFixture } from "./lifecycleCoherenceFixture.js";
import { OPERATOR_ACKNOWLEDGE, OPERATOR_ACTION_ROWS, OPERATOR_COMPLETE, OPERATOR_EVIDENCE, OPERATOR_REVISE, OPERATOR_SUPERSEDE } from "./operatorActionLifecycleContract.js";

test("all operator-action variants project exact changed documents locally and on peers [T5547]", async () => {
  const fixture = await lifecycleCoherenceFixture();
  const { store, db, capture } = fixture;
  try {
    for (const suffix of ["1", "2"]) for (const { ledgerId, item } of OPERATOR_ACTION_ROWS) {
      db.query("INSERT OR IGNORE INTO groups (ledger, id, title, description) VALUES (?, ?, '', '')").run(ledgerId, item.milestoneId);
      db.query("INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(ledgerId, item.id.replace(/1$/, suffix), item.milestoneId, item.status,
          JSON.stringify({ ...item.fields, ...(ledgerId === "operatorActions" ? { taskRef: `tasks:T${suffix}` } : {}) }), item.createdAt, item.updatedAt);
    }
    for (const ledgerId of ["operatorActions", "tasks", "handoffs"]) await store.invalidate(ledgerId);
    await capture(() => store.mutateOperatorAction({ ...OPERATOR_ACKNOWLEDGE, outputIdentity: "wrong" }), [], []);
    await capture(() => store.mutateOperatorAction(OPERATOR_ACKNOWLEDGE), ["operatorActions:OA1"], []);
    await capture(() => store.mutateOperatorAction(OPERATOR_ACKNOWLEDGE), [], []);
    await capture(() => store.mutateOperatorAction({ ...OPERATOR_EVIDENCE, evidence: { ...OPERATOR_EVIDENCE.evidence, exitCode: 1 } }), ["operatorActions:OA1"], []);
    await capture(() => store.mutateOperatorAction(OPERATOR_REVISE), ["operatorActions:OA1", "tasks:T1", "handoffs:HO1"], []);
    await capture(() => store.mutateOperatorAction({ ...OPERATOR_ACKNOWLEDGE, expectedRevision: 2, outputIdentity: "identity-2" }), ["operatorActions:OA1"], []);
    await capture(() => store.mutateOperatorAction({ ...OPERATOR_EVIDENCE, expectedRevision: 2, evidence: { ...OPERATOR_EVIDENCE.evidence, command: "probe-2", outputIdentity: "identity-2" } }), ["operatorActions:OA1"], []);
    await capture(() => store.mutateOperatorAction({ ...OPERATOR_COMPLETE, expectedRevision: 2 }), ["operatorActions:OA1", "tasks:T1"], []);
    await capture(() => store.mutateOperatorAction({ ...OPERATOR_SUPERSEDE, actionId: "OA2" }), ["operatorActions:OA2", "tasks:T2"], []);
    await capture(() => store.mutateOperatorAction({ ...OPERATOR_SUPERSEDE, actionId: "OA2" }), [], []);
    expect(store.fetchItem("tasks", "T1").status).toBe("done");
  } finally { await fixture.dispose(); }
});
