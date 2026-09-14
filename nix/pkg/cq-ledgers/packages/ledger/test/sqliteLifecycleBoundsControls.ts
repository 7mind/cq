import { strict as assert } from "node:assert";
import { recordProtectedImplementationCompletion, supersedeOperatorAction, type PlanReleaseInput } from "../src/index.js";
import { DIRECT_SUPERSEDE_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { LifecycleBoundsMeasurement, lifecycleDomainDigest, measureRejectedLifecycle } from "./lifecycleBoundsMeasurement.js";
import { seedUnrelatedOwnedRows } from "./ownedLifecycleSqliteFixtures.js";
import { guardedPlanSurface } from "./sqliteLifecycleBoundsScenarios.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

export async function releaseAndRefusalBounds(unrelatedRows: number) {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  const measurement = new LifecycleBoundsMeasurement(fixture);
  const capture = async <T>(invoke: () => Promise<T>): Promise<T> => {
    measurement.start(); const result = await invoke(); measurement.finish(result); return result;
  };
  const refuse = (invoke: () => Promise<unknown>, message: RegExp) => measureRejectedLifecycle(fixture, measurement, invoke, message);
  try {
    for (const id of ["G10", "G11", "G12", "G13"]) await store.createItem("goals", "M-AMBIENT", {
      id, status: "clarifying", fields: { title: id, description: "release case" },
    });
    await store.createItem("tasks", "M-AMBIENT", { id: "T7", status: "planned", fields: { headline: "wait task" } });
    await store.createMilestone({ id: "M50", title: "archived parent" });
    await store.updateMilestone("M50", { status: "done" });
    await store.archiveMilestone("M50", "archived fixture");
    seedUnrelatedOwnedRows(db, unrelatedRows);
    for (const [goalId, kind] of [["G10", "questions"], ["G11", "researches"], ["G12", "tasks"], ["G13", "abandon"]] as const) {
      const claimed = await capture(() => store.claimPlan({ ...LIFECYCLE_CLAIM_INPUT, goalId, claimRequestId: `request-${goalId}` }));
      assert(claimed.ok);
      const identity = { goalId, claimId: claimed.acknowledgement.claimId, generation: 1, operationId: `release-${goalId}`, ...LIFECYCLE_PROVENANCE };
      const input: PlanReleaseInput = kind === "abandon" ? { ...identity, kind, reason: "explicit abandonment" } : {
        ...identity, kind: "pause", ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken,
        effect: kind === "tasks" ? { kind, tasks: ["tasks:T7"] } : kind === "questions"
          ? { kind, questions: [{ key: "scope", question: "Choose scope" }] } : { kind, researches: [{ key: "probe", question: "Measure behavior" }] },
      };
      if (kind === "questions") {
        db.query(`CREATE TRIGGER fail_bounds_release BEFORE INSERT ON plan_operations WHEN NEW.goal_id = 'G10'
          BEGIN SELECT RAISE(ABORT, 'injected bounds release failure'); END`).run();
        await refuse(() => store.releasePlanClaim(input), /injected bounds release failure/);
        db.query("DROP TRIGGER fail_bounds_release").run();
      }
      const released = await capture(() => store.releasePlanClaim(input));
      assert(released.ok);
      assert.deepEqual(await capture(() => store.releasePlanClaim(input)), { ...released, replayed: true });
    }
    db.query(`CREATE TRIGGER fail_bounds_claim BEFORE INSERT ON plan_claims WHEN NEW.goal_id = 'G1'
      BEGIN SELECT RAISE(ABORT, 'injected bounds claim failure'); END`).run();
    await refuse(() => store.claimPlan(LIFECYCLE_CLAIM_INPUT), /injected bounds claim failure/);
    db.query("DROP TRIGGER fail_bounds_claim").run();
    assert((await capture(() => store.claimPlan(LIFECYCLE_CLAIM_INPUT))).ok);
    await refuse(() => store.publishPlanDraft({ goalId: "G1", claimId: "claim_G1_1", generation: 1,
      ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, operationId: "dangling", ...LIFECYCLE_PROVENANCE,
      manifest: { milestones: [{ key: "delivery", title: "delivery" }], tasks: [{ key: "task", milestoneKey: "delivery", headline: "task",
        dependsOn: [{ kind: "ledger", ref: "tasks:T99999" }],
      }] },
    }), /T99999/);
    const guarded = guardedPlanSurface(store);
    await refuse(() => guarded.owned.createOwnerless({ ledgerId: "tasks", milestoneId: "M50", status: "planned", fields: { headline: "invalid parent" } }), /M50/);
    await store.replaceWorksetRoots(["goals:G10"]);
    const before = lifecycleDomainDigest(db);
    const excluded = await capture(() => guarded.claimPlan({ ...LIFECYCLE_CLAIM_INPUT, claimRequestId: "excluded" }));
    assert(!excluded.ok && excluded.conflict.code === "workset-conflict");
    assert.equal(lifecycleDomainDigest(db), before);
    return measurement.report();
  } finally { await fixture.dispose(); }
}

export async function unmaterializedAndUnownedCompletionBounds(unrelatedRows: number, completion: Awaited<ReturnType<typeof directCompletionRecord>>) {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  const measurement = new LifecycleBoundsMeasurement(fixture);
  try {
    await seedDirectOwnedTasks(store);
    await store.updateItem("tasks", "T2345", { fields: { ledgerRefs: [] } });
    seedUnrelatedOwnedRows(db, unrelatedRows);
    for (const invoke of [() => supersedeOperatorAction(store, DIRECT_SUPERSEDE_INPUT),
      () => recordProtectedImplementationCompletion(store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE)]) {
      for (const _attempt of ["first", "replay"]) {
        measurement.start(); const result = await invoke(); measurement.finish(result);
      }
    }
    assert.equal(store.fetchItem("defects", "D1").status, "root-caused");
    assert.equal(store.fetchItem("defects", "D4").status, "root-caused");
    return measurement.report();
  } finally { await fixture.dispose(); }
}
