/**
 * T502 (G67 / Q244 / Q247): the one-way human-readable backup exporter — the
 * four acceptance cases, exercised through the REAL wiring (`createLedgerStore`
 * over a cq.toml-configured xdg backend, mutations firing the store's
 * onMutation hook into the debounced BackupScheduler):
 *
 *  1. backup="in-tree": a mutation eventually produces a `.cq/` dump parseable
 *     by the existing parsers AND containing every log artifact from the
 *     primary log store at its `.cq/logs/**` path, byte-equal to the stored
 *     artifact.
 *  2. backup="orphan-branch": the dump lands as a commit on the configured ref
 *     whose tree carries the same `.cq/logs/**` entries with the same bytes
 *     (and nothing is written in the work tree).
 *  3. Default config (backup absent = "none"): NOTHING is written in-tree or
 *     to any ref.
 *  4. A store-write failure is never caused by a backup failure (the guarded,
 *     fire-and-forget trigger swallows the export error).
 *
 * Throwaway git repos + a per-test XDG_STATE_HOME override keep everything off
 * the real machine state. `resolved.backup.flush()` makes the debounced
 * trigger deterministic (the mutation itself scheduled the export; flush only
 * fires the pending timer and awaits the run).
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  BackupScheduler,
  createLedgerStore,
  GitPlumbing,
  parseArchive,
  parseLedger,
  parseRegistry,
  resolveLogsDir,
  resolveProjectKey,
  MILESTONES_LEDGER,
  TASKS_LEDGER,
  type ResolvedLedgerStore,
} from "../src/index.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/** A throwaway initialised git repo with one commit (the xdg identity key). */
async function gitRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), `# repo ${prefix}\n`);
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The two log artifacts seeded into the primary log store per test. */
const SUMMARY_REL = "20260714-1200-worker.md";
const SUMMARY_BYTES = "### Session summary\n\n- worker transcript, **markdown** body\n";
const RAW_REL = "raw/20260714-1200-worker.jsonl";
const RAW_BYTES = '{"type":"turn","n":1}\n{"type":"turn","n":2}\n';

/**
 * Seed the OUT-OF-TREE primary log store (`resolveLogsDir(projectKey)`, the
 * same area `cq log put --dest logs/<rel>` writes for the xdg backend) with a
 * session summary + a raw transcript.
 */
async function seedPrimaryLogs(root: string): Promise<string> {
  const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
  const logsDir = resolveLogsDir(projectKey);
  await fs.mkdir(path.join(logsDir, "raw"), { recursive: true });
  await fs.writeFile(path.join(logsDir, SUMMARY_REL), SUMMARY_BYTES);
  await fs.writeFile(path.join(logsDir, RAW_REL), RAW_BYTES);
  return logsDir;
}

/** Mutate the store: one milestone, one done task, and one ARCHIVED milestone. */
async function mutate(resolved: ResolvedLedgerStore): Promise<void> {
  const store = resolved.store;
  const m1 = await store.createMilestone({ title: "backup smoke" });
  await store.createItem(TASKS_LEDGER, m1.id, {
    status: "done",
    fields: { headline: "backed-up task" },
  });
  const m2 = await store.createMilestone({ title: "to archive" });
  await store.createItem(TASKS_LEDGER, m2.id, {
    status: "done",
    fields: { headline: "archived task" },
  });
  await store.updateMilestone(m2.id, { status: "done" });
  await store.archiveMilestone(m2.id, "archived for backup coverage");
}

