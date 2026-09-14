import { describe, expect, test } from "bun:test";
import { PostgresOperationQueries } from "../src/store/postgres/operationAccess.js";
import { persistPostgresPrivateRecords } from "../src/store/postgres/lifecycleRowRepository.js";
import { lifecycleClaim, lifecycleOperation } from "./lifecycleRowRepositoryContract.js";
import { postgresLifecycleRowFixture } from "./postgresLifecycleRowFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL operation access [T5916 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("reports every selected public, joined, and private row without unrelated tenant keys", async () => {
    const fixture = await postgresLifecycleRowFixture();
    const { rows, pool, queries, accesses, projectKey } = fixture;
    try {
      const claim = lifecycleClaim("G1");
      await rows.publicRows.fetchActiveItem("goals:G1");
      await rows.publicRows.fetchArchivedItem("tasks:T2");
      await rows.publicRows.referenceSources("goals:G1", ["worksetOwnerRef"]);
      await rows.fetchGroup("tasks", "M1");
      await rows.taskRefsByMilestones(["M1"]);
      await rows.fetchClaimByRequest(claim);
      await rows.fetchClaimByIdentity(claim);
      await rows.fetchActiveClaim("G1");
      await rows.fetchOperation(lifecycleOperation("existing").replay);
      await pool.begin((tx) => persistPostgresPrivateRecords(queries(tx), {
        claims: [{ ...claim, state: "released" }], operations: [lifecycleOperation("observed")],
      }));
      expect(accesses).toHaveLength(12);
      for (const access of accesses) {
        expect(access.projectKey).toBe(projectKey);
        expect(access.phase).toBe("transaction");
        expect(access.count).toBe(1);
        expect(access.keyedPredicate.keys.length).toBeGreaterThan(0);
        expect(access.durationMs).toBeGreaterThanOrEqual(0);
        expect(access.lockMode).toBe(access.mode === "write" ? "update" : "none");
      }
    } finally { await fixture.dispose(); }
  });

  test("rejects an unkeyed descriptor and isolates observer failure from authoritative results", async () => {
    const fixture = await postgresLifecycleRowFixture();
    try {
      const queries = new PostgresOperationQueries(fixture.pool, fixture.projectKey, "observer-control", {
        record: () => { throw new Error("observer unavailable"); },
      }, () => performance.now(), null);
      const scope = { table: "items", phase: "transaction" as const, mode: "read" as const,
        predicate: { kind: "keys" as const, keys: [] as string[] }, lockMode: "none" as const };
      const statement = { sql: "SELECT id FROM items WHERE project_key = $1 AND ledger = 'goals' AND id = 'G1'", parameters: [fixture.projectKey] };
      const keyOf = ({ id }: { id: string }) => `goals:${id}`;
      await expect(queries.execute(scope, statement, keyOf)).rejects.toThrow("without a keyed predicate");
      expect(await queries.execute({ ...scope, predicate: { kind: "keys", keys: ["goals:G1"] } }, statement, keyOf)).toEqual([{ id: "G1" }]);
    } finally { await fixture.dispose(); }
  });
});
