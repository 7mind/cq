/**
 * Git-backend INVARIANT regression guards (T359 / G43 / Q196 / K66).
 *
 * The five invariants below are the WHOLE POINT of `GitObjectLedgerBackend`:
 * they are what makes an orphan-ref ledger store safe to co-locate inside a
 * working host checkout. T352's `gitObjectLedgerBackend.test.ts` proves them
 * mostly INLINE inside one large persistence test; this file factors each of
 * the five into a NAMED, separable, focused test so a regression in any one of
 * them fails a clearly-labelled assertion (and the CAS-stale group, untested by
 * T352, is covered explicitly here).
 *
 * The five groups:
 *   1. Host-checkout byte-identity — working tree (sha256 of tracked files),
 *      HEAD ref, index (`git ls-files -s` digest), and `git status --porcelain`
 *      are BYTE-IDENTICAL before vs after a real create+update+archive sequence.
 *   2. Orphan-ref advance — exactly ONE commit per mutation, and the FIRST
 *      commit is PARENTLESS (a true orphan).
 *   3. CAS stale-reject — a CAS update-ref with a STALE expectedOld surfaces the
 *      typed StaleRefError (NOT silent last-writer-wins), both at the plumbing
 *      level and across a concurrent backend advance.
 *   4. Lock-not-committed — advisory `.lock` files NEVER appear in the orphan
 *      tree (`git ls-tree -r cq-ledger`); they live on the real, gitignored FS.
 *   5. Backup-tag — schema-divergence reinit tags `refs/tags/cq-ledger-backup-<ts>`
 *      at the PRIOR orphan head BEFORE resetting the ref.
 *
 * Throwaway repos use `mkdtemp`, cleaned up in `afterAll` (no residue). No test
 * ever touches the worktree's own `.git`.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  GitObjectLedgerBackend,
  GitPlumbing,
  StaleRefError,
  createTrustedWorksetManagementAuthority,
  serializeRegistry,
  type LedgerSchema,
} from "../src/index.js";

const exec = promisify(execFile);
const BRANCH = "cq-ledger";
const REF = `refs/heads/${BRANCH}`;

// Git plumbing is slower than the in-memory FS backend. Under full-gate
// parallel load fixture staging (seedRepo / seedRegistry / multi-op sequences)
// needs a generous wall-clock bound (T1995/T1998 ORCHESTRATION_WAIT_MS
// pattern, D281); tight SUT invariants are asserted separately without a
// stopwatch on the staging itself.
const ORCHESTRATION_WAIT_MS = 120_000;
const GIT_TIMEOUT_MS = ORCHESTRATION_WAIT_MS;

const repos: string[] = [];

/** Run a raw git command in `cwd`, returning trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

/** Create a fresh seeded repo with one real commit + one tracked working file. */
async function seedRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "git-inv-"));
  repos.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(
    path.join(dir, "src.txt"),
    "real source file, must stay byte-identical\n",
  );
  await git(dir, "add", "src.txt");
  await git(dir, "commit", "-q", "-m", "main: initial");
  return dir;
}

/** Pre-seed the orphan ref with a ledgers.yaml blob (so init() finds a registry). */
async function seedRegistry(
  dir: string,
  seed: Array<{ name: string; schema: LedgerSchema }>,
): Promise<void> {
  const plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
  const yaml = serializeRegistry({ version: 1, ledgers: seed });
  const blob = await plumbing.hashObject(yaml);
  const tree = await plumbing.writeTree([
    { mode: "100644", sha: blob, path: "ledgers.yaml" },
  ]);
  const commit = await plumbing.commitTree(tree, null, "ledger: seed registry");
  await plumbing.updateRef(REF, commit, null);
}

/** sha256 of all tracked working-tree files (excludes .git). */
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

/** sha256 of the index (`git ls-files -s`). */
async function indexDigest(dir: string): Promise<string> {
  return createHash("sha256")
    .update(await git(dir, "ls-files", "-s"))
    .digest("hex");
}

