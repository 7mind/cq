/**
 * Ref-sha coherence watcher tests (T353 / G43).
 *
 * 1. Cross-instance coherence: two GitObjectLedgerBackend instances on the SAME
 *    throwaway repo — a write through instance A advances the orphan ref, and
 *    after the watcher fires, instance B's reads reflect A's write; onChange is
 *    invoked with the ledger id.
 *
 * 2. Git-dir indirection robustness: the watcher still detects the ref advance
 *    when the repo's git dir is at a non-default path (a linked worktree where
 *    `.git` is a file, not a directory, and GIT_DIR points elsewhere). The ref
 *    is resolved via `git rev-parse --verify` — never a hard-coded
 *    `.git/refs/heads/…` path.
 *
 * Throwaway repos use mkdtemp; cleaned up in afterAll. Tests never touch the
 * worktree's own .git.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  GitObjectLedgerBackend,
  GitPlumbing,
  nodeGitRunner,
  type GitRunner,
  type LedgerSchema,
} from "@cq/ledger";
import { startLedgerRefWatcher } from "../src/refWatcher.js";

const exec = promisify(execFile);
const BRANCH = "cq-ledger";

const repos: string[] = [];

/** Run a raw git command in `cwd`, returning trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return stdout.trim();
}

/** Create a fresh seeded repo with one real commit. */
async function seedRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "ref-watcher-"));
  repos.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "README.md"), "test\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

const widgetsSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { note: { type: "string", required: true } },
};

async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

