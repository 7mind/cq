import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  FsLedgerStore,
  GOALS_LEDGER,
  IDEAS_LEDGER,
  MILESTONES_LEDGER,
  PLAN_CURRENT_DRAFT_FIELD,
  TASKS_LEDGER,
  worksetMemberRefSet,
  type FsLedgerStoreOpts,
  type WorksetOwnedGuardedLedger,
} from "../src/index.js";
import { atomicWrite } from "../src/store/fsAtomic.js";

const roots: string[] = [];
const ledgers: WorksetOwnedGuardedLedger[] = [];

afterAll(async () => {
  for (const ledger of ledgers) await ledger.dispose().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function open(
  root: string,
  options: Omit<FsLedgerStoreOpts, "root"> = {},
): Promise<{ raw: FsLedgerStore; ledger: WorksetOwnedGuardedLedger }> {
  const raw = new FsLedgerStore({ root, ...options });
  const worksetStore = raw.createWorksetStore({
    isTargetAdmitted: (target, selectedRoots) => {
      if (selectedRoots.length === 0) return true;
      const graph = closeWorkset(
        selectedRoots,
        buildActiveStateFromLedgerStore(raw),
      );
      return worksetMemberRefSet(graph).has(target) || graph.inactiveRoots.includes(target);
    },
  });
  const ledger = createWorksetOwnedGuardedLedger({
    rawStore: raw,
    worksetStore,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate) => raw.runAtomicOwnedMutation(mutate),
  });
  await ledger.init();
  ledgers.push(ledger);
  return { raw, ledger };
}

describe("workset coordination-bundle filesystem faults [T1963]", () => {
  it("write failure rolls the complete bundle back and restart preserves the prior graph", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "owned-write-fs-fault-"));
    roots.push(root);
    let armed = false;
    let writeCount = 0;
    const { ledger } = await open(root, {
      atomicWrite: async (filePath, text) => {
        if (armed && ++writeCount === 3) throw new Error("injected owned bundle write failure");
        await atomicWrite(filePath, text);
      },
    });
    const idea = await ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "fs-fault-idea" },
    });
    const { goal } = await ledger.bundles.bootstrapIdeaToGoal({
      ideaId: idea.id,
      goal: { title: "fs-fault-goal", description: "pre-state" },
    });
    const beforeMilestones = ledger.fetch(MILESTONES_LEDGER).counters.item;
    const beforeTasks = ledger.fetch(TASKS_LEDGER).counters.item;

    armed = true;
    await expect(
      ledger.bundles.publishOwnedDraft({
        goalId: goal.id,
        creationKind: "active-current-draft",
        milestone: { title: "must-rollback" },
        tasks: [{ headline: "must-rollback" }],
      }),
    ).rejects.toThrow("injected owned bundle write failure");
    armed = false;
    expect(ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(beforeMilestones);
    expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
    expect(
      ledger.fetchItem(GOALS_LEDGER, goal.id).fields[PLAN_CURRENT_DRAFT_FIELD],
    ).toBeUndefined();

    const restarted = await open(root);
    expect(restarted.ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(beforeMilestones);
    expect(restarted.ledger.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
    expect(restarted.ledger.search(TASKS_LEDGER, "must-rollback")).toEqual([]);
  });

  it("two store instances serialize ownerless allocation without losing either write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "owned-write-fs-race-"));
    roots.push(root);
    const first = await open(root);
    const second = await open(root);
    const [left, right] = await Promise.all([
      first.ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "fs-race-left" },
      }),
      second.ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "fs-race-right" },
      }),
    ]);
    expect(left.id).not.toBe(right.id);
    await first.raw.invalidate(IDEAS_LEDGER);
    expect(first.raw.search(IDEAS_LEDGER, "fs-race-").map((item) => item.id).sort()).toEqual(
      [left.id, right.id].sort(),
    );
  });
});
