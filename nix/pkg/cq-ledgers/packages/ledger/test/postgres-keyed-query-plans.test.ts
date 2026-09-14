import { describe, expect, test } from "bun:test";
import { POSTGRES_ACTIVE_TARGET_SQL, POSTGRES_ARCHIVED_TARGET_SQL, POSTGRES_LEDGER_STATUS_SQL, POSTGRES_MILESTONE_MEMBERS_SQL,
  POSTGRES_REFERENCE_SOURCE_SQL, POSTGRES_REFERENCE_TARGET_SQL } from "../src/store/postgres/genericMutationDataSource.js";
import type { PostgresStatement } from "../src/store/postgres/operationAccess.js";
import { postgresLifecycleRowFixture } from "./postgresLifecycleRowFixture.js";
import { observePostgresQueryPlan } from "./postgresQueryPlan.js";
import { seedPostgresUnrelatedRows } from "./postgresUnrelatedRows.js";
import { assertPostgresQueryPlanBounds } from "./postgresLifecycleBoundsAssertions.js";

async function fixturePlans(size: number) {
  const fixture = await postgresLifecycleRowFixture();
  const { pool, projectKey } = fixture;
  try {
    await pool`UPDATE items SET status = 'done' WHERE project_key = ${projectKey} AND ledger = 'tasks' AND id = 'T1'`;
    await seedPostgresUnrelatedRows(pool, projectKey, size);
    expect([...await pool`SHOW enable_seqscan`]).toEqual([{ enable_seqscan: "on" }]);
    const cases: readonly { name: string; index: string; statement: PostgresStatement }[] = [
      { name: "active-target", index: "items_pkey", statement: { sql: POSTGRES_ACTIVE_TARGET_SQL, parameters: [projectKey, "goals", "G1"] } },
      { name: "archive-target", index: "archived_items_target", statement: { sql: POSTGRES_ARCHIVED_TARGET_SQL, parameters: [projectKey, "tasks", "T2"] } },
      { name: "selected-status", index: "items_ledger_status", statement: { sql: POSTGRES_LEDGER_STATUS_SQL, parameters: [projectKey, "tasks", ["done"]] } },
      { name: "milestone-members", index: "items_milestone", statement: { sql: POSTGRES_MILESTONE_MEMBERS_SQL, parameters: [projectKey, "M1"] } },
      { name: "reference-source", index: "item_references_pkey", statement: { sql: POSTGRES_REFERENCE_SOURCE_SQL, parameters: [projectKey, "tasks", "T1", ["dependsOn"]] } },
      { name: "reference-target", index: "item_references_target", statement: { sql: POSTGRES_REFERENCE_TARGET_SQL, parameters: [projectKey, "tasks", "T2", ["dependsOn"]] } },
      { name: "ownership-target", index: "item_references_target", statement: { sql: POSTGRES_REFERENCE_TARGET_SQL, parameters: [projectKey, "goals", "G1", ["worksetOwnerRef"]] } },
    ];
    const reports = [];
    for (const entry of cases) {
      await observePostgresQueryPlan(pool, entry.statement);
      const nodes = await observePostgresQueryPlan(pool, entry.statement);
      expect(nodes.some(({ index }) => index === entry.index)).toBe(true);
      expect(nodes.some(({ node }) => node === "Seq Scan")).toBe(false);
      reports.push({ name: entry.name, sql: entry.statement.sql,
        lookups: Math.max(1, ...entry.statement.parameters.map((value) => Array.isArray(value) ? value.length : 1)), nodes });
    }
    return reports;
  } finally { await fixture.dispose(); }
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL keyed query plans [T5916 Performance-Effectual Blackbox-GoodCommunication]", () => {
  test("named closure indexes retain equal visited rows and bounded indexed page work across warm small and large tenants", async () => {
    const small = await fixturePlans(2_000);
    const large = await fixturePlans(20_000);
    expect(large.map(({ name }) => name)).toEqual(small.map(({ name }) => name));
    for (const [index, plan] of small.entries()) assertPostgresQueryPlanBounds(plan, large[index]!);
  }, 30_000);
});
