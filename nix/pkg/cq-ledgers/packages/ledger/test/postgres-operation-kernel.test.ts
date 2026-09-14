import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { runPostgresKeyedOperation, type PostgresKeyedOperation, type PostgresOperationKernelOptions } from "../src/store/postgres/operationKernel.js";
import { createPostgresLifecycleRowRepository } from "../src/store/postgres/lifecycleRowRepository.js";
import type { Item } from "../src/types.js";
import { postgresLifecycleRowFixture } from "./postgresLifecycleRowFixture.js";
import { waitForPostgresLock } from "./postgresLockWait.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL keyed transaction kernel [T5917 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("an unrelated goal proceeds while a same-row contender waits and then reads the committed state", async () => {
    const fixture = await postgresLifecycleRowFixture();
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
    const application = `cq-kernel-${randomUUID()}`;
    const worker = new SQL({ url: dsn, connection: { search_path: fixture.schema, application_name: application, lock_timeout: "2s" } });
    const options: PostgresOperationKernelOptions = { projectKey: fixture.projectKey, observer: { record: (record) => fixture.accesses.push(record) },
      monotonicNow: () => performance.now(), onClosureRetry: null };
    const operation = (id: string): PostgresKeyedOperation<Item | undefined, string | undefined> => ({
      name: `read-locked-${id}`,
      resolve: async (queries) => ({ plan: await createPostgresLifecycleRowRepository(queries).publicRows.fetchActiveItem(`goals:${id}`),
        locks: [{ target: { table: "items", ledgerId: "goals", id }, mode: "update" }], exactReplay: false }),
      apply: async (_queries, item) => item === undefined ? undefined : String(item.fields.title),
    });
    let contender: Promise<string | undefined> | null = null;
    try {
      await fixture.pool`INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at)
        SELECT project_key, ledger, 'G2', milestone_id, status, fields_json, created_at, updated_at FROM items
        WHERE project_key = ${fixture.projectKey} AND ledger = 'goals' AND id = 'G1'`;
      const held = await fixture.pool.begin(async (holder) => {
        await holder`SELECT 1 FROM items WHERE project_key = ${fixture.projectKey} AND ledger = 'goals' AND id = 'G1' FOR UPDATE`;
        expect(await runPostgresKeyedOperation(worker, options, operation("G2"))).toBe("selected");
        const pending = runPostgresKeyedOperation(worker, options, operation("G1"));
        contender = pending;
        await waitForPostgresLock(fixture.pool, application, 1_000);
        await holder`UPDATE items SET fields_json = '{"title":"after-holder-commit"}'
          WHERE project_key = ${fixture.projectKey} AND ledger = 'goals' AND id = 'G1'`;
        return { pending };
      });
      expect(await held.pending).toBe("after-holder-commit");
      expect(fixture.accesses.filter(({ lockMode }) => lockMode !== "none").map(({ rowKeys }) => rowKeys))
        .toEqual([["goals:G2"], ["goals:G1"]]);
    } finally {
      if (contender !== null) await Promise.allSettled([contender]);
      await worker.close();
      await fixture.dispose();
    }
  });

  test("closure growth restarts before effects and an apply failure rolls its write back", async () => {
    const fixture = await postgresLifecycleRowFixture();
    let resolutions = 0;
    let applications = 0;
    const retries: number[] = [];
    const options: PostgresOperationKernelOptions = { projectKey: fixture.projectKey, observer: null,
      monotonicNow: () => performance.now(), onClosureRetry: ({ attempt }) => { retries.push(attempt); } };
    try {
      await expect(runPostgresKeyedOperation(fixture.pool, options, {
        name: "growing-closure",
        resolve: async () => {
          resolutions++;
          return { plan: null, exactReplay: false, locks: (resolutions === 1 ? ["G1"] : ["G1", "G2"]).map((id) => ({
            target: { table: "items" as const, ledgerId: "goals", id }, mode: "update" as const,
          })) };
        },
        apply: async (queries) => {
          applications++;
          await queries.sql`UPDATE items SET status = 'done' WHERE project_key = ${fixture.projectKey} AND ledger = 'goals' AND id = 'G1'`;
          throw new Error("injected after selected row write");
        },
      })).rejects.toThrow("injected after selected row write");
      expect(resolutions).toBe(4);
      expect(applications).toBe(1);
      expect(retries).toEqual([1]);
      expect((await fixture.rows.publicRows.fetchActiveItem("goals:G1"))!.status).toBe("planning");
    } finally { await fixture.dispose(); }
  });
});