describe("backup exporter — T502 acceptance (xdg backend, debounced trigger)", () => {
  let originalXdgStateHome: string | undefined;

  beforeEach(async () => {
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "bk-xdg-home-"));
    dirs.push(xdgHome);
    process.env["XDG_STATE_HOME"] = xdgHome;
  });

  afterEach(() => {
    if (originalXdgStateHome === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = originalXdgStateHome;
    }
  });

  it('(1) backup="in-tree": a mutation produces a parseable .cq/ dump carrying every log artifact byte-identically', async () => {
    const root = await gitRepo("bk-intree-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nbackup = "in-tree"\n',
    );
    await seedPrimaryLogs(root);

    const resolved = await createLedgerStore(root);
    try {
      expect(resolved.backup).toBeInstanceOf(BackupScheduler);
      await mutate(resolved);
      await resolved.backup!.flush();

      const docsDir = path.join(root, ".cq");

      // Registry parses and names the canonical ledgers.
      const registry = parseRegistry(await fs.readFile(path.join(docsDir, "ledgers.yaml"), "utf8"));
      const names = registry.ledgers.map((e) => e.name);
      expect(names).toContain(TASKS_LEDGER);
      expect(names).toContain(MILESTONES_LEDGER);

      // The tasks ledger parses with its dumped schema and carries the item.
      const tasksSchema = registry.ledgers.find((e) => e.name === TASKS_LEDGER)!.schema;
      const tasks = parseLedger(await fs.readFile(path.join(docsDir, "tasks.md"), "utf8"), {
        schema: tasksSchema,
      });
      expect(tasks.id).toBe(TASKS_LEDGER);
      const t1 = tasks.milestones.flatMap((m) => m.items).find((i) => i.id === "T1");
      expect(t1?.fields["headline"]).toBe("backed-up task");
      expect(t1?.status).toBe("done");
      // The archived group's pointer round-trips through the frontmatter.
      expect(tasks.archivePointers.map((p) => p.id)).toContain("M2");

      // The milestones ledger parses under its §8d grammar.
      const msSchema = registry.ledgers.find((e) => e.name === MILESTONES_LEDGER)!.schema;
      const milestones = parseLedger(
        await fs.readFile(path.join(docsDir, "milestones.md"), "utf8"),
        { schema: msSchema, isMilestonesLedger: true },
      );
      expect(milestones.milestones[0]!.items.map((i) => i.id)).toContain("M1");

      // The archived tasks group parses via the archive parser.
      const archived = parseArchive(
        await fs.readFile(path.join(docsDir, "archive", TASKS_LEDGER, "M2.md"), "utf8"),
      );
      expect(archived.id).toBe("M2");
      expect(archived.items.map((i) => i.fields["headline"])).toContain("archived task");

      // Q247 log coverage: EVERY primary-log artifact is in the dump at its
      // .cq/logs/** path, byte-identical to the stored artifact.
      expect(await fs.readFile(path.join(docsDir, "logs", SUMMARY_REL), "utf8")).toBe(
        SUMMARY_BYTES,
      );
      expect(await fs.readFile(path.join(docsDir, "logs", RAW_REL), "utf8")).toBe(RAW_BYTES);
    } finally {
      resolved.backup?.close();
      await resolved.store.dispose();
    }
  });

  it('(2) backup="orphan-branch": the dump lands as a commit on the configured ref with the same .cq/logs/** bytes; the work tree stays clean', async () => {
    const root = await gitRepo("bk-orphan-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nbackup = "orphan-branch"\nbranch = "cq-backup"\n',
    );
    await seedPrimaryLogs(root);

    const resolved = await createLedgerStore(root);
    try {
      await mutate(resolved);
      await resolved.backup!.flush();

      const git = GitPlumbing.withCwd(root, path.join(root, ".git"));
      const ref = "refs/heads/cq-backup";
      expect(await git.readRef(ref)).not.toBeNull();

      const paths = await git.lsTree(ref);
      expect(paths).toContain(".cq/ledgers.yaml");
      expect(paths).toContain(".cq/tasks.md");
      expect(paths).toContain(".cq/milestones.md");
      expect(paths).toContain(`.cq/archive/${TASKS_LEDGER}/M2.md`);

      // Q247: the SAME .cq/logs/** entries, same bytes, inside the dump tree.
      expect(paths).toContain(`.cq/logs/${SUMMARY_REL}`);
      expect(paths).toContain(`.cq/logs/${RAW_REL}`);
      expect(await git.catFile(ref, `.cq/logs/${SUMMARY_REL}`)).toBe(SUMMARY_BYTES);
      expect(await git.catFile(ref, `.cq/logs/${RAW_REL}`)).toBe(RAW_BYTES);

      // The committed ledger dump parses too (write-only, but byte-compatible).
      const registry = parseRegistry(await git.catFile(ref, ".cq/ledgers.yaml"));
      const tasksSchema = registry.ledgers.find((e) => e.name === TASKS_LEDGER)!.schema;
      const tasks = parseLedger(await git.catFile(ref, ".cq/tasks.md"), { schema: tasksSchema });
      expect(tasks.milestones.flatMap((m) => m.items).map((i) => i.id)).toContain("T1");

      // Orphan-branch writes NOTHING into the work tree.
      expect(await exists(path.join(root, ".cq"))).toBe(false);
    } finally {
      resolved.backup?.close();
      await resolved.store.dispose();
    }
  });

  it("(3) default config (backup=none): NOTHING is written in-tree or to any ref", async () => {
    const root = await gitRepo("bk-none-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    await seedPrimaryLogs(root);

    const resolved = await createLedgerStore(root);
    try {
      // No scheduler is even constructed — no trigger can ever fire.
      expect(resolved.backup).toBeUndefined();
      await mutate(resolved);
      // Give any (defectively) scheduled work a chance to surface.
      await new Promise((r) => setTimeout(r, 50));

      expect(await exists(path.join(root, ".cq"))).toBe(false);
      const git = GitPlumbing.withCwd(root, path.join(root, ".git"));
      expect(await git.readRef("refs/heads/cq-ledger")).toBeNull();
      expect(await git.readRef("refs/heads/cq-backup")).toBeNull();
    } finally {
      await resolved.store.dispose();
    }
  });

  it("(4) a store-write failure is never caused by a backup failure", async () => {
    const root = await gitRepo("bk-fail-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nbackup = "in-tree"\n',
    );
    // Sabotage the in-tree target: a regular FILE at <root>/.cq makes every
    // dump write fail with ENOTDIR. The xdg primary itself never touches it.
    await fs.writeFile(path.join(root, ".cq"), "not a directory\n");

    const resolved = await createLedgerStore(root);
    try {
      // The mutations MUST succeed — the trigger is fire-and-forget + guarded.
      const m = await resolved.store.createMilestone({ title: "survives backup failure" });
      const item = await resolved.store.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "write survives" },
      });
      // flush() resolves despite the failing export (the error is swallowed).
      await resolved.backup!.flush();

      // The primary store carries the writes...
      expect(resolved.store.fetchItem(TASKS_LEDGER, item.id).fields["headline"]).toBe(
        "write survives",
      );
      // ...and the sabotaged target is untouched (still the plain file).
      expect(await fs.readFile(path.join(root, ".cq"), "utf8")).toBe("not a directory\n");
    } finally {
      resolved.backup?.close();
      await resolved.store.dispose();
    }
  });
});

