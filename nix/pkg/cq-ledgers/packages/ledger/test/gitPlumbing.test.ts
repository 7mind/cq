/**
 * GitPlumbing tests (T348) — mirror the K66 orphan-ledger PoC proof
 * (`debug/20260609-221530-orphan-ledger-poc.sh`) against a THROWAWAY `/tmp` git
 * repo. They assert the central invariant: advancing an orphan ref two commits
 * via the plumbing wrapper leaves the main checkout's HEAD sha, `git status
 * --porcelain`, working-tree bytes, and index sha BYTE-IDENTICAL — no checkout,
 * no real-index mutation. Plus: a CAS `updateRef` with a stale `expectedOld`
 * throws `StaleRefError`, and `catFile`/`lsTree` read back content with NO
 * checkout.
 *
 * The throwaway repo is created with `os.tmpdir()` + `mkdtemp` and removed in a
 * `finally`/`afterAll`. The test NEVER touches the worktree's own `.git`.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { GitCommandError, GitPlumbing, StaleRefError } from "../src/index.js";

const exec = promisify(execFile);

const LEDGER_BRANCH = "refs/heads/cq-ledger";
const LEDGER_PATH = "docs/tasks.md";

const repos: string[] = [];

/** Run a raw git command in `cwd`, returning trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

/** Create a fresh seeded repo with one real commit + one tracked working file. */
async function seedRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "git-plumbing-"));
  repos.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "src.txt"), "real source file, must stay byte-identical\n");
  await git(dir, "add", "src.txt");
  await git(dir, "commit", "-q", "-m", "main: initial");
  return dir;
}

/** sha256 of all tracked working-tree files (excludes .git) — mirrors PoC. */
async function workingTreeDigest(dir: string): Promise<string> {
  const list = (await git(dir, "ls-files")).split("\n").filter((l) => l.length > 0);
  const h = createHash("sha256");
  for (const rel of list.sort()) {
    h.update(rel);
    h.update("\0");
    h.update(await fs.readFile(path.join(dir, rel)));
  }
  return h.digest("hex");
}

/** sha256 of the index (`git ls-files -s`) — mirrors PoC index digest. */
async function indexDigest(dir: string): Promise<string> {
  return createHash("sha256")
    .update(await git(dir, "ls-files", "-s"))
    .digest("hex");
}

afterAll(async () => {
  for (const d of repos) await fs.rm(d, { recursive: true, force: true });
});

