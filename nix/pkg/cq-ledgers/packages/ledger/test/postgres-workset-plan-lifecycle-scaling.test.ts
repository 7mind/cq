import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createTrustedWorksetManagementAuthority, createWorksetGuardedPlanLifecycleStore, PostgresLedgerStore,
  type PlanFinalizeInput, type PlanPublishDraftInput, type PlanReleaseInput } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_NOW, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";
import { guardedPlanPostgresFixture, guardedPlanPostgresSurface } from "./guardedPlanPostgresFixture.js";
import { seedPostgresUnrelatedPrivateRows, seedPostgresUnrelatedRows } from "./postgresUnrelatedRows.js";
import type { PostgresAccessRecord } from "../src/store/postgres/operationAccess.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL guarded plan scope [T5922 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("postgres guarded plan lifecycle uses an exact affected closure", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const { store } = fixture;
    const suppliedState: string[][] = [];
    try {
      await store.createItem("goals", "M-AMBIENT", { id: "G90000", status: "clarifying", fields: { title: "unrelated", description: "outside roots" } });
      await store.replaceWorksetRoots(["goals:G1"]);
      const guarded = createWorksetGuardedPlanLifecycleStore({ rawStore: store, worksetStore: store.worksetStore(),
        invocationAuthority: createTrustedWorksetManagementAuthority(),
        runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context),
        runPlanLifecycleTransaction: (context, mutate) => store.runAtomicWorksetPlanLifecycleMutation(context, (tx) => {
          suppliedState.push([...tx.activeState().byRef.keys()]);
          return mutate(tx);
        }),
      });
      expect(await guarded.claimPlan(LIFECYCLE_CLAIM_INPUT)).toMatchObject({ ok: true });
      expect(suppliedState).toHaveLength(1);
      if (suppliedState.flat().includes("goals:G90000")) console.info("T5922 reproduced: guarded G1 claim receives unrelated G90000 in its transaction state");
      expect(suppliedState.flat()).not.toContain("goals:G90000");
    } finally { await fixture.dispose(); }
  });
  test("restrictive guarded operations and restarted replay retain exact scopes at 20k/20k/2k unrelated rows", async () => {
    expect(await guardedScaling(20_000)).toEqual(await guardedScaling(0));
  }, 30_000);
});

async function guardedScaling(unrelated: number) {
  const fixture = await guardedPlanPostgresFixture();
  const { pool, projectKey, accesses } = fixture;
  let store = fixture.store;
  let guarded = fixture.guarded;
  const observed: { result: unknown; accesses: Omit<PostgresAccessRecord, "durationMs">[] }[] = [];
  const capture = async <T>(run: () => Promise<T>, privateWrites: readonly string[]): Promise<T> => {
    accesses.length = 0;
    const result = await run();
    expect(accesses.filter(({ mode, table }) => mode === "write" && table.startsWith("plan_"))
      .flatMap(({ table, rowKeys }) => rowKeys.map(() => table)).sort()).toEqual([...privateWrites].sort());
    const admissions = accesses.filter(({ table }) => table === "workset_admissions");
    expect(admissions).toHaveLength(3);
    expect(admissions.filter(({ lockMode }) => lockMode === "share")).toHaveLength(1);
    observed.push({ result, accesses: accesses.map(({ durationMs: _durationMs, ...access }) => access.table !== "workset_admissions" ? access : {
      ...access, keyedPredicate: { ...access.keyedPredicate, keys: ["current-admission"] }, rowKeys: ["current-admission"],
    }) });
    return result;
  };
  try {
    await seedPostgresUnrelatedRows(pool, projectKey, unrelated);
    await seedPostgresUnrelatedPrivateRows(pool, projectKey, unrelated === 0 ? 0 : 2_000);
    await store.reloadCommittedState();
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
    expect((await capture(() => guarded.publishPlanDraft({ ...publish, operationId: "guarded-replace" }), ["plan_operations"])).ok).toBe(true);
    await guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review", child: {
      ledgerId: "reviews", id: "R1", status: "go-ahead", fields: {
        planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 2 }),
      },
    } });
    const finalize: PlanFinalizeInput = { ...identity, operationId: "guarded-finalize", reviewId: "R1", draftRevision: 2,
      decision: { headline: "approved" }, reviewDefects: { reviewId: "R1", defects: [{ key: "follow-up", headline: "retained", severity: "low" }] } };
    const finalized = await capture(() => guarded.finalizePlan(finalize), ["plan_claims", "plan_operations"]);
    expect(finalized.ok).toBe(true);
    const followup = await capture(() => guarded.claimPlan({ ...LIFECYCLE_CLAIM_INPUT, purpose: "follow-up", expectedGeneration: 1, claimRequestId: "guarded-follow-up" }), ["plan_claims"]);
    if (!followup.ok) throw new Error(`guarded follow-up failed: ${JSON.stringify(followup)}`);
    const release: PlanReleaseInput = { ...identity, generation: 2, claimId: followup.acknowledgement.claimId, operationId: "guarded-release",
      kind: "pause", effect: { kind: "questions", questions: [{ key: "decision", question: "Choose scope" }] } };
    const released = await capture(() => guarded.releasePlanClaim(release), ["plan_claims", "plan_operations"]);
    expect(released.ok).toBe(true);
    await store.dispose();
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
    store = new PostgresLedgerStore({ pool: new SQL({ url: dsn, connection: { search_path: fixture.schema } }), projectKey, displayName: projectKey,
      now: () => LIFECYCLE_NOW, accessObserver: { record: (record) => accesses.push(record) } });
    await store.init();
    guarded = guardedPlanPostgresSurface(store);
    for (const [run, expected] of [
      [() => guarded.claimPlan(LIFECYCLE_CLAIM_INPUT), claimed], [() => guarded.publishPlanDraft(publish), published],
      [() => guarded.finalizePlan(finalize), finalized], [() => guarded.releasePlanClaim(release), released],
    ] as const) {
      expect(await capture<unknown>(run, [])).toEqual({ ...expected, replayed: true });
      expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    }
    return observed;
  } finally { await store.dispose(); await fixture.dispose(); }
}
