import { describe, expect, test } from "bun:test";
import { createTrustedWorksetManagementAuthority, createWorksetGuardedPlanLifecycleStore } from "../src/index.js";
import { ownedLifecyclePostgresFixtureWithPool } from "./ownedLifecyclePostgresFixture.js";
import { PostgresStatementFaults } from "./postgresStatementFaults.js";
import { snapshotPostgresLifecycleRows } from "./postgresLifecycleSnapshot.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

const INJECTED_STATEMENT = "T5922 injected guarded statement failure";
const INJECTED_COMMIT = "T5922 injected guarded commit failure";
type GuardedCase = "claim" | "publish" | "release" | "finalize";

async function guardedFaultFixture(kind: GuardedCase) {
  const faults = new PostgresStatementFaults(INJECTED_STATEMENT);
  const fixture = await ownedLifecyclePostgresFixtureWithPool((pool) => faults.wrap(pool));
  const { store } = fixture;
  let failAt: number | null = null;
  try {
    const guarded = createWorksetGuardedPlanLifecycleStore({ rawStore: store, worksetStore: store.worksetStore(),
      invocationAuthority: createTrustedWorksetManagementAuthority(),
      runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context),
      runPlanLifecycleTransaction: async (context, mutate) => {
        if (failAt !== null) faults.armAt(failAt);
        try { return await store.runAtomicWorksetPlanLifecycleMutation(context, mutate); }
        finally { faults.disarm(); }
      },
    });
    await store.replaceWorksetRoots(["goals:G1"]);
    let run: () => Promise<unknown> = () => guarded.claimPlan(LIFECYCLE_CLAIM_INPUT);
    if (kind !== "claim") {
      const claim = await guarded.claimPlan(LIFECYCLE_CLAIM_INPUT);
      if (!claim.ok) throw new Error("guarded fault fixture claim failed");
      const identity = { goalId: "G1", claimId: claim.acknowledgement.claimId, generation: 1,
        ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, ...LIFECYCLE_PROVENANCE };
      const publish = { ...identity, operationId: "guarded-fault-publish", manifest: {
        milestones: [{ key: "delivery", title: "delivery" }], tasks: [{ key: "task", milestoneKey: "delivery", headline: "task" }],
      } };
      if (kind === "publish") run = () => guarded.publishPlanDraft(publish);
      else if (kind === "release") run = () => guarded.releasePlanClaim({ ...identity, operationId: "guarded-fault-release", kind: "pause",
        effect: { kind: "questions", questions: [{ key: "scope", question: "scope?" }] } });
      else {
        if (!(await guarded.publishPlanDraft(publish)).ok) throw new Error("guarded fault fixture publication failed");
        await guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review", child: {
          ledgerId: "reviews", id: "R1", status: "go-ahead", fields: {
            planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 1 }),
          },
        } });
        run = () => guarded.finalizePlan({ ...identity, operationId: "guarded-fault-finalize", reviewId: "R1", draftRevision: 1,
          decision: { headline: "approved" }, reviewDefects: { reviewId: "R1", defects: [{ key: "retained", headline: "retained observation", severity: "low" }] } });
      }
    }
    return { ...fixture, run, arm: (nth: number) => { failAt = nth; }, snapshot: () => snapshotPostgresLifecycleRows(fixture.pool, fixture.projectKey) };
  } catch (error) { await fixture.dispose(); throw error; }
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL guarded-plan faults [T5922 Behavioral-Active Blackbox-GoodCommunication]", () => {
  for (const kind of ["claim", "publish", "release", "finalize"] as const) {
    test(`${kind}: each statement failure preserves public/private/coherence rows and cache`, async () => {
      const fixture = await guardedFaultFixture(kind);
      try {
        const before = await fixture.snapshot();
        const cached = fixture.store.snapshot();
        const maximumStatements = 400;
        let failures = 0;
        let committed = false;
        for (let nth = 1; nth <= maximumStatements; nth++) {
          fixture.arm(nth);
          try { expect(await fixture.run()).toMatchObject({ ok: true }); committed = true; }
          catch (error) { expect((error as Error).message).toBe(INJECTED_STATEMENT); failures++; }
          if (committed) break;
          expect(await fixture.snapshot()).toEqual(before);
          expect(fixture.store.snapshot()).toEqual(cached);
        }
        expect(committed).toBe(true);
        expect(failures).toBeGreaterThan(10);
      } finally { await fixture.dispose(); }
    }, 30_000);
    test(`${kind}: an actual deferred COMMIT failure rolls back the entire affected set and permits retry`, async () => {
      const fixture = await guardedFaultFixture(kind);
      try {
        const before = await fixture.snapshot();
        const cached = fixture.store.snapshot();
        await fixture.pool.unsafe(`CREATE FUNCTION reject_guarded_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION '${INJECTED_COMMIT}'; END $$;
          CREATE CONSTRAINT TRIGGER reject_guarded_commit AFTER UPDATE ON items DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (NEW.ledger = 'goals') EXECUTE FUNCTION reject_guarded_commit()`);
        await expect(fixture.run()).rejects.toThrow(INJECTED_COMMIT);
        expect(await fixture.snapshot()).toEqual(before);
        expect(fixture.store.snapshot()).toEqual(cached);
        await fixture.pool.unsafe("DROP TRIGGER reject_guarded_commit ON items");
        expect(await fixture.run()).toMatchObject({ ok: true });
      } finally { await fixture.dispose(); }
    });
  }
});
