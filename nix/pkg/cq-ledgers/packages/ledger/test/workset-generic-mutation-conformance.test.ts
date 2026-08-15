import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TASKS_LEDGER,
  WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES,
  WORKSET_GENERIC_MUTATION_OPERATION_KINDS,
  WorksetGenericMutationError,
  createInMemoryWorksetManagementLedger,
} from "../src/index.js";

describe("T1988 generic mutation conformance [Behavioral-Active Blackbox-Atomic]", () => {
  test("classifies every ordinary operation exactly once", () => {
    expect(WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES.map(({ kind }) => kind)).toEqual(
      [...WORKSET_GENERIC_MUTATION_OPERATION_KINDS],
    );
    expect(new Set(WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES.map(({ method }) => method)).size)
      .toBe(WORKSET_GENERIC_MUTATION_OPERATION_KINDS.length);
  });

  test("recovers only an exact inactive root and preserves its archived sibling", async () => {
    const ledger = createInMemoryWorksetManagementLedger();
    await ledger.init();
    try {
      const milestone = await ledger.mutations.createMilestone({ title: "inactive recovery" });
      const selected = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "selected archived task" },
      });
      const sibling = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "sibling archived task" },
      });
      await ledger.mutations.updateItem(TASKS_LEDGER, selected.id, { status: "done" });
      await ledger.mutations.updateItem(TASKS_LEDGER, sibling.id, { status: "done" });
      await ledger.mutations.updateMilestone(milestone.id, { status: "done" });
      await ledger.mutations.archiveMilestone(milestone.id, "complete");

      await ledger.setRoots([`${TASKS_LEDGER}:${selected.id}`]);
      const before = await ledger.snapshotRoots();
      const restored = await ledger.mutations.unarchiveItem(
        TASKS_LEDGER,
        milestone.id,
        selected.id,
      );
      expect(restored.id).toBe(selected.id);
      await expect(
        ledger.mutations.unarchiveItem(TASKS_LEDGER, milestone.id, sibling.id),
      ).rejects.toBeInstanceOf(WorksetGenericMutationError);
      expect(await ledger.snapshotRoots()).toEqual(before);
      expect(ledger.fetchItem(TASKS_LEDGER, selected.id).id).toBe(selected.id);
      expect(() => ledger.fetchItem(TASKS_LEDGER, sibling.id)).toThrow();
      expect(ledger.activeAdmissionCount()).toBe(0);
    } finally {
      await ledger.dispose();
    }
  });
});

describe("T1988 durable generic shared-contract registration [Contract-Active Whitebox-Atomic]", () => {
  test("keeps the unchanged shared runner registered for every durable backend", async () => {
    for (const backend of ["fs", "git", "sqlite", "postgres"] as const) {
      const source = await readFile(
        join(import.meta.dir, `workset-generic-mutation-${backend}.test.ts`),
        "utf8",
      );
      expect(source, backend).toContain("runWorksetGenericMutationContract");
    }
  });
});
