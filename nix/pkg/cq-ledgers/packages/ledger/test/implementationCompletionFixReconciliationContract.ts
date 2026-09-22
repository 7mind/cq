import { describe, expect, test } from "bun:test";
import {
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  recordProtectedImplementationCompletion,
  type LedgerStore,
} from "../src/index.js";
import {
  DIRECT_TASK_AUTHORITY,
  directCompletionRecord,
} from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

export interface FixReconciliationFixture {
  readonly store: LedgerStore;
  dispose(): Promise<void>;
}

export type FixReconciliationFixtureFactory = () => Promise<FixReconciliationFixture>;

async function seed(store: LedgerStore): Promise<void> {
  const milestone = await store.createMilestone({ title: "completion fix reconciliation" });
  await store.createItem(GOALS_LEDGER, milestone.id, {
    id: "G1",
    status: "building",
    fields: { title: "implementation", description: "implementation" },
  });
  await store.createItem(TASKS_LEDGER, milestone.id, {
    id: "T2345",
    status: "wip",
    fields: {
      headline: "completing fix",
      ledgerRefs: [
        "defects:D1",
        "defects:D2",
        "defects:D3",
        "defects:D4",
        "defects:D5",
        "defects:D6",
        "defects:D7",
        "defects:D8",
      ],
    },
  });
  for (const [id, status, refs] of [
    ["T1", "planned", ["defects:D1"]],
    ["T2", "wip", ["defects:D2"]],
    ["T3", "blocked", ["defects:D3"]],
    ["T4", "abandoned", ["defects:D4"]],
    ["T5", "done", ["defects:D5", "defects:D6"]],
    ["T6", "done", []],
  ] as const) {
    await store.createItem(TASKS_LEDGER, milestone.id, {
      id,
      status,
      fields: { headline: id, ...(refs.length === 0 ? {} : { ledgerRefs: [...refs] }) },
    });
  }
  await store.createItem(TASKS_LEDGER, milestone.id, {
    id: "T7",
    status: "wip",
    fields: { headline: "advisory only", sourceRefs: ["defects:D7"] },
  });
  const defects: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["D1", []],
    ["D2", []],
    ["D3", []],
    ["D4", []],
    ["D5", ["tasks:T2345", "tasks:T5"]],
    ["D6", ["T2345", "T6"]],
    ["D7", ["tasks:T2345"]],
    ["D8", ["tasks:T2345", "tasks:T5"]],
  ];
  for (const [id, dependsOn] of defects) {
    await store.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
      id,
      status: "root-caused",
      fields: {
        headline: id,
        severity: "high",
        ...(dependsOn.length === 0 ? {} : { dependsOn: [...dependsOn] }),
      },
    });
  }
  await store.updateItem(TASKS_LEDGER, "T5", {
    fields: { ledgerRefs: ["defects:D5", "defects:D6", "defects:D8"] },
  });
}

async function complete(store: LedgerStore): Promise<{ readonly reviewRef: string }> {
  return await recordProtectedImplementationCompletion(
    store,
    DIRECT_TASK_AUTHORITY,
    await directCompletionRecord(),
    LIFECYCLE_PROVENANCE,
  );
}

async function seedRelationshipShapes(store: LedgerStore): Promise<void> {
  const milestone = await store.createMilestone({ title: "completion relationship shapes" });
  await store.createItem(GOALS_LEDGER, milestone.id, {
    id: "G1",
    status: "building",
    fields: { title: "implementation", description: "implementation" },
  });
  await store.createItem(TASKS_LEDGER, milestone.id, {
    id: "T2345",
    status: "wip",
    fields: {
      headline: "completing fix",
      ledgerRefs: ["defects:D1", "defects:D2", "defects:D3", "defects:D4"],
    },
  });
  for (const [id, refs, sourceRefs] of [
    ["T1", [], []],
    ["T2", ["defects:D2"], []],
    ["T3", ["defects:D3"], []],
    ["T4", [], []],
    ["T5", [], ["defects:D4"]],
    ["T6", ["defects:D5"], []],
  ] as const) {
    await store.createItem(TASKS_LEDGER, milestone.id, {
      id,
      status: id === "T5" || id === "T6" ? "wip" : "done",
      fields: {
        headline: id,
        ...(refs.length === 0 ? {} : { ledgerRefs: [...refs] }),
        ...(sourceRefs.length === 0 ? {} : { sourceRefs: [...sourceRefs] }),
      },
    });
  }
  for (const [id, dependsOn] of [
    ["D1", ["tasks:T2345", "tasks:T1"]],
    ["D2", []],
    ["D3", ["T2345", "T4"]],
    ["D4", ["tasks:T2345", "malformed-ref"]],
    ["D5", ["tasks:T6"]],
  ] as const) {
    await store.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
      id,
      status: "root-caused",
      fields: {
        headline: id,
        severity: "high",
        ...(dependsOn.length === 0 ? {} : { dependsOn: [...dependsOn] }),
      },
    });
  }
}

