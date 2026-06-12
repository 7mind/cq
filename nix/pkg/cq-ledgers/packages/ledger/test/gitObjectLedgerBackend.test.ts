/**
 * GitObjectLedgerBackend tests (T352 / G43 / K66) — drive the git-object backend
 * against a THROWAWAY `/tmp` git repo and assert the K66 PoC invariants:
 *
 *  - create/update/archive ops persist and read back correctly;
 *  - the host checkout's HEAD sha, `git status --porcelain`, working-tree bytes,
 *    and index sha stay BYTE-IDENTICAL after every write (no checkout);
 *  - the orphan ref advances exactly one commit per mutation;
 *  - lockfiles NEVER appear in `git ls-tree -r cq-ledger`;
 *  - a schema divergence tags `refs/tags/cq-ledger-backup-<ts>` BEFORE reinit.
 *
 * Throwaway repos use `mkdtemp`; cleaned up in `afterAll`. The tests NEVER touch
 * the worktree's own `.git`.
 *
 * The backend ALSO runs the shared abstract LedgerStore suite (dual-tests: the
 * git adapter must be observationally indistinguishable from the FS adapter).
 */

import { describe, it, test, expect, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  GitObjectLedgerBackend,
  GitPlumbing,
  serializeRegistry,
  MAX_READ_LOG_BYTES,
  type LedgerSchema,
  type LedgerStore,
} from "../src/index.js";
import { runStoreAbstractSuite } from "./store-abstract.js";

const exec = promisify(execFile);
const BRANCH = "cq-ledger";
const REF = `refs/heads/${BRANCH}`;

const repos: string[] = [];

/** Run a raw git command in `cwd`, returning trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

/** Create a fresh seeded repo with one real commit + one tracked working file. */
async function seedRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "git-ledger-"));
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

/**
 * Seed a `logs/<rel>` blob onto the orphan ref tip (the git analogue of writing
 * a file under <root>/docs/logs). Advances the ref by one commit carrying the
 * single log blob; idempotent w.r.t. the current tip via a CAS parent.
 */
async function seedLog(dir: string, rel: string, content: string): Promise<void> {
  const plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
  const blob = await plumbing.hashObject(content);
  const tree = await plumbing.writeTree([
    { mode: "100644", sha: blob, path: `logs/${rel}` },
  ]);
  const parent = await plumbing.readRef(REF);
  const commit = await plumbing.commitTree(tree, parent, "ledger: seed log");
  await plumbing.updateRef(REF, commit, parent);
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
  const out = await git(dir, "rev-list", "--count", REF);
  return Number(out);
}

