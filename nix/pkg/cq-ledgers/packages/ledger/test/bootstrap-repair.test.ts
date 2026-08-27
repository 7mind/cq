import { describe, expect, test } from "bun:test";
import {
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  createInMemoryWorksetStore,
  createWorksetOwnedGuardedLedger,
  derivePredicates,
  type InMemoryLedgerStore,
} from "../src/index.js";
import { inMemoryPlanLifecycleFactory } from "./planLifecycleInMemoryAdapter.js";

const OWNER = "bootstraprepairfencetoken";
const PROVENANCE = { author: "bootstrap-repair", session: "d359" } as const;

describe("guarded bootstrap repair", () => {
  // Regression: D359 — an owned root-caused defect blocking the only active finalized task
  // previously made every advance action false while ordinary follow-up correctly refused it.
  test("root-caused blocker is actionable without superseding its blocked task [Behavioral-Active Blackbox-Group]", async () => {
    const fixture = (await inMemoryPlanLifecycleFactory.build()) as Awaited<
      ReturnType<typeof inMemoryPlanLifecycleFactory.build>
    > & { readonly store: InMemoryLedgerStore };
    const { store } = fixture;
    try {
      await fixture.seedGoal({ goalId: "G1", phase: "building", generation: 1 });
      await fixture.seedWork("G1", {
        taskStatuses: ["blocked"],
        openQuestionCount: 0,
        legacy: false,
      });
      const taskId = (await fixture.observe("G1")).tasks[0]?.id;
      if (taskId === undefined) throw new Error("blocked task fixture was not allocated");
      const defect = await store.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "root-caused",
        fields: {
          headline: "implementation infrastructure rejects the retained authority",
          severity: "high",
          rootCause: "the bootstrap path cannot repair its own implementation blocker",
          suggestedFix: "allocate a separate guarded correction task",
          ledgerRefs: ["goals:G1", `tasks:${taskId}`],
          tags: ["infrastructure"],
        },
        ...PROVENANCE,
      });
      await store.updateItem("tasks", taskId, {
        fields: { blockedBy: [`defects:${defect.id}`] },
        ...PROVENANCE,
      });

      const before = structuredClone(store.snapshot());
      const predicates = derivePredicates(store);
      for (const action of [
        predicates.pInvestigate,
        predicates.pPlan,
        predicates.pResearch,
        predicates.pImplement,
        predicates.pOperatorAction,
      ]) {
        expect(action.value).toBe(false);
      }

      const followUp = await fixture.lifecycle.claimPlan({
        goalId: "G1",
        purpose: "follow-up",
        claimRequestId: "ordinary-follow-up",
        ownerFenceToken: OWNER,
        expectedGeneration: 1,
        ...PROVENANCE,
      });
      expect(followUp).toMatchObject({
        ok: false,
        conflict: {
          code: "implementation-active",
          tasks: [{ taskId, status: "blocked" }],
        },
      });
      expect(store.snapshot()).toEqual(before);

      expect(predicates.pSeed).toEqual({ value: true, items: [defect.id] });
    } finally {
      await fixture.dispose();
    }
  });

  test("repair lineage keeps advance actionable until the blocker is terminal [Behavioral-Active Blackbox-Group]", async () => {
    const fixture = (await inMemoryPlanLifecycleFactory.build()) as Awaited<
      ReturnType<typeof inMemoryPlanLifecycleFactory.build>
    > & { readonly store: InMemoryLedgerStore };
    const { store } = fixture;
    try {
      await fixture.seedGoal({ goalId: "G1", phase: "building", generation: 1 });
      await fixture.seedWork("G1", {
        taskStatuses: ["blocked"],
        openQuestionCount: 0,
        legacy: false,
      });
      const blockedTask = (await fixture.observe("G1")).tasks[0];
      if (blockedTask === undefined) throw new Error("blocked task fixture was not allocated");
      const defect = await store.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "root-caused",
        fields: {
          headline: "implementation infrastructure blocker",
          severity: "high",
          rootCause: "the active implementation cannot repair its own bootstrap",
          ledgerRefs: ["goals:G1", `tasks:${blockedTask.id}`],
        },
        ...PROVENANCE,
      });
      await store.updateItem(TASKS_LEDGER, blockedTask.id, {
        fields: { blockedBy: [`defects:${defect.id}`] },
        ...PROVENANCE,
      });
      const preservedGoal = structuredClone(store.fetchItem(GOALS_LEDGER, "G1"));
      const preservedTask = structuredClone(store.fetchItem(TASKS_LEDGER, blockedTask.id));

      const worksetStore = createInMemoryWorksetStore({
        isTargetAdmitted: () => true,
      });
      const guarded = createWorksetOwnedGuardedLedger({
        rawStore: store,
        worksetStore,
        runOwnedTransaction: async (mutate) => await store.runAtomicOwnedMutation(mutate),
      });
      const { goal: repairGoal } = await guarded.bundles.bootstrapDefectToFixGoal({
        defectId: defect.id,
        goal: {
          title: "bootstrap repair",
          description: "correct the infrastructure defect",
          status: "planning",
          fields: { sourceRefs: [`defects:${defect.id}`] },
          ...PROVENANCE,
        },
      });
      let predicates = derivePredicates(store);
      expect(predicates.pSeed).toEqual({ value: false, items: [] });
      expect(predicates.pPlan.items).toEqual([repairGoal.id]);

      await store.updateItem(GOALS_LEDGER, repairGoal.id, {
        status: "abandoned",
        ...PROVENANCE,
      });
      predicates = derivePredicates(store);
      expect(predicates.pSeed).toEqual({ value: true, items: [defect.id] });

      await store.updateItem(DEFECTS_LEDGER, defect.id, {
        status: "resolved",
        ...PROVENANCE,
      });
      predicates = derivePredicates(store);
      expect(predicates.pSeed).toEqual({ value: false, items: [] });
      expect(predicates.pPlan).toEqual({ value: false, items: [] });
      expect(predicates.pImplement).toEqual({ value: false, items: [] });
      expect(store.fetchItem(GOALS_LEDGER, "G1")).toEqual(preservedGoal);
      expect(store.fetchItem(TASKS_LEDGER, blockedTask.id)).toEqual(preservedTask);
    } finally {
      await fixture.dispose();
    }
  });

  test("multiple active tasks keep ordinary implementation readiness unchanged [Behavioral-Active Blackbox-Group]", async () => {
    const fixture = (await inMemoryPlanLifecycleFactory.build()) as Awaited<
      ReturnType<typeof inMemoryPlanLifecycleFactory.build>
    > & { readonly store: InMemoryLedgerStore };
    const { store } = fixture;
    try {
      await fixture.seedGoal({ goalId: "G1", phase: "building", generation: 1 });
      await fixture.seedWork("G1", {
        taskStatuses: ["blocked", "planned"],
        openQuestionCount: 0,
        legacy: false,
      });
      const [blocked, ordinary] = (await fixture.observe("G1")).tasks;
      if (blocked === undefined || ordinary === undefined) {
        throw new Error("multiple-task fixture was not allocated");
      }
      const defect = await store.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "root-caused",
        fields: {
          headline: "one task is blocked",
          severity: "high",
          rootCause: "a local implementation defect",
          ledgerRefs: ["goals:G1", `tasks:${blocked.id}`],
        },
        ...PROVENANCE,
      });
      await store.updateItem(TASKS_LEDGER, blocked.id, {
        fields: { blockedBy: [`defects:${defect.id}`] },
        ...PROVENANCE,
      });
      await store.updateItem(TASKS_LEDGER, ordinary.id, {
        fields: { dependsOn: [] },
        ...PROVENANCE,
      });

      const predicates = derivePredicates(store);
      expect(predicates.pSeed).toEqual({ value: false, items: [] });
      expect(predicates.pImplement).toEqual({ value: true, items: [ordinary.id] });
    } finally {
      await fixture.dispose();
    }
  });
});
