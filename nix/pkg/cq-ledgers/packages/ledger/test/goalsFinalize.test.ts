/**
 * T643 — Behavioral-Active, Blackbox-Atomic coverage for the pure,
 * selector-aware goals-scope Finalize planner.
 */

import { describe, expect, it } from "bun:test";
import {
  buildFinalizeSnapshot,
  computeGoalsFinalizePlan,
  runGoalsFinalize,
  SKIP_INCOMPLETE_MILESTONE,
  SKIP_NO_MILESTONES,
  SKIP_WRONG_PHASE,
  type FinalizeOps,
  type FinalizeSnapshot,
  type GoalsFinalizeExecResult,
  type GoalsFinalizeOperation,
  type GoalsFinalizePlan,
} from "../src/finalize.js";
import {
  DEFECTS_LEDGER,
  DEFECTS_SCHEMA,
  GOALS_LEDGER,
  GOALS_SCHEMA,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
  TASKS_LEDGER,
  TASKS_SCHEMA,
} from "../src/constants.js";
import type {
  ArchivePointer,
  FetchedLedger,
  FieldValue,
  Item,
  LedgerSchema,
} from "../src/types.js";

const NOW = "2026-07-24T00:00:00.000Z";

function makeItem(id: string, status: string, fields: Record<string, FieldValue> = {}): Item {
  return { id, milestoneId: "", status, fields, createdAt: NOW, updatedAt: NOW };
}

function makeView(
  id: string,
  schema: LedgerSchema,
  groups: Record<string, Item[]>,
  archivePointers: ArchivePointer[] = [],
): FetchedLedger {
  return {
    id,
    schema,
    counters: { milestone: 1, item: 1 },
    milestones: Object.entries(groups).map(([groupId, items]) => ({
      id: groupId,
      milestone: { id: groupId, status: "", title: "", description: "" },
      items: items.map((item) => ({ ...item, milestoneId: groupId })),
    })),
    archivePointers,
  };
}

function archived(id: string): ArchivePointer {
  return { id, path: `./archive/milestones/${id}.md`, summary: id, title: id, status: "done" };
}

function makeSnapshot(input: {
  milestones: Item[];
  tasks?: Record<string, Item[]>;
  defects?: Record<string, Item[]>;
  goals?: Record<string, Item[]>;
  archivedMilestones?: ArchivePointer[];
}): FinalizeSnapshot {
  const views: FetchedLedger[] = [
    makeView(
      MILESTONES_LEDGER,
      MILESTONES_SCHEMA,
      { active: input.milestones },
      input.archivedMilestones ?? [],
    ),
  ];
  if (input.tasks !== undefined) views.push(makeView(TASKS_LEDGER, TASKS_SCHEMA, input.tasks));
  if (input.defects !== undefined) {
    views.push(makeView(DEFECTS_LEDGER, DEFECTS_SCHEMA, input.defects));
  }
  if (input.goals !== undefined) views.push(makeView(GOALS_LEDGER, GOALS_SCHEMA, input.goals));
  return buildFinalizeSnapshot(views);
}

function operation(
  operations: GoalsFinalizeOperation[],
  id: string,
): GoalsFinalizeOperation {
  const found = operations.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing operation ${id}`);
  return found;
}

function makeRecordingOps(failures: ReadonlySet<string>): {
  ops: FinalizeOps;
  calls: string[];
} {
  const calls: string[] = [];
  const record = (call: string): void => {
    calls.push(call);
    if (failures.has(call)) throw new Error(`recording failure: ${call}`);
  };
  return {
    calls,
    ops: {
      async updateItem(ledgerId, itemId, patch) {
        record(`updateItem:${ledgerId}:${itemId}:${patch.status}`);
      },
      async updateMilestone(milestoneId, patch) {
        record(`updateMilestone:${milestoneId}:${patch.status}`);
      },
      async archiveMilestone(milestoneId, summary) {
        record(`archiveMilestone:${milestoneId}:${summary}`);
      },
    },
  };
}

function result(
  results: GoalsFinalizeExecResult[],
  id: string,
): GoalsFinalizeExecResult {
  const found = results.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing result ${id}`);
  return found;
}