afterAll(async () => {
  for (const d of repos) await fs.rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared abstract suite (dual-tests parity with FsLedgerStore)
// ---------------------------------------------------------------------------

runStoreAbstractSuite({
  name: "GitObjectLedgerBackend",
  // Each store op shells out to git; under full-suite parallel load individual
  // tests can exceed bun's 5s default. 30s keeps them deterministic.
  timeoutMs: 30_000,
  async build(seed): Promise<LedgerStore> {
    const dir = await seedRepo();
    if (seed.length > 0) await seedRegistry(dir, seed);
    const store = new GitObjectLedgerBackend({ repoRoot: dir });
    await store.init();
    return store;
  },
  async buildWithHook(seed, onMutation): Promise<LedgerStore> {
    const dir = await seedRepo();
    if (seed.length > 0) await seedRegistry(dir, seed);
    const store = new GitObjectLedgerBackend({ repoRoot: dir, onMutation });
    await store.init();
    return store;
  },
  async teardown(store): Promise<void> {
    await store.dispose();
  },
});

// ---------------------------------------------------------------------------
// Git-object-backend-specific invariants (K66 acceptance)
// ---------------------------------------------------------------------------

const widgetsSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { note: { type: "string", required: true } },
};

describe("GitObjectLedgerBackend — orphan-ref invariants", () => {
  it("persists create/update/archive and reads them back, host checkout byte-identical, one commit per mutation", async () => {
    const dir = await seedRepo();
    await seedRegistry(dir, [{ name: "widgets", schema: widgetsSchema }]);
    const store = new GitObjectLedgerBackend({ repoRoot: dir });
    await store.init();

    // capture BEFORE state of the host checkout (after init, which already
    // advanced the orphan ref but must NOT have perturbed the working tree).
    const headBefore = await git(dir, "rev-parse", "HEAD");
    const refSymBefore = await git(dir, "symbolic-ref", "HEAD");
    const wtBefore = await workingTreeDigest(dir);
    const indexBefore = await indexDigest(dir);
    expect(await git(dir, "status", "--porcelain")).toBe("");

    // create a milestone, then an item under it.
    const ms = await store.createMilestone({ title: "M one" });
    let count = await refCommitCount(dir);
    const created = await store.createItem("widgets", ms.id, {
      status: "open",
      fields: { note: "first" },
    });
    expect(await refCommitCount(dir)).toBe(count + 1);

    // update the item.
    count = await refCommitCount(dir);
    const updated = await store.updateItem("widgets", created.id, {
      fields: { note: "edited" },
    });
    expect(updated.fields["note"]).toBe("edited");
    expect(await refCommitCount(dir)).toBe(count + 1);

    // read back via a SECOND backend instance (forces a real init() read from
    // the orphan ref, not the in-memory map).
    const reader = new GitObjectLedgerBackend({ repoRoot: dir });
    await reader.init();
    const readBack = reader.fetchItem("widgets", created.id);
    expect(readBack.fields["note"]).toBe("edited");
    await reader.dispose();

    // archive the milestone (the item AND the milestone-item must be terminal).
    await store.updateItem("widgets", created.id, { status: "done" });
    await store.updateMilestone(ms.id, { status: "done" });
    const ptr = await store.archiveMilestone(ms.id, "done with M one");
    expect(ptr.id).toBe(ms.id);

    // the archive blob is readable at archive/<ledger>/<id>.md WITHOUT checkout.
    const plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
    const archiveText = await plumbing.catFile(REF, `archive/widgets/${ms.id}.md`);
    expect(archiveText.length).toBeGreaterThan(0);

    // host checkout stayed byte-identical across every write.
    expect(await git(dir, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(dir, "symbolic-ref", "HEAD")).toBe(refSymBefore);
    expect(await workingTreeDigest(dir)).toBe(wtBefore);
    expect(await indexDigest(dir)).toBe(indexBefore);
    expect(await git(dir, "status", "--porcelain")).toBe("");

    await store.dispose();
  });

  it("never commits lockfiles into the orphan tree", async () => {
    const dir = await seedRepo();
    await seedRegistry(dir, [{ name: "widgets", schema: widgetsSchema }]);
    const store = new GitObjectLedgerBackend({ repoRoot: dir });
    await store.init();

    const ms = await store.createMilestone({ title: "M lock" });
    await store.createItem("widgets", ms.id, {
      status: "open",
      fields: { note: "x" },
    });

    // The advisory lock did get acquired on the real FS during the writes above.
    // Assert it exists on disk but is ABSENT from the orphan tree.
    const lockOnDisk = await fs
      .readdir(path.join(dir, "docs", ".locks"))
      .catch(() => [] as string[]);
    // (Locks are released after each op; the dir may be empty — what matters is
    // no lock path is in the tree, asserted next.)
    void lockOnDisk;

    const treePaths = await git(dir, "ls-tree", "-r", "--name-only", REF);
    for (const p of treePaths.split("\n")) {
      expect(p.includes(".locks")).toBe(false);
      expect(p.endsWith(".lock")).toBe(false);
    }

    await store.dispose();
  });

  it("tags refs/tags/cq-ledger-backup-<ts> before reinit on schema divergence", async () => {
    const dir = await seedRepo();
    // Seed a canonical ledger name (tasks) with a DIVERGENT schema so init()
    // detects divergence against canon and runs backup-reinit.
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

    // No backup tag yet.
    const tagsBefore = await git(dir, "tag", "--list", "cq-ledger-backup-*");
    expect(tagsBefore).toBe("");

    const store = new GitObjectLedgerBackend({ repoRoot: dir });
    await store.init(); // divergence → backupCanonicalState tags, then reinit

    const tagsAfter = (await git(dir, "tag", "--list", "cq-ledger-backup-*"))
      .split("\n")
      .filter((t) => t.length > 0);
    expect(tagsAfter.length).toBe(1);

    // The canonical tasks ledger now exists with the CANONICAL schema (reinit'd).
    const fetched = store.fetch("tasks");
    expect(fetched.schema.statusValues).not.toEqual(["weird", "states"]);

    await store.dispose();
  });

  it("'abort' divergence policy throws rather than reinitialising", async () => {
    const dir = await seedRepo();
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
    const store = new GitObjectLedgerBackend({
      repoRoot: dir,
      onSchemaDivergence: "abort",
    });
    await expect(store.init()).rejects.toThrow();
    await store.dispose();
  });
});

// ---------------------------------------------------------------------------
// read_log capability over the git-object backend (T408) — Blackbox-Atomic:
// drive the REAL git adapter's readLog against a throwaway repo, mirroring the
// FS read-log test's confinement + 4 MiB cap + not-found assertions.
// ---------------------------------------------------------------------------

describe("GitObjectLedgerBackend — read_log capability (T408)", () => {
  it("returns content byte-identical to what was committed under logs/", async () => {
    const dir = await seedRepo();
    const store = new GitObjectLedgerBackend({ repoRoot: dir });
    await store.init();
    await seedLog(dir, "raw/x.jsonl", '{"a":1}\n{"b":2}\n');
    // Second instance forces a real read from the ref tip (no in-memory cache).
    const reader = new GitObjectLedgerBackend({ repoRoot: dir });
    await reader.init();

    const res = await reader.readLog("raw/x.jsonl");
    expect(res.path).toBe("raw/x.jsonl");
    expect(res.content).toBe('{"a":1}\n{"b":2}\n');
    expect(res.truncated).toBeUndefined();

    await reader.dispose();
    await store.dispose();
  });

  it("accepts a repo-relative .cq/logs/ path without doubling the prefix", async () => {
    const dir = await seedRepo();
    const store = new GitObjectLedgerBackend({ repoRoot: dir });
    await store.init();
    await seedLog(dir, "session.md", "hello log\n");

    const res = await store.readLog(".cq/logs/session.md");
    expect(res.content).toBe("hello log\n");
    await store.dispose();
  });

  it("rejects a path escaping logs/ (../tasks.md)", async () => {
    const dir = await seedRepo();
    const store = new GitObjectLedgerBackend({ repoRoot: dir });
    await store.init();
    await expect(store.readLog("../tasks.md")).rejects.toThrow(/escapes \.cq\/logs/);
    await store.dispose();
  });

  it("rejects an absolute path (/etc/passwd)", async () => {
    const dir = await seedRepo();
    const store = new GitObjectLedgerBackend({ repoRoot: dir });
    await store.init();
    await expect(store.readLog("/etc/passwd")).rejects.toThrow(
      /absolute paths are not allowed/,
    );
    await store.dispose();
  });

  it("truncates a file > 4 MiB and sets truncated:true", async () => {
    const dir = await seedRepo();
    const store = new GitObjectLedgerBackend({ repoRoot: dir });
    await store.init();
    const big = "x".repeat(MAX_READ_LOG_BYTES + 1024);
    await seedLog(dir, "big.log", big);

    const res = await store.readLog("big.log");
    expect(res.truncated).toBe(true);
    expect(res.content.length).toBe(MAX_READ_LOG_BYTES);
    await store.dispose();
  });

  it("returns a clean not-found for a missing path (mirrors FS ENOENT)", async () => {
    const dir = await seedRepo();
    const store = new GitObjectLedgerBackend({ repoRoot: dir });
    await store.init();
    let threw = false;
    try {
      await store.readLog("nonexistent.log");
    } catch (e: unknown) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      // Must NOT be a false "escape" error — a clean not-found.
      expect(msg.includes("escapes .cq/logs")).toBe(false);
      expect(msg.includes("no such file") || msg.includes("ENOENT")).toBe(true);
    }
    expect(threw).toBe(true);
    await store.dispose();
  });

  // D69 reproduction: readLog must fall back to the working-tree logs dir when a
  // log file is present there but ABSENT from the orphan ref. Today it throws the
  // ref-absent ENOENT ("read_log: no such file … (ENOENT, ref …)") even though
  // the file exists in <repoRoot>/docs/logs/. Marked test.failing so the suite
  // stays green and flips to passing when the fallback fix lands.
  test.failing(
    "D69 repro: readLog throws ref-absent ENOENT for a working-tree-only log (file on disk, absent from orphan ref)",
    async () => {
      const dir = await seedRepo();
      const store = new GitObjectLedgerBackend({ repoRoot: dir });
      await store.init();

      // Write the log file DIRECTLY into the working-tree logs dir — NOT via
      // seedLog, so it never lands in the orphan ref (the defect precondition).
      const logsDir = path.join(dir, "docs", "logs");
      await fs.mkdir(logsDir, { recursive: true });
      const filename = "wt-only.jsonl";
      await fs.writeFile(path.join(logsDir, filename), '{"wt":true}\n', "utf8");

      // Verify the file is present on disk …
      const onDisk = await fs.readFile(path.join(logsDir, filename), "utf8");
      expect(onDisk).toBe('{"wt":true}\n');

      // … but absent from the orphan ref tree (the defect precondition).
      const treePaths = await git(dir, "ls-tree", "-r", "--name-only", REF);
      const logTreePath = `logs/${filename}`;
      expect(treePaths.split("\n").includes(logTreePath)).toBe(false);

      // readLog should return the working-tree content (post-fix). Today (D69) it
      // throws the ref-absent LedgerError; this test.failing captures that exact
      // failure. The assertion below is what the fixed behaviour must satisfy:
      const res = await store.readLog(filename);
      expect(res.path).toBe(filename);
      expect(res.content).toBe('{"wt":true}\n');
      expect(res.truncated).toBeUndefined();

      // Also confirm the repo-relative path form works after the fix.
      const res2 = await store.readLog(`docs/logs/${filename}`);
      expect(res2.content).toBe('{"wt":true}\n');

      await store.dispose();
    },
  );
});
