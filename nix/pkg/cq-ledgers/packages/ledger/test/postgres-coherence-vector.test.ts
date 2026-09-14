import { describe, expect, test } from "bun:test";
import { PostgresOperationQueries } from "../src/store/postgres/operationAccess.js";
import { postgresCoherenceVersion, readPostgresCoherence, recordPostgresCoherence, type PostgresCoherenceChange } from "../src/store/postgres/coherenceVector.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL transaction coherence vector [T5924 Behavioral-Active Effectual-GoodCommunication]", () => {
  test("one domain transaction owns one version; empty deltas and rollback publish none", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const { pool, projectKey, accesses } = fixture;
    const queries = (sql: typeof pool) => new PostgresOperationQueries(sql, projectKey, "coherence-contract", { record: (access) => accesses.push(access) }, () => performance.now(), null);
    const changes: PostgresCoherenceChange[] = [{ ledger: "goals", documentId: "G1", scope: "active", kind: "upsert" },
      { ledger: "goals", documentId: "plan_claims:retained-scope", scope: "control", kind: "upsert" }];
    try {
      const before = await postgresCoherenceVersion(queries(pool));
      accesses.length = 0;
      expect(await pool.begin((tx) => recordPostgresCoherence(queries(tx), "writer", []))).toBeNull();
      expect(accesses).toEqual([]);
      await expect(pool.begin(async (tx) => {
        await tx`UPDATE items SET status = 'planning' WHERE project_key = ${projectKey} AND ledger = 'goals' AND id = 'G1'`;
        await recordPostgresCoherence(queries(tx), "writer", changes);
        throw new Error("rollback this complete change");
      })).rejects.toThrow("rollback this complete change");
      expect(await postgresCoherenceVersion(queries(pool))).toBe(before);
      expect(await readPostgresCoherence(queries(pool), before, before + 1)).toEqual([]);
      expect([...await pool`SELECT status FROM items WHERE project_key = ${projectKey} AND ledger = 'goals' AND id = 'G1'`]).toEqual([{ status: "clarifying" }]);
      const committed = await pool.begin(async (tx) => {
        await tx`UPDATE items SET status = 'planning' WHERE project_key = ${projectKey} AND ledger = 'goals' AND id = 'G1'`;
        return recordPostgresCoherence(queries(tx), "writer", changes);
      });
      expect(committed).toBe(before + 1);
      expect(await readPostgresCoherence(queries(pool), before, before + 1)).toEqual(changes.map((change) => ({ ...change, version: before + 1, origin: "writer" })));
    } finally { await fixture.dispose(); }
  });
});