const PG_URL = process.env.CQ_TEST_PG_URL;

/**
 * T582 (Q275 full-parity decision): the SAME debounced-trigger acceptance as
 * the xdg suite above, but for `backend = 'postgres'` — a mutation's
 * `onMutation` hook schedules the SAME `BackupScheduler`, and `buildBackupDump`
 * feeds it this tenant's rows + the T575 `listLogs` seam (the tenant-keyed
 * `logs` table) INSTEAD OF a filesystem `logsDir` (which this backend has
 * none of). Env-gated on CQ_TEST_PG_URL (Q286) — skips cleanly offline.
 */
describe.skipIf(!PG_URL)("backup exporter — T582 acceptance (postgres backend, debounced trigger)", () => {
  /** A throwaway initialised git repo with a UNIQUE first commit (distinct tenant per test). */
  async function pgGitRepo(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
    dirs.push(dir);
    await exec("git", ["init", "-q"], { cwd: dir });
    await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await exec("git", ["config", "user.name", "t"], { cwd: dir });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    await fs.writeFile(path.join(dir, "README.md"), `# repo ${randomUUID()}\n`);
    await exec("git", ["add", "README.md"], { cwd: dir });
    await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    return dir;
  }

  let originalPgUrl: string | undefined;

  beforeEach(() => {
    originalPgUrl = process.env["CQ_LEDGER_PG_URL"];
    process.env["CQ_LEDGER_PG_URL"] = PG_URL;
  });

  afterEach(() => {
    if (originalPgUrl === undefined) {
      delete process.env["CQ_LEDGER_PG_URL"];
    } else {
      process.env["CQ_LEDGER_PG_URL"] = originalPgUrl;
    }
  });

  it('backup="in-tree": a mutation produces a parseable .cq/ dump carrying every tenant log artifact byte-identically', async () => {
    const root = await pgGitRepo("bk-pg-intree-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "postgres"\nbackup = "in-tree"\n',
    );

    const resolved = await createLedgerStore(root);
    try {
      expect(resolved.backend).toBe("postgres");
      expect(resolved.backup).toBeInstanceOf(BackupScheduler);
      // Store-side log writes (the postgres analogue of seedPrimaryLogs) —
      // MUST happen after init() so the tenant is registered.
      const store = resolved.store as unknown as {
        putLog(relPath: string, content: string): Promise<void>;
      };
      await store.putLog(SUMMARY_REL, SUMMARY_BYTES);
      await store.putLog(RAW_REL, RAW_BYTES);

      await mutate(resolved);
      await resolved.backup!.flush();

      const docsDir = path.join(root, ".cq");
      const registry = parseRegistry(await fs.readFile(path.join(docsDir, "ledgers.yaml"), "utf8"));
      const names = registry.ledgers.map((e) => e.name);
      expect(names).toContain(TASKS_LEDGER);

      const tasksSchema = registry.ledgers.find((e) => e.name === TASKS_LEDGER)!.schema;
      const tasks = parseLedger(await fs.readFile(path.join(docsDir, "tasks.md"), "utf8"), {
        schema: tasksSchema,
      });
      const t1 = tasks.milestones.flatMap((m) => m.items).find((i) => i.id === "T1");
      expect(t1?.fields["headline"]).toBe("backed-up task");

      // T575 listLogs seam: the tenant-keyed logs table feeds the SAME
      // .cq/logs/** path, byte-identical to the stored artifact.
      expect(await fs.readFile(path.join(docsDir, "logs", SUMMARY_REL), "utf8")).toBe(SUMMARY_BYTES);
      expect(await fs.readFile(path.join(docsDir, "logs", RAW_REL), "utf8")).toBe(RAW_BYTES);
    } finally {
      resolved.backup?.close();
      await resolved.store.dispose();
    }
  });

  it('backup="orphan-branch": the dump lands as a commit on the configured ref with the same tenant .cq/logs/** bytes', async () => {
    const root = await pgGitRepo("bk-pg-orphan-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "postgres"\nbackup = "orphan-branch"\nbranch = "cq-backup-pg"\n',
    );

    const resolved = await createLedgerStore(root);
    try {
      const store = resolved.store as unknown as {
        putLog(relPath: string, content: string): Promise<void>;
      };
      await store.putLog(SUMMARY_REL, SUMMARY_BYTES);

      await mutate(resolved);
      await resolved.backup!.flush();

      const git = GitPlumbing.withCwd(root, path.join(root, ".git"));
      const ref = "refs/heads/cq-backup-pg";
      expect(await git.readRef(ref)).not.toBeNull();

      const paths = await git.lsTree(ref);
      expect(paths).toContain(".cq/ledgers.yaml");
      expect(paths).toContain(".cq/tasks.md");
      expect(paths).toContain(`.cq/logs/${SUMMARY_REL}`);
      expect(await git.catFile(ref, `.cq/logs/${SUMMARY_REL}`)).toBe(SUMMARY_BYTES);

      // Orphan-branch writes NOTHING into the work tree.
      expect(await exists(path.join(root, ".cq"))).toBe(false);
    } finally {
      resolved.backup?.close();
      await resolved.store.dispose();
    }
  });

  it("default config (backup=none): NOTHING is written in-tree or to any ref; no scheduler is constructed", async () => {
    const root = await pgGitRepo("bk-pg-none-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "postgres"\n');

    const resolved = await createLedgerStore(root);
    try {
      expect(resolved.backup).toBeUndefined();
      await mutate(resolved);
      await new Promise((r) => setTimeout(r, 50));

      expect(await exists(path.join(root, ".cq"))).toBe(false);
      const git = GitPlumbing.withCwd(root, path.join(root, ".git"));
      expect(await git.readRef("refs/heads/cq-ledger")).toBeNull();
    } finally {
      await resolved.store.dispose();
    }
  });
});

describe("BackupScheduler — debounce/coalesce semantics", () => {
  it("coalesces a burst of schedule() calls into one run; close() cancels pending work", async () => {
    let runs = 0;
    const scheduler = new BackupScheduler(async () => {
      runs += 1;
    }, 5);

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    await scheduler.flush();
    expect(runs).toBe(1);

    scheduler.schedule();
    await scheduler.flush();
    expect(runs).toBe(2);

    scheduler.close();
    scheduler.schedule();
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(2);
  });
});
