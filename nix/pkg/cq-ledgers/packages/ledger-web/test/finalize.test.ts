/**
 * Scratch unit test for T614 — proves the `@cq/ledger/finalize` subpath
 * resolves and the Q288/Q289 plan semantics + R722 exclusions hold. The full
 * suite is owned by a separate task (T618); this stays minimal-but-real.
 *
 * Lives in ledger-web (like the D106 coverage guard) because this package's
 * tsconfig `paths` carry the dist-independent `@cq/ledger/finalize` mapping
 * the import below exercises.
 */

import { describe, it, expect } from "bun:test";
import {
  buildFinalizeSnapshot,
  computeApplyDonePlan,
  computeArchivePlan,
  SKIP_AMBIENT_GROUP,
  SKIP_EMPTY_MILESTONE,
  SKIP_INCOMPLETE_MILESTONE,
  SKIP_NON_TERMINAL_ITEMS,
} from "@cq/ledger/finalize";
import type { FinalizeSnapshot } from "@cq/ledger/finalize";
import {
  DEFECTS_LEDGER,
  DEFECTS_SCHEMA,
  GOALS_LEDGER,
  GOALS_SCHEMA,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
  TASKS_LEDGER,
  TASKS_SCHEMA,
} from "@cq/ledger/constants";
import type { FetchedLedger, FieldValue, Item, LedgerSchema } from "@cq/ledger";

const NOW = "2026-07-23T00:00:00.000Z";

function makeItem(id: string, status: string, fields: Record<string, FieldValue> = {}): Item {
  return { id, milestoneId: "", status, fields, createdAt: NOW, updatedAt: NOW };
}

function makeView(
  id: string,
  schema: LedgerSchema,
  groups: Record<string, Item[]>,
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
    archivePointers: [],
  };
}

/**
 * Fixture:
 *  - M-AMBIENT  open  (ambient — always excluded)
 *  - M1  open   all tasks done BUT one defect still open (Q288 gate)
 *  - M2  open   EMPTY — no items in any ledger (R722 exclusion)
 *  - M3  open   all items terminal → apply-done closes it
 *  - M4  done   all items terminal + own status terminal → archivable
 *  - Goals (under the ambient group): G1 building over [M3] → closes;
 *    G2 building over [M1] → gated by the incomplete milestone.
 */
function fixture(): FinalizeSnapshot {
  const milestones = makeView(MILESTONES_LEDGER, MILESTONES_SCHEMA, {
    active: [
      makeItem(MILESTONES_AMBIENT_ID, "open", { title: "ambient" }),
      makeItem("M1", "open", { title: "open defect" }),
      makeItem("M2", "open", { title: "empty" }),
      makeItem("M3", "open", { title: "complete" }),
      makeItem("M4", "done", { title: "complete and closed" }),
    ],
  });
  const tasks = makeView(TASKS_LEDGER, TASKS_SCHEMA, {
    M1: [makeItem("T1", "done")],
    M3: [makeItem("T2", "done")],
    M4: [makeItem("T3", "done")],
  });
  const defects = makeView(DEFECTS_LEDGER, DEFECTS_SCHEMA, {
    M1: [makeItem("D1", "open", { severity: "minor" })],
  });
  const goals = makeView(GOALS_LEDGER, GOALS_SCHEMA, {
    [MILESTONES_AMBIENT_ID]: [
      makeItem("G1", "building", { title: "t", description: "d", milestones: ["M3"] }),
      makeItem("G2", "building", { title: "t", description: "d", milestones: ["M1"] }),
    ],
  });
  return buildFinalizeSnapshot([milestones, tasks, defects, goals]);
}

describe("computeApplyDonePlan (Q288/Q289 + R722)", () => {
  const plan = computeApplyDonePlan(fixture());
  const affectedIds = plan.affected.map((e) => e.id);
  const skippedById = new Map(plan.skipped.map((e) => [e.id, e]));

  it("does NOT treat an all-tasks-done milestone with an open defect as complete (Q288)", () => {
    expect(affectedIds).not.toContain("M1");
    expect(skippedById.get("M1")).toEqual({
      id: "M1",
      reason: SKIP_NON_TERMINAL_ITEMS,
      detail: "defects:D1",
    });
  });

  it("excludes M-AMBIENT and an empty milestone into skipped[] (R722)", () => {
    expect(affectedIds).not.toContain(MILESTONES_AMBIENT_ID);
    expect(affectedIds).not.toContain("M2");
    expect(skippedById.get(MILESTONES_AMBIENT_ID)?.reason).toBe(SKIP_AMBIENT_GROUP);
    expect(skippedById.get("M2")?.reason).toBe(SKIP_EMPTY_MILESTONE);
  });

  it("closes a complete milestone to the schema's done-like terminal status", () => {
    expect(plan.affected).toContainEqual({
      id: "M3",
      action: "close-milestone",
      targetStatus: "done",
    });
  });

  it("closes only building goals whose work milestones are all complete (Q289)", () => {
    expect(plan.affected).toContainEqual({
      id: "G1",
      action: "close-goal",
      targetStatus: "done",
    });
    expect(affectedIds).not.toContain("G2");
    expect(skippedById.get("G2")).toEqual({
      id: "G2",
      reason: SKIP_INCOMPLETE_MILESTONE,
      detail: "M1",
    });
  });
});

describe("computeArchivePlan (Q290 — mirrors performArchive)", () => {
  const plan = computeArchivePlan(fixture());
  const affectedIds = plan.affected.map((e) => e.id);

  it("archives only item-terminal AND self-terminal milestones, never the ambient one", () => {
    expect(plan.affected).toContainEqual({ id: "M4", action: "archive-milestone" });
    // M3 is item-complete but its own status is still `open` (phase 1b).
    expect(affectedIds).not.toContain("M3");
    expect(affectedIds).not.toContain("M1");
    expect(affectedIds).not.toContain(MILESTONES_AMBIENT_ID);
  });
});
