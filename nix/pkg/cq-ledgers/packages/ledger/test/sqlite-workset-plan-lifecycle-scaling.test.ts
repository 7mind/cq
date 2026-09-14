import { expect, test } from "bun:test";
import { assertSqliteAccessContract, createTrustedWorksetManagementAuthority, createWorksetGuardedPlanLifecycleStore, type PlanFinalizeInput, type PlanPublishDraftInput, type PlanReleaseInput, type SqliteAccessRecord, type SqliteLedgerStore } from "../src/index.js";
import type { AdmittedPlanMutation } from "../src/worksetPlanLifecycle.js";
import { seedUnrelatedOwnedRows } from "./ownedLifecycleSqliteFixtures.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

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

function guardedPlanSurface(store: SqliteLedgerStore) {
  return createWorksetGuardedPlanLifecycleStore({
    rawStore: store, worksetStore: store.worksetStore(), invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context),
    runPlanLifecycleTransaction: (context, mutate) => store.runAtomicWorksetPlanLifecycleMutation(context, mutate),
  });
}

async function guardedPlanSqliteFixture() {
  const fixture = await sqlitePlanLifecycleFixture();
  return { ...fixture, guarded: guardedPlanSurface(fixture.store) };
}

async function guardedScalingFixture(unrelatedRows: number) {
  const fixture = await guardedPlanSqliteFixture();
  const { store, db, accesses } = fixture;
  let guarded = fixture.guarded;
  const observed: { result: unknown; accesses: SqliteAccessRecord[] }[] = [];
  const capture = async <T>(operation: () => Promise<T>, privateWrites: readonly string[]): Promise<T> => {
    accesses.length = 0;
    const result = await operation();
    for (const access of accesses) assertSqliteAccessContract(access);
    expect(accesses.filter(({ mode, table }) => mode === "write" && table.startsWith("plan_"))
      .flatMap(({ table, rowKeys }) => rowKeys.map(() => table)).sort()).toEqual([...privateWrites].sort());
    const grantReads = accesses.filter(({ table }) => table === "workset_admissions");
    expect(grantReads).toHaveLength(1);
    expect(grantReads[0]!.rowKeys).toEqual(grantReads[0]!.keyedPredicate.keys);
    observed.push({ result, accesses: structuredClone(accesses.map((access) => access.table !== "workset_admissions" ? access : {
      ...access, keyedPredicate: { ...access.keyedPredicate, keys: ["current-admission"] }, rowKeys: ["current-admission"],
    })) });
    return result;
  };
  try {
    seedUnrelatedOwnedRows(db, unrelatedRows);
    await store.replaceWorksetRoots(["goals:G1"]);
    const claimed = await capture(() => guarded.claimPlan(LIFECYCLE_CLAIM_INPUT), ["plan_claims"]);
    if (!claimed.ok) throw new Error("guarded claim failed");
    const identity = { goalId: "G1", claimId: claimed.acknowledgement.claimId, generation: 1,
      ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, ...LIFECYCLE_PROVENANCE };
    const publish: PlanPublishDraftInput = { ...identity, operationId: "guarded-publish", manifest: {
      milestones: [{ key: "delivery", title: "delivery" }], tasks: [{ key: "task", milestoneKey: "delivery", headline: "task" }],
    } };
    const published = await capture(() => guarded.publishPlanDraft(publish), ["plan_operations"]);
    expect(published.ok).toBe(true);
    const replaced = await capture(() => guarded.publishPlanDraft({ ...publish, operationId: "guarded-replace" }), ["plan_operations"]);
    expect(replaced.ok).toBe(true);
    await guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review", child: {
      ledgerId: "reviews", id: "R1", status: "go-ahead", fields: {
        planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 2 }),
      },
    } });
    const finalize: PlanFinalizeInput = { ...identity, operationId: "guarded-finalize", reviewId: "R1", draftRevision: 2,
      decision: { headline: "approved" }, reviewDefects: { reviewId: "R1", defects: [{ key: "follow-up", headline: "retained", severity: "low" }] },
    };
    const finalized = await capture(() => guarded.finalizePlan(finalize), ["plan_claims", "plan_operations"]);
    expect(finalized.ok).toBe(true);
    const followUp = await capture(() => guarded.claimPlan({ ...LIFECYCLE_CLAIM_INPUT, purpose: "follow-up", expectedGeneration: 1, claimRequestId: "guarded-follow-up" }), ["plan_claims"]);
    if (!followUp.ok) throw new Error(`guarded follow-up failed: ${JSON.stringify(followUp)}`);
    const release: PlanReleaseInput = { ...identity, generation: 2, claimId: followUp.acknowledgement.claimId, operationId: "guarded-release",
      kind: "pause", effect: { kind: "questions", questions: [{ key: "decision", question: "Choose scope" }] },
    };
    const released = await capture(() => guarded.releasePlanClaim(release), ["plan_claims", "plan_operations"]);
    expect(released.ok).toBe(true);
    await store.dispose();
    await store.init();
    guarded = guardedPlanSurface(store);
    for (const [operation, expected] of [
      [() => guarded.claimPlan(LIFECYCLE_CLAIM_INPUT), claimed], [() => guarded.publishPlanDraft(publish), published],
      [() => guarded.finalizePlan(finalize), finalized], [() => guarded.releasePlanClaim(release), released],
    ] as const) {
      expect(await capture<unknown>(operation, [])).toEqual({ ...expected, replayed: true });
      expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    }
    return observed;
  } finally { await fixture.dispose(); }
}

test("restrictive guarded plan operations and restarted replays retain exact keys with 20k active plus 20k archived rows [T5546]", async () => {
  expect(await guardedScalingFixture(20_000)).toEqual(await guardedScalingFixture(0));
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
