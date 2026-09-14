import { describe, expect, test } from "bun:test";
import { directCompletionRecord } from "./directOwnedLifecycleContract.js";
import { postgresPlanBounds, postgresOperatorBounds, postgresOwnedBounds, postgresDirectBounds, postgresGenericBounds } from "./postgresLifecycleBoundsScenarios.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL consolidated lifecycle bounds [T5925 Performance-Effectual Blackbox-GoodCommunication]", () => {
  test("follow-up task membership does not scan unrelated active rows", async () => {
    const report = await postgresPlanBounds(20_000, false);
    const followup = report.diagnostics.find(({ name }) => name === "follow-up");
    expect(followup).toBeDefined();
    const membership = followup!.plans.filter(({ sql }) => sql.includes("SELECT i.id, g.id AS group_id"));
    expect(membership).toHaveLength(2);
    for (const plan of membership) expect(plan.nodes.filter(({ relation, node }) => relation === "items" && node === "Seq Scan")).toEqual([]);
  }, 30_000);
  for (const guarded of [false, true]) test(`plan measurement includes private/public changes, projections and restart (guarded=${guarded})`, async () => {
    const report = await postgresPlanBounds(0, guarded);
    expect(report.observations).toHaveLength(10);
    expect(report.diagnostics.every(({ plans }) => plans.length > 0)).toBe(true);
  }, 30_000);
  test("operator variants have exact acknowledged projection deltas", async () => {
    expect((await postgresOperatorBounds(0)).observations).toHaveLength(10);
  }, 30_000);
  test("owned intake and bundles have exact acknowledged projection deltas", async () => {
    expect((await postgresOwnedBounds(0)).observations).toHaveLength(6);
  }, 30_000);
  test("direct consumers retain keyed bounds after restart", async () => {
    expect((await postgresDirectBounds(0, await directCompletionRecord())).observations).toHaveLength(11);
  }, 30_000);
  test("generic archive/unarchive includes exact active and archived projection keys", async () => {
    expect((await postgresGenericBounds(0)).observations).toHaveLength(11);
  }, 30_000);
});
