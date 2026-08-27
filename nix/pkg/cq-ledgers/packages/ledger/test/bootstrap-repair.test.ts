import { describe, expect, test } from "bun:test";
import {
  DEFECTS_LEDGER,
  MILESTONES_AMBIENT_ID,
  derivePredicates,
  type DerivedPredicates,
  type InMemoryLedgerStore,
} from "../src/index.js";
import { inMemoryPlanLifecycleFactory } from "./planLifecycleInMemoryAdapter.js";

const OWNER = "bootstraprepairfencetoken";
const PROVENANCE = { author: "bootstrap-repair", session: "d359" } as const;

type RepairPredicates = DerivedPredicates & {
  readonly pBootstrapRepair: { readonly value: boolean; readonly items: readonly string[] };
};

describe("guarded bootstrap repair", () => {
  // Regression: D359 — an owned root-caused defect blocking the only active finalized task
  // previously made every advance action false while ordinary follow-up correctly refused it.
  test("root-caused blocker is actionable without superseding its blocked task [Behavioral-Active Blackbox-Group]", async () => {
    const fixture = await inMemoryPlanLifecycleFactory.build();
    const store = fixture.store as InMemoryLedgerStore;
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
      const predicates = derivePredicates(store) as RepairPredicates;
      for (const action of [
        predicates.pInvestigate,
        predicates.pSeed,
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

      expect(predicates.pBootstrapRepair).toEqual({ value: true, items: [defect.id] });
    } finally {
      await fixture.dispose();
    }
  });
});
