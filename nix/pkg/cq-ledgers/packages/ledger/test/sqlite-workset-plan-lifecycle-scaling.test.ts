import { expect, test } from "bun:test";
import { assertSqliteAccessContract, createTrustedWorksetManagementAuthority, createWorksetGuardedPlanLifecycleStore } from "../src/index.js";
import type { AdmittedPlanMutation } from "../src/worksetPlanLifecycle.js";
import { LIFECYCLE_CLAIM_INPUT, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";
import { guardedPlanSqliteFixture, guardedScalingFixture } from "./sqliteLifecycleBoundsScenarios.js";

test("sqlite guarded plan lifecycle uses an exact affected closure", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store } = fixture;
  const authorizationSnapshots: string[][] = [];
  try {
    await store.createItem("goals", "M-AMBIENT", { id: "G90000", status: "clarifying", fields: { title: "unrelated goal", description: "outside selected roots" } });
    await store.replaceWorksetRoots(["goals:G1"]);
    const guarded = createWorksetGuardedPlanLifecycleStore({
      rawStore: store, worksetStore: store.worksetStore(), invocationAuthority: createTrustedWorksetManagementAuthority(),
      runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context),
      runPlanLifecycleTransaction: (context, mutate) => store.runAtomicWorksetPlanLifecycleMutation(context, (tx) => mutate({
        ...tx,
        activeState: () => {
          const state = tx.activeState();
          authorizationSnapshots.push([...state.byRef.keys()]);
          return state;
        },
      })),
    });
    fixture.accesses.length = 0;
    expect((await guarded.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
    expect(authorizationSnapshots.flat()).not.toContain("goals:G90000");
    expect(fixture.accesses.length).toBeGreaterThan(0);
    expect(fixture.accesses.flatMap(({ rowKeys }) => rowKeys)).not.toContain("goals:G90000");
    for (const access of fixture.accesses) assertSqliteAccessContract(access);
  } finally { await fixture.dispose(); }
});




test("restrictive guarded plan operations and restarted replays retain exact keys with 20k active plus 20k archived rows [T5546]", async () => {
  expect((await guardedScalingFixture(20_000)).observations).toEqual((await guardedScalingFixture(0)).observations);
}, 30_000);

test("native guarded plan admission rejects substituted goal/kind, closed grants and stale epochs without partial state [T5546]", async () => {
  const fixture = await guardedPlanSqliteFixture();
  const { store, db } = fixture;
  try {
    await store.replaceWorksetRoots(["goals:G1"]);
    const admission = await store.worksetStore().admitLedgerMutation({ kind: "claim-plan", targets: ["goals:G1"] });
    const context: AdmittedPlanMutation = { admission, operation: { kind: "claim-plan", input: LIFECYCLE_CLAIM_INPUT } };
    const snapshot = () => ["items", "groups", "ledgers", "item_references", "plan_claims", "plan_operations", "coherence_vector"]
      .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
    const before = snapshot();
    try {
      await expect(store.runAtomicWorksetPlanLifecycleMutation({ ...context, admission: { ...admission } }, () => undefined)).rejects.toThrow("exact live operation/goal admission");
      await expect(store.runAtomicWorksetPlanLifecycleMutation({ admission, operation: { kind: "claim-plan", input: { ...LIFECYCLE_CLAIM_INPUT, goalId: "G2" } } }, () => undefined)).rejects.toThrow("exact live operation/goal admission");
      db.query("UPDATE workset_admissions SET kind = 'finalize-plan' WHERE id = ?").run(admission.id);
      await expect(store.runAtomicWorksetPlanLifecycleMutation(context, () => undefined)).rejects.toThrow("exact durable operation/goal/roots epoch");
      db.query("UPDATE workset_admissions SET kind = 'claim-plan' WHERE id = ?").run(admission.id);
      db.query("UPDATE workset_state SET epoch = epoch + 1 WHERE id = 1").run();
      try {
        await expect(store.runAtomicWorksetPlanLifecycleMutation(context, () => undefined)).rejects.toThrow("exact durable operation/goal/roots epoch");
      } finally { db.query("UPDATE workset_state SET epoch = ? WHERE id = 1").run(admission.epoch); }
      expect(snapshot()).toEqual(before);
    } finally { await admission.acknowledge(); }
    await expect(store.runAtomicWorksetPlanLifecycleMutation(context, () => undefined)).rejects.toThrow("exact live operation/goal admission");
  } finally { await fixture.dispose(); }
});