async function seedIncompleteStatuses(store: LedgerStore): Promise<void> {
  const milestone = await store.createMilestone({ title: "completion incomplete statuses" });
  await store.createItem(GOALS_LEDGER, milestone.id, {
    id: "G1",
    status: "building",
    fields: { title: "implementation", description: "implementation" },
  });
  const cases = [
    ["D1", "T1", "planned"],
    ["D2", "T2", "wip"],
    ["D3", "T3", "blocked"],
    ["D4", "T4", "abandoned"],
  ] as const;
  await store.createItem(TASKS_LEDGER, milestone.id, {
    id: "T2345",
    status: "wip",
    fields: {
      headline: "completing fix",
      ledgerRefs: [...cases.map(([defectId]) => `defects:${defectId}`), "defects:D5"],
    },
  });
  for (const [defectId, taskId, status] of cases) {
    await store.createItem(TASKS_LEDGER, milestone.id, {
      id: taskId,
      status,
      fields: { headline: taskId },
    });
    await store.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: defectId,
      status: "root-caused",
      fields: {
        headline: defectId,
        severity: "high",
        dependsOn: ["tasks:T2345", `tasks:${taskId}`],
      },
    });
  }
  const archivedMilestone = await store.createMilestone({ title: "archived required fix" });
  await store.createItem(TASKS_LEDGER, archivedMilestone.id, {
    id: "T404",
    status: "done",
    fields: { headline: "archived required fix" },
  });
  await store.updateMilestone(archivedMilestone.id, { status: "done" });
  await store.archiveMilestone(archivedMilestone.id, "archived required fix");
  await store.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "D5",
    status: "root-caused",
    fields: {
      headline: "missing required fix",
      severity: "high",
      dependsOn: ["tasks:T2345", "tasks:T404"],
    },
  });
}

export function runImplementationCompletionFixReconciliationContract(
  name: string,
  build: FixReconciliationFixtureFactory,
): void {
  describe(`implementation completion fix reconciliation — ${name} [Behavioral-Active Blackbox-Atomic]`, () => {
    test("reconciles forward-only, reverse-only, combined, canonical, and legacy fix links", async () => {
      const fixture = await build();
      try {
        await seedRelationshipShapes(fixture.store);
        await expect(complete(fixture.store)).resolves.toEqual({ reviewRef: "reviews:R1" });
        expect(Object.fromEntries(["D1", "D2", "D3", "D4", "D5"].map((id) => [
          id,
          fixture.store.fetchItem(DEFECTS_LEDGER, id).status,
        ]))).toEqual({
          D1: "resolved",
          D2: "resolved",
          D3: "resolved",
          D4: "resolved",
          D5: "root-caused",
        });
      } finally {
        await fixture.dispose();
      }
    });

    test("retains every non-done and missing required fix task", async () => {
      const fixture = await build();
      try {
        await seedIncompleteStatuses(fixture.store);
        await complete(fixture.store);
        expect(Object.fromEntries(["D1", "D2", "D3", "D4", "D5"].map((id) => [
          id,
          fixture.store.fetchItem(DEFECTS_LEDGER, id).status,
        ]))).toEqual({
          D1: "root-caused",
          D2: "root-caused",
          D3: "root-caused",
          D4: "root-caused",
          D5: "root-caused",
        });
      } finally {
        await fixture.dispose();
      }
    });

    test("uses the complete forward/reverse union and treats sourceRefs as advisory", async () => {
      const fixture = await build();
      try {
        await seed(fixture.store);
        const completion = await directCompletionRecord();
        const first = await recordProtectedImplementationCompletion(
          fixture.store,
          DIRECT_TASK_AUTHORITY,
          completion,
          LIFECYCLE_PROVENANCE,
        );
        expect(fixture.store.fetchItem(TASKS_LEDGER, "T2345").status).toBe("done");
        expect(Object.fromEntries(["D1", "D2", "D3", "D4"].map((id) => [
          id,
          fixture.store.fetchItem(DEFECTS_LEDGER, id).status,
        ]))).toEqual({ D1: "root-caused", D2: "root-caused", D3: "root-caused", D4: "root-caused" });
        expect(fixture.store.fetchItem(DEFECTS_LEDGER, "D5").status).toBe("resolved");
        expect(fixture.store.fetchItem(DEFECTS_LEDGER, "D6").status).toBe("resolved");
        expect(fixture.store.fetchItem(DEFECTS_LEDGER, "D7").status).toBe("resolved");
        expect(fixture.store.fetchItem(DEFECTS_LEDGER, "D8").status).toBe("resolved");
        expect(await recordProtectedImplementationCompletion(
          fixture.store,
          DIRECT_TASK_AUTHORITY,
          completion,
          LIFECYCLE_PROVENANCE,
        )).toEqual(first);
      } finally {
        await fixture.dispose();
      }
    });
  });
}