afterAll(async () => {
  for (const d of repos) await fs.rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: cross-instance coherence
// ---------------------------------------------------------------------------

describe("startLedgerRefWatcher — cross-instance coherence", () => {
  it("invalidates B's cache after A writes through the git backend, onChange called per ledger", async () => {
    const dir = await seedRepo();

    // Instance A: init + create the ledger + a milestone so B has context.
    const storeA = new GitObjectLedgerBackend({ repoRoot: dir });
    await storeA.init();
    await storeA.createLedger("widgets", widgetsSchema);
    const ms = await storeA.createMilestone({ id: "M1", title: "m1" });

    // Instance B: init (reads the same ref state A wrote).
    const storeB = new GitObjectLedgerBackend({ repoRoot: dir });
    await storeB.init();

    // B sees no items yet (A hasn't written any).
    expect(storeB.fetch("widgets").milestones.flatMap((g) => g.items)).toHaveLength(0);

    // Wire the watcher onto B with the production runner so it polls the real ref.
    const changedIds: string[] = [];
    const runner: GitRunner = nodeGitRunner(dir);
    const watcher = startLedgerRefWatcher(storeB, BRANCH, runner, (id) => {
      if (id !== null) changedIds.push(id);
    }, 50 /* fast poll for tests */);

    // A writes an item — advances the orphan ref.
    await storeA.createItem("widgets", ms.id, {
      status: "open",
      fields: { note: "from A" },
    });

    // After the watcher fires, B should see the item A wrote.
    const coherent = await waitUntil(
      () =>
        storeB
          .fetch("widgets")
          .milestones.flatMap((g) => g.items)
          .some((i) => i.fields["note"] === "from A"),
    );
    expect(coherent).toBe(true);

    // onChange was called with the "widgets" ledger id.
    expect(changedIds).toContain("widgets");

    watcher.close();
    await storeA.dispose();
    await storeB.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 2: git-dir indirection (linked worktree — .git is a FILE, not a dir)
// ---------------------------------------------------------------------------

describe("startLedgerRefWatcher — git-dir indirection robustness", () => {
  it("detects ref advance when .git is a file (linked worktree) via rev-parse --verify", async () => {
    // Create a bare-style source repo.
    const sourceDir = await seedRepo();

    // Create a linked worktree — in this worktree .git is a TEXT FILE pointing
    // to the real git dir, not a directory. This is the pattern that breaks
    // watchers that hard-code `.git/refs/heads/<branch>`.
    const linkedDir = await fs.mkdtemp(path.join(tmpdir(), "ref-watcher-linked-"));
    repos.push(linkedDir);
    await git(sourceDir, "worktree", "add", "--detach", linkedDir);

    // Verify the linked worktree's .git is indeed a file, not a directory.
    const dotGitStat = await fs.stat(path.join(linkedDir, ".git"));
    expect(dotGitStat.isFile()).toBe(true);

    // Instance A operates on the SOURCE repo's working tree (via nodeGitRunner
    // bound to sourceDir) — writes advance the orphan ref in the shared git store.
    const storeA = new GitObjectLedgerBackend({ repoRoot: sourceDir });
    await storeA.init();
    await storeA.createLedger("widgets", widgetsSchema);
    const ms = await storeA.createMilestone({ id: "M2", title: "m2" });

    // Instance B operates on the LINKED worktree — its runner resolves the ref
    // via `git rev-parse --verify`, which follows the `.git` file indirection.
    const storeB = new GitObjectLedgerBackend({ repoRoot: linkedDir });
    await storeB.init();

    expect(storeB.fetch("widgets").milestones.flatMap((g) => g.items)).toHaveLength(0);

    const changedIds: string[] = [];
    const runner: GitRunner = nodeGitRunner(linkedDir);
    const watcher = startLedgerRefWatcher(storeB, BRANCH, runner, (id) => {
      if (id !== null) changedIds.push(id);
    }, 50 /* fast poll for tests */);

    // A writes through the source repo's runner — orphan ref advances.
    await storeA.createItem("widgets", ms.id, {
      status: "open",
      fields: { note: "via indirection" },
    });

    // The watcher on the LINKED worktree must still detect the advance because
    // it uses `git rev-parse --verify` (which follows .git-file indirection),
    // NOT a hard-coded `.git/refs/heads/cq-ledger` path.
    const coherent = await waitUntil(
      () =>
        storeB
          .fetch("widgets")
          .milestones.flatMap((g) => g.items)
          .some((i) => i.fields["note"] === "via indirection"),
    );
    expect(coherent).toBe(true);
    expect(changedIds).toContain("widgets");

    watcher.close();
    await storeA.dispose();
    await storeB.dispose();

    // Remove the linked worktree (from source repo).
    await git(sourceDir, "worktree", "remove", "--force", linkedDir);
  });
});

// ---------------------------------------------------------------------------
// Test 3: inert handle when no runner supplied
// ---------------------------------------------------------------------------

describe("startLedgerRefWatcher — inert when no runner", () => {
  it("returns a handle that can be closed without errors", () => {
    // A dummy store — we won't call any methods.
    const dummyStore = {
      enumerate: () => [] as string[],
      invalidate: async () => {},
    } as unknown as import("@cq/ledger").LedgerStore;
    const watcher = startLedgerRefWatcher(dummyStore);
    expect(() => watcher.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 4: onChange receives null when store has no known ledgers
// ---------------------------------------------------------------------------

describe("startLedgerRefWatcher — onChange(null) when no ledgers known", () => {
  it("fires onChange(null) when enumerate() returns empty but ref advances", async () => {
    const dir = await seedRepo();

    // Seed the orphan ref so there's something to advance.
    const plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
    const blob = await plumbing.hashObject("seed");
    const tree = await plumbing.writeTree([{ mode: "100644", sha: blob, path: "seed.txt" }]);
    const commit1 = await plumbing.commitTree(tree, null, "seed");
    await plumbing.updateRef(`refs/heads/${BRANCH}`, commit1, null);

    // A store that always reports no ledgers.
    const nullStore = {
      enumerate: () => [] as string[],
      invalidate: async () => {},
    } as unknown as import("@cq/ledger").LedgerStore;

    const nullChanges: Array<string | null> = [];
    const runner: GitRunner = nodeGitRunner(dir);
    const watcher = startLedgerRefWatcher(nullStore, BRANCH, runner, (id) => {
      nullChanges.push(id);
    }, 50);

    // Wait for the first poll to establish lastSha before advancing the ref.
    // (The first poll fires after pollMs; wait 2× to be safe.)
    await new Promise((r) => setTimeout(r, 120));

    // Advance the ref by writing a new commit.
    const blob2 = await plumbing.hashObject("advanced");
    const tree2 = await plumbing.writeTree([{ mode: "100644", sha: blob2, path: "seed.txt" }]);
    const commit2 = await plumbing.commitTree(tree2, commit1, "advance");
    await plumbing.updateRef(`refs/heads/${BRANCH}`, commit2, commit1);

    const fired = await waitUntil(() => nullChanges.length > 0);
    expect(fired).toBe(true);
    expect(nullChanges[0]).toBeNull();

    watcher.close();
  });
});
