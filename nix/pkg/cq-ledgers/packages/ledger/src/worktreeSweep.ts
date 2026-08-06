/**
 * Worktree sweep-merged predicate (D164).
 *
 * The implement/advance start-of-pass sweep and the advance.md end-of-run
 * maintenance both encode the same removal decision in prose. This module is
 * the executable owner of that decision so the two command files cannot drift
 * without a failing unit test.
 *
 * Inputs are OBSERVED facts — never a branch name alone (advance.md: "Never
 * infer safety from a branch name alone"). Callers gather git ancestry /
 * patch-equivalence and the associated task status, then consult
 * {@link decideWorktreeSweep}.
 *
 * Removal is allowed only when the worktree is not a protected surface AND at
 * least one positive removal leg holds:
 *   - tip is already merged into the integration base (ancestry), OR
 *   - the worktree patch is equivalent to the landed change, OR
 *   - the associated task is terminal (`done` / `abandoned`).
 * Protected surfaces (main checkout, ledger backup branch, live wip/blocked
 * task association) always preserve.
 */

/** Task statuses the implement-flow associates with a worktree. */
export type WorktreeAssociatedTaskStatus =
  | "planned"
  | "wip"
  | "blocked"
  | "done"
  | "abandoned";

/**
 * Observed facts about one candidate worktree. Branch names are deliberately
 * absent — callers must reduce git state to the boolean legs below.
 */
export interface WorktreeSweepFacts {
  /** True when the path is the repository's main checkout. */
  readonly isMainCheckout: boolean;
  /** True when the worktree carries the ledger backup branch. */
  readonly isLedgerBackupBranch: boolean;
  /**
   * Associated task status when known; `null` when the worktree has no
   * terminal-or-live task association (orphan / metadata-only).
   */
  readonly associatedTaskStatus: WorktreeAssociatedTaskStatus | null;
  /**
   * True when the worktree tip is an ancestor of the integration base
   * (`git merge-base --is-ancestor <tip> <base>` exits 0) — the content is
   * already landed.
   */
  readonly tipMergedIntoBase: boolean;
  /**
   * True when the worktree's patch is byte-equivalent to the landed change
   * even if the tip commit itself is not an ancestor (rebased / cherry-picked
   * equivalent).
   */
  readonly patchEquivalentToLanded: boolean;
}

export type WorktreeSweepDecision = "remove" | "preserve";

/**
 * D158: reduce `git cherry <base> <tip>` stdout to the
 * {@link WorktreeSweepFacts.patchEquivalentToLanded} boolean.
 *
 * `git cherry` prints one `+ <sha>` / `- <sha>` line per commit on tip-not-in
 * base. Every line starting with `-` means the patch is already present on
 * base (cherry-pick / rebase equivalent). A single `+` line means the tip
 * carries a novel patch. Empty stdout (no commits to compare) is equivalent.
 *
 * Pure over the captured stdout — callers run `git cherry` themselves.
 */
export function patchEquivalentFromGitCherry(stdout: string): boolean {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return true;
  return lines.every((line) => line.startsWith("-"));
}

/**
 * Decide whether a candidate implementation worktree may be removed.
 *
 * Pure over {@link WorktreeSweepFacts}. The sole owner of the sweep-merged
 * status table shared by `/cq:implement/advance` and `/cq:advance`.
 */
export function decideWorktreeSweep(facts: WorktreeSweepFacts): WorktreeSweepDecision {
  // Hard preserves — never touch these surfaces.
  if (facts.isMainCheckout) return "preserve";
  if (facts.isLedgerBackupBranch) return "preserve";
  if (facts.associatedTaskStatus === "wip" || facts.associatedTaskStatus === "blocked") {
    return "preserve";
  }

  // Positive removal legs (content-based merged OR terminal task association).
  if (facts.tipMergedIntoBase) return "remove";
  if (facts.patchEquivalentToLanded) return "remove";
  if (facts.associatedTaskStatus === "done" || facts.associatedTaskStatus === "abandoned") {
    return "remove";
  }

  // Unmerged worktree without a terminal task association — preserve.
  return "preserve";
}
