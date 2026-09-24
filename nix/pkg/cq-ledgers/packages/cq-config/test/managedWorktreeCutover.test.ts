/**
 * defects:D404 step 2 — move CQ-managed placement off the harness namespace.
 *
 * Step 1 gave the placement one definition. This is the cutover, and the whole
 * risk lives in what must NOT move with it. At the time of writing this
 * repository has ninety-seven live worktrees and a live registry under
 * `.claude/worktrees`, so a mechanical rename would strand every one of them.
 *
 * Four things therefore stay able to recognize the harness-native parent:
 *   - stored handle integrity, so live handles keep validating;
 *   - managed-cwd detection, so a live tree is still a managed tree;
 *   - the D170 store-safety guard, which must refuse a ledger opened inside
 *     ANY agent worktree, old placement or new;
 *   - legacy adoption, which by definition adopts a pre-cutover tree.
 *
 * Only FRESH creation and the registry's canonical location move.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  CQ_MANAGED_WORKTREES_SEGMENTS,
  HARNESS_NATIVE_WORKTREES_SEGMENTS,
  MANAGED_REGISTRY_DIRNAME,
  cqManagedWorktreesParent,
  harnessNativeWorktreesParent,
  selectManagedWorktreeRegistryRoot,
} from "../src/managedWorktreePlacement.js";
import {
  MANAGED_WORKTREE_HANDLE_KIND,
  validateManagedWorktreeHandle,
} from "../src/managedWorktreeHandle.js";
import { isManagedWorktreePath } from "../src/nativeDispatchQualification.js";

const REPO = "/repo";
const CQ_REGISTRY = path.join(REPO, ".cq", "worktrees", MANAGED_REGISTRY_DIRNAME);
const LEGACY_REGISTRY = path.join(REPO, ".claude", "worktrees", MANAGED_REGISTRY_DIRNAME);
const UUID = "0192f3a1-7c2b-7e10-9a44-2f5b6c7d8e9f";

function handle(absolutePath: string): Record<string, unknown> {
  return {
    kind: MANAGED_WORKTREE_HANDLE_KIND,
    version: 1,
    token: "tok-d404",
    worktreeId: UUID,
    taskId: "T4242",
    branch: "implement/T4242",
    repositoryRoot: REPO,
    absolutePath,
    baseCommit: "a".repeat(40),
    createdAt: "2026-09-24T00:00:00.000Z",
    nonce: "nonce-d404",
  };
}

describe("D404 managed worktree placement cutover", () => {
  test("CQ places its own worktrees under .cq, not under a harness namespace", () => {
    expect([...CQ_MANAGED_WORKTREES_SEGMENTS]).toEqual([".cq", "worktrees"]);
    expect(cqManagedWorktreesParent(REPO)).toBe(path.join(REPO, ".cq", "worktrees"));
    // The recognizer keeps its own, unchanged value.
    expect([...HARNESS_NATIVE_WORKTREES_SEGMENTS]).toEqual([".claude", "worktrees"]);
    expect(harnessNativeWorktreesParent(REPO)).toBe(path.join(REPO, ".claude", "worktrees"));
    expect(cqManagedWorktreesParent(REPO)).not.toBe(harnessNativeWorktreesParent(REPO));
  });

  describe("registry resolution across the migration boundary", () => {
    const select = (present: readonly string[], stateDir?: string): string =>
      selectManagedWorktreeRegistryRoot({
        repositoryRoot: REPO,
        stateDir,
        exists: (candidate) => present.includes(candidate),
      });

    test("a fresh repository uses the CQ location", () => {
      expect(select([])).toBe(CQ_REGISTRY);
    });

    test("a repository whose registry predates the cutover keeps using it", () => {
      // This is the anti-stranding rule: ninety-seven live worktrees' handles,
      // seals and task bindings live in that directory and are NOT moved by a
      // code change.
      expect(select([LEGACY_REGISTRY])).toBe(LEGACY_REGISTRY);
    });

    test("a migrated repository uses the CQ location even though the parent remains", () => {
      expect(select([CQ_REGISTRY])).toBe(CQ_REGISTRY);
    });

    test("two registries is a half-finished migration and is refused, not guessed", () => {
      // Picking either one silently orphans the other's seals and bindings.
      expect(() => select([CQ_REGISTRY, LEGACY_REGISTRY])).toThrow(/both/i);
    });

    test("an explicit stateDir wins over both and never probes", () => {
      let probed = false;
      const root = selectManagedWorktreeRegistryRoot({
        repositoryRoot: REPO,
        stateDir: "/injected/state",
        exists: () => {
          probed = true;
          return true;
        },
      });
      expect(root).toBe("/injected/state");
      expect(probed).toBe(false);
    });
  });

  test("a live handle under the harness-native parent still validates", () => {
    const live = validateManagedWorktreeHandle(
      handle(`${REPO}/.claude/worktrees/${UUID}`),
      REPO,
    );
    expect(live.status).toBe("valid");
  });

  test("a handle under the CQ parent validates too", () => {
    const fresh = validateManagedWorktreeHandle(handle(`${REPO}/.cq/worktrees/${UUID}`), REPO);
    expect(fresh.status).toBe("valid");
  });

  test("a handle outside both managed parents is still refused", () => {
    const foreign = validateManagedWorktreeHandle(handle(`${REPO}/elsewhere/${UUID}`), REPO);
    expect(foreign.status).toBe("invalid");
    // And the basename rule still binds inside an accepted parent.
    const renamed = validateManagedWorktreeHandle(
      handle(`${REPO}/.cq/worktrees/not-the-worktree-id`),
      REPO,
    );
    expect(renamed.status).toBe("invalid");
  });

  test("managed-cwd detection accepts both parents and still rejects traversal", () => {
    expect(isManagedWorktreePath(`${REPO}/.claude/worktrees/${UUID}`)).toBe(true);
    expect(isManagedWorktreePath(`${REPO}/.cq/worktrees/${UUID}`)).toBe(true);
    expect(isManagedWorktreePath(`${REPO}/.cq/worktrees/implement-T42`)).toBe(true);
    expect(isManagedWorktreePath(`${REPO}/.cq/worktrees/${UUID}/../escape`)).toBe(false);
    expect(isManagedWorktreePath(`${REPO}/.cq/worktrees/${UUID}/nested`)).toBe(false);
    expect(isManagedWorktreePath(`${REPO}/.cq/worktrees/not-an-id`)).toBe(false);
  });
});