function baseSnapshot(): FinalizeSnapshot {
  return makeSnapshot({
    milestones: [
      makeItem("M-W-OPEN", "open", { title: "open work" }),
      makeItem("M-W-DONE", "done", { title: "closed work" }),
      makeItem("M-COORD", "open", { title: "coordination" }),
    ],
    tasks: {
      "M-W-OPEN": [makeItem("T1", "done")],
      "M-W-DONE": [makeItem("T2", "done")],
    },
    goals: {
      "M-COORD": [
        makeItem("G1", "planned", {
          title: "planned complete",
          description: "d",
          milestones: ["M-W-OPEN"],
        }),
        makeItem("G2", "building", {
          title: "building complete",
          description: "d",
          milestones: ["M-W-DONE"],
        }),
      ],
    },
  });
}

describe("computeGoalsFinalizePlan", () => {
  it("defaults every eligible planned/building goal to selected and emits exact operation edges", () => {
    const plan = computeGoalsFinalizePlan(baseSnapshot());

    expect(plan.eligibleGoals).toEqual([
      {
        id: "G1",
        status: "planned",
        workMilestoneIds: ["M-W-OPEN"],
        coordinationMilestoneId: "M-COORD",
        selected: true,
      },
      {
        id: "G2",
        status: "building",
        workMilestoneIds: ["M-W-DONE"],
        coordinationMilestoneId: "M-COORD",
        selected: true,
      },
    ]);

    expect(operation(plan.operations, "goal:G1:to-building")).toMatchObject({
      targetId: "G1",
      action: "close-goal",
      targetStatus: "building",
      orderedAfter: ["milestone:M-W-OPEN:close"],
      requiresSuccessOf: [],
    });
    expect(operation(plan.operations, "goal:G1:to-done")).toMatchObject({
      targetId: "G1",
      action: "close-goal",
      targetStatus: "done",
      orderedAfter: ["milestone:M-W-OPEN:close", "goal:G1:to-building"],
      requiresSuccessOf: ["goal:G1:to-building"],
    });
    expect(operation(plan.operations, "goal:G2:to-done")).toMatchObject({
      targetId: "G2",
      action: "close-goal",
      targetStatus: "done",
      orderedAfter: [],
      requiresSuccessOf: [],
    });
    expect(operation(plan.operations, "milestone:M-W-OPEN:archive")).toMatchObject({
      requiresSuccessOf: ["milestone:M-W-OPEN:close"],
    });
    expect(operation(plan.operations, "milestone:M-W-DONE:archive")).toMatchObject({
      requiresSuccessOf: [],
    });
    expect(operation(plan.operations, "milestone:M-COORD:close")).toMatchObject({
      orderedAfter: ["goal:G1:to-done", "goal:G2:to-done"],
      requiresSuccessOf: ["goal:G1:to-done", "goal:G2:to-done"],
    });
    expect(operation(plan.operations, "milestone:M-COORD:archive")).toMatchObject({
      orderedAfter: [
        "goal:G1:to-done",
        "goal:G2:to-done",
        "milestone:M-COORD:close",
      ],
      requiresSuccessOf: [
        "goal:G1:to-done",
        "goal:G2:to-done",
        "milestone:M-COORD:close",
      ],
    });

    const ids = plan.operations.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("supports explicit opt-out and leaves deselected projected state able to block coordination archival", () => {
    const plan = computeGoalsFinalizePlan(baseSnapshot(), { deselectedGoalIds: ["G2"] });
    expect(plan.eligibleGoals.map(({ id, selected }) => [id, selected])).toEqual([
      ["G1", true],
      ["G2", false],
    ]);

    const ids = plan.operations.map(({ id }) => id);
    expect(ids).toContain("goal:G1:to-building");
    expect(ids).toContain("goal:G1:to-done");
    expect(ids).toContain("milestone:M-W-OPEN:archive");
    expect(ids).not.toContain("goal:G2:to-done");
    expect(ids).not.toContain("milestone:M-W-DONE:archive");
    expect(ids).not.toContain("milestone:M-COORD:close");
    expect(ids).not.toContain("milestone:M-COORD:archive");
  });

  it("accepts open-complete and archived work while skipping incomplete, empty, and wrong-phase goals", () => {
    const snapshot = makeSnapshot({
      milestones: [
        makeItem("M-OPEN", "open"),
        makeItem("M-INCOMPLETE", "open"),
        makeItem("M-EMPTY", "open"),
        makeItem("M-COORD", "open"),
      ],
      archivedMilestones: [archived("M-ARCHIVED")],
      tasks: {
        "M-OPEN": [makeItem("T1", "done")],
        "M-INCOMPLETE": [makeItem("T2", "wip")],
      },
      goals: {
        "M-COORD": [
          makeItem("G-OPEN", "building", {
            title: "t",
            description: "d",
            milestones: ["M-OPEN"],
          }),
          makeItem("G-ARCHIVED", "planned", {
            title: "t",
            description: "d",
            milestones: ["milestones:M-ARCHIVED"],
          }),
          makeItem("G-INCOMPLETE", "building", {
            title: "t",
            description: "d",
            milestones: ["M-INCOMPLETE"],
          }),
          makeItem("G-EMPTY", "planned", {
            title: "t",
            description: "d",
            milestones: ["M-EMPTY"],
          }),
          makeItem("G-NONE", "building", { title: "t", description: "d", milestones: [] }),
          makeItem("G-WRONG", "planning", {
            title: "t",
            description: "d",
            milestones: ["M-OPEN"],
          }),
        ],
      },
    });

    const plan = computeGoalsFinalizePlan(snapshot);
    expect(plan.eligibleGoals.map(({ id }) => id)).toEqual(["G-OPEN", "G-ARCHIVED"]);
    expect(new Map(plan.skipped.map((entry) => [entry.id, entry]))).toEqual(
      new Map([
        [
          "G-INCOMPLETE",
          {
            id: "G-INCOMPLETE",
            reason: SKIP_INCOMPLETE_MILESTONE,
            detail: "M-INCOMPLETE",
          },
        ],
        [
          "G-EMPTY",
          { id: "G-EMPTY", reason: SKIP_INCOMPLETE_MILESTONE, detail: "M-EMPTY" },
        ],
        ["G-NONE", { id: "G-NONE", reason: SKIP_NO_MILESTONES }],
        ["G-WRONG", { id: "G-WRONG", reason: SKIP_WRONG_PHASE, detail: "planning" }],
      ]),
    );
    expect(plan.operations.map(({ id }) => id)).not.toContain("milestone:M-ARCHIVED:archive");
  });

  it("projects Q290 across every ledger and excludes unrelated global archive candidates", () => {
    const snapshot = makeSnapshot({
      milestones: [
        makeItem("M-WORK", "done"),
        makeItem("M-COORD", "open"),
        makeItem("M-UNRELATED", "done"),
      ],
      tasks: {
        "M-WORK": [makeItem("T1", "done")],
        "M-UNRELATED": [makeItem("T2", "done")],
      },
      defects: {
        "M-COORD": [makeItem("D1", "open", { severity: "major" })],
      },
      goals: {
        "M-COORD": [
          makeItem("G1", "building", {
            title: "t",
            description: "d",
            milestones: ["M-WORK"],
          }),
        ],
      },
    });

    const ids = computeGoalsFinalizePlan(snapshot).operations.map(({ id }) => id);
    expect(ids).toContain("goal:G1:to-done");
    expect(ids).toContain("milestone:M-WORK:archive");
    expect(ids).not.toContain("milestone:M-COORD:close");
    expect(ids).not.toContain("milestone:M-COORD:archive");
    expect(ids).not.toContain("milestone:M-UNRELATED:archive");
  });

  it("deduplicates shared work and coordination targets and preserves snapshot purity", () => {
    const snapshot = makeSnapshot({
      milestones: [
        makeItem("M-SHARED-WORK", "open"),
        makeItem("M-SHARED-COORD", "open"),
      ],
      tasks: {
        "M-SHARED-WORK": [makeItem("T1", "done")],
      },
      goals: {
        "M-SHARED-COORD": [
          makeItem("G1", "planned", {
            title: "t",
            description: "d",
            milestones: ["M-SHARED-WORK"],
          }),
          makeItem("G2", "building", {
            title: "t",
            description: "d",
            milestones: ["M-SHARED-WORK"],
          }),
        ],
      },
    });
    const before = structuredClone(snapshot);

    const plan = computeGoalsFinalizePlan(snapshot);
    const ids = plan.operations.map(({ id }) => id);
    expect(ids.filter((id) => id === "milestone:M-SHARED-WORK:close")).toHaveLength(1);
    expect(ids.filter((id) => id === "milestone:M-SHARED-WORK:archive")).toHaveLength(1);
    expect(ids.filter((id) => id === "milestone:M-SHARED-COORD:close")).toHaveLength(1);
    expect(ids.filter((id) => id === "milestone:M-SHARED-COORD:archive")).toHaveLength(1);
    expect(operation(plan.operations, "milestone:M-SHARED-COORD:close").requiresSuccessOf).toEqual([
      "goal:G1:to-done",
      "goal:G2:to-done",
    ]);
    expect(snapshot).toEqual(before);
  });

  it("unions exact prerequisites when one milestone is both work and coordination", () => {
    const snapshot = makeSnapshot({
      milestones: [
        makeItem("M-SHARED", "open"),
        makeItem("M-COMPLETE", "done"),
      ],
      // An active/archive overlap cannot occur in a live store, but it is the
      // only pure snapshot that keeps M-SHARED Q289-complete for G-WORK while
      // a selected non-terminal G-COORD remains grouped under the same id.
      archivedMilestones: [archived("M-SHARED")],
      tasks: {
        "M-SHARED": [makeItem("T1", "done")],
        "M-COMPLETE": [makeItem("T2", "done")],
      },
      goals: {
        "M-OTHER": [
          makeItem("G-WORK", "building", {
            title: "work role",
            description: "d",
            milestones: ["M-SHARED"],
          }),
        ],
        "M-SHARED": [
          makeItem("G-COORD", "building", {
            title: "coordination role",
            description: "d",
            milestones: ["M-COMPLETE"],
          }),
        ],
      },
    });

    const plan = computeGoalsFinalizePlan(snapshot);
    expect(plan.eligibleGoals.map(({ id }) => id)).toEqual(["G-WORK", "G-COORD"]);
    expect(
      plan.operations.filter(({ id }) => id === "milestone:M-SHARED:close"),
    ).toHaveLength(1);
    expect(
      plan.operations.filter(({ id }) => id === "milestone:M-SHARED:archive"),
    ).toHaveLength(1);
    expect(operation(plan.operations, "milestone:M-SHARED:close")).toMatchObject({
      orderedAfter: ["goal:G-COORD:to-done"],
      requiresSuccessOf: ["goal:G-COORD:to-done"],
    });
    expect(operation(plan.operations, "milestone:M-SHARED:archive")).toMatchObject({
      orderedAfter: ["goal:G-COORD:to-done", "milestone:M-SHARED:close"],
      requiresSuccessOf: ["goal:G-COORD:to-done", "milestone:M-SHARED:close"],
    });
  });

  it("adds no synthetic close prerequisite for an already-terminal coordination milestone", () => {
    const snapshot = makeSnapshot({
      milestones: [makeItem("M-WORK", "done"), makeItem("M-COORD", "done")],
      tasks: { "M-WORK": [makeItem("T1", "done")] },
      goals: {
        "M-COORD": [
          makeItem("G1", "building", {
            title: "t",
            description: "d",
            milestones: ["M-WORK"],
          }),
        ],
      },
    });

    const plan = computeGoalsFinalizePlan(snapshot);
    expect(plan.operations.map(({ id }) => id)).not.toContain("milestone:M-COORD:close");
    expect(operation(plan.operations, "milestone:M-COORD:archive")).toMatchObject({
      orderedAfter: ["goal:G1:to-done"],
      requiresSuccessOf: ["goal:G1:to-done"],
    });
  });
});

describe("runGoalsFinalize", () => {
  it("records every selected operation once in deterministic topological order", async () => {
    const plan = computeGoalsFinalizePlan(baseSnapshot());
    const { ops, calls } = makeRecordingOps(new Set());

    const results = await runGoalsFinalize(ops, plan);

    expect(results.map(({ id }) => id)).toEqual([
      "milestone:M-W-OPEN:close",
      "goal:G1:to-building",
      "goal:G1:to-done",
      "goal:G2:to-done",
      "milestone:M-COORD:close",
      "milestone:M-W-OPEN:archive",
      "milestone:M-COORD:archive",
      "milestone:M-W-DONE:archive",
    ]);
    expect(calls).toEqual([
      "updateMilestone:M-W-OPEN:done",
      "updateItem:goals:G1:building",
      "updateItem:goals:G1:done",
      "updateItem:goals:G2:done",
      "updateMilestone:M-COORD:done",
      "archiveMilestone:M-W-OPEN:finalized: open work",
      "archiveMilestone:M-COORD:finalized: coordination",
      "archiveMilestone:M-W-DONE:finalized: closed work",
    ]);
    expect(results.every(({ attempted, ok }) => attempted && ok)).toBe(true);
    expect(result(results, "goal:G1:to-building")).toMatchObject({
      id: "goal:G1:to-building",
      targetId: "G1",
      attempted: true,
      ok: true,
    });
    expect(result(results, "goal:G1:to-done")).toMatchObject({
      id: "goal:G1:to-done",
      targetId: "G1",
      attempted: true,
      ok: true,
    });
    expect(calls.filter((call) => call.startsWith("updateMilestone:M-COORD:"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("archiveMilestone:M-COORD:"))).toHaveLength(1);
  });

  it("never writes deselected or skipped goals", async () => {
    const snapshot = makeSnapshot({
      milestones: [
        makeItem("M-WORK", "done"),
        makeItem("M-INCOMPLETE", "open"),
        makeItem("M-COORD", "open"),
      ],
      tasks: {
        "M-WORK": [makeItem("T-DONE", "done")],
        "M-INCOMPLETE": [makeItem("T-WIP", "wip")],
      },
      goals: {
        "M-COORD": [
          makeItem("G-SELECTED", "building", {
            title: "selected",
            description: "d",
            milestones: ["M-WORK"],
          }),
          makeItem("G-DESELECTED", "building", {
            title: "deselected",
            description: "d",
            milestones: ["M-WORK"],
          }),
          makeItem("G-SKIPPED", "building", {
            title: "skipped",
            description: "d",
            milestones: ["M-INCOMPLETE"],
          }),
        ],
      },
    });
    const plan = computeGoalsFinalizePlan(snapshot, {
      deselectedGoalIds: ["G-DESELECTED"],
    });
    const { ops, calls } = makeRecordingOps(new Set());

    await runGoalsFinalize(ops, plan);

    expect(calls).toContain("updateItem:goals:G-SELECTED:done");
    expect(calls.some((call) => call.includes("G-DESELECTED"))).toBe(false);
    expect(calls.some((call) => call.includes("G-SKIPPED"))).toBe(false);
  });

  it("does not let a failed ordering-only work close suppress goal transitions", async () => {
    const plan = computeGoalsFinalizePlan(baseSnapshot());
    const failedCall = "updateMilestone:M-W-OPEN:done";
    const { ops, calls } = makeRecordingOps(new Set([failedCall]));

    const results = await runGoalsFinalize(ops, plan);

    expect(result(results, "milestone:M-W-OPEN:close")).toEqual({
      id: "milestone:M-W-OPEN:close",
      targetId: "M-W-OPEN",
      action: "close-milestone",
      attempted: true,
      ok: false,
      error: `recording failure: ${failedCall}`,
    });
    expect(result(results, "goal:G1:to-building")).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result(results, "goal:G1:to-done")).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result(results, "milestone:M-W-OPEN:archive")).toEqual({
      id: "milestone:M-W-OPEN:archive",
      targetId: "M-W-OPEN",
      action: "archive-milestone",
      attempted: false,
      ok: false,
      failedPrerequisite: "milestone:M-W-OPEN:close",
    });
    expect(calls.some((call) => call.startsWith("archiveMilestone:M-W-OPEN:"))).toBe(false);
    expect(result(results, "milestone:M-COORD:archive")).toMatchObject({
      attempted: true,
      ok: true,
    });
  });

  it("suppresses only the declared branch after a planned-to-building failure", async () => {
    const failedCall = "updateItem:goals:G1:building";
    const { ops, calls } = makeRecordingOps(new Set([failedCall]));

    const results = await runGoalsFinalize(ops, computeGoalsFinalizePlan(baseSnapshot()));

    expect(result(results, "goal:G1:to-building")).toMatchObject({
      attempted: true,
      ok: false,
      error: `recording failure: ${failedCall}`,
    });
    expect(result(results, "goal:G1:to-done")).toMatchObject({
      attempted: false,
      ok: false,
      failedPrerequisite: "goal:G1:to-building",
    });
    expect(result(results, "goal:G2:to-done")).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result(results, "milestone:M-COORD:close")).toMatchObject({
      attempted: false,
      ok: false,
      failedPrerequisite: "goal:G1:to-done",
    });
    expect(result(results, "milestone:M-COORD:archive")).toMatchObject({
      attempted: false,
      ok: false,
      failedPrerequisite: "goal:G1:to-done",
    });
    expect(calls).not.toContain("updateItem:goals:G1:done");
    expect(calls.some((call) => call.startsWith("updateMilestone:M-COORD:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("archiveMilestone:M-COORD:"))).toBe(false);
    expect(result(results, "milestone:M-W-OPEN:archive")).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result(results, "milestone:M-W-DONE:archive")).toMatchObject({
      attempted: true,
      ok: true,
    });
  });

  it("suppresses every and only declared dependent of a failed shared prerequisite", async () => {
    const plan: GoalsFinalizePlan = {
      eligibleGoals: [],
      skipped: [],
      operations: [
        {
          id: "milestone:M-LEFT:archive",
          targetId: "M-LEFT",
          action: "archive-milestone",
          orderedAfter: ["milestone:M-SHARED:close"],
          requiresSuccessOf: ["milestone:M-SHARED:close"],
        },
        {
          id: "milestone:M-SHARED:close",
          targetId: "M-SHARED",
          action: "close-milestone",
          targetStatus: "done",
          orderedAfter: [],
          requiresSuccessOf: [],
        },
        {
          id: "milestone:M-RIGHT:archive",
          targetId: "M-RIGHT",
          action: "archive-milestone",
          orderedAfter: ["milestone:M-SHARED:close"],
          requiresSuccessOf: ["milestone:M-SHARED:close"],
        },
        {
          id: "goal:G-ORDERED:to-done",
          targetId: "G-ORDERED",
          action: "close-goal",
          targetStatus: "done",
          orderedAfter: ["milestone:M-SHARED:close"],
          requiresSuccessOf: [],
        },
        {
          id: "goal:G-INDEPENDENT:to-done",
          targetId: "G-INDEPENDENT",
          action: "close-goal",
          targetStatus: "done",
          orderedAfter: [],
          requiresSuccessOf: [],
        },
      ],
    };
    const failedCall = "updateMilestone:M-SHARED:done";
    const { ops, calls } = makeRecordingOps(new Set([failedCall]));

    const results = await runGoalsFinalize(ops, plan);

    expect(results.map(({ id }) => id)).toEqual([
      "milestone:M-SHARED:close",
      "milestone:M-LEFT:archive",
      "milestone:M-RIGHT:archive",
      "goal:G-ORDERED:to-done",
      "goal:G-INDEPENDENT:to-done",
    ]);
    expect(result(results, "milestone:M-LEFT:archive")).toMatchObject({
      attempted: false,
      failedPrerequisite: "milestone:M-SHARED:close",
    });
    expect(result(results, "milestone:M-RIGHT:archive")).toMatchObject({
      attempted: false,
      failedPrerequisite: "milestone:M-SHARED:close",
    });
    expect(result(results, "goal:G-ORDERED:to-done")).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result(results, "goal:G-INDEPENDENT:to-done")).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(calls).toEqual([
      failedCall,
      "updateItem:goals:G-ORDERED:done",
      "updateItem:goals:G-INDEPENDENT:done",
    ]);
  });

  it("emits no close result for already-terminal work and coordination milestones", async () => {
    const snapshot = makeSnapshot({
      milestones: [
        makeItem("M-WORK", "done", { title: "work" }),
        makeItem("M-COORD", "done", { title: "coordination" }),
      ],
      tasks: { "M-WORK": [makeItem("T1", "done")] },
      goals: {
        "M-COORD": [
          makeItem("G1", "building", {
            title: "goal",
            description: "d",
            milestones: ["M-WORK"],
          }),
        ],
      },
    });
    const { ops, calls } = makeRecordingOps(new Set());

    const results = await runGoalsFinalize(ops, computeGoalsFinalizePlan(snapshot));

    expect(results.map(({ id }) => id)).toEqual([
      "goal:G1:to-done",
      "milestone:M-WORK:archive",
      "milestone:M-COORD:archive",
    ]);
    expect(calls.some((call) => call.startsWith("updateMilestone:"))).toBe(false);
  });
});
