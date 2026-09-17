import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { IMPLEMENTATION_COMPLETION_REVIEW_FIELD, materializeOperatorAction, PostgresLedgerStore, recordProtectedImplementationCompletion, supersedeOperatorAction } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { waitForPostgresLock } from "./postgresLockWait.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL materialization/supersession race [T5921 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("concurrent first completion recorders converge through post-lock binding re-resolution", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
    const name = `completion-race-${randomUUID()}`;
    const peer = (applicationName: string) => new PostgresLedgerStore({
      projectKey: fixture.projectKey,
      displayName: fixture.projectKey,
      pool: new SQL({ url: dsn, connection: { search_path: fixture.schema, application_name: applicationName, lock_timeout: "2s" } }),
      now: () => LIFECYCLE_NOW,
    });
    const first = peer(`${name}-first`);
    const second = peer(`${name}-second`);
    const pending: Promise<unknown>[] = [];
    try {
      await seedDirectOwnedTasks(fixture.store);
      const completion = await directCompletionRecord();
      await first.init();
      await second.init();
      const queued = await fixture.pool.begin(async (holder) => {
        await holder`SELECT 1 FROM ledgers WHERE project_key = ${fixture.projectKey} AND name = 'reviews' FOR UPDATE`;
        const record = (store: PostgresLedgerStore) => recordProtectedImplementationCompletion(
          store,
          DIRECT_TASK_AUTHORITY,
          completion,
          LIFECYCLE_PROVENANCE,
        );
        const firstRun = record(first);
        pending.push(firstRun);
        await waitForPostgresLock(fixture.pool, `${name}-first`, 1_000);
        const secondRun = record(second);
        pending.push(secondRun);
        await waitForPostgresLock(fixture.pool, `${name}-second`, 1_000);
        return { firstRun, secondRun };
      });
      await expect(Promise.all([queued.firstRun, queued.secondRun])).resolves.toEqual([
        { reviewRef: "reviews:R1" },
        { reviewRef: "reviews:R1" },
      ]);
      await fixture.store.reloadCommittedState();
      expect(fixture.store.fetchItem("tasks", "T2345").fields[IMPLEMENTATION_COMPLETION_REVIEW_FIELD])
        .toBe("reviews:R1");
      expect(fixture.store.fetch("reviews").milestones.flatMap(({ items }) => items)).toHaveLength(1);
      const counters = await fixture.pool<Array<{ item_counter: number }>>`
        SELECT item_counter FROM ledgers WHERE project_key = ${fixture.projectKey} AND name = 'reviews'`;
      expect(counters[0]?.item_counter).toBe(1);
    } finally {
      await Promise.allSettled(pending);
      await first.dispose();
      await second.dispose();
      await fixture.dispose();
    }
  });

  for (const order of ["materialize-first", "supersede-first"] as const) {
    test(`${order}: queued peer transactions produce one complete serial outcome`, async () => {
      const fixture = await ownedLifecyclePostgresFixture();
      const dsn = process.env.CQ_TEST_PG_URL;
      if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
      const name = `direct-race-${randomUUID()}`;
      const peer = (applicationName: string) => new PostgresLedgerStore({ projectKey: fixture.projectKey, displayName: fixture.projectKey,
        pool: new SQL({ url: dsn, connection: { search_path: fixture.schema, application_name: applicationName, lock_timeout: "2s" } }),
        now: () => LIFECYCLE_NOW });
      const materializer = peer(`${name}-materialize`);
      const superseder = peer(`${name}-supersede`);
      const pending: Promise<unknown>[] = [];
      const settle = (run: Promise<unknown>) => {
        const observed = run.then((result) => ({ kind: "result" as const, result }), (error: unknown) => ({ kind: "error" as const, error }));
        pending.push(observed);
        return observed;
      };
      try {
        await seedDirectOwnedTasks(fixture.store);
        await materializer.init(); await superseder.init();
        const queued = await fixture.pool.begin(async (holder) => {
          await holder`SELECT 1 FROM items WHERE project_key = ${fixture.projectKey} AND ledger = 'tasks' AND id = 'T1' FOR UPDATE`;
          const materialize = () => settle(materializeOperatorAction(materializer, DIRECT_OPERATOR_INPUT));
          const supersede = () => settle(supersedeOperatorAction(superseder, DIRECT_SUPERSEDE_INPUT));
          if (order === "materialize-first") {
            const creation = materialize();
            await waitForPostgresLock(fixture.pool, `${name}-materialize`, 1_000);
            const supersession = supersede();
            await waitForPostgresLock(fixture.pool, `${name}-supersede`, 1_000);
            return { creation, supersession };
          }
          const supersession = supersede();
          await waitForPostgresLock(fixture.pool, `${name}-supersede`, 1_000);
          const creation = materialize();
          await waitForPostgresLock(fixture.pool, `${name}-materialize`, 1_000);
          return { creation, supersession };
        });
        const creation = await queued.creation;
        const supersession = await queued.supersession;
        expect(supersession).toMatchObject({ kind: "result", result: { task: { status: "abandoned" } } });
        await fixture.store.reloadCommittedState();
        expect(fixture.store.fetchItem("tasks", "T1").status).toBe("abandoned");
        if (order === "materialize-first") {
          expect(creation).toMatchObject({ kind: "result", result: { state: "created" } });
          expect(fixture.store.fetchItem("operatorActions", "OA1").status).toBe("superseded");
          expect(fixture.store.fetchItem("handoffs", "HO1").status).toBe("user-action-required");
        } else {
          expect(creation.kind).toBe("error");
          if (creation.kind !== "error") throw new Error("materialization accepted an abandoned task");
          expect((creation.error as Error).message).toContain("must remain planned");
          expect(() => fixture.store.fetchItem("operatorActions", "OA1")).toThrow();
          expect(() => fixture.store.fetchItem("handoffs", "HO1")).toThrow();
        }
      } finally {
        await Promise.allSettled(pending);
        await materializer.dispose(); await superseder.dispose(); await fixture.dispose();
      }
    });
  }
});
