import { describe, expect, test } from "bun:test";
import type { LedgerStore } from "../src/store/LedgerStore.js";
import type { DirectOwnedMutation, DirectOwnedWriteTx } from "../src/store/directOwnedMutation.js";

export function cohortCompletionTransactionContract(label: string, create: () => Promise<{
  store: LedgerStore;
  dispose(): Promise<void>;
}>): void {
  describe(`atomic cohort completion transaction ${label}`, () => {
    test("admits every exact member binding and rolls all of them back on failure [Behavioral-Active Blackbox]", async () => {
      const fixture = await create();
      try {
        const milestone = await fixture.store.createMilestone({ title: "cohort transaction" });
        for (const id of ["T1", "T2"]) await fixture.store.createItem("tasks", milestone.id, {
          id, status: "wip", fields: { headline: id },
        });
        const operation = { direct: { kind: "cohort-completion", operatorSettlement: null, members: ["T1", "T2"].map((taskId) => ({
          kind: "implementation-completion", taskId, ownerGoalId: "G1",
          reviewInit: { status: "go-ahead", fields: { summary: taskId } },
          taskPatch: { fields: { completion: "cohort transaction" } },
          defectPatch: { status: "resolved", fields: { fix: "cohort transaction" } },
        })), sweep: { archiveCompletedMembers: false, terminalItems: [], milestones: [], summary: "cohort" }, fence: null } } as DirectOwnedMutation;
        const store = fixture.store as LedgerStore & {
          runAtomicOwnedMutation<T>(mutate: (tx: DirectOwnedWriteTx) => T, context: DirectOwnedMutation): Promise<T>;
        };
        await store.runAtomicOwnedMutation((tx) => {
          expect(tx.fetchImplementationCompletionBinding("T1")).toBeUndefined();
          expect(tx.fetchImplementationCompletionBinding("T2")).toBeUndefined();
          expect(() => tx.fetchImplementationCompletionBinding("T3")).toThrow("exact protected operation");
        }, operation);
        await expect(store.runAtomicOwnedMutation((tx) => {
          tx.bindImplementationCompletionReview("T1", "reviews:R1");
          tx.bindImplementationCompletionReview("T2", "reviews:R2");
          throw new Error("abort whole cohort");
        }, operation)).rejects.toThrow("abort whole cohort");
        await store.runAtomicOwnedMutation((tx) => {
          expect(tx.fetchImplementationCompletionBinding("T1")).toBeUndefined();
          expect(tx.fetchImplementationCompletionBinding("T2")).toBeUndefined();
        }, operation);
      } finally { await fixture.dispose(); }
    });
  });
}
