import { describe, expect, test } from "bun:test";
import { persistPostgresPrivateRecords } from "../src/store/postgres/lifecycleRowRepository.js";
import { lifecycleClaim, lifecycleOperation, runLifecycleRowReadContract } from "./lifecycleRowRepositoryContract.js";
import { postgresLifecycleRowFixture } from "./postgresLifecycleRowFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL keyed row repository [T5916]", () => {
  runLifecycleRowReadContract("real PostgreSQL / GoodCommunication", postgresLifecycleRowFixture);

  test("private writes retain siblings, encode separators, and roll back together [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const fixture = await postgresLifecycleRowFixture();
    const { pool, rows, queries, accesses } = fixture;
    try {
      const claim = { ...lifecycleClaim("G1"), state: "released" as const };
      const operation = lifecycleOperation("new_id");
      await pool.begin((tx) => persistPostgresPrivateRecords(queries(tx), { claims: [claim], operations: [operation] }));
      expect(accesses.map(({ table, mode, count }) => ({ table, mode, count }))).toEqual([
        { table: "plan_claims", mode: "write", count: 1 }, { table: "plan_operations", mode: "write", count: 1 },
      ]);
      expect(await rows.fetchClaimByRequest(claim)).toEqual(claim);
      expect(await rows.fetchActiveClaim("G1")).toBeUndefined();
      expect(await rows.fetchActiveClaim("G2")).toEqual(lifecycleClaim("G2"));
      expect(await rows.fetchOperation(operation.replay)).toEqual(operation);
      let rejection: unknown;
      try {
        await pool.begin((tx) => persistPostgresPrivateRecords(queries(tx), { claims: [lifecycleClaim("G1")], operations: [operation] }));
      } catch (error) { rejection = error; }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as { errno: string }).errno).toBe("23505");
      expect(await rows.fetchClaimByRequest(claim)).toEqual(claim);
      expect(await rows.fetchOperation(operation.replay)).toEqual(operation);
      expect([...await pool`SELECT count(*)::integer AS count FROM plan_claims WHERE project_key = 'unrelated-tenant' AND state = 'active'`])
        .toEqual([{ count: 2 }]);
    } finally { await fixture.dispose(); }
  });
});
