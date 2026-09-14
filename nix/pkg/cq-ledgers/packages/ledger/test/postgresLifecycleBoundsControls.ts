import { strict as assert } from "node:assert";
import type { PlanReleaseInput } from "../src/index.js";
import { postgresLifecycleBoundsFixture } from "./postgresLifecycleBoundsMeasurement.js";
import { guardedPlanPostgresSurface } from "./guardedPlanPostgresFixture.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";
import { OPERATOR_ACTION_ROWS, OPERATOR_ACKNOWLEDGE } from "./operatorActionLifecycleContract.js";
import { waitForPostgresLock } from "./postgresLockWait.js";

export async function postgresReleaseBounds(size: number) {
  const fixture = await postgresLifecycleBoundsFixture(size);
  const { pool, store } = fixture;
  const capture = <Result>(name: string, invoke: () => Promise<Result>) => fixture.capture(name, invoke, null);
  try {
    for (const id of ["G10", "G11", "G12", "G13"]) await store.createItem("goals", "M-AMBIENT", {
      id, status: "clarifying", fields: { title: id, description: "release case" },
    });
    await store.createItem("tasks", "M-AMBIENT", { id: "T7", status: "planned", fields: { headline: "selected task wait" } });
    await fixture.warm();
    for (const [goalId, effect] of [["G10", "questions"], ["G11", "researches"], ["G12", "tasks"], ["G13", "abandon"]] as const) {
      const claim = await capture(`${effect}-claim`, () => store.claimPlan({ ...LIFECYCLE_CLAIM_INPUT, goalId, claimRequestId: `request-${goalId}` }));
      assert(claim.ok);
      const identity = { goalId, claimId: claim.acknowledgement.claimId, generation: 1, operationId: `release-${goalId}`, ...LIFECYCLE_PROVENANCE };
      const release: PlanReleaseInput = effect === "abandon" ? { ...identity, kind: "abandon", reason: "explicit abandonment" } : {
        ...identity, kind: "pause", ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken,
        effect: effect === "tasks" ? { kind: "tasks", tasks: ["tasks:T7"] } : effect === "questions"
          ? { kind: "questions", questions: [{ key: "scope", question: "select scope" }] }
          : { kind: "researches", researches: [{ key: "probe", question: "measure behavior" }] },
      };
      if (effect === "questions") {
        await pool.unsafe(`CREATE FUNCTION reject_bounds_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected bounds COMMIT failure'; END $$;
          CREATE CONSTRAINT TRIGGER reject_bounds_commit AFTER UPDATE ON items DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (NEW.ledger = 'goals' AND NEW.id = 'G10') EXECUTE FUNCTION reject_bounds_commit()`);
        await fixture.capture("release-commit-rollback", () => store.releasePlanClaim(release), /injected bounds COMMIT failure/);
        await pool.unsafe("DROP TRIGGER reject_bounds_commit ON items");
      }
      const released = await capture(`${effect}-release`, () => store.releasePlanClaim(release));
      assert(released.ok);
      assert.deepEqual(await capture(`${effect}-release-replay`, () => store.releasePlanClaim(release)), { ...released, replayed: true });
    }
    await store.replaceWorksetRoots(["goals:G10"]);
    const refused = await capture("restrictive-claim-refusal", () => guardedPlanPostgresSurface(store).claimPlan(LIFECYCLE_CLAIM_INPUT));
    assert(!refused.ok && refused.conflict.code === "workset-conflict");
    assert.deepEqual(fixture.observations.at(-1)!.coherence, []);
    return { observations: fixture.observations, diagnostics: fixture.diagnostics };
  } finally { await fixture.dispose(); }
}

export async function postgresIndependentProgressBounds(size: number) {
  const fixture = await postgresLifecycleBoundsFixture(size);
  const { pool, projectKey, store } = fixture;
  const pending: Promise<unknown>[] = [];
  try {
    await store.createItem("goals", "M-AMBIENT", { id: "G2", status: "clarifying", fields: { title: "independent goal", description: "independent" } });
    for (const { ledgerId, item } of OPERATOR_ACTION_ROWS) {
      await pool`INSERT INTO groups (project_key, ledger, id, title, description) VALUES (${projectKey}, ${ledgerId}, ${item.milestoneId}, '', '') ON CONFLICT DO NOTHING`;
      await pool`INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at)
        VALUES (${projectKey}, ${ledgerId}, ${item.id}, ${item.milestoneId}, ${item.status}, ${JSON.stringify(item.fields)}, ${item.createdAt}, ${item.updatedAt})`;
    }
    await pool`INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at)
      SELECT project_key, ledger, 'OA2', milestone_id, status, fields_json, created_at, updated_at FROM items
      WHERE project_key = ${projectKey} AND ledger = 'operatorActions' AND id = 'OA1'`;
    await fixture.warm();
    const claim = (goalId: string) => store.claimPlan({ ...LIFECYCLE_CLAIM_INPUT, goalId, claimRequestId: `request-${goalId}` });
    const exercise = async <Result>(ledgerId: string, id: string, selected: () => Promise<Result>, unrelated: () => Promise<Result>) => {
      const held = await pool.begin(async (holder) => {
        await holder`SELECT 1 FROM items WHERE project_key = ${projectKey} AND ledger = ${ledgerId} AND id = ${id} FOR UPDATE`;
        await holder`SELECT 1 FROM ledgers WHERE project_key = ${projectKey} AND name = 'ideas' FOR UPDATE`;
        const contender = selected().then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
        pending.push(contender);
        await waitForPostgresLock(pool, fixture.applicationName, 2_000);
        const independent = await unrelated();
        const waiting = await pool`SELECT pid FROM pg_stat_activity WHERE application_name = ${fixture.applicationName} AND wait_event_type = 'Lock'`;
        assert(waiting.length > 0, "selected contender stopped waiting before the holder released its target");
        return { contender, independent };
      });
      const selectedResult = await held.contender;
      if (selectedResult.error !== null) throw selectedResult.error;
      return { selected: selectedResult.result, independent: held.independent };
    };
    const goals = await exercise("goals", "G1", () => claim("G1"), () => claim("G2"));
    assert(goals.selected !== null && goals.selected.ok && goals.independent.ok);
    const actions = await exercise("operatorActions", "OA1", () => store.mutateOperatorAction(OPERATOR_ACKNOWLEDGE),
      () => store.mutateOperatorAction({ ...OPERATOR_ACKNOWLEDGE, actionId: "OA2" }));
    assert(actions.selected !== null && actions.selected.kind === "acknowledge" && actions.independent.kind === "acknowledge");
    assert(actions.selected.state === "acknowledged" && actions.independent.state === "acknowledged");
    await fixture.peer.reconcileProjection();
    assert.deepEqual(fixture.peer.fetchItem("goals", "G1"), store.fetchItem("goals", "G1"));
    assert.deepEqual(fixture.peer.fetchItem("operatorActions", "OA1"), store.fetchItem("operatorActions", "OA1"));
    return { goals, actions };
  } finally { await Promise.allSettled(pending); await fixture.dispose(); }
}
