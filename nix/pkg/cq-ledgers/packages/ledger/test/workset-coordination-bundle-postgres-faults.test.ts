import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  ensureSchema,
  GOALS_LEDGER,
  IDEAS_LEDGER,
  MILESTONES_LEDGER,
  openPgPool,
  PLAN_CURRENT_DRAFT_FIELD,
  PostgresLedgerStore,
  startPostgresCoherenceWatcher,
  TASKS_LEDGER,
  worksetMemberRefSet,
  type WorksetOwnedGuardedLedger,
} from "../src/index.js";
import type { ResolvedPostgresHandle } from "../src/store/createLedgerStore.js";

const dsn = process.env.CQ_TEST_PG_URL;
const requirePostgres = process.env.CQ_TEST_REQUIRE_PG === "1";

if (dsn === undefined || dsn.length === 0) {
  if (requirePostgres) {
    throw new Error(
      "CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN",
    );
  }
  describe.skip("workset coordination-bundle PostgreSQL faults [T1966]", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const pgDsn: string = dsn;
  const setupPool = openPgPool(pgDsn);
  const schemaReady = ensureSchema(setupPool);
  const ledgers: WorksetOwnedGuardedLedger[] = [];

  afterAll(async () => {
    for (const ledger of ledgers) await ledger.dispose().catch(() => undefined);
    await setupPool.close();
  });

  async function open(
    projectKey: string,
    onMutation?: (ledgerId: string) => void,
  ): Promise<{
    raw: PostgresLedgerStore;
    ledger: WorksetOwnedGuardedLedger;
    pool: ReturnType<typeof openPgPool>;
  }> {
    await schemaReady;
    const pool = openPgPool(pgDsn);
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
    const ledger = createWorksetOwnedGuardedLedger({
      rawStore: raw,
      worksetStore: raw.worksetStore(),
      invocationAuthority: createTrustedWorksetManagementAuthority(),
      runOwnedTransaction: (mutate) => raw.runAtomicOwnedMutation(mutate),
    });
    ledgers.push(ledger);
    return { raw, ledger, pool };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate();
  }

  describe("workset coordination-bundle PostgreSQL faults [T1966]", () => {
    it("statement failure rolls back the tenant and emits no post-commit hook", async () => {
      const projectKey = `t1966-fault-${randomUUID()}`;
      const mutations: string[] = [];
      const { ledger } = await open(projectKey, (ledgerId) => mutations.push(ledgerId));
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "pg-fault-idea" },
      });
      const { goal } = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "pg-fault-goal", description: "pre-state" },
      });
      mutations.length = 0;
      const beforeMilestones = ledger.fetch(MILESTONES_LEDGER).counters.item;
      const beforeTasks = ledger.fetch(TASKS_LEDGER).counters.item;
      const suffix = randomUUID().replaceAll("-", "");
      const functionName = `fail_owned_task_${suffix}`;
      const triggerName = `fail_owned_task_trigger_${suffix}`;
      await setupPool.unsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.project_key = '${projectKey}' AND NEW.ledger = 'tasks'
             AND NEW.fields_json LIKE '%pg-must-rollback%' THEN
            RAISE EXCEPTION 'injected owned task statement failure';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `);
      try {
        await expect(
          ledger.bundles.publishOwnedDraft({
            goalId: goal.id,
            creationKind: "active-current-draft",
            milestone: { title: "pg-must-rollback" },
            tasks: [{ headline: "pg-must-rollback" }],
          }),
        ).rejects.toThrow("injected owned task statement failure");
      } finally {
        await setupPool.unsafe(`DROP TRIGGER ${triggerName} ON items`);
        await setupPool.unsafe(`DROP FUNCTION ${functionName}()`);
      }
      expect(mutations).toEqual([]);
      expect(ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(beforeMilestones);
      expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
      expect(
        ledger.fetchItem(GOALS_LEDGER, goal.id).fields[PLAN_CURRENT_DRAFT_FIELD],
      ).toBeUndefined();

      const restarted = await open(projectKey);
      expect(restarted.ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(
        beforeMilestones,
      );
      expect(restarted.ledger.search(TASKS_LEDGER, "pg-must-rollback")).toEqual([]);
    });

    it("post-commit NOTIFY invalidates a peer after the complete owned write", async () => {
      const projectKey = `t1966-notify-${randomUUID()}`;
      const writer = await open(projectKey);
      const reader = await open(projectKey);
      let notifications = 0;
      const handle: ResolvedPostgresHandle = {
        pool: reader.pool,
        dsn: pgDsn,
        projectKey,
      };
      const watcher = startPostgresCoherenceWatcher(reader.raw, handle, () => {
        notifications += 1;
      });
      try {
        await waitFor(() => notifications > 0);
        const before = notifications;
        const idea = await writer.ledger.owned.createOwnerless({
          ledgerId: IDEAS_LEDGER,
          status: "open",
          fields: { title: "pg-notify-complete" },
        });
        const converged = await waitFor(() => {
          if (notifications <= before) return false;
          try {
            return reader.raw.fetchItem(IDEAS_LEDGER, idea.id).fields.title ===
              "pg-notify-complete";
          } catch {
            return false;
          }
        });
        expect(converged).toBe(true);
      } finally {
        watcher.close();
      }
    });
  });
}
