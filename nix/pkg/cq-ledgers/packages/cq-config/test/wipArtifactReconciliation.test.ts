/**
 * defects:D435 — recovery-safe reconciliation of historical WIP artifacts.
 *
 * Thirty-two `WIP-T*.md` files are tracked at the integration root, and D435's
 * recorded root cause held that deleting them "would bypass active
 * recovery/worktree authority". Scanning the real registry does not support
 * that, and the classifier is built on what the scan found rather than on the
 * inference:
 *
 *  - Across 2235 registry JSON files, every one of the 77 distinct WIP paths
 *    mentioned appears in exactly ONE context, `cq-git-change-receipt.paths`,
 *    which records what a past commit touched. That is history, not a claim;
 *    treating it as one makes every artifact permanently undeletable.
 *  - A recovery seal's WIP mentions are all inside its EMBEDDED receipts. The
 *    seal's authority is over the recovery lineage, and its `gitReceiptsDigest`
 *    covers immutable records that deleting a working-tree file cannot alter.
 *  - Each live task's worktree is a separate checkout carrying its OWN tracked
 *    copy on its own branch, so the integration-tree copy is not the one a live
 *    generation claims.
 *
 * The rule is therefore fail-closed on REFERENCE KIND, not on task state.
 */
import { describe, expect, test } from "bun:test";
import {
  HISTORICAL_WIP_REFERENCE,
  classifyWipArtifactReconciliation,
  type WipArtifactReconciliationInput,
} from "../src/wipArtifactReconciliation.js";

function input(
  overrides: Partial<WipArtifactReconciliationInput> = {},
): WipArtifactReconciliationInput {
  return {
    trackedArtifacts: [],
    references: new Map(),
    liveGenerations: new Set(),
    registeredWorktrees: new Set(),
    ...overrides,
  };
}

describe("D435 WIP artifact reconciliation", () => {
  test("an artifact mentioned only by historical receipts is deletable", () => {
    const report = classifyWipArtifactReconciliation(
      input({
        trackedArtifacts: ["WIP-T2816.md"],
        references: new Map([["WIP-T2816.md", [HISTORICAL_WIP_REFERENCE]]]),
      }),
    );
    expect(report.delete.map((entry) => entry.path)).toEqual(["WIP-T2816.md"]);
    expect(report.retain).toEqual([]);
  });

  test("an artifact with no references at all is deletable", () => {
    const report = classifyWipArtifactReconciliation(
      input({ trackedArtifacts: ["WIP-T2816.md"] }),
    );
    expect(report.delete).toHaveLength(1);
  });

  test("an unrecognized reference context retains the artifact and is named", () => {
    // Fail-closed: a context this classifier has not seen might be a live
    // claim, so it holds the file rather than assuming it harmless.
    const report = classifyWipArtifactReconciliation(
      input({
        trackedArtifacts: ["WIP-T2345.md"],
        references: new Map([
          ["WIP-T2345.md", [HISTORICAL_WIP_REFERENCE, "cq-some-future-record::currentPath"]],
        ]),
      }),
    );
    expect(report.delete).toEqual([]);
    expect(report.retain[0]?.heldBy).toEqual(["cq-some-future-record::currentPath"]);
  });

  test("a live generation does NOT hold the integration-tree copy, and says so", () => {
    // The claim a live generation makes is on the worktree, which is a separate
    // checkout with its own tracked copy. The verdict still reports the state,
    // because an operator clearing these wants to know which trees are live.
    const report = classifyWipArtifactReconciliation(
      input({
        trackedArtifacts: ["WIP-T2346.md"],
        references: new Map([["WIP-T2346.md", [HISTORICAL_WIP_REFERENCE]]]),
        liveGenerations: new Set(["T2346"]),
        registeredWorktrees: new Set(["T2346"]),
      }),
    );
    expect(report.delete).toHaveLength(1);
    expect(report.delete[0]?.liveWorktree).toEqual({ generation: "live", registered: true });
    // D405 owns the worktree-side disposal; this names the tasks that need it.
    expect(report.pendingWorktreeDisposal).toEqual(["T2346"]);
  });

  test("a live generation with no registered worktree is reported as orphaned", () => {
    // T2345's real shape: live generation, no git worktree. Orphaned authority
    // an operator must terminalize explicitly — and still not a reason to keep
    // the file, because the file is not what that authority holds.
    const report = classifyWipArtifactReconciliation(
      input({
        trackedArtifacts: ["WIP-T2345.md"],
        references: new Map([["WIP-T2345.md", [HISTORICAL_WIP_REFERENCE]]]),
        liveGenerations: new Set(["T2345"]),
      }),
    );
    expect(report.delete).toHaveLength(1);
    expect(report.orphanedAuthority).toEqual(["T2345"]);
    expect(report.pendingWorktreeDisposal).toEqual([]);
  });

  test("a registered worktree whose generation is RELEASED needs no disposal", () => {
    // Discriminating control: without it, reporting every registered worktree
    // as pending disposal passes, and the report would send an operator into
    // trees that have already been released.
    const report = classifyWipArtifactReconciliation(
      input({
        trackedArtifacts: ["WIP-T2816.md"],
        references: new Map([["WIP-T2816.md", [HISTORICAL_WIP_REFERENCE]]]),
        liveGenerations: new Set(["T2818"]),
        registeredWorktrees: new Set(["T2816", "T2818"]),
      }),
    );
    expect(report.pendingWorktreeDisposal).toEqual(["T2818"]);
    expect(report.orphanedAuthority).toEqual([]);
  });

  test("a path that is not a WIP artifact is refused rather than silently ignored", () => {
    expect(() =>
      classifyWipArtifactReconciliation(input({ trackedArtifacts: ["README.md"] })),
    ).toThrow(/WIP-<taskId>\.md/);
  });

  test("classification is idempotent and order-independent", () => {
    const shared = {
      references: new Map([
        ["WIP-T2816.md", [HISTORICAL_WIP_REFERENCE]],
        ["WIP-T2818.md", [HISTORICAL_WIP_REFERENCE]],
        ["WIP-T6580.md", [HISTORICAL_WIP_REFERENCE, "cq-unknown::held"]],
      ]),
      liveGenerations: new Set(["T6580", "T2818"]),
      registeredWorktrees: new Set(["T6580", "T2818"]),
    };
    const forward = classifyWipArtifactReconciliation(
      input({ ...shared, trackedArtifacts: ["WIP-T2818.md", "WIP-T6580.md", "WIP-T2816.md"] }),
    );
    const reversed = classifyWipArtifactReconciliation(
      input({ ...shared, trackedArtifacts: ["WIP-T6580.md", "WIP-T2816.md", "WIP-T2818.md"] }),
    );
    expect(forward).toEqual(reversed);
    // Sorted by task number so a report diff is stable between runs.
    expect(forward.delete.map((entry) => entry.taskId)).toEqual(["T2816", "T2818"]);
    expect(forward.pendingWorktreeDisposal).toEqual(["T2818", "T6580"]);
    // Re-running against the post-deletion tree leaves exactly the retained set.
    const after = classifyWipArtifactReconciliation(
      input({ ...shared, trackedArtifacts: forward.retain.map((entry) => entry.path) }),
    );
    expect(after.delete).toEqual([]);
    expect(after.retain.map((entry) => entry.path)).toEqual(["WIP-T6580.md"]);
  });
});
