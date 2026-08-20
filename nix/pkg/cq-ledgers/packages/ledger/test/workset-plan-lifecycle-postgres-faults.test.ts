import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetGuardedPlanLifecycleStore,
  ensureSchema,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  openPgPool,
  PLAN_CURRENT_DRAFT_FIELD,
  PostgresLedgerStore,
  TASKS_LEDGER,
  worksetMemberRefSet,
  type PlanClaimAcknowledgement,
  type PlanPublishDraftInput,
  type WorksetGuardedPlanLifecycleStore,
} from "../src/index.js";

const dsn = process.env.CQ_TEST_PG_URL;
const requirePostgres = process.env.CQ_TEST_REQUIRE_PG === "1";
const provenance = { author: "T1971", session: "T1971-fault" } as const;

if (dsn === undefined || dsn.length === 0) {
  if (requirePostgres) {
    throw new Error(
      "CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN",
    );
  }
  describe.skip("workset plan lifecycle PostgreSQL faults [T1971]", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const pgDsn: string = dsn;
  const setupPool = openPgPool(pgDsn);
  const sharedPool = new Proxy(setupPool, {
    apply: (target, _thisArgument, argumentsList) =>
      Reflect.apply(
        target as unknown as (...args: unknown[]) => unknown,
        target,
        argumentsList,
      ),
    get: (target, property) => {
      if (property === "close") return async () => undefined;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const schemaReady = ensureSchema(setupPool);
  const stores: WorksetGuardedPlanLifecycleStore[] = [];

  afterAll(async () => {
    for (const store of stores) await store.dispose().catch(() => undefined);
    await setupPool.close();
  });

  async function open(
    projectKey: string,
    onMutation?: (ledgerId: string) => void,
  ): Promise<{
    raw: PostgresLedgerStore;
    store: WorksetGuardedPlanLifecycleStore;
    pool: ReturnType<typeof openPgPool>;
  }> {
    await schemaReady;
    const pool = sharedPool;
    const raw = new PostgresLedgerStore({
      pool,
      projectKey,
      displayName: projectKey,
      ...(onMutation !== undefined ? { onMutation } : {}),
      workset: {
        isTargetAdmitted: (target, selectedRoots) => {
          if (selectedRoots.length === 0) return true;
          const graph = closeWorkset(
            selectedRoots,
            buildActiveStateFromLedgerStore(raw),
          );
          return (
            worksetMemberRefSet(graph).has(target) ||
            graph.inactiveRoots.includes(target)
          );
        },
      },
    });
    await raw.init();
    const store = createWorksetGuardedPlanLifecycleStore({
      rawStore: raw,
      worksetStore: raw.worksetStore(),
      invocationAuthority: createTrustedWorksetManagementAuthority(),
      runOwnedTransaction: (mutate) => raw.runAtomicOwnedMutation(mutate),
      runPlanLifecycleTransaction: (goalId, mutate) =>
        raw.runAtomicWorksetPlanLifecycleMutation(goalId, mutate),
    });
    stores.push(store);
    return { raw, store, pool };
  }

  async function seedClaim(
    store: WorksetGuardedPlanLifecycleStore,
    requestId: string,
  ): Promise<PlanClaimAcknowledgement> {
    await store.owned.createOwnerless({
      ledgerId: GOALS_LEDGER,
      milestoneId: MILESTONES_AMBIENT_ID,
      id: "G1",
      status: "clarifying",
      fields: { title: "postgres lifecycle goal", description: "prestate" },
      ...provenance,
    });
    const claimed = await store.claimPlan({
      goalId: "G1",
      purpose: "initial",
      claimRequestId: requestId,
      ownerFenceToken: "p".repeat(22),
      expectedGeneration: null,
      ...provenance,
    });
    if (!claimed.ok) throw new Error(`claim failed: ${claimed.conflict.code}`);
    return claimed.acknowledgement;
  }

  function publishInput(
    claim: PlanClaimAcknowledgement,
    operationId: string,
    headline: string,
  ): PlanPublishDraftInput {
    return {
      goalId: "G1",
      claimId: claim.claimId,
      generation: claim.generation,
      operationId,
      ownerFenceToken: claim.ownerFenceToken,
      manifest: {
        milestones: [{ key: "delivery", title: headline }],
        tasks: [{ key: "task", milestoneKey: "delivery", headline }],
      },
      ...provenance,
    };
  }

  async function settleWithoutDeadlock<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      Bun.sleep(3_000).then(() => {
        throw new Error("guarded/raw same-goal writers did not settle");
      }),
    ]);
  }

  describe("workset plan lifecycle PostgreSQL faults [T1971]", () => {
    it("serializes guarded and raw same-goal writes in both lock orders", async () => {
      for (const order of ["raw-first", "guarded-first"] as const) {
        const projectKey = `t1971-goal-race-${order}-${randomUUID()}`;
        const writer = await open(projectKey);
        const claim = await seedClaim(writer.store, `pg-goal-race-claim-${order}`);
        const input = publishInput(
          claim,
          `pg-goal-race-publish-${order}`,
          `pg-goal-race-task-${order}`,
        );
        const marker = `pg-goal-race-marker-${order}`;
        const suffix = randomUUID().replaceAll("-", "");
        const functionName = `pause_goal_race_${suffix}`;
        const triggerName = `pause_goal_race_trigger_${suffix}`;
        const triggerCondition =
          order === "raw-first"
            ? `NEW.fields_json LIKE '%${marker}%'`
            : `NEW.fields_json LIKE '%planCurrentDraft%' AND NEW.fields_json NOT LIKE '%${marker}%'`;
        await setupPool.unsafe(`
          CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.project_key = '${projectKey}' AND NEW.ledger = 'goals'
               AND NEW.id = 'G1' AND ${triggerCondition} THEN
              PERFORM pg_sleep(0.25);
            END IF;
            RETURN NEW;
          END
          $$;
          CREATE TRIGGER ${triggerName}
          BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION ${functionName}();
        `);
        try {
          const rawWrite = () =>
            writer.raw.updateItem(GOALS_LEDGER, "G1", {
              fields: { description: marker },
            });
          let first: Promise<unknown>;
          let second: Promise<unknown>;
          if (order === "raw-first") {
            first = rawWrite();
            await Bun.sleep(50);
            second = writer.store.publishPlanDraft(input);
          } else {
            first = writer.store.publishPlanDraft(input);
            await Bun.sleep(50);
            second = rawWrite();
          }
          await settleWithoutDeadlock(Promise.all([first, second]));
        } finally {
          await setupPool.unsafe(`DROP TRIGGER ${triggerName} ON items`);
          await setupPool.unsafe(`DROP FUNCTION ${functionName}()`);
        }

        const restarted = await open(projectKey);
        expect(restarted.store.fetchItem(GOALS_LEDGER, "G1").fields.description).toBe(
          marker,
        );
        expect(
          restarted.store.search(TASKS_LEDGER, `pg-goal-race-task-${order}`),
        ).toHaveLength(1);
      }
    });

    it("statement failure rolls back tenant rows and restart retries as new", async () => {
      const projectKey = `t1971-fault-${randomUUID()}`;
      const mutations: string[] = [];
      const { store } = await open(projectKey, (ledgerId) => mutations.push(ledgerId));
      const claim = await seedClaim(store, "pg-fault-claim");
      const input = publishInput(claim, "pg-fault-publish", "pg-must-rollback");
      const beforeTasks = store.fetch(TASKS_LEDGER).counters.item;
      mutations.length = 0;
      const suffix = randomUUID().replaceAll("-", "");
      const functionName = `fail_plan_task_${suffix}`;
      const triggerName = `fail_plan_task_trigger_${suffix}`;
      await setupPool.unsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.project_key = '${projectKey}' AND NEW.ledger = 'tasks'
             AND NEW.fields_json LIKE '%pg-must-rollback%' THEN
            RAISE EXCEPTION 'injected plan task statement failure';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `);
      try {
        await expect(store.publishPlanDraft(input)).rejects.toThrow(
          "injected plan task statement failure",
        );
      } finally {
        await setupPool.unsafe(`DROP TRIGGER ${triggerName} ON items`);
        await setupPool.unsafe(`DROP FUNCTION ${functionName}()`);
      }
      expect(mutations).toEqual([]);
      expect(store.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
      expect(store.fetchItem(GOALS_LEDGER, "G1").fields[PLAN_CURRENT_DRAFT_FIELD]).toBeUndefined();

      const restarted = await open(projectKey);
      expect(restarted.store.search(TASKS_LEDGER, "pg-must-rollback")).toEqual([]);
      const retried = await restarted.store.publishPlanDraft(input);
      expect(retried).toMatchObject({ ok: true, replayed: false });
      expect(restarted.store.search(TASKS_LEDGER, "pg-must-rollback")).toHaveLength(1);
    });

    it("backend disconnect aborts the transaction without a replay row", async () => {
      const projectKey = `t1971-disconnect-${randomUUID()}`;
      const { store } = await open(projectKey);
      const claim = await seedClaim(store, "pg-disconnect-claim");
      const input = publishInput(
        claim,
        "pg-disconnect-publish",
        "pg-disconnect-must-rollback",
      );
      const suffix = randomUUID().replaceAll("-", "");
      const functionName = `disconnect_plan_task_${suffix}`;
      const triggerName = `disconnect_plan_task_trigger_${suffix}`;
      await setupPool.unsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.project_key = '${projectKey}' AND NEW.ledger = 'tasks'
             AND NEW.fields_json LIKE '%pg-disconnect-must-rollback%' THEN
            PERFORM pg_terminate_backend(pg_backend_pid());
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `);
      try {
        await expect(store.publishPlanDraft(input)).rejects.toThrow();
      } finally {
        await setupPool.unsafe(`DROP TRIGGER ${triggerName} ON items`);
        await setupPool.unsafe(`DROP FUNCTION ${functionName}()`);
      }

      const restarted = await open(projectKey);
      expect(restarted.store.search(TASKS_LEDGER, "pg-disconnect-must-rollback")).toEqual([]);
      const retried = await restarted.store.publishPlanDraft(input);
      expect(retried).toMatchObject({ ok: true, replayed: false });
      expect(
        restarted.store.search(TASKS_LEDGER, "pg-disconnect-must-rollback"),
      ).toHaveLength(1);
    });

    it("serializes same-tenant replacements while preserving tenant isolation", async () => {
      const sharedKey = `t1971-race-${randomUUID()}`;
      const isolatedKey = `t1971-isolated-${randomUUID()}`;
      const first = await open(sharedKey);
      const sharedClaim = await seedClaim(first.store, "pg-race-claim");
      const second = await open(sharedKey);
      const isolated = await open(isolatedKey);
      const isolatedClaim = await seedClaim(isolated.store, "pg-isolated-claim");
      const [left, right, other] = await Promise.all([
        first.store.publishPlanDraft(
          publishInput(sharedClaim, "pg-race-left", "pg-race-left"),
        ),
        second.store.publishPlanDraft(
          publishInput(sharedClaim, "pg-race-right", "pg-race-right"),
        ),
        isolated.store.publishPlanDraft(
          publishInput(isolatedClaim, "pg-isolated", "pg-isolated-other"),
        ),
      ]);
      expect(left).toMatchObject({ ok: true, replayed: false });
      expect(right).toMatchObject({ ok: true, replayed: false });
      expect(other).toMatchObject({ ok: true, replayed: false });

      const sharedRestart = await open(sharedKey);
      const isolatedRestart = await open(isolatedKey);
      const sharedTasks = sharedRestart.store
        .fetch(TASKS_LEDGER)
        .milestones.flatMap(({ items }) => items);
      expect(sharedTasks.map(({ fields }) => fields.headline).sort()).toEqual([
        "pg-race-left",
        "pg-race-right",
      ]);
      expect(sharedTasks.map(({ status }) => status).sort()).toEqual([
        "abandoned",
        "planned",
      ]);
      expect(sharedRestart.store.search(TASKS_LEDGER, "pg-isolated-other")).toEqual([]);
      expect(isolatedRestart.store.search(TASKS_LEDGER, "pg-race")).toEqual([]);
      expect(isolatedRestart.store.search(TASKS_LEDGER, "pg-isolated-other")).toHaveLength(1);
    });
  });
}
