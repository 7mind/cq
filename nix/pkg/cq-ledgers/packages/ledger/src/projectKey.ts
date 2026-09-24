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
 * Shallow-clone behaviour (D85 / H66): a shallow clone (`git clone --depth
 * N`) grafts its shallow-boundary commit to appear parentless, so
 * `firstCommitShas` would return that unstable boundary SHA instead of the
 * true root — silently resolving a DIFFERENT key than a full clone of the
 * same repo. We check {@link GitPlumbing.isShallowRepository} BEFORE deriving
 * and FAIL FAST rather than key off the boundary SHA. This check only
 * applies to the SHA-derivation path — `projectId`, when set, still wins
 * even in a shallow clone (checked first, above).
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

import {
  CQ_MANAGED_WORKTREES_SEGMENTS,
  HARNESS_NATIVE_WORKTREES_SEGMENTS,
} from "@cq/config";
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

/**
 * Path segments marking an agent worktree (D170). Both the native
 * `worktree-agent-<hex>` trees and the `implement/<taskId>` trees the flow
 * creates live under one of these. Two entries since D404 moved CQ's own
 * placement off the harness namespace: the guard must refuse a ledger opened
 * inside EITHER, or the cutover would silently reopen the hole D170 closed.
 */
export const AGENT_WORKTREE_SEGMENTS: readonly string[] = Object.freeze([
  CQ_MANAGED_WORKTREES_SEGMENTS.join("/"),
  HARNESS_NATIVE_WORKTREES_SEGMENTS.join("/"),
]);

/**
 * True when `repoRoot` lies inside an agent worktree (D170). Compared on path
 * SEGMENTS, so a directory merely *named* like the segment (e.g.
 * `my.claude/worktrees-notes`) does not match, and both separators are handled.
 */
export function isInsideAgentWorktree(repoRoot: string): boolean {
  const segments = repoRoot.split(/[/\\]+/);
  const parents = [CQ_MANAGED_WORKTREES_SEGMENTS, HARNESS_NATIVE_WORKTREES_SEGMENTS];
  for (let i = 0; i + 1 < segments.length; i++) {
    for (const parent of parents) {
      if (segments[i] === parent[0] && segments[i + 1] === parent[1]) return true;
    }
  }
  return false;
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
    // D91: an empty/blank projectId is not a valid key — resolveStateDirBase("")
    // collapses to the XDG *projects base* itself (path.join drops the trailing
    // empty segment), so a caller keying off this value would point erase/init
    // at every project's directory instead of one. FAIL FAST rather than let
    // that empty string flow downstream.
    if (opts.projectId.trim() === "") {
      throw new ProjectKeyResolutionError(
        `Cannot resolve a project key for ${opts.repoRoot}: [ledger].projectId is set but ` +
          `empty/blank. projectId must be a non-empty stable identifier — an empty value would ` +
          `resolve to the shared XDG projects BASE directory instead of a per-project one. Fix: ` +
          `set [ledger].projectId to a non-empty string in cq.toml, or remove the key so the ` +
          `repo's first commit SHA is used instead.`,
      );
    }
    return opts.projectId;
  }

  // D170: REFUSE to SHA-derive a key from inside an agent worktree.
  //
  // A worktree shares the repo's object database, so `firstCommitShas` returns
  // the SAME root SHA as the main checkout — by design (Q246, to keep every
  // worktree on ONE store). The consequence is that anything executed inside a
  // dispatched-agent worktree resolves the developer's LIVE store. That is how
  // the ledger was destroyed on 2026-07-27 (1147 active + 2278 archived items
  // replaced by one bootstrap milestone) and, by the same signature, once
  // before on 2026-07-25: a subagent ran `bun -e` with a module import from its
  // worktree, and the store's divergence path reinitialised canon.
  //
  // Refusing here is semantically correct, not merely defensive: by the flow's
  // own contract a dispatched worker NEVER mutates the ledger, so a worktree has
  // no business resolving the shared project store at all. This also covers
  // vectors a `bun test` preload cannot: `bun -e`, `bun run`, and the `cq` CLI.
  //
  // Deliberate overrides still work — an explicit [ledger].projectId returns
  // above, before this check, so a worktree that genuinely wants its own store
  // can pin one.
  if (isInsideAgentWorktree(opts.repoRoot)) {
    throw new ProjectKeyResolutionError(
      `Refusing to resolve a project key for ${opts.repoRoot}: it is inside an agent worktree ` +
        `(${AGENT_WORKTREE_SEGMENTS.join(" or ")}). A worktree shares the repo's object database, so the ` +
        `first-commit SHA would resolve the SAME out-of-tree store as the main checkout — the ` +
        `developer's LIVE ledger — and a divergent open can reinitialise it (D170: this ` +
        `destroyed 1147 active + 2278 archived items). Dispatched workers must not touch the ` +
        `shared ledger. Fix: point XDG_STATE_HOME at a throwaway directory for this process, or ` +
        `set [ledger].projectId = "<a stable identifier>" in the worktree's cq.toml to pin a ` +
        `separate store deliberately.`,
    );
  }

  const git = opts.git ?? GitPlumbing.withCwd(opts.repoRoot);

  // D85 / H66: a shallow clone grafts its shallow-boundary commit to appear
  // parentless, so `firstCommitShas` below WOULD return that unstable
  // boundary SHA (it does not come back empty — a shallow repo has a normal,
  // non-unborn HEAD) instead of the true root, silently resolving a DIFFERENT
  // key than a full clone of the same repo (Q246). Check explicitly before
  // deriving, rather than relying on the empty-roots no-root-commit path.
  if (await git.isShallowRepository()) {
    throw new ProjectKeyResolutionError(
      `Cannot resolve a project key for ${opts.repoRoot}: it is a SHALLOW git clone ` +
        `(e.g. \`git clone --depth N\`). \`git rev-list --max-parents=0 HEAD\` would return ` +
        `the shallow-boundary commit, not the repo's true root commit — that boundary SHA is ` +
        `unstable (it depends on the clone's depth, not the repo's history) and would silently ` +
        `resolve a DIFFERENT project key than a full clone of the same repo, splitting the ` +
        `out-of-tree ledger (Q246). Fix: set [ledger].projectId = "<a stable identifier>" in ` +
        `cq.toml, or use a full (non-shallow) clone.`,
    );
  }

  const roots = await git.firstCommitShas();
  const firstRoot = roots[0];
  if (firstRoot === undefined) {
    throw new ProjectKeyResolutionError(
      `Cannot identify the project at ${opts.repoRoot}: cq.toml sets no [ledger].projectId and ` +
        `there is no git root commit to key the ledger by. Set [ledger].projectId in cq.toml, ` +
        `make an initial commit, or run \`cq init --force\` to rewrite cq.toml with a generated ` +
        `projectId.`,
    );
  }
  return firstRoot;
}
