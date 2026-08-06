/**
 * D164 — executable regression guard for the worktree sweep-merged predicate.
 *
 * The two command files (`commands/cq/implement/advance.md` start-of-pass
 * sweep and `commands/cq/advance.md` end-of-run maintenance) previously held
 * the decision only as duplicated prose. {@link decideWorktreeSweep} is the
 * single owner; this suite locks the decision table.
 */

import { describe, expect, test } from "bun:test";
import {
  decideWorktreeSweep,
  patchEquivalentFromGitCherry,
  type WorktreeSweepFacts,
} from "../src/worktreeSweep.js";

const BASE: WorktreeSweepFacts = {
  isMainCheckout: false,
  isLedgerBackupBranch: false,
  associatedTaskStatus: null,
  tipMergedIntoBase: false,
  patchEquivalentToLanded: false,
};

describe("D164 decideWorktreeSweep", () => {
  test("preserves the main checkout even when every removal leg is true", () => {
    expect(
      decideWorktreeSweep({
        ...BASE,
        isMainCheckout: true,
        tipMergedIntoBase: true,
        patchEquivalentToLanded: true,
        associatedTaskStatus: "done",
      }),
    ).toBe("preserve");
  });

  test("preserves the ledger backup branch even when every removal leg is true", () => {
    expect(
      decideWorktreeSweep({
        ...BASE,
        isLedgerBackupBranch: true,
        tipMergedIntoBase: true,
        associatedTaskStatus: "abandoned",
      }),
    ).toBe("preserve");
  });

  test("preserves a live wip task association even when tip is merged", () => {
    expect(
      decideWorktreeSweep({
        ...BASE,
        associatedTaskStatus: "wip",
        tipMergedIntoBase: true,
      }),
    ).toBe("preserve");
  });

  test("preserves a live blocked task association even when patch-equivalent", () => {
    expect(
      decideWorktreeSweep({
        ...BASE,
        associatedTaskStatus: "blocked",
        patchEquivalentToLanded: true,
      }),
    ).toBe("preserve");
  });

  test("removes when tip is merged into the integration base", () => {
    expect(
      decideWorktreeSweep({
        ...BASE,
        tipMergedIntoBase: true,
      }),
    ).toBe("remove");
  });

  test("removes when the patch is equivalent to the landed change", () => {
    expect(
      decideWorktreeSweep({
        ...BASE,
        patchEquivalentToLanded: true,
      }),
    ).toBe("remove");
  });

  test("removes when the associated task is done", () => {
    expect(
      decideWorktreeSweep({
        ...BASE,
        associatedTaskStatus: "done",
      }),
    ).toBe("remove");
  });

  test("removes when the associated task is abandoned", () => {
    expect(
      decideWorktreeSweep({
        ...BASE,
        associatedTaskStatus: "abandoned",
      }),
    ).toBe("remove");
  });

  test("preserves an unmerged worktree with no terminal task association", () => {
    expect(decideWorktreeSweep(BASE)).toBe("preserve");
    expect(
      decideWorktreeSweep({
        ...BASE,
        associatedTaskStatus: "planned",
      }),
    ).toBe("preserve");
  });

  test("does not consult a branch name — only the observed boolean legs", () => {
    // Structural: the facts type carries no branchName field. A rename of a
    // still-unmerged branch cannot flip the decision without content evidence.
    const facts: WorktreeSweepFacts = { ...BASE };
    expect("branchName" in facts).toBe(false);
    expect(decideWorktreeSweep(facts)).toBe("preserve");
  });
});

describe("D158 patchEquivalentFromGitCherry", () => {
  test("all '-' lines → equivalent", () => {
    expect(patchEquivalentFromGitCherry("- abc\n- def\n")).toBe(true);
  });

  test("any '+' line → not equivalent", () => {
    expect(patchEquivalentFromGitCherry("- abc\n+ def\n")).toBe(false);
  });

  test("empty stdout → equivalent", () => {
    expect(patchEquivalentFromGitCherry("")).toBe(true);
    expect(patchEquivalentFromGitCherry("\n\n")).toBe(true);
  });
});
