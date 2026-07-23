/**
 * Tests for the T615 finalize executor (`runApplyDone`/`runArchive` +
 * `FinalizeOps`): sequential execution against a stub ops, per-id result
 * capture that continues past a mid-sweep rejection (Q292), and the
 * `runArchive` summary synthesis from a plan entry's `title`.
 */

import { describe, it, expect } from "bun:test";
import {
  runApplyDone,
  runArchive,
  type FinalizeOps,
  type FinalizePlan,
  type FinalizeExecResult,
} from "../src/finalize.js";

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

describe("runApplyDone", () => {
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

describe("runArchive", () => {
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
