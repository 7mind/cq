/**
 * resolveProjectKey tests (T496, G67-B) — repo-identity project keying.
 *
 * Exercises the resolution order against THROWAWAY `/tmp` git repos (created
 * with `os.tmpdir()` + `mkdtemp`, removed in `afterAll`):
 *   - `projectId` (when present) overrides any git derivation entirely.
 *   - absent `projectId` derives the repo's first-commit SHA via
 *     `git rev-list --max-parents=0 HEAD`.
 *   - two `git worktree add` worktrees of one repo resolve the SAME key.
 *   - a `git clone` of the repo resolves the SAME key.
 *   - a non-git directory FAILS FAST with `ProjectKeyResolutionError` (no
 *     silent path-hash fallback — Q246).
 *   - a git repo with no commits yet (unborn HEAD) also FAILS FAST.
 *
 * Never touches this worktree's own `.git`.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { GitPlumbing, ProjectKeyResolutionError, resolveProjectKey } from "../src/index.js";

const exec = promisify(execFile);

const dirs: string[] = [];

/** Run a raw git command in `cwd`, returning trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

/** A fresh, empty tmp directory (tracked for cleanup). */
async function freshDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Create a fresh git repo with one commit, returning its root dir. */
async function seedRepo(prefix = "project-key-"): Promise<string> {
  const dir = await freshDir(prefix);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "seed.txt"), "seed\n");
  await git(dir, "add", "seed.txt");
  await git(dir, "commit", "-q", "-m", "root commit");
  return dir;
}

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

