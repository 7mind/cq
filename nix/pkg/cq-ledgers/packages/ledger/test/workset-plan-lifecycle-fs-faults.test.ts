import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetGuardedPlanLifecycleStore,
  FsLedgerStore,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  PLAN_CURRENT_DRAFT_FIELD,
  TASKS_LEDGER,
  worksetMemberRefSet,
  type FsLedgerStoreOpts,
  type PlanPublishDraftInput,
  type WorksetGuardedPlanLifecycleStore,
} from "../src/index.js";
import { atomicWrite } from "../src/store/fsAtomic.js";

const roots: string[] = [];
const stores: WorksetGuardedPlanLifecycleStore[] = [];
const provenance = { author: "T1968", session: "T1968-fault" } as const;

afterAll(async () => {
  for (const store of stores) await store.dispose().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function open(
  root: string,
  options: Omit<FsLedgerStoreOpts, "root"> = {},
): Promise<WorksetGuardedPlanLifecycleStore> {
  const rawStore = new FsLedgerStore({ root, ...options });
  const worksetStore = rawStore.createWorksetStore({
    isTargetAdmitted: (target, selectedRoots) => {
      if (selectedRoots.length === 0) return true;
      const graph = closeWorkset(
        selectedRoots,
        buildActiveStateFromLedgerStore(rawStore),
      );
      return worksetMemberRefSet(graph).has(target) || graph.inactiveRoots.includes(target);
    },
  });
  const store = createWorksetGuardedPlanLifecycleStore({
    rawStore,
    worksetStore,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate) => rawStore.runAtomicOwnedMutation(mutate),
    runPlanLifecycleTransaction: (mutate) =>
      rawStore.runAtomicWorksetPlanLifecycleMutation(mutate),
  });
  await store.init();
  stores.push(store);
  return store;
}

describe("workset plan lifecycle filesystem faults [T1968]", () => {
  it("failed lifecycle persistence restarts at the prestate and retries as new", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workset-plan-fs-fault-"));
    roots.push(root);
    let armed = false;
    let writes = 0;
    const store = await open(root, {
      atomicWrite: async (filePath, text) => {
        if (armed && ++writes === 3) {
          throw new Error("injected guarded plan write failure");
        }
        await atomicWrite(filePath, text);
      },
    });
    await store.owned.createOwnerless({
      ledgerId: GOALS_LEDGER,
      milestoneId: MILESTONES_AMBIENT_ID,
      id: "G1",
      status: "clarifying",
      fields: { title: "fault goal", description: "prestate" },
      ...provenance,
    });
    const claimed = await store.claimPlan({
      goalId: "G1",
      purpose: "initial",
      claimRequestId: "claim-fault",
      ownerFenceToken: "a".repeat(22),
      expectedGeneration: null,
      ...provenance,
    });
    if (!claimed.ok) throw new Error(`claim failed: ${claimed.conflict.code}`);
    const publishInput: PlanPublishDraftInput = {
      goalId: "G1",
      claimId: claimed.acknowledgement.claimId,
      generation: claimed.acknowledgement.generation,
      operationId: "publish-fault",
      ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
      manifest: {
        milestones: [{ key: "delivery", title: "Must rollback" }],
        tasks: [{ key: "task", milestoneKey: "delivery", headline: "Must rollback" }],
      },
      ...provenance,
    };
    const beforeTasks = store.fetch(TASKS_LEDGER).counters.item;

    armed = true;
    await expect(store.publishPlanDraft(publishInput)).rejects.toThrow(
      "injected guarded plan write failure",
    );
    armed = false;
    expect(store.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
    expect(
      store.fetchItem(GOALS_LEDGER, "G1").fields[PLAN_CURRENT_DRAFT_FIELD],
    ).toBeUndefined();

    const restarted = await open(root);
    expect(restarted.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
    expect(restarted.search(TASKS_LEDGER, "Must rollback")).toEqual([]);
    expect(
      restarted.fetchItem(GOALS_LEDGER, "G1").fields[PLAN_CURRENT_DRAFT_FIELD],
    ).toBeUndefined();
    const retried = await restarted.publishPlanDraft(publishInput);
    expect(retried).toMatchObject({ ok: true, replayed: false });
    if (!retried.ok) throw new Error(`retry failed: ${retried.conflict.code}`);
    expect(retried.acknowledgement.manifest.tasks).toHaveLength(1);
    expect(restarted.search(TASKS_LEDGER, "Must rollback")).toHaveLength(1);
  });
});
