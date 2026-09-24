/**
 * defects:D435 — which historical WIP artifacts may leave the integration tree.
 *
 * Thirty-two `WIP-T*.md` files are tracked at the repository root, and D435's
 * recorded root cause held that deleting them "would bypass active
 * recovery/worktree authority". Scanning the real registry does not support
 * that: across 2235 JSON files every one of the 77 distinct WIP paths it
 * mentions appears in exactly ONE context — `cq-git-change-receipt.paths`,
 * which records what a past commit touched. A receipt is history, not a claim.
 * Treating it as one makes every artifact permanently undeletable, which is the
 * defect rather than the fix.
 *
 * What live authority actually holds is the WORKTREE and the recovery lineage,
 * neither of which is the integration-tree copy: each live task's worktree is a
 * separate checkout carrying its OWN tracked copy on its own branch, and a
 * recovery seal's embedded receipts are immutable records whose digest deleting
 * a working-tree file cannot change.
 *
 * So the rule is fail-closed on REFERENCE KIND rather than on task state: an
 * artifact leaves only if every reference to it is historical. Anything else —
 * including a context this classifier does not recognize — retains it, because
 * an unknown claim must not be assumed harmless.
 */

/** `WIP-<taskId>.md`, the only shape the integration tree should ever carry. */
const WIP_ARTIFACT_RE = /^WIP-(T\d+)\.md$/u;

/**
 * The one registry context that merely RECORDS a path: the `paths` array of a
 * `cq-git-change-receipt`, naming what a past commit touched.
 */
export const HISTORICAL_WIP_REFERENCE = "cq-git-change-receipt::paths";

/** The managed-worktree state of the artifact's own task, reported either way. */
export interface WipArtifactWorktreeState {
  readonly generation: "live" | "released";
  readonly registered: boolean;
}

export interface WipArtifactVerdict {
  readonly path: string;
  readonly taskId: string;
  readonly liveWorktree: WipArtifactWorktreeState;
}

export interface WipArtifactHeldVerdict extends WipArtifactVerdict {
  /** The reference contexts that are not historical, sorted and deduplicated. */
  readonly heldBy: readonly string[];
}

export interface WipArtifactReconciliationReport {
  /** Artifacts every reference to which is historical. Sorted by task number. */
  readonly delete: readonly WipArtifactVerdict[];
  /** Artifacts with at least one non-historical reference. Sorted likewise. */
  readonly retain: readonly WipArtifactHeldVerdict[];
  /**
   * Tasks whose generation is live while Git registers no worktree. Not a
   * retention reason — the integration-tree copy is not what that authority
   * holds — but authority an operator must terminalize explicitly, reported so
   * it cannot pass unnoticed.
   */
  readonly orphanedAuthority: readonly string[];
  /**
   * Tasks whose live worktree still tracks its own copy. Deleting the
   * integration-tree copy does not touch those, and a `done` release would
   * fast-forward one back in — which is precisely what defects:D405's
   * `wip-retained` refusal exists to stop, inside the worktree, before release.
   */
  readonly pendingWorktreeDisposal: readonly string[];
}

export interface WipArtifactReconciliationInput {
  /** Tracked integration-tree artifact paths, e.g. `WIP-T2345.md`. */
  readonly trackedArtifacts: readonly string[];
  /**
   * Every registry context each artifact path appears in. A path absent from
   * the map has no references at all and is deletable.
   */
  readonly references: ReadonlyMap<string, readonly string[]>;
  /** Tasks whose current managed-worktree generation is live. */
  readonly liveGenerations: ReadonlySet<string>;
  /** Tasks for which Git still registers an `implement/<taskId>` worktree. */
  readonly registeredWorktrees: ReadonlySet<string>;
}

function taskNumber(taskId: string): number {
  return Number.parseInt(taskId.slice(1), 10);
}

/**
 * Classify every tracked artifact. Total over its input and order-independent:
 * the same tree yields the same report, and re-running it against the retained
 * set is a fixed point, so the reconciliation can be repeated safely.
 *
 * A path that is not a `WIP-<taskId>.md` is a caller error rather than
 * something to skip — silently ignoring it would let a mis-built input report
 * an empty deletion set and look like success.
 */
export function classifyWipArtifactReconciliation(
  input: WipArtifactReconciliationInput,
): WipArtifactReconciliationReport {
  const deletable: WipArtifactVerdict[] = [];
  const held: WipArtifactHeldVerdict[] = [];
  for (const path of input.trackedArtifacts) {
    const matched = WIP_ARTIFACT_RE.exec(path);
    if (matched === null) {
      throw new Error(`not a WIP artifact path: ${path} (expected WIP-<taskId>.md)`);
    }
    const taskId = matched[1]!;
    const liveWorktree: WipArtifactWorktreeState = {
      generation: input.liveGenerations.has(taskId) ? "live" : "released",
      registered: input.registeredWorktrees.has(taskId),
    };
    const claims = [
      ...new Set(
        (input.references.get(path) ?? []).filter(
          (context) => context !== HISTORICAL_WIP_REFERENCE,
        ),
      ),
    ].sort();
    if (claims.length === 0) deletable.push({ path, taskId, liveWorktree });
    else held.push({ path, taskId, liveWorktree, heldBy: claims });
  }

  const byTask = (left: { taskId: string }, right: { taskId: string }): number =>
    taskNumber(left.taskId) - taskNumber(right.taskId);
  const byNumber = (left: string, right: string): number => taskNumber(left) - taskNumber(right);
  return {
    delete: deletable.sort(byTask),
    retain: held.sort(byTask),
    orphanedAuthority: [...input.liveGenerations]
      .filter((taskId) => !input.registeredWorktrees.has(taskId))
      .sort(byNumber),
    pendingWorktreeDisposal: [...input.registeredWorktrees]
      .filter((taskId) => input.liveGenerations.has(taskId))
      .sort(byNumber),
  };
}