/** Count commits on the orphan ref. */
async function refCommitCount(dir: string): Promise<number> {
  return Number(await git(dir, "rev-list", "--count", REF));
}

const widgetsSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { note: { type: "string", required: true } },
};

afterAll(async () => {
  for (const d of repos) await fs.rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Group 1 — host-checkout byte-identity
// ---------------------------------------------------------------------------

describe("git invariant 1 — host-checkout byte-identity", () => {
  it(
    "working tree, HEAD, index, and porcelain stay byte-identical across create+update+archive",
    async () => {
      const dir = await seedRepo();
      await seedRegistry(dir, [{ name: "widgets", schema: widgetsSchema }]);
      const store = new GitObjectLedgerBackend({ repoRoot: dir });
      await store.init();

      // Capture the host-checkout state AFTER init (init already advanced the
      // orphan ref but must not have perturbed the host working tree).
      const headBefore = await git(dir, "rev-parse", "HEAD");
      const symRefBefore = await git(dir, "symbolic-ref", "HEAD");
      const wtBefore = await workingTreeDigest(dir);
      const indexBefore = await indexDigest(dir);
      expect(await git(dir, "status", "--porcelain")).toBe("");

      // A real create + update + archive sequence.
      const ms = await store.createMilestone({ title: "M byte-identity" });
      const created = await store.createItem("widgets", ms.id, {
        status: "open",
        fields: { note: "v1" },
      });
      await store.updateItem("widgets", created.id, { fields: { note: "v2" } });
      await store.updateItem("widgets", created.id, { status: "done" });
      await store.updateMilestone(ms.id, { status: "done" });
      await store.archiveMilestone(ms.id, "archived");

      // Every dimension of the host checkout is byte-identical: no checkout,
      // no HEAD switch, no index churn, no working-tree dirt.
      expect(await git(dir, "rev-parse", "HEAD")).toBe(headBefore);
      expect(await git(dir, "symbolic-ref", "HEAD")).toBe(symRefBefore);
      expect(await workingTreeDigest(dir)).toBe(wtBefore);
      expect(await indexDigest(dir)).toBe(indexBefore);
      expect(await git(dir, "status", "--porcelain")).toBe("");

      await store.dispose();
    },
    GIT_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Group 2 — orphan-ref advance (one commit per mutation, parentless first)
// ---------------------------------------------------------------------------

describe("git invariant 2 — orphan-ref advance", () => {
  it(
    "advances exactly one commit per mutation and the first commit is parentless",
    async () => {
      const dir = await seedRepo();
      // Seed the registry: the seed commit is the PARENTLESS root of the orphan
      // ref chain (asserted below); every subsequent mutation builds on it.
      await seedRegistry(dir, [{ name: "widgets", schema: widgetsSchema }]);
      const store = new GitObjectLedgerBackend({ repoRoot: dir });
      await store.init();

      // The ROOT of the orphan ref chain must be a true orphan: zero parents.
      // `git rev-list --max-parents=0` lists exactly the parentless commits;
      // a healthy orphan history has EXACTLY ONE such root. `git cat-file -p`
      // of that root prints NO `parent ` line.
      const rootCommits = (await git(dir, "rev-list", "--max-parents=0", REF))
        .split("\n")
        .filter((l) => l.length > 0);
      expect(rootCommits.length).toBe(1);
      const rootObj = await git(dir, "cat-file", "-p", rootCommits[0] as string);
      expect(rootObj.includes("parent ")).toBe(false);

      // Each subsequent mutation advances the ref by EXACTLY one commit.
      const ms = await store.createMilestone({ title: "M advance" });
      let count = await refCommitCount(dir);
      const created = await store.createItem("widgets", ms.id, {
        status: "open",
        fields: { note: "a" },
      });
      expect(await refCommitCount(dir)).toBe(count + 1);

      count = await refCommitCount(dir);
      await store.updateItem("widgets", created.id, { fields: { note: "b" } });
      expect(await refCommitCount(dir)).toBe(count + 1);

      count = await refCommitCount(dir);
      await store.updateItem("widgets", created.id, { status: "done" });
      expect(await refCommitCount(dir)).toBe(count + 1);

      await store.dispose();
    },
    GIT_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Group 3 — CAS stale-reject (typed StaleRefError, no last-writer-wins)
// ---------------------------------------------------------------------------

describe("git invariant 3 — CAS stale-reject", () => {
  it(
    "GitPlumbing.updateRef with a stale expectedOld throws the typed StaleRefError",
    async () => {
      const dir = await seedRepo();
      await seedRegistry(dir, [{ name: "widgets", schema: widgetsSchema }]);
      const plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));

      // Current ref head — the genuine expected-old.
      const head = await plumbing.readRef(REF);
      expect(head).not.toBeNull();

      // Advance the ref OUT-OF-BAND (a concurrent writer) so `head` is now stale.
      const tree = await plumbing.lsTreeEntries(REF);
      const advancedCommit = await plumbing.commitTree(
        await plumbing.writeTree(tree),
        head,
        "concurrent advance",
      );
      await plumbing.updateRef(REF, advancedCommit, head);

      // Now attempt a CAS using the STALE `head` as expectedOld. Build a fresh
      // commit to point at; the CAS must reject because the ref has moved.
      const staleCommit = await plumbing.commitTree(
        await plumbing.writeTree(tree),
        advancedCommit,
        "would-be lost write",
      );
      let thrown: unknown;
      try {
        await plumbing.updateRef(REF, staleCommit, head);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(StaleRefError);
      expect((thrown as StaleRefError).expectedOld).toBe(head);

      // The CAS rejection means NO last-writer-wins: the ref still points at the
      // concurrent advance, not at the would-be-lost write.
      expect(await plumbing.readRef(REF)).toBe(advancedCommit);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "a backend write whose ref moved out-of-band mid-op surfaces StaleRefError",
    async () => {
      const dir = await seedRepo();
      await seedRegistry(dir, [{ name: "widgets", schema: widgetsSchema }]);

      // A backend reads expectedOld at the start of a mutation under its lock.
      // We model the read-old → (out-of-band advance) → update-ref race by
      // injecting a GitPlumbing whose updateRef fires a one-shot hook that
      // advances the ref BEHIND the backend's back, just before the real CAS.
      const realPlumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
      // `armed` gates the one-shot race so it fires on the FIRST post-init
      // mutation only — init() itself drives updateRef and must not be raced.
      let armed = false;
      let raced = false;
      const racingPlumbing = new Proxy(realPlumbing, {
        get(target, prop, receiver) {
          if (prop === "updateRef") {
            return async (ref: string, newSha: string, expectedOld: string | null) => {
              if (armed && !raced) {
                raced = true;
                // Concurrent writer advances the ref out-of-band.
                const cur = await target.readRef(ref);
                const entries = await target.lsTreeEntries(ref);
                const tree = await target.writeTree(entries);
                const advanced = await target.commitTree(tree, cur, "out-of-band");
                await target.updateRef(ref, advanced, cur);
              }
              return target.updateRef(ref, newSha, expectedOld);
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });

      const store = new GitObjectLedgerBackend({
        repoRoot: dir,
        git: racingPlumbing,
      });
      await store.init();
      armed = true;

      // This mutation reads expectedOld, the proxy advances the ref out-of-band,
      // then the backend's CAS update-ref must reject with StaleRefError.
      await expect(
        store.createMilestone({ title: "M racy" }),
      ).rejects.toBeInstanceOf(StaleRefError);

      await store.dispose();
    },
    GIT_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Group 4 — lock-not-committed
// ---------------------------------------------------------------------------

describe("git invariant 4 — lock-not-committed", () => {
  it(
    "advisory .lock files never appear in the orphan tree",
    async () => {
      const dir = await seedRepo();
      await seedRegistry(dir, [{ name: "widgets", schema: widgetsSchema }]);
      const store = new GitObjectLedgerBackend({ repoRoot: dir });
      await store.init();

      // A write that takes the advisory lock (createItem locks the ledger, the
      // milestones lock, and the registry lock across the op).
      const ms = await store.createMilestone({ title: "M lock" });
      await store.createItem("widgets", ms.id, {
        status: "open",
        fields: { note: "locked write" },
      });

      // The advisory lock lives on the real (gitignored) FS, not in the tree.
      // Enumerate the WHOLE orphan tree and assert no `.lock` / `.locks` path.
      const treePaths = await git(dir, "ls-tree", "-r", "--name-only", REF);
      const paths = treePaths.split("\n").filter((p) => p.length > 0);
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) {
        expect(p.endsWith(".lock")).toBe(false);
        expect(p.includes(".locks")).toBe(false);
      }

      await store.dispose();
    },
    GIT_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Group 5 — backup-tag at the prior head before reinit
// ---------------------------------------------------------------------------

describe("git invariant 5 — backup-tag before reinit", () => {
  it(
    "tags cq-ledger-backup-<ts> at the prior orphan head before resetting the ref",
    async () => {
      const dir = await seedRepo();
      // Seed a CANONICAL ledger name (tasks) with a DIVERGENT schema so init()
      // detects divergence and runs the backup-reinit path.
      await seedRegistry(dir, [
        {
          name: "tasks",
          schema: {
            statusValues: ["weird", "states"],
            terminalStatuses: ["states"],
            fields: { bogus: { type: "string", required: true } },
          },
        },
      ]);

      // Capture the PRIOR orphan head — the tag must point here.
      const priorHead = await git(dir, "rev-parse", REF);
      expect(await git(dir, "tag", "--list", "cq-ledger-backup-*")).toBe("");

      const store = new GitObjectLedgerBackend({
        repoRoot: dir,
        onSchemaDivergence: "backup-reinit",
        worksetAuthority: createTrustedWorksetManagementAuthority(),
      });
      await store.init(); // divergence → backup tag, then reinit advances the ref

      const tags = (await git(dir, "tag", "--list", "cq-ledger-backup-*"))
        .split("\n")
        .filter((t) => t.length > 0);
      expect(tags.length).toBe(1);

      // The tag points at the PRIOR head (captured BEFORE reinit moved the ref).
      const tagSha = await git(dir, "rev-parse", `${tags[0]}^{commit}`);
      expect(tagSha).toBe(priorHead);

      // And reinit DID advance the ref past the tagged prior head.
      expect(await git(dir, "rev-parse", REF)).not.toBe(priorHead);

      await store.dispose();
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "updateMilestone close honors parent liveness under the git-object lock, with reload of peer commits (D267/T1856)",
    async () => {
      const dir = await seedRepo();
      await seedRegistry(dir, [{ name: "widgets", schema: widgetsSchema }]);
      const store = new GitObjectLedgerBackend({ repoRoot: dir });
      await store.init();
      try {
        const m = await store.createMilestone({ title: "close-me" });
        const w1 = await store.createItem("widgets", m.id, {
          status: "open",
          fields: { note: "live child" },
        });
        await expect(store.updateMilestone(m.id, { status: "done" })).rejects.toThrow(
          `Cannot close milestone ${m.id}: children not in terminal status: widgets:${w1.id}`,
        );
        await expect(
          store.updateItem("milestones", m.id, { status: "done" }),
        ).rejects.toThrow(`Cannot close milestone ${m.id}`);
        await store.updateItem("widgets", w1.id, { status: "done" });
        expect((await store.updateItem("milestones", m.id, { status: "done" })).status).toBe(
          "done",
        );
        await expect(store.reopenItem("widgets", w1.id, "open")).rejects.toThrow(/terminal/);
      } finally {
        await store.dispose();
      }
    },
    GIT_TIMEOUT_MS,
  );
});
