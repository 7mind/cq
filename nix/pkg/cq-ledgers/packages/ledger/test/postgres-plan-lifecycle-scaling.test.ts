import { describe, expect, test } from "bun:test";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";
import { SQL } from "bun";
import type { PlanClaimInput, PlanFinalizeInput, PlanPublishDraftInput, PlanReleaseInput } from "../src/planLifecycle.js";
import type { PostgresAccessRecord } from "../src/store/postgres/operationAccess.js";
import { seedPostgresUnrelatedRows, seedPostgresUnrelatedPrivateRows } from "./postgresUnrelatedRows.js";

async function nativePlanScaling(unrelated: number) {
  const fixture = await postgresKeyedFixture();
  const dsn = process.env.CQ_TEST_PG_URL;
  if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
  const projectKey = "native-plan-scaling";
  const accesses: PostgresAccessRecord[] = [];
  const build = () => new PostgresLedgerStore({ pool: new SQL({ url: dsn, connection: { search_path: fixture.schema } }),
    projectKey, displayName: projectKey, now: () => "2026-09-14T00:00:00.000Z", accessObserver: { record: (record) => accesses.push(record) } });
  let store = build();
  const provenance = { author: "T5918", session: "native-plan-scaling" };
  const input: PlanClaimInput = { ...provenance, goalId: "G1", purpose: "initial", claimRequestId: "initial",
    expectedGeneration: null, ownerFenceToken: "A".repeat(43) };
  const observations: { result: unknown; accesses: Omit<PostgresAccessRecord, "durationMs">[] }[] = [];
  const capture = async <Result>(run: () => Promise<Result>, privateWrites: readonly string[]): Promise<Result> => {
    accesses.length = 0;
    const result = await run();
    expect(accesses.filter(({ mode, table }) => mode === "write" && table.startsWith("plan_"))
      .flatMap(({ table, rowKeys }) => rowKeys.map(() => table)).sort()).toEqual([...privateWrites].sort());
    expect(accesses.every(({ keyedPredicate }) => keyedPredicate.keys.length > 0)).toBe(true);
    observations.push({ result, accesses: accesses.map(({ durationMs: _duration, ...record }) => record) });
    return result;
  };
  try {
    await store.init();
    await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "selected", description: "selected" }, ...provenance });
    await seedPostgresUnrelatedRows(fixture.pool, projectKey, unrelated);
    await seedPostgresUnrelatedPrivateRows(fixture.pool, projectKey, unrelated === 0 ? 0 : 2_000);
    await store.reloadCommittedState();
    const claimed = await capture(() => store.claimPlan(input), ["plan_claims"]);
    if (!claimed.ok) throw new Error("scaling claim conflicted");
    const identity = { ...provenance, goalId: "G1", claimId: claimed.acknowledgement.claimId, generation: 1, ownerFenceToken: input.ownerFenceToken };
    const publish: PlanPublishDraftInput = { ...identity, operationId: "publish", manifest: {
      milestones: [{ key: "delivery", title: "delivery" }],
      tasks: [{ key: "implementation", milestoneKey: "delivery", headline: "implementation" }],
    } };
    const published = await capture(() => store.publishPlanDraft(publish), ["plan_operations"]);
    if (!published.ok) throw new Error("scaling publish conflicted");
    const replaced = await capture(() => store.publishPlanDraft({ ...publish, operationId: "replace" }), ["plan_operations"]);
    if (!replaced.ok) throw new Error("scaling replacement conflicted");
    expect(store.fetchItem("tasks", "T1").status).toBe("abandoned");
    await store.createItem("reviews", "M-AMBIENT", { id: "R1", status: "go-ahead", ...provenance, fields: {
      planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 2 }),
    } });
    const finalize: PlanFinalizeInput = { ...identity, operationId: "finalize", reviewId: "R1", draftRevision: 2,
      decision: { headline: "accepted" }, reviewDefects: { reviewId: "R1", defects: [{ key: "observed", headline: "retained observation", severity: "low" }] } };
    const finalized = await capture(() => store.finalizePlan(finalize), ["plan_claims", "plan_operations"]);
    if (!finalized.ok) throw new Error(`scaling finalize conflicted: ${finalized.conflict.code}`);
    const followup = await capture(() => store.claimPlan({ ...input, purpose: "follow-up", claimRequestId: "follow-up", expectedGeneration: 1 }), ["plan_claims"]);
    if (!followup.ok) throw new Error("scaling follow-up conflicted");
    const release: PlanReleaseInput = { ...identity, claimId: followup.acknowledgement.claimId, generation: 2, operationId: "release",
      kind: "pause", effect: { kind: "researches", researches: [{ key: "investigate", question: "answer before planning" }] } };
    const released = await capture(() => store.releasePlanClaim(release), ["plan_claims", "plan_operations"]);
    expect(released.ok).toBe(true);
    expect(await capture(() => store.claimPlan({ ...input, claimRequestId: "waiting", expectedGeneration: 2 }), []))
      .toMatchObject({ ok: false, conflict: { code: "research-wait-active" } });
    await store.dispose();
    store = build();
    await store.init();
    for (const [run, expected] of [
      [() => store.claimPlan(input), claimed], [() => store.publishPlanDraft(publish), published],
      [() => store.finalizePlan(finalize), finalized], [() => store.releasePlanClaim(release), released],
    ] as const) {
      expect(await capture<unknown>(run, [])).toEqual({ ...expected, replayed: true });
      expect(accesses.every(({ mode, lockMode, table }) => mode === "read" && lockMode === "none" && table.startsWith("plan_"))).toBe(true);
    }
    return observations;
  } finally { await store.dispose(); await fixture.dispose(); }
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL keyed plan lifecycle [T5918 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("native plan rows, locks, private writes and restarted replay are invariant to 20k active and archived rows plus 2k private records", async () => {
    expect(await nativePlanScaling(20_000)).toEqual(await nativePlanScaling(0));
  }, 30_000);

  test("postgres plan lifecycle uses keyed row plans", async () => {
    const fixture = await postgresKeyedFixture();
    const projectKey = "plan-private-write-scope";
    const store = new PostgresLedgerStore({ pool: fixture.pool, projectKey, displayName: projectKey });
    const claim = (goalId: string) => store.claimPlan({ goalId, purpose: "initial", claimRequestId: `request-${goalId}`,
      expectedGeneration: null, ownerFenceToken: "A".repeat(43), author: "T5918", session: "keyed-private-writes" });
    try {
      await store.init();
      for (const id of ["G1", "G2"]) await store.createItem("goals", "M-AMBIENT", {
        id, status: "clarifying", fields: { title: id, description: id },
      });
      expect((await claim("G2")).ok).toBe(true);
      const before = await fixture.pool`SELECT scope, record_json, xmin::text AS version FROM plan_claims
        WHERE project_key = ${projectKey} AND goal_id = 'G2'`;
      expect(before).toHaveLength(1);
      expect((await claim("G1")).ok).toBe(true);
      const after = await fixture.pool`SELECT scope, record_json, xmin::text AS version FROM plan_claims
        WHERE project_key = ${projectKey} AND goal_id = 'G2'`;
      expect(after[0].record_json).toBe(before[0].record_json);
      if (after[0].version !== before[0].version) console.info("T5918 reproduced: claiming G1 rewrites G2's unchanged private claim row");
      expect(after[0].version).toBe(before[0].version);
    } finally { await store.dispose(); await fixture.dispose(); }
  });
});