describe("GitPlumbing", () => {
  let dir: string;
  let plumbing: GitPlumbing;

  beforeAll(async () => {
    dir = await seedRepo();
    // scratch index files live in the repo's .git dir, as the PoC does; the
    // wrapper removes them per writeTree call regardless.
    plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
  });

  it("advances an orphan ref two commits while the main checkout stays byte-identical", async () => {
    // capture BEFORE state of the main checkout
    const headBefore = await git(dir, "rev-parse", "HEAD");
    const refBefore = await git(dir, "symbolic-ref", "HEAD");
    const wtBefore = await workingTreeDigest(dir);
    const statusBefore = await git(dir, "status", "--porcelain");
    const indexBefore = await indexDigest(dir);

    // Round 1 — orphan (no parent)
    const blob1 = await plumbing.hashObject("# tasks\n\nT1 planned\n");
    const tree1 = await plumbing.writeTree([{ mode: "100644", sha: blob1, path: LEDGER_PATH }]);
    const commit1 = await plumbing.commitTree(tree1, null, "ledger: round 1");
    await plumbing.updateRef(LEDGER_BRANCH, commit1, null);

    // Round 2 — child of round 1
    const blob2 = await plumbing.hashObject("# tasks\n\nT1 done\nT2 planned\n");
    const tree2 = await plumbing.writeTree([{ mode: "100644", sha: blob2, path: LEDGER_PATH }]);
    const commit2 = await plumbing.commitTree(tree2, commit1, "ledger: round 2");
    await plumbing.updateRef(LEDGER_BRANCH, commit2, commit1);

    // the orphan ref advanced two distinct commits
    expect(commit1).not.toBe(commit2);
    expect(await plumbing.readRef(LEDGER_BRANCH)).toBe(commit2);

    // round-1 commit is a TRUE orphan (no parents)
    const parentsOfL1 = await git(dir, "rev-list", "--parents", "-n1", commit1);
    expect(parentsOfL1.split(/\s+/).length).toBe(1);

    // capture AFTER state and compare — must be byte-identical
    expect(await git(dir, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(dir, "symbolic-ref", "HEAD")).toBe(refBefore);
    expect(await workingTreeDigest(dir)).toBe(wtBefore);
    expect(await git(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(await git(dir, "status", "--porcelain")).toBe("");
    expect(await indexDigest(dir)).toBe(indexBefore);
  });

  it("reads back content with NO checkout via catFile and lsTree", async () => {
    // ref already at round-2 from the previous test
    expect(await plumbing.catFile(LEDGER_BRANCH, LEDGER_PATH)).toBe("# tasks\n\nT1 done\nT2 planned\n");
    expect(await plumbing.lsTree(LEDGER_BRANCH)).toEqual([LEDGER_PATH]);
    // and reading the parent (round-1) commit directly still works without checkout
    const head = await plumbing.readRef(LEDGER_BRANCH);
    expect(head).not.toBeNull();
  });

  it("returns null from readRef for a non-existent ref", async () => {
    expect(await plumbing.readRef("refs/heads/does-not-exist")).toBeNull();
  });

  it("throws StaleRefError when CAS updateRef sees a stale expectedOld", async () => {
    const current = await plumbing.readRef(LEDGER_BRANCH);
    expect(current).not.toBeNull();

    const blob = await plumbing.hashObject("# tasks\n\nstale attempt\n");
    const tree = await plumbing.writeTree([{ mode: "100644", sha: blob, path: LEDGER_PATH }]);
    const commit = await plumbing.commitTree(tree, current, "ledger: stale attempt");

    const staleOld = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    await expect(plumbing.updateRef(LEDGER_BRANCH, commit, staleOld)).rejects.toBeInstanceOf(
      StaleRefError,
    );
    // the ref did NOT move under the failed CAS
    expect(await plumbing.readRef(LEDGER_BRANCH)).toBe(current);
  });

  it("throws StaleRefError when CAS expects absence but the ref exists", async () => {
    const current = await plumbing.readRef(LEDGER_BRANCH);
    expect(current).not.toBeNull();
    const blob = await plumbing.hashObject("# tasks\n\nclobber\n");
    const tree = await plumbing.writeTree([{ mode: "100644", sha: blob, path: LEDGER_PATH }]);
    const commit = await plumbing.commitTree(tree, current, "ledger: clobber attempt");
    // expectedOld=null asserts the ref must NOT exist, but it does → stale
    await expect(plumbing.updateRef(LEDGER_BRANCH, commit, null)).rejects.toBeInstanceOf(
      StaleRefError,
    );
  });

  // D49: updateRef must distinguish CAS mismatch from other git failures.

  it("D49: CAS mismatch with a genuinely stale expectedOld throws StaleRefError (not GitCommandError)", async () => {
    // The ref is currently at some commit; supply a stale (wrong) expectedOld so
    // git rejects the CAS with "is at ... but expected ...".
    const current = await plumbing.readRef(LEDGER_BRANCH);
    expect(current).not.toBeNull();

    const blob = await plumbing.hashObject("# tasks\n\nD49 CAS test\n");
    const tree = await plumbing.writeTree([{ mode: "100644", sha: blob, path: LEDGER_PATH }]);
    const newCommit = await plumbing.commitTree(tree, current, "ledger: D49 cas attempt");

    const staleOld = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const err = await plumbing
      .updateRef(LEDGER_BRANCH, newCommit, staleOld)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StaleRefError);
    expect(err).not.toBeInstanceOf(GitCommandError);
    // The ref must not have moved.
    expect(await plumbing.readRef(LEDGER_BRANCH)).toBe(current);
  });

  it("D49: updateRef with a nonexistent newSha throws GitCommandError (not StaleRefError)", async () => {
    // A well-formed but nonexistent SHA as newSha triggers "nonexistent object"
    // in git's stderr — this is a programming error, not a concurrency signal,
    // and must surface as GitCommandError.
    const current = await plumbing.readRef(LEDGER_BRANCH);
    expect(current).not.toBeNull();

    const nonexistentSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const err = await plumbing
      .updateRef(LEDGER_BRANCH, nonexistentSha, current)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitCommandError);
    expect(err).not.toBeInstanceOf(StaleRefError);
    // The ref must not have moved.
    expect(await plumbing.readRef(LEDGER_BRANCH)).toBe(current);
  });

  it("builds nested-path subtrees automatically (multi-file tree)", async () => {
    const blobA = await plumbing.hashObject("alpha\n");
    const blobB = await plumbing.hashObject("beta\n");
    const tree = await plumbing.writeTree([
      { mode: "100644", sha: blobA, path: "docs/a.md" },
      { mode: "100644", sha: blobB, path: "docs/sub/b.md" },
    ]);
    const commit = await plumbing.commitTree(tree, null, "multi");
    await plumbing.updateRef("refs/heads/multi-test", commit, null);
    expect((await plumbing.lsTree("refs/heads/multi-test")).sort()).toEqual([
      "docs/a.md",
      "docs/sub/b.md",
    ]);
    expect(await plumbing.catFile("refs/heads/multi-test", "docs/sub/b.md")).toBe("beta\n");
  });

  it("tags a commit via tagRef and resolves it through readRef", async () => {
    const head = await plumbing.readRef(LEDGER_BRANCH);
    expect(head).not.toBeNull();
    await plumbing.tagRef("cq-ledger-snapshot", head as string);
    expect(await plumbing.readRef("refs/tags/cq-ledger-snapshot")).toBe(head);
  });
});
