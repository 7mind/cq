/**
 * defects:D404 — where CQ-managed worktrees live.
 *
 * CQ's managed-worktree lifecycle is shared infrastructure, but its persistent
 * placement was spelled `<repositoryRoot>/.claude/worktrees` at eight
 * production sites in three packages: the parent of every freshly created
 * worktree, the registry root six callers derive independently, and the handle
 * integrity check. That put ONE external harness's namespace on a location that
 * Codex, Pi and CQ itself all write to.
 *
 * This module is the single definition. It deliberately distinguishes two
 * domains that the old literal conflated:
 *
 *  - CQ-MANAGED PLACEMENT — where CQ puts worktrees it owns. That is this
 *    module's business, and it is harness-neutral.
 *  - HARNESS-NATIVE ISOLATION — where Claude Code puts trees IT creates. CQ
 *    does not choose that path; it only has to RECOGNIZE it, for native
 *    confinement and the D170 store-safety guard.
 *
 * The two are exported separately so a later cutover moves the first without
 * breaking the second.
 */
import { join } from "node:path";

/** Claude Code's native isolation namespace. CQ recognizes it; it never picks it. */
export const HARNESS_NATIVE_WORKTREES_SEGMENTS: readonly string[] = Object.freeze([
  ".claude",
  "worktrees",
]);

/**
 * Where CQ places the worktrees it manages.
 *
 * Still `.claude/worktrees` at this step: naming the placement once is a
 * prerequisite for changing it, and changing it in the same step would move
 * ninety-seven live worktrees and their registry without a migration rule.
 */
export const CQ_MANAGED_WORKTREES_SEGMENTS: readonly string[] = HARNESS_NATIVE_WORKTREES_SEGMENTS;

/** The registry directory inside the managed-worktree parent. */
export const MANAGED_REGISTRY_DIRNAME = ".cq-managed-registry";

/** The parent directory CQ creates managed worktrees under. */
export function cqManagedWorktreesParent(repositoryRoot: string): string {
  return join(repositoryRoot, ...CQ_MANAGED_WORKTREES_SEGMENTS);
}

/**
 * The managed-worktree registry root: handles, recovery seals and per-task
 * current bindings. An explicit `stateDir` overrides it verbatim — every caller
 * that accepts one threads a test or host override through here.
 */
export function managedWorktreeRegistryRoot(
  repositoryRoot: string,
  stateDir?: string | undefined,
): string {
  if (stateDir !== undefined) return stateDir;
  return join(cqManagedWorktreesParent(repositoryRoot), MANAGED_REGISTRY_DIRNAME);
}
