/**
 * resolveProjectKey — repo-identity project keying for the out-of-tree ledger
 * store (G67, Q246).
 *
 * The out-of-tree store (XDG state dir, {@link resolveStateDir}) is keyed by
 * `projectKey` — a string that MUST resolve to the SAME value for every
 * worktree and every clone of one repo, so they all land on the same
 * out-of-tree store instead of silently splitting into several (the defect
 * Q246 rejects).
 *
 * Resolution order:
 *   1. `[ledger].projectId` from cq.toml, when present — committed,
 *      deterministic, and the explicit escape hatch for repos whose commit
 *      graph is not stable enough to key off (e.g. it gets rewritten).
 *   2. Otherwise, the repo's FIRST commit SHA: `git rev-list --max-parents=0
 *      HEAD` (see {@link GitPlumbing.firstCommitShas}). A commit SHA is
 *      stable across worktrees (they share one object database and ref
 *      namespace), clones (a full clone has an identical commit graph), and
 *      moves (it does not depend on the filesystem path at all) — exactly
 *      the properties a path-hash key would lack.
 *
 *      A history can have more than one root commit (e.g. after a
 *      `--allow-unrelated-histories` merge). We deterministically take the
 *      FIRST line `git rev-list --max-parents=0 HEAD` emits — the same
 *      choice for the same commit graph everywhere, per
 *      {@link GitPlumbing.firstCommitShas}'s ordering guarantee.
 *
 * No-git / empty-repo behaviour (decision, recorded here since the worker
 * cannot write to the ledger — see the Session summary of the task that
 * introduced this module for the orchestrator to file as a `decisions` item):
 *
 *   FAIL FAST with an actionable {@link ProjectKeyResolutionError} pointing the
 *   user at `[ledger].projectId`. We deliberately do NOT fall back to a hash
 *   of the repo path — a path-hash fallback is exactly the split-ledger
 *   defect Q246 rejects (two clones/worktrees at different paths would
 *   resolve to two different keys and silently diverge into two ledgers).
 *   A repo with no commits (or no git at all) has no stable identity to key
 *   off, so the correct behaviour is to refuse and ask the user to pin one
 *   explicitly via `projectId`, not to manufacture an unstable one.
 */

import { GitPlumbing } from "./store/git/GitPlumbing.js";

/**
 * Thrown when neither `[ledger].projectId` nor a git root commit is available
 * to key the out-of-tree store — see the no-fallback rationale above.
 */
export class ProjectKeyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectKeyResolutionError";
  }
}

/** Options for {@link resolveProjectKey}. */
export interface ResolveProjectKeyOpts {
  /** The repo root to derive a key for when `projectId` is absent. */
  readonly repoRoot: string;
  /**
   * The resolved `[ledger].projectId` from cq.toml (or `null` when absent) —
   * pass `config?.ledger?.projectId ?? null` from the loaded {@link CqConfig}.
   */
  readonly projectId: string | null;
  /**
   * Injected {@link GitPlumbing} (so a test drives a throwaway repo). Defaults
   * to `GitPlumbing.withCwd(repoRoot)`.
   */
  readonly git?: GitPlumbing;
}

/**
 * Resolve the stable `projectKey` for `opts.repoRoot`: `opts.projectId` when
 * present, else the repo's first commit SHA. Throws
 * {@link ProjectKeyResolutionError} when neither is available (see the
 * module-level no-fallback rationale).
 */
export async function resolveProjectKey(opts: ResolveProjectKeyOpts): Promise<string> {
  if (opts.projectId !== null) {
    return opts.projectId;
  }

  const git = opts.git ?? GitPlumbing.withCwd(opts.repoRoot);
  const roots = await git.firstCommitShas();
  const firstRoot = roots[0];
  if (firstRoot === undefined) {
    throw new ProjectKeyResolutionError(
      `Cannot resolve a project key for ${opts.repoRoot}: no [ledger].projectId is set in ` +
        `cq.toml, and \`git rev-list --max-parents=0 HEAD\` found no root commit (the directory ` +
        `is not a git repository, or it is a repo with no commits yet). The out-of-tree ledger ` +
        `store needs a repo identity that is stable across worktrees, clones, and moves — a ` +
        `path-hash fallback would silently split the ledger across clones (Q246), so this fails ` +
        `fast instead. Fix: set [ledger].projectId = "<a stable identifier>" in cq.toml, or make ` +
        `an initial commit so the repo has a root commit to key off.`,
    );
  }
  return firstRoot;
}
