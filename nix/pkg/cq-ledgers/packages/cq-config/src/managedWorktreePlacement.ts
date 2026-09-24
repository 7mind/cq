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
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Claude Code's native isolation namespace. CQ recognizes it; it never picks it. */
export const HARNESS_NATIVE_WORKTREES_SEGMENTS: readonly string[] = Object.freeze([
  ".claude",
  "worktrees",
]);

/** Where CQ places the worktrees it manages. Harness-neutral by design. */
export const CQ_MANAGED_WORKTREES_SEGMENTS: readonly string[] = Object.freeze([
  ".cq",
  "worktrees",
]);

/** The registry directory inside the managed-worktree parent. */
export const MANAGED_REGISTRY_DIRNAME = ".cq-managed-registry";

/** The parent directory CQ creates managed worktrees under. */
export function cqManagedWorktreesParent(repositoryRoot: string): string {
  return join(repositoryRoot, ...CQ_MANAGED_WORKTREES_SEGMENTS);
}

/**
 * The parent the external harness creates ITS worktrees under. CQ never
 * chooses this path; it recognizes it, because trees created before the D404
 * cutover live there and must keep working.
 */
export function harnessNativeWorktreesParent(repositoryRoot: string): string {
  return join(repositoryRoot, ...HARNESS_NATIVE_WORKTREES_SEGMENTS);
}

/**
 * Parents a STORED managed path may legitimately lie under: the CQ placement
 * and, for anything created before the cutover, the harness-native one. Order
 * is canonical-first; callers that only need containment may treat it as a set.
 */
export function acceptedManagedWorktreeParents(repositoryRoot: string): readonly string[] {
  return Object.freeze([
    cqManagedWorktreesParent(repositoryRoot),
    harnessNativeWorktreesParent(repositoryRoot),
  ]);
}

/**
 * Decide the managed-worktree registry root — where handles, recovery seals
 * and per-task current bindings live — across the D404 migration boundary.
 *
 * The registry is NOT moved by the cutover: a repository that already has one
 * under the harness-native parent keeps using it, because its live handles,
 * seals and task bindings are in that directory and no code change relocates
 * them. Only a repository with no registry yet, or one already migrated, uses
 * the CQ location.
 *
 * Two registries means a half-finished migration. Picking either silently
 * orphans the other's seals, so this refuses instead of guessing.
 *
 * `exists` is injected so both arms are provable without a filesystem;
 * {@link managedWorktreeRegistryRoot} applies the same rule to the real one.
 */
export function selectManagedWorktreeRegistryRoot(input: {
  readonly repositoryRoot: string;
  readonly stateDir: string | undefined;
  readonly exists: (candidate: string) => boolean;
}): string {
  if (input.stateDir !== undefined) return input.stateDir;
  const canonical = join(cqManagedWorktreesParent(input.repositoryRoot), MANAGED_REGISTRY_DIRNAME);
  const legacy = join(
    harnessNativeWorktreesParent(input.repositoryRoot),
    MANAGED_REGISTRY_DIRNAME,
  );
  const hasCanonical = input.exists(canonical);
  const hasLegacy = input.exists(legacy);
  if (hasCanonical && hasLegacy) {
    throw new Error(
      `managed worktree registry exists in both ${canonical} and ${legacy}; ` +
        "a migration left two registries and neither can be chosen without orphaning the other",
    );
  }
  return hasLegacy ? legacy : canonical;
}

/**
 * The registry root for the real filesystem. An explicit `stateDir` overrides
 * it verbatim — every caller that accepts one threads a test or host override
 * through here.
 */
export function managedWorktreeRegistryRoot(
  repositoryRoot: string,
  stateDir?: string | undefined,
): string {
  return selectManagedWorktreeRegistryRoot({
    repositoryRoot,
    stateDir,
    exists: (candidate) => existsSync(candidate),
  });
}
