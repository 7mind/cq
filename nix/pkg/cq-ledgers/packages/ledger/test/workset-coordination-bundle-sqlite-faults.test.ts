import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  GOALS_LEDGER,
  IDEAS_LEDGER,
  MILESTONES_LEDGER,
  PLAN_CURRENT_DRAFT_FIELD,
  SqliteLedgerStore,
  TASKS_LEDGER,
  worksetMemberRefSet,
  type WorksetOwnedGuardedLedger,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const roots: string[] = [];
const ledgers: WorksetOwnedGuardedLedger[] = [];

afterAll(async () => {
  for (const ledger of ledgers) await ledger.dispose().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function freshDbPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "owned-write-sqlite-fault-"));
  roots.push(root);
  return path.join(root, "ledger.db");
}

async function open(
  dbPath: string,
): Promise<{ raw: SqliteLedgerStore; ledger: WorksetOwnedGuardedLedger }> {
  const raw = new SqliteLedgerStore({
    dbPath,
    workset: {
      isTargetAdmitted: (target, selectedRoots) => {
        if (selectedRoots.length === 0) return true;
        const graph = closeWorkset(
          selectedRoots,
          buildActiveStateFromLedgerStore(raw),
        );
        return worksetMemberRefSet(graph).has(target) || graph.inactiveRoots.includes(target);
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
  return { raw, ledger };
}

describe("workset coordination-bundle SQLite faults [T1965]", () => {
  it("statement failure rolls back rows, counters, manifests, and restart state", async () => {
    const dbPath = await freshDbPath();
    const { ledger } = await open(dbPath);
    const idea = await ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "sqlite-fault-idea" },
    });
    const { goal } = await ledger.bundles.bootstrapIdeaToGoal({
      ideaId: idea.id,
      goal: { title: "sqlite-fault-goal", description: "pre-state" },
    });
    const beforeMilestones = ledger.fetch(MILESTONES_LEDGER).counters.item;
    const beforeTasks = ledger.fetch(TASKS_LEDGER).counters.item;
    const injector = openLedgerDb(dbPath);
    injector.exec(`
      CREATE TRIGGER fail_owned_task_insert
      BEFORE INSERT ON items
      WHEN NEW.ledger = 'tasks' AND json_extract(NEW.fields_json, '$.headline') = 'sqlite-must-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'injected owned task statement failure');
      END
    `);
    injector.close();

    await expect(
      ledger.bundles.publishOwnedDraft({
        goalId: goal.id,
        creationKind: "active-current-draft",
        milestone: { title: "sqlite-must-rollback" },
        tasks: [{ headline: "sqlite-must-rollback" }],
      }),
    ).rejects.toThrow("injected owned task statement failure");
    expect(ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(beforeMilestones);
    expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
    expect(
      ledger.fetchItem(GOALS_LEDGER, goal.id).fields[PLAN_CURRENT_DRAFT_FIELD],
    ).toBeUndefined();
    expect(
      (await ledger.ftsSearch("sqlite-must-rollback")).some(
        (hit) =>
          hit.item.fields.headline === "sqlite-must-rollback" ||
          hit.item.fields.title === "sqlite-must-rollback",
      ),
    ).toBe(false);

    const cleanup = openLedgerDb(dbPath);
    cleanup.exec("DROP TRIGGER fail_owned_task_insert");
    cleanup.close();
    const restarted = await open(dbPath);
    expect(restarted.ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(beforeMilestones);
    expect(restarted.ledger.search(TASKS_LEDGER, "sqlite-must-rollback")).toEqual([]);
  });

  it("peer commit remains complete and enters the derived index after invalidation", async () => {
    const dbPath = await freshDbPath();
    const writer = await open(dbPath);
    const reader = await open(dbPath);
    const idea = await writer.ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "sqlite-peer-visible" },
    });
    expect(reader.raw.fetchItem(IDEAS_LEDGER, idea.id).fields.title).toBe(
      "sqlite-peer-visible",
    );
    expect(await reader.raw.ftsSearch("sqlite-peer-visible")).toEqual([]);
    await reader.raw.invalidate(IDEAS_LEDGER);
    expect((await reader.raw.ftsSearch("sqlite-peer-visible")).map((hit) => hit.item.id)).toEqual([
      idea.id,
    ]);
  });
});
