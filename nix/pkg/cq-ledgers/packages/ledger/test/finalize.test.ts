/**
 * T618 — full bun test coverage for `@cq/ledger/finalize` (T614's pure
 * predicates + T615's executor): the Q288 milestone-completeness gate, Q289
 * goal-closure gating (incl. phase/empty-milestones skips), the R722
 * ambient/empty-milestone exclusions, the Q290 archive-plan mirror of
 * `performArchive`, and the executor's per-id result capture/ordering (Q292).
 *
 * Import-resolution choice (per T618's spec): T614's scratch coverage lived
 * in `packages/ledger-web/test/finalize.test.ts` because that package's
 * tsconfig carries a dist-independent `@cq/ledger/finalize` paths mapping
 * this same-package subpath cannot self-resolve from inside `@cq/ledger`
 * itself (there is no `paths` entry pointing `@cq/ledger/finalize` back at
 * its own `src/`). `packages/ledger/test/finalize-exec.test.ts` (T615)
 * already demonstrated the alternative that keeps `bun run check` green: a
 * plain relative import (`../src/finalize.js`), which needs no package-self
 * mapping at all. This suite uses that relative-import form and RELOCATES
 * the executor coverage out of `finalize-exec.test.ts` (removed) to avoid
 * two files asserting the same executor behavior; the ledger-web scratch
 * file is trimmed to the narrow packaging concern it actually guards (the
 * subpath keeps resolving dist-independently for a consuming package),
 * leaving the full predicate/executor matrix here as the single canonical
 * suite the task's acceptance runs directly.
 */

import { describe, it, expect } from "bun:test";
import {
  buildFinalizeSnapshot,
  computeApplyDonePlan,
  computeArchivePlan,
  runApplyDone,
  runArchive,
  SKIP_AMBIENT_GROUP,
  SKIP_EMPTY_MILESTONE,
  SKIP_INCOMPLETE_MILESTONE,
  SKIP_MILESTONE_NOT_TERMINAL,
  SKIP_NON_TERMINAL_ITEMS,
  SKIP_NO_MILESTONES,
  SKIP_WRONG_PHASE,
  type FinalizeExecResult,
  type FinalizeOps,
  type FinalizePlan,
  type FinalizeSnapshot,
} from "../src/finalize.js";
import {
  DEFECTS_LEDGER,
  DEFECTS_SCHEMA,
  GOALS_LEDGER,
  GOALS_SCHEMA,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
  QUESTIONS_LEDGER,
  QUESTIONS_SCHEMA,
  TASKS_LEDGER,
  TASKS_SCHEMA,
} from "../src/constants.js";
import type { FetchedLedger, FieldValue, Item, LedgerSchema } from "../src/types.js";

const NOW = "2026-07-23T00:00:00.000Z";

function makeItem(id: string, status: string, fields: Record<string, FieldValue> = {}): Item {
  return { id, milestoneId: "", status, fields, createdAt: NOW, updatedAt: NOW };
}

