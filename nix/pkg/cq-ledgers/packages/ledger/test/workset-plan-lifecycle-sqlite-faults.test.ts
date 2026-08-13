import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetGuardedPlanLifecycleStore,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  PLAN_CURRENT_DRAFT_FIELD,
  SqliteLedgerStore,
  TASKS_LEDGER,
  worksetMemberRefSet,
  type PlanClaimAcknowledgement,
  type PlanPublishDraftInput,
  type WorksetGuardedPlanLifecycleStore,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const roots: string[] = [];
const stores: WorksetGuardedPlanLifecycleStore[] = [];
const provenance = { author: "T1970", session: "T1970-fault" } as const;

afterAll(async () => {
  for (const store of stores) await store.dispose().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function freshDbPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "workset-plan-sqlite-fault-"));
  roots.push(root);
  return path.join(root, "ledger.db");
}

async function open(
  dbPath: string,
  onMutation?: (ledgerId: string) => void,
): Promise<{ raw: SqliteLedgerStore; store: WorksetGuardedPlanLifecycleStore }> {
  const raw = new SqliteLedgerStore({
    dbPath,
    ...(onMutation !== undefined ? { onMutation } : {}),
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
  const store = createWorksetGuardedPlanLifecycleStore({
    rawStore: raw,
    worksetStore: raw.worksetStore(),
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate) => raw.runAtomicOwnedMutation(mutate),
    runPlanLifecycleTransaction: (mutate) =>
      raw.runAtomicWorksetPlanLifecycleMutation(mutate),
  });
  stores.push(store);
  return { raw, store };
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
    fields: { title: "sqlite lifecycle goal", description: "prestate" },
    ...provenance,
  });
  const claimed = await store.claimPlan({
    goalId: "G1",
    purpose: "initial",
    claimRequestId: requestId,
    ownerFenceToken: "s".repeat(22),
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

describe("workset plan lifecycle SQLite faults [T1970]", () => {
  it("statement failure rolls back lifecycle rows, effects, and restart state", async () => {
    const dbPath = await freshDbPath();
    const mutations: string[] = [];
    const { store } = await open(dbPath, (ledgerId) => mutations.push(ledgerId));
    const claim = await seedClaim(store, "sqlite-fault-claim");
    const input = publishInput(claim, "sqlite-fault-publish", "sqlite-must-rollback");
    const beforeTasks = store.fetch(TASKS_LEDGER).counters.item;
    mutations.length = 0;
    const injector = openLedgerDb(dbPath);
    injector.exec(`
      CREATE TRIGGER fail_plan_task_insert
      BEFORE INSERT ON items
      WHEN NEW.ledger = 'tasks' AND json_extract(NEW.fields_json, '$.headline') = 'sqlite-must-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'injected plan task statement failure');
      END
    `);
    injector.close();

    await expect(store.publishPlanDraft(input)).rejects.toThrow(
      "injected plan task statement failure",
    );
    expect(mutations).toEqual([]);
    expect(store.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
    expect(store.fetchItem(GOALS_LEDGER, "G1").fields[PLAN_CURRENT_DRAFT_FIELD]).toBeUndefined();

    const cleanup = openLedgerDb(dbPath);
    cleanup.exec("DROP TRIGGER fail_plan_task_insert");
    cleanup.close();
    const restarted = await open(dbPath);
    expect(restarted.store.search(TASKS_LEDGER, "sqlite-must-rollback")).toEqual([]);
    const retried = await restarted.store.publishPlanDraft(input);
    expect(retried).toMatchObject({ ok: true, replayed: false });
    expect(restarted.store.search(TASKS_LEDGER, "sqlite-must-rollback")).toHaveLength(1);
  });

  it("BEGIN IMMEDIATE serializes competing lifecycle replacements without partial state", async () => {
    const dbPath = await freshDbPath();
    const first = await open(dbPath);
    const claim = await seedClaim(first.store, "sqlite-race-claim");
    const second = await open(dbPath);
    const [left, right] = await Promise.all([
      first.store.publishPlanDraft(
        publishInput(claim, "sqlite-race-left", "sqlite-race-left"),
      ),
      second.store.publishPlanDraft(
        publishInput(claim, "sqlite-race-right", "sqlite-race-right"),
      ),
    ]);
    expect(left).toMatchObject({ ok: true, replayed: false });
    expect(right).toMatchObject({ ok: true, replayed: false });

    const restarted = await open(dbPath);
    const tasks = restarted.store.fetch(TASKS_LEDGER).milestones.flatMap(({ items }) => items);
    expect(tasks.map(({ fields }) => fields.headline).sort()).toEqual([
      "sqlite-race-left",
      "sqlite-race-right",
    ]);
    expect(tasks.map(({ status }) => status).sort()).toEqual(["abandoned", "planned"]);
    const current = JSON.parse(
      restarted.store.fetchItem(GOALS_LEDGER, "G1").fields[
        PLAN_CURRENT_DRAFT_FIELD
      ] as string,
    ) as { manifest: { tasks: { id: string }[] } };
    expect(tasks.find(({ status }) => status === "planned")?.id).toBe(
      current.manifest.tasks[0]?.id,
    );
    expect(
      (await restarted.store.ftsSearch("sqlite-race")).filter(
        ({ item }) => item.fields.headline !== undefined,
      ),
    ).toHaveLength(2);
  });
});
