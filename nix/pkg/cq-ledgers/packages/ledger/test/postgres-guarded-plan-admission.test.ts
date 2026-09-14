import { describe, expect, test } from "bun:test";
import type { AdmittedPlanMutation } from "../src/worksetPlanLifecycle.js";
import { guardedPlanPostgresFixture } from "./guardedPlanPostgresFixture.js";
import { snapshotPostgresLifecycleRows } from "./postgresLifecycleSnapshot.js";
import { LIFECYCLE_CLAIM_INPUT } from "./sqlitePlanLifecycleFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL guarded-plan admission [T5922 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("an excluded changed coordination row rejects before the first public or private write", async () => {
    const fixture = await guardedPlanPostgresFixture();
    const { pool, store, projectKey, accesses } = fixture;
    try {
      await store.replaceWorksetRoots(["goals:G1"]);
      const admission = await store.worksetStore().admitLedgerMutation({ kind: "claim-plan", targets: ["goals:G1"] });
      try {
        const before = await snapshotPostgresLifecycleRows(pool, projectKey);
        const cached = store.snapshot();
        accesses.length = 0;
        await expect(store.runAtomicWorksetPlanLifecycleMutation({ admission, operation: { kind: "claim-plan", input: LIFECYCLE_CLAIM_INPUT } }, (tx) => {
          const coordination = tx.activeState().byRef.get("milestones:M-AMBIENT");
          if (coordination === undefined) throw new Error("coordination validation row missing");
          coordination.fields.title = "unauthorized coordination change";
          return tx.claimPlan(LIFECYCLE_CLAIM_INPUT);
        })).rejects.toThrow("milestones:M-AMBIENT");
        expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
        expect(await snapshotPostgresLifecycleRows(pool, projectKey)).toEqual(before);
        expect(store.snapshot()).toEqual(cached);
      } finally { await admission.acknowledge(); }
    } finally { await fixture.dispose(); }
  });

  test("substituted operation/goal, stale epoch and closed grant cannot produce partial plan state", async () => {
    const fixture = await guardedPlanPostgresFixture();
    const { pool, store, projectKey } = fixture;
    try {
      await store.replaceWorksetRoots(["goals:G1"]);
      const admission = await store.worksetStore().admitLedgerMutation({ kind: "claim-plan", targets: ["goals:G1"] });
      const context: AdmittedPlanMutation = { admission, operation: { kind: "claim-plan", input: LIFECYCLE_CLAIM_INPUT } };
      const before = await snapshotPostgresLifecycleRows(pool, projectKey);
      const cached = store.snapshot();
      try {
        await expect(store.runAtomicWorksetPlanLifecycleMutation({ ...context, admission: { ...admission } }, () => undefined)).rejects.toThrow("exact live operation/goal admission");
        await expect(store.runAtomicWorksetPlanLifecycleMutation({ admission, operation: { kind: "claim-plan", input: { ...LIFECYCLE_CLAIM_INPUT, goalId: "G2" } } }, () => undefined))
          .rejects.toThrow("exact live operation/goal admission");
        await pool`UPDATE workset_admissions SET kind = 'finalize-plan' WHERE project_key = ${projectKey} AND admission_id = ${admission.id}`;
        try { await expect(store.runAtomicWorksetPlanLifecycleMutation(context, () => undefined)).rejects.toThrow("exact durable operation/goal/roots epoch"); }
        finally { await pool`UPDATE workset_admissions SET kind = 'claim-plan' WHERE project_key = ${projectKey} AND admission_id = ${admission.id}`; }
        await pool`UPDATE workset_roots SET epoch = epoch + 1 WHERE project_key = ${projectKey}`;
        try { await expect(store.runAtomicWorksetPlanLifecycleMutation(context, () => undefined)).rejects.toThrow("exact durable operation/goal/roots epoch"); }
        finally { await pool`UPDATE workset_roots SET epoch = ${admission.epoch} WHERE project_key = ${projectKey}`; }
        expect(await snapshotPostgresLifecycleRows(pool, projectKey)).toEqual(before);
        expect(store.snapshot()).toEqual(cached);
      } finally { await admission.acknowledge(); }
      await expect(store.runAtomicWorksetPlanLifecycleMutation(context, () => undefined)).rejects.toThrow("exact live operation/goal admission");
    } finally { await fixture.dispose(); }
  });
});