function makeView(id: string, schema: LedgerSchema, groups: Record<string, Item[]>): FetchedLedger {
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
 * Fixture covering every case in the T618 acceptance:
 *  - M-AMBIENT  open   its grouped goals (below) are all NON-terminal → excluded
 *               outright by the R722 ambient special-case regardless (this
 *               fixture does not by itself prove the exclusion is what keeps
 *               it out — see the dedicated all-terminal variant below, (d))
 *  - M1         open   all tasks done BUT one open defect → NOT complete (Q288, (a))
 *  - M1Q        open   all tasks done BUT one open question → NOT complete (Q288, (a))
 *  - M2         open   EMPTY (zero items in any ledger) → never affected (R722, (d))
 *  - M3         open   all items terminal → apply-done closes it, targetStatus "done" ((b))
 *  - M4         done   all items terminal + own status terminal → archivable ((e))
 *  - Goals (grouped under the ambient group, per how goals are recorded):
 *      G1 building over [M3]            → closes ((c))
 *      G2 building over [M1]            → skipped, incomplete milestone id in reason ((c))
 *      G3 planned  over [M3]            → skipped, phase reason ((c))
 *      G4 clarifying over [M3]          → skipped, phase reason ((c))
 *      G5 building over [] (no milestones recorded) → skipped, explicit reason ((c) edge case)
 */
function fixture(): FinalizeSnapshot {
  const milestones = makeView(MILESTONES_LEDGER, MILESTONES_SCHEMA, {
    active: [
      makeItem(MILESTONES_AMBIENT_ID, "open", { title: "ambient" }),
      makeItem("M1", "open", { title: "open defect" }),
      makeItem("M1Q", "open", { title: "open question" }),
      makeItem("M2", "open", { title: "empty" }),
      makeItem("M3", "open", { title: "complete" }),
      makeItem("M4", "done", { title: "complete and closed" }),
    ],
  });
  const tasks = makeView(TASKS_LEDGER, TASKS_SCHEMA, {
    M1: [makeItem("T1", "done")],
    M1Q: [makeItem("T4", "done")],
    M3: [makeItem("T2", "done")],
    M4: [makeItem("T3", "done")],
  });
  const defects = makeView(DEFECTS_LEDGER, DEFECTS_SCHEMA, {
    M1: [makeItem("D1", "open", { severity: "minor" })],
  });
  const questions = makeView(QUESTIONS_LEDGER, QUESTIONS_SCHEMA, {
    M1Q: [makeItem("Q1", "open", { question: "still open" })],
  });
  const goals = makeView(GOALS_LEDGER, GOALS_SCHEMA, {
    [MILESTONES_AMBIENT_ID]: [
      makeItem("G1", "building", { title: "t", description: "d", milestones: ["M3"] }),
      makeItem("G2", "building", { title: "t", description: "d", milestones: ["M1"] }),
      makeItem("G3", "planned", { title: "t", description: "d", milestones: ["M3"] }),
      makeItem("G4", "clarifying", { title: "t", description: "d", milestones: ["M3"] }),
      makeItem("G5", "building", { title: "t", description: "d", milestones: [] }),
    ],
  });
  return buildFinalizeSnapshot([milestones, tasks, defects, questions, goals]);
}

describe("computeApplyDonePlan (Q288/Q289 + R722)", () => {
  const plan = computeApplyDonePlan(fixture());
  const affectedIds = plan.affected.map((e) => e.id);
  const skippedById = new Map(plan.skipped.map((e) => [e.id, e]));

  it("(a) does NOT treat an all-tasks-done milestone with an open defect as complete", () => {
    expect(affectedIds).not.toContain("M1");
    expect(skippedById.get("M1")).toEqual({
      id: "M1",
      reason: SKIP_NON_TERMINAL_ITEMS,
      detail: "defects:D1",
    });
  });

  it("(a) does NOT treat an all-tasks-done milestone with an open question as complete", () => {
    expect(affectedIds).not.toContain("M1Q");
    expect(skippedById.get("M1Q")).toEqual({
      id: "M1Q",
      reason: SKIP_NON_TERMINAL_ITEMS,
      detail: "questions:Q1",
    });
  });

  it("(b) closes a fully-terminal milestone, targetStatus is the schema's done-like value", () => {
    expect(plan.affected).toContainEqual({
      id: "M3",
      action: "close-milestone",
      targetStatus: "done",
    });
  });

  it("(c) closes a building goal whose work milestones are all complete", () => {
    expect(plan.affected).toContainEqual({ id: "G1", action: "close-goal", targetStatus: "done" });
  });

  it("(c) skips a building goal with an incomplete work milestone, naming the milestone id", () => {
    expect(affectedIds).not.toContain("G2");
    expect(skippedById.get("G2")).toEqual({
      id: "G2",
      reason: SKIP_INCOMPLETE_MILESTONE,
      detail: "M1",
    });
  });

  it("(c) skips a 'planned' goal with complete milestones, giving the phase as the reason", () => {
    expect(affectedIds).not.toContain("G3");
    expect(skippedById.get("G3")).toEqual({ id: "G3", reason: SKIP_WRONG_PHASE, detail: "planned" });
  });

  it("(c) skips a 'clarifying' goal with complete milestones, giving the phase as the reason", () => {
    expect(affectedIds).not.toContain("G4");
    expect(skippedById.get("G4")).toEqual({
      id: "G4",
      reason: SKIP_WRONG_PHASE,
      detail: "clarifying",
    });
  });

  it("(c) edge case: a building goal with an empty milestones list is skipped with an explicit reason", () => {
    expect(affectedIds).not.toContain("G5");
    expect(skippedById.get("G5")).toEqual({ id: "G5", reason: SKIP_NO_MILESTONES });
  });

  it("(d) NEVER affects the ambient milestone (fixture's grouped goals happen to be non-terminal too)", () => {
    expect(affectedIds).not.toContain(MILESTONES_AMBIENT_ID);
    expect(skippedById.get(MILESTONES_AMBIENT_ID)).toEqual({
      id: MILESTONES_AMBIENT_ID,
      reason: SKIP_AMBIENT_GROUP,
    });
  });

  it("(d) NEVER affects the ambient milestone even when its grouped items are genuinely ALL terminal", () => {
    // Literal R722 scenario: unlike the shared fixture above (whose ambient
    // group holds non-terminal goals, which would exclude it via Q288 alone),
    // this snapshot's ambient group is a single terminal ("done") goal — so
    // Q288 completeness would call it complete. It must still be excluded,
    // proving the ambient special-case is the operative gate, not an
    // incidental non-terminal-items result.
    const allTerminalAmbientSnapshot: FinalizeSnapshot = buildFinalizeSnapshot([
      makeView(MILESTONES_LEDGER, MILESTONES_SCHEMA, {
        active: [makeItem(MILESTONES_AMBIENT_ID, "open", { title: "ambient" })],
      }),
      makeView(GOALS_LEDGER, GOALS_SCHEMA, {
        [MILESTONES_AMBIENT_ID]: [
          makeItem("G9", "done", { title: "t", description: "d" }),
        ],
      }),
    ]);
    const variantPlan = computeApplyDonePlan(allTerminalAmbientSnapshot);
    expect(variantPlan.affected.map((e) => e.id)).not.toContain(MILESTONES_AMBIENT_ID);
    expect(
      variantPlan.skipped.find((s) => s.id === MILESTONES_AMBIENT_ID),
    ).toEqual({ id: MILESTONES_AMBIENT_ID, reason: SKIP_AMBIENT_GROUP });
  });

  it("(d) NEVER affects an empty milestone (zero items across all ledgers)", () => {
    expect(affectedIds).not.toContain("M2");
    expect(skippedById.get("M2")).toEqual({ id: "M2", reason: SKIP_EMPTY_MILESTONE });
  });

  it("regression guard: Q288 completeness reads EVERY ledger, not just tasks", () => {
    // M1 and M1Q both have their sole task `done`; only a tasks-only rule
    // would (incorrectly) call them complete. Assert both stay excluded.
    for (const id of ["M1", "M1Q"]) {
      expect(affectedIds).not.toContain(id);
      expect(skippedById.get(id)?.reason).toBe(SKIP_NON_TERMINAL_ITEMS);
    }
  });
});

describe("computeArchivePlan (Q290 — mirrors performArchive)", () => {
  const plan = computeArchivePlan(fixture());
  const affectedIds = plan.affected.map((e) => e.id);

  it("(e) includes only a milestone that is item-terminal AND self-terminal", () => {
    expect(plan.affected).toContainEqual({
      id: "M4",
      action: "archive-milestone",
      title: "complete and closed",
    });
  });

  it("(e) excludes an item-terminal milestone whose own status is not yet terminal", () => {
    // M3 is item-complete (Q288) but its own status is still `open` (phase 1b).
    expect(affectedIds).not.toContain("M3");
  });

  it("(e) excludes a non-item-terminal milestone", () => {
    expect(affectedIds).not.toContain("M1");
  });

  it("(e) excludes the ambient/active bootstrap group", () => {
    expect(affectedIds).not.toContain(MILESTONES_AMBIENT_ID);
  });
});

// ---------------------------------------------------------------------------
// (f) Executor: per-id failure capture + ordering. Relocated from T615's
// `finalize-exec.test.ts` (removed) so this single file covers the whole
// T618 acceptance without a second file re-asserting the same behavior.
// ---------------------------------------------------------------------------

/** A stub `FinalizeOps` that records every call and can be told to reject on a given call index. */
function makeStubOps(rejectOnCallIndex?: number): {
  ops: FinalizeOps;
  calls: string[];
} {
  const calls: string[] = [];
  let callIndex = 0;
  function maybeReject(label: string): void {
    callIndex += 1;
    if (rejectOnCallIndex !== undefined && callIndex === rejectOnCallIndex) {
      throw new Error(`stub rejection on call ${callIndex} (${label})`);
    }
  }
  const ops: FinalizeOps = {
    async updateItem(ledgerId, itemId, patch) {
      calls.push(`updateItem:${ledgerId}:${itemId}:${patch.status}`);
      maybeReject(`updateItem:${itemId}`);
      return {};
    },
    async updateMilestone(milestoneId, patch) {
      calls.push(`updateMilestone:${milestoneId}:${patch.status}`);
      maybeReject(`updateMilestone:${milestoneId}`);
      return {};
    },
    async archiveMilestone(milestoneId, summary) {
      calls.push(`archiveMilestone:${milestoneId}:${summary}`);
      maybeReject(`archiveMilestone:${milestoneId}`);
      return {};
    },
  };
  return { ops, calls };
}

describe("(f) runApplyDone executor", () => {
  const plan: FinalizePlan = {
    affected: [
      { id: "M1", action: "close-milestone", targetStatus: "done" },
      { id: "M2", action: "close-milestone", targetStatus: "done" },
      { id: "G1", action: "close-goal", targetStatus: "done" },
    ],
    skipped: [],
  };

  it("executes every entry in order when nothing rejects", async () => {
    const { ops, calls } = makeStubOps();
    const results = await runApplyDone(ops, plan);
    expect(results).toEqual([
      { id: "M1", action: "close-milestone", ok: true },
      { id: "M2", action: "close-milestone", ok: true },
      { id: "G1", action: "close-goal", ok: true },
    ]);
    expect(calls).toEqual([
      "updateMilestone:M1:done",
      "updateMilestone:M2:done",
      "updateItem:goals:G1:done",
    ]);
  });

  it("marks exactly the id whose call rejects ok:false with the error message, and still runs the rest (Q292)", async () => {
    const { ops, calls } = makeStubOps(2); // 2nd call = M2's updateMilestone
    const results: FinalizeExecResult[] = await runApplyDone(ops, plan);

    expect(results).toEqual([
      { id: "M1", action: "close-milestone", ok: true },
      {
        id: "M2",
        action: "close-milestone",
        ok: false,
        error: "stub rejection on call 2 (updateMilestone:M2)",
      },
      { id: "G1", action: "close-goal", ok: true },
    ]);
    // The 3rd entry (G1) still ran despite the 2nd entry's rejection.
    expect(calls).toEqual([
      "updateMilestone:M1:done",
      "updateMilestone:M2:done",
      "updateItem:goals:G1:done",
    ]);
  });
});

describe("(f) runArchive executor", () => {
  it("synthesizes 'finalized: <title>' from the entry's title, falling back to the id", async () => {
    const plan: FinalizePlan = {
      affected: [
        { id: "M1", action: "archive-milestone", title: "Ship the widget" },
        { id: "M2", action: "archive-milestone" },
      ],
      skipped: [],
    };
    const { ops, calls } = makeStubOps();
    const results = await runArchive(ops, plan);

    expect(results).toEqual([
      { id: "M1", action: "archive-milestone", ok: true },
      { id: "M2", action: "archive-milestone", ok: true },
    ]);
    expect(calls).toEqual([
      "archiveMilestone:M1:finalized: Ship the widget",
      "archiveMilestone:M2:finalized: M2",
    ]);
  });

  it("continues past a rejected archive call and reports it ok:false", async () => {
    const plan: FinalizePlan = {
      affected: [
        { id: "M1", action: "archive-milestone", title: "First" },
        { id: "M2", action: "archive-milestone", title: "Second" },
      ],
      skipped: [],
    };
    const { ops } = makeStubOps(1); // 1st call = M1's archiveMilestone
    const results = await runArchive(ops, plan);

    expect(results).toEqual([
      {
        id: "M1",
        action: "archive-milestone",
        ok: false,
        error: "stub rejection on call 1 (archiveMilestone:M1)",
      },
      { id: "M2", action: "archive-milestone", ok: true },
    ]);
  });
});

describe("(e) SKIP_MILESTONE_NOT_TERMINAL is exposed for archive-plan callers", () => {
  it("is the reason constant used when phase 1b fails", () => {
    // Documented via computeArchivePlan's own skipped[] entries; asserted
    // here to pin the exact exported string preview UIs match on.
    const plan = computeArchivePlan(fixture());
    const m3 = plan.skipped.find((s) => s.id === "M3");
    expect(m3).toEqual({ id: "M3", reason: SKIP_MILESTONE_NOT_TERMINAL, detail: "open" });
  });
});