describe("resolveProjectKey", () => {
  it("returns projectId directly when present, without touching git", async () => {
    const dir = await freshDir("project-key-no-git-");
    const key = await resolveProjectKey({ repoRoot: dir, projectId: "committed-project-id" });
    expect(key).toBe("committed-project-id");
  });

  it("projectId OVERRIDES the SHA derivation even inside a real repo", async () => {
    const dir = await seedRepo();
    const shaKey = await resolveProjectKey({ repoRoot: dir, projectId: null });
    const overriddenKey = await resolveProjectKey({ repoRoot: dir, projectId: "pinned-id" });
    expect(overriddenKey).toBe("pinned-id");
    expect(overriddenKey).not.toBe(shaKey);
  });

  it("derives the first-commit SHA when projectId is absent", async () => {
    const dir = await seedRepo();
    const expectedSha = await git(dir, "rev-list", "--max-parents=0", "HEAD");
    const key = await resolveProjectKey({ repoRoot: dir, projectId: null });
    expect(key).toBe(expectedSha);
  });

  it("two worktrees of one repo resolve the IDENTICAL key", async () => {
    const dir = await seedRepo();
    await git(dir, "branch", "feature");
    const worktreeDir = await freshDir("project-key-worktree-");
    // git worktree add requires the target to not already exist as a non-empty
    // dir it manages itself; remove the mkdtemp-created empty dir first so git
    // can create it fresh.
    await fs.rm(worktreeDir, { recursive: true, force: true });
    await git(dir, "worktree", "add", "-q", worktreeDir, "feature");

    const keyMain = await resolveProjectKey({ repoRoot: dir, projectId: null });
    const keyWorktree = await resolveProjectKey({ repoRoot: worktreeDir, projectId: null });
    expect(keyWorktree).toBe(keyMain);
  });

  it("a clone of the repo resolves the SAME key", async () => {
    const dir = await seedRepo();
    const cloneDir = await freshDir("project-key-clone-");
    await fs.rm(cloneDir, { recursive: true, force: true });
    await git(dir, "clone", "-q", dir, cloneDir);

    const keyOriginal = await resolveProjectKey({ repoRoot: dir, projectId: null });
    const keyClone = await resolveProjectKey({ repoRoot: cloneDir, projectId: null });
    expect(keyClone).toBe(keyOriginal);
  });

  it("picks the deterministic FIRST root for a history with multiple root commits", async () => {
    const dir = await seedRepo();
    const rootA = await git(dir, "rev-list", "--max-parents=0", "HEAD");

    await git(dir, "checkout", "-q", "--orphan", "other");
    await git(dir, "rm", "-rf", "-q", ".");
    await fs.writeFile(path.join(dir, "other.txt"), "other root\n");
    await git(dir, "add", "other.txt");
    await git(dir, "commit", "-q", "-m", "other root commit");
    await git(dir, "checkout", "-q", "main");
    await git(dir, "merge", "--allow-unrelated-histories", "-q", "-m", "merge", "other");

    const roots = (await git(dir, "rev-list", "--max-parents=0", "HEAD")).split("\n");
    expect(roots.length).toBe(2);
    const expectedFirst = roots[0];
    if (expectedFirst === undefined) throw new Error("expected a first root SHA");
    const key = await resolveProjectKey({ repoRoot: dir, projectId: null });
    // Deterministic: the first line git emits, which is rootA here (documented
    // choice — see GitPlumbing.firstCommitShas and the projectKey.ts module doc).
    expect(key).toBe(expectedFirst);
    expect(key).toBe(rootA);
  });

  it("FAILS FAST (no path-hash fallback) for a non-git directory", async () => {
    const dir = await freshDir("project-key-not-git-");
    await expect(resolveProjectKey({ repoRoot: dir, projectId: null })).rejects.toThrow(
      ProjectKeyResolutionError,
    );
  });

  it("FAILS FAST for a git repo with no commits yet (unborn HEAD)", async () => {
    const dir = await freshDir("project-key-unborn-");
    await git(dir, "init", "-q", "-b", "main");
    await expect(resolveProjectKey({ repoRoot: dir, projectId: null })).rejects.toThrow(
      ProjectKeyResolutionError,
    );
  });

  it("the fail-fast error message points at [ledger].projectId", async () => {
    const dir = await freshDir("project-key-message-");
    try {
      await resolveProjectKey({ repoRoot: dir, projectId: null });
      throw new Error("expected resolveProjectKey to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectKeyResolutionError);
      expect((err as Error).message).toContain("projectId");
    }
  });

  it("accepts an injected GitPlumbing (test seam)", async () => {
    const dir = await seedRepo();
    const git_ = GitPlumbing.withCwd(dir);
    const expectedSha = await git(dir, "rev-list", "--max-parents=0", "HEAD");
    const key = await resolveProjectKey({ repoRoot: dir, projectId: null, git: git_ });
    expect(key).toBe(expectedSha);
  });

  // D85 / H66: a shallow clone grafts the shallow-boundary commit to appear
  // parentless, so `git rev-list --max-parents=0 HEAD` returns that boundary
  // SHA rather than the true root — a shallow clone would silently resolve a
  // DIFFERENT projectKey than a full clone of the same repo (splitting the
  // out-of-tree ledger, Q246) unless we fail fast instead.
  it("FAILS FAST (no unstable boundary-SHA key) for a SHALLOW clone", async () => {
    const srcDir = await seedRepo();
    // A second commit so the shallow boundary commit is provably NOT the true
    // root (the shallow clone's HEAD~0 differs from the source's root commit).
    await fs.writeFile(path.join(srcDir, "second.txt"), "second\n");
    await git(srcDir, "add", "second.txt");
    await git(srcDir, "commit", "-q", "-m", "second commit");

    const shallowDir = await freshDir("project-key-shallow-");
    await fs.rm(shallowDir, { recursive: true, force: true });
    // file:// is REQUIRED: git ignores --depth for plain-path local clones.
    await git(srcDir, "clone", "-q", "--depth", "1", `file://${srcDir}`, shallowDir);
    const isShallow = await git(shallowDir, "rev-parse", "--is-shallow-repository");
    expect(isShallow).toBe("true");

    await expect(resolveProjectKey({ repoRoot: shallowDir, projectId: null })).rejects.toThrow(
      ProjectKeyResolutionError,
    );
  });

  it("a FULL clone still resolves the true-root-based key (unaffected by the shallow guard)", async () => {
    const srcDir = await seedRepo();
    await fs.writeFile(path.join(srcDir, "second.txt"), "second\n");
    await git(srcDir, "add", "second.txt");
    await git(srcDir, "commit", "-q", "-m", "second commit");

    const fullCloneDir = await freshDir("project-key-full-clone-");
    await fs.rm(fullCloneDir, { recursive: true, force: true });
    await git(srcDir, "clone", "-q", `file://${srcDir}`, fullCloneDir);

    const expectedSha = await git(srcDir, "rev-list", "--max-parents=0", "HEAD");
    const key = await resolveProjectKey({ repoRoot: fullCloneDir, projectId: null });
    expect(key).toBe(expectedSha);
  });

  // D91: an empty/blank projectId must FAIL FAST rather than be returned
  // verbatim — resolveStateDirBase("") collapses to the shared XDG *projects
  // base* itself (path.join drops the trailing empty segment), so a caller
  // (e.g. `cq erase`'s xdg branch) keying off an empty string would point a
  // recursive delete at the base directory shared by EVERY project instead of
  // one project's subdirectory — an irreversible, catastrophic data-loss bug.
  it("D91: THROWS ProjectKeyResolutionError for an empty-string projectId (was: returned \"\" verbatim)", async () => {
    const dir = await freshDir("project-key-empty-id-");
    await expect(resolveProjectKey({ repoRoot: dir, projectId: "" })).rejects.toThrow(
      ProjectKeyResolutionError,
    );
  });

  it("D91: THROWS ProjectKeyResolutionError for a whitespace-only projectId", async () => {
    const dir = await freshDir("project-key-blank-id-");
    await expect(resolveProjectKey({ repoRoot: dir, projectId: "   " })).rejects.toThrow(
      ProjectKeyResolutionError,
    );
  });

  it("D91: the empty-projectId error message is actionable (mentions projectId)", async () => {
    const dir = await freshDir("project-key-empty-id-message-");
    try {
      await resolveProjectKey({ repoRoot: dir, projectId: "" });
      throw new Error("expected resolveProjectKey to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectKeyResolutionError);
      expect((err as Error).message).toContain("projectId");
    }
  });

  it("projectId OVERRIDES even in a shallow clone (no throw)", async () => {
    const srcDir = await seedRepo();
    await fs.writeFile(path.join(srcDir, "second.txt"), "second\n");
    await git(srcDir, "add", "second.txt");
    await git(srcDir, "commit", "-q", "-m", "second commit");

    const shallowDir = await freshDir("project-key-shallow-pinned-");
    await fs.rm(shallowDir, { recursive: true, force: true });
    await git(srcDir, "clone", "-q", "--depth", "1", `file://${srcDir}`, shallowDir);

    const key = await resolveProjectKey({ repoRoot: shallowDir, projectId: "pinned-id" });
    expect(key).toBe("pinned-id");
  });
});
