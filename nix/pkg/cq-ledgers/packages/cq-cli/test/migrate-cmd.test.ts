/**
 * T504: the `cq migrate` subcommand — one-shot LEGACY (fs | git-object) → xdg
 * migration, per the acceptance:
 *
 *   - a seeded fs-backend repo and a seeded git-object-backend repo each
 *     migrate with FULL fetch parity: items, milestones, ARCHIVES, and logs
 *     (readable via the store's readLog surface) post-migrate;
 *   - the legacy `.cq/` files / orphan ref are BYTE-IDENTICAL before and
 *     after (migrate reads, never moves/deletes);
 *   - cq.toml's [ledger].backend flips to "xdg";
 *   - a second run without --yes refuses (backend is already xdg — no legacy
 *     source configured);
 *   - a NON-EMPTY xdg target without --yes refuses (non-TTY, the shared
 *     destructive-op policy) and writes NOTHING; --yes proceeds.
 *
 * Throwaway git repos + a per-test XDG_STATE_HOME override (mirrors
 * restore-cmd.test.ts).
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  createFsWorksetStore,
  createGitObjectWorksetStore,
  CANONICAL_LEDGERS,
  GitPlumbing,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  PLAN_CURRENT_DRAFT_FIELD,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
  openLegacyLedgerStore,
  ledgerTreePaths,
  resolveLedgerBackend,
  resolveLogsDir,
  resolveProjectKey,
  resolveStateDir,
  SqliteLedgerStore,
  LEDGER_STORAGE_DIRNAME,
  MILESTONES_LEDGER,
  TASKS_LEDGER,
  XDG_DB_FILENAME,
  readWorksetRootsEpoch,
  readCanonicalOwnership,
  parseLedger,
  serializeLedger,
  type ArchiveContent,
  type Item,
} from "@cq/ledger";
import { dispatch, EXIT_USAGE, type ConfirmIo, type DispatchIo } from "../src/main.js";
import { EXIT_REFUSED } from "../src/confirm.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)),
  );
});

const silentConfirm: ConfirmIo = {
  isTty: false,
  out: () => {},
  err: () => {},
  prompt: async () => "",
};

function recordingIo(stdin = ""): DispatchIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return {
    outs,
    errs,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    confirm: silentConfirm,
    readStdin: async () => stdin,
  };
}

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

const SESSION_LOG_REL = "20260714-1400-session.md";
const SESSION_LOG_BODY = "# session log\n\nmigrate notes.\n";
const RAW_LOG_REL = "raw/20260714-1400-cli.jsonl";
const RAW_LOG_BODY = '{"type":"turn","n":1}\n';

/** What the legacy seed produced — the parity baseline for post-migrate reads. */
interface SeededState {
  milestone: Item;
  item: Item;
  goal: Item;
  archivedMilestoneId: string;
  tasksArchive: ArchiveContent;
  milestonesArchive: ArchiveContent;
  roots: string[];
  rootEpoch: number;
}

/**
 * Seed the LEGACY backend at `root` via its public store surface (through
 * openLegacyLedgerStore — the same internal legacy path `cq migrate` reads
 * with; the runtime factory rejects legacy backends per T505): an active
 * milestone + task, PLUS a fully archived milestone (a done task, milestone
 * done, archiveMilestone) so the migrate parity covers archives too. Logs are
 * seeded separately via `cq log put` (the same path a real session uses).
 */
async function seedLegacy(root: string, backend?: "fs" | "git-object"): Promise<SeededState> {
  const seeded = await openLegacyLedgerStore(root, backend);
  try {
    const milestone = await seeded.store.createMilestone({ title: "active work" });
    const item = await seeded.store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "seeded task" },
      author: "tester[1m]",
      session: "sess-1",
    });
    const goal = await seeded.store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "planning",
      fields: { title: "legacy goal", description: "exact manifest owner" },
    });

    const doneMilestone = await seeded.store.createMilestone({ title: "finished work" });
    const doneItem = await seeded.store.createItem(TASKS_LEDGER, doneMilestone.id, {
      status: "planned",
      fields: { headline: "finished task" },
    });
    await seeded.store.updateItem(TASKS_LEDGER, doneItem.id, { status: "done" });
    await seeded.store.updateMilestone(doneMilestone.id, { status: "done" });
    await seeded.store.archiveMilestone(doneMilestone.id, "finished for migrate test");

    const tasksArchive = await seeded.store.fetchArchive(TASKS_LEDGER, doneMilestone.id);
    const milestonesArchive = await seeded.store.fetchArchive(MILESTONES_LEDGER, doneMilestone.id);
    const resolvedBackend = backend ?? resolveLedgerBackend(root).backend;
    const workset =
      resolvedBackend === "git-object"
        ? await createGitObjectWorksetStore({
            repoRoot: root,
            ref: resolveLedgerBackend(root).branch,
          })
        : createFsWorksetStore({ root });
    const roots = ["tasks:T-seeded", "goals:G-seeded"];
    await workset.setRoots(roots);
    const rootState = await workset.setRoots(roots);
    return {
      milestone,
      item,
      goal,
      archivedMilestoneId: doneMilestone.id,
      tasksArchive,
      milestonesArchive,
      roots,
      rootEpoch: rootState.epoch,
    };
  } finally {
    await seeded.store.dispose();
  }
}

async function addLegacyManifestEvidence(
  root: string,
  backend: "fs" | "git-object",
  seed: SeededState,
): Promise<void> {
  const goalsSchema = CANONICAL_LEDGERS.find(({ name }) => name === GOALS_LEDGER)?.schema;
  if (goalsSchema === undefined) throw new Error("canonical goals schema missing");
  const update = (source: string): string => {
    const ledger = parseLedger(source, { schema: goalsSchema, isMilestonesLedger: false });
    const goal = ledger.milestones
      .flatMap(({ items }) => items)
      .find(({ id }) => id === seed.goal.id);
    if (goal === undefined) throw new Error("legacy goal missing");
    goal.fields[PLAN_CURRENT_DRAFT_FIELD] = JSON.stringify({
      identity: {
        goalId: seed.goal.id,
        claimId: "legacy-claim",
        generation: 1,
        revision: 1,
      },
      manifest: {
        revision: 1,
        milestones: [{ key: "delivery", id: seed.milestone.id }],
        tasks: [{ key: "task", id: seed.item.id }],
      },
    });
    return serializeLedger(ledger);
  };

  const goalPath =
    backend === "fs" ? `${LEDGER_STORAGE_DIRNAME}/${GOALS_LEDGER}.md` : `${GOALS_LEDGER}.md`;
  if (backend === "fs") {
    const absolute = path.join(root, goalPath);
    await fs.writeFile(absolute, update(await fs.readFile(absolute, "utf8")), "utf8");
    return;
  }
  const branch = resolveLedgerBackend(root).branch;
  const ref = `refs/heads/${branch}`;
  const git = GitPlumbing.withCwd(root);
  const parent = await git.readRef(ref);
  if (parent === null) throw new Error("legacy git ref missing");
  const entries = await git.lsTreeEntries(ref);
  const updatedBlob = await git.hashObject(update(await git.catFile(ref, goalPath)));
  const tree = await git.writeTree(
    entries.map((entry) =>
      entry.path === goalPath ? { ...entry, sha: updatedBlob } : entry,
    ),
  );
  const commit = await git.commitTree(tree, parent, "legacy manifest ownership fixture");
  await git.updateRef(ref, commit, parent);
}

/** Seed both log artifacts through `cq log put` (backend-routed). */
async function seedLogs(root: string): Promise<void> {
  const putMd = await dispatch(
    ["log", "put", "--stdin", "--dest", `logs/${SESSION_LOG_REL}`, "--cwd", root],
    recordingIo(SESSION_LOG_BODY),
  );
  expect(putMd.exitCode).toBe(0);
  const putRaw = await dispatch(
    ["log", "put", "--stdin", "--dest", `logs/${RAW_LOG_REL}`, "--cwd", root],
    recordingIo(RAW_LOG_BODY),
  );
  expect(putRaw.exitCode).toBe(0);
}

/**
 * Full post-migrate parity assertions: cq.toml flipped to xdg, fetch parity
 * (item, milestone, BOTH archives), and readLog parity for both artifacts.
 */
async function assertMigratedParity(root: string, seed: SeededState): Promise<void> {
  expect(resolveLedgerBackend(root).backend).toBe("xdg");

  const migrated = await createLedgerStore(root);
  try {
    expect(migrated.backend).toBe("xdg");
    expect(migrated.store.fetchItem(TASKS_LEDGER, seed.item.id)).toEqual(seed.item);
    expect(migrated.store.fetchMilestone(seed.milestone.id).milestone).toEqual(seed.milestone);
    expect(await migrated.store.fetchArchive(TASKS_LEDGER, seed.archivedMilestoneId)).toEqual(
      seed.tasksArchive,
    );
    expect(await migrated.store.fetchArchive(MILESTONES_LEDGER, seed.archivedMilestoneId)).toEqual(
      seed.milestonesArchive,
    );
    const workset = migrated.store as typeof migrated.store & {
      worksetStore(): ReturnType<SqliteLedgerStore["worksetStore"]>;
    };
    expect(await readWorksetRootsEpoch(workset.worksetStore())).toEqual({
      roots: seed.roots,
      epoch: seed.rootEpoch,
    });

    // read_log parity — logsDir is resolved the SAME way `read_log` resolves
    // it (resolveLogsDir(projectKey)); a bare probe store reads it directly
    // (readLog is a concrete-backend surface, not on the LedgerStore
    // interface — mirrors restore-cmd.test.ts).
    const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
    const probe = new SqliteLedgerStore({
      dbPath: path.join(resolveStateDir(projectKey), XDG_DB_FILENAME),
      logsDir: resolveLogsDir(projectKey),
    });
    const md = await probe.readLog(SESSION_LOG_REL);
    expect(md.content).toBe(SESSION_LOG_BODY);
    expect(md.truncated).toBeUndefined();
    const raw = await probe.readLog(RAW_LOG_REL);
    expect(raw.content).toBe(RAW_LOG_BODY);
    expect(raw.truncated).toBeUndefined();
  } finally {
    await migrated.store.dispose();
  }
}

describe("cq migrate (T504)", () => {
  let originalXdgStateHome: string | undefined;

  beforeEach(async () => {
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "cq-migrate-xdg-home-"));
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

  it("refuses when [ledger].backend is already 'xdg' (no legacy source)", async () => {
    const root = await gitRepo("cq-migrate-xdg-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toContain("already 'xdg'");
  });

  it("fs backend: migrates state + logs, leaves .cq/ byte-identical, second run refuses", async () => {
    const root = await gitRepo("cq-migrate-fs-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');

    const seed = await seedLegacy(root);
    await seedLogs(root);

    // Snapshot every legacy ledger file's bytes (registry, ledgers, archives,
    // logs) BEFORE migrate.
    const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
    const relsBefore = await ledgerTreePaths(docsDir);
    expect(relsBefore.length).toBeGreaterThan(0);
    const bytesBefore = new Map<string, string>();
    for (const rel of relsBefore) {
      bytesBefore.set(rel, await fs.readFile(path.join(docsDir, rel), "utf8"));
    }

    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);
    expect(io.outs.join("\n")).toContain("UNTOUCHED");

    await assertMigratedParity(root, seed);

    // The legacy .cq/ files are byte-identical: same file set, same bytes.
    const relsAfter = await ledgerTreePaths(docsDir);
    expect(relsAfter).toEqual(relsBefore);
    const bytesAfter = new Map<string, string>();
    for (const rel of relsAfter) {
      bytesAfter.set(rel, await fs.readFile(path.join(docsDir, rel), "utf8"));
    }
    expect(bytesAfter).toEqual(bytesBefore);

    // A second run without --yes refuses (the backend is already xdg).
    const second = await dispatch(["migrate", "--cwd", root], recordingIo());
    expect(second.exitCode).toBe(EXIT_USAGE);
  });

  it("waits for an in-flight source mutation before migration", async () => {
    const root = await gitRepo("cq-migrate-source-admission-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    await seedLegacy(root);

    const sourceWorkset = createFsWorksetStore({ root });
    const mutation = await sourceWorkset.admitLedgerMutation({
      kind: "generic-write",
      targets: ["tasks:T-seeded"],
    });
    const migration = dispatch(["migrate", "--cwd", root], recordingIo());
    let settled = false;
    void migration.then(() => {
      settled = true;
    });

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (sourceWorkset.exclusiveHeld()) break;
      if (settled) throw new Error("migration settled before acquiring source exclusion");
      await Bun.sleep(5);
    }
    expect(settled).toBe(false);
    expect(sourceWorkset.exclusiveHeld()).toBe(true);
    expect(resolveLedgerBackend(root).backend).toBe("fs");

    await mutation.acknowledge();
    expect((await migration).exitCode).toBe(0);
    expect(resolveLedgerBackend(root).backend).toBe("xdg");
  });

  it("refuses a target mutation that commits after the initial emptiness check", async () => {
    const root = await gitRepo("cq-migrate-target-admission-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const target = await createLedgerStore(root);
    if (target.dbPath === undefined) throw new Error("fixture: xdg dbPath missing");
    const targetWorkset = target.store as typeof target.store & {
      worksetStore(): ReturnType<SqliteLedgerStore["worksetStore"]>;
    };
    const taskSchema = target.store.fetch(TASKS_LEDGER).schema;

    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    await seedLegacy(root);
    const mutation = await targetWorkset.worksetStore().admitLedgerMutation({
      kind: "generic-write",
      targets: [],
    });
    const migration = dispatch(["migrate", "--cwd", root], recordingIo());
    let outcome: Awaited<typeof migration> | undefined;
    void migration.then((value) => {
      outcome = value;
    });

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (targetWorkset.worksetStore().exclusiveHeld()) break;
      if (outcome !== undefined) throw new Error("migration settled before acquiring target exclusion");
      await Bun.sleep(5);
    }
    expect(targetWorkset.worksetStore().exclusiveHeld()).toBe(true);

    const db = new Database(target.dbPath);
    db.query(
      "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 0)",
    ).run("late_target", JSON.stringify(taskSchema));
    db.close();
    await mutation.acknowledge();

    expect((await migration).exitCode).toBe(EXIT_REFUSED);
    expect(resolveLedgerBackend(root).backend).toBe("fs");
    expect(target.store.enumerate()).toContain("late_target");
    await target.store.dispose();
  });

  it("--yes authorizes a target mutation that commits after the initial emptiness check", async () => {
    const root = await gitRepo("cq-migrate-target-admission-yes-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const target = await createLedgerStore(root);
    if (target.dbPath === undefined) throw new Error("fixture: xdg dbPath missing");
    const targetWorkset = target.store as typeof target.store & {
      worksetStore(): ReturnType<SqliteLedgerStore["worksetStore"]>;
    };
    const taskSchema = target.store.fetch(TASKS_LEDGER).schema;

    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    const seed = await seedLegacy(root);
    await seedLogs(root);
    const mutation = await targetWorkset.worksetStore().admitLedgerMutation({
      kind: "generic-write",
      targets: [],
    });
    const migration = dispatch(["migrate", "--cwd", root, "--yes"], recordingIo());
    let outcome: Awaited<typeof migration> | undefined;
    void migration.then((value) => {
      outcome = value;
    });

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (targetWorkset.worksetStore().exclusiveHeld()) break;
      if (outcome !== undefined) throw new Error("migration settled before acquiring target exclusion");
      await Bun.sleep(5);
    }
    expect(targetWorkset.worksetStore().exclusiveHeld()).toBe(true);

    const db = new Database(target.dbPath);
    db.query(
      "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 0)",
    ).run("late_target", JSON.stringify(taskSchema));
    db.close();
    await mutation.acknowledge();

    expect((await migration).exitCode).toBe(0);
    expect(resolveLedgerBackend(root).backend).toBe("xdg");
    await target.store.dispose();
    await assertMigratedParity(root, seed);
    const restored = await createLedgerStore(root);
    expect(restored.store.enumerate()).not.toContain("late_target");
    await restored.store.dispose();
  });

  it("K117: a cq.toml-less legacy tree migrates as an fs source (default resolution is xdg, but the in-tree ledger is detected)", async () => {
    const root = await gitRepo("cq-migrate-noconfig-");
    // NO cq.toml at all — pre-K117 this root resolved to the fs default; now
    // it resolves to xdg with explicit=false, and migrate must still find the
    // legacy in-tree source.
    const seed = await seedLegacy(root, "fs");
    await seedLogs(root);

    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);
    expect(io.outs.join("\n")).toContain("legacy in-tree ledger");

    await assertMigratedParity(root, seed);

    // A second run refuses: cq.toml now names xdg explicitly.
    const second = await dispatch(["migrate", "--cwd", root], recordingIo());
    expect(second.exitCode).toBe(EXIT_USAGE);
  });

  it("git-object backend: migrates state + logs, leaves the orphan ref byte-identical, second run refuses", async () => {
    const root = await gitRepo("cq-migrate-git-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "git-object"\nbranch = "cq-migrate-src"\n',
    );

    const seed = await seedLegacy(root);
    await seedLogs(root);

    // Snapshot the orphan ref's tip BEFORE migrate — byte-identity of the
    // whole legacy source (state + log CAS) reduces to the commit sha.
    const shaBefore = (
      await exec("git", ["rev-parse", "refs/heads/cq-migrate-src"], { cwd: root })
    ).stdout.trim();

    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);
    expect(io.outs.join("\n")).toContain("refs/heads/cq-migrate-src");

    await assertMigratedParity(root, seed);

    // The orphan ref never moved.
    const shaAfter = (
      await exec("git", ["rev-parse", "refs/heads/cq-migrate-src"], { cwd: root })
    ).stdout.trim();
    expect(shaAfter).toBe(shaBefore);

    // A second run without --yes refuses (the backend is already xdg).
    const second = await dispatch(["migrate", "--cwd", root], recordingIo());
    expect(second.exitCode).toBe(EXIT_USAGE);
  }, 30_000);

  for (const backend of ["fs", "git-object"] as const) {
    it(`${backend} legacy migration infers only the exact manifest ownership`, async () => {
      const root = await gitRepo(`cq-migrate-owner-${backend}-`);
      await fs.writeFile(
        path.join(root, "cq.toml"),
        backend === "fs"
          ? '[ledger]\nbackend = "fs"\n'
          : '[ledger]\nbackend = "git-object"\nbranch = "cq-owner-source"\n',
      );
      const seed = await seedLegacy(root);
      await addLegacyManifestEvidence(root, backend, seed);
      const beforeRoots = { roots: seed.roots, epoch: seed.rootEpoch };

      expect((await dispatch(["migrate", "--cwd", root], recordingIo())).exitCode).toBe(0);
      const migrated = await createLedgerStore(root);
      try {
        for (const [ledgerId, itemId] of [
          [MILESTONES_LEDGER, seed.milestone.id],
          [TASKS_LEDGER, seed.item.id],
        ] as const) {
          expect(readCanonicalOwnership(migrated.store.fetchItem(ledgerId, itemId))).toEqual({
            ownerRef: `goals:${seed.goal.id}`,
            edgeKind: "active-current-draft",
          });
        }
        const workset = migrated.store as typeof migrated.store & {
          worksetStore(): ReturnType<SqliteLedgerStore["worksetStore"]>;
        };
        expect(await readWorksetRootsEpoch(workset.worksetStore())).toEqual(beforeRoots);
      } finally {
        await migrated.store.dispose();
      }
    }, 30_000);
  }

  it("rejects sealed/evidence conflict before xdg target access or config flip", async () => {
    const root = await gitRepo("cq-migrate-owner-conflict-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    const seed = await seedLegacy(root);
    await addLegacyManifestEvidence(root, "fs", seed);

    const taskSchema = CANONICAL_LEDGERS.find(({ name }) => name === TASKS_LEDGER)?.schema;
    if (taskSchema === undefined) throw new Error("canonical tasks schema missing");
    const tasksPath = path.join(root, LEDGER_STORAGE_DIRNAME, `${TASKS_LEDGER}.md`);
    const tasks = parseLedger(await fs.readFile(tasksPath, "utf8"), {
      schema: taskSchema,
      isMilestonesLedger: false,
    });
    const task = tasks.milestones
      .flatMap(({ items }) => items)
      .find(({ id }) => id === seed.item.id);
    if (task === undefined) throw new Error("legacy task missing");
    task.fields[WORKSET_OWNER_REF_FIELD] = `goals:${seed.goal.id}`;
    task.fields[WORKSET_OWNER_EDGE_KIND_FIELD] = "finalized-manifest";
    await fs.writeFile(tasksPath, serializeLedger(tasks), "utf8");

    const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
    const dbPath = path.join(resolveStateDir(projectKey), XDG_DB_FILENAME);
    await expect(dispatch(["migrate", "--cwd", root], recordingIo())).rejects.toThrow(
      /conflicting sealed ownership and imported evidence/,
    );
    expect(resolveLedgerBackend(root).backend).toBe("fs");
    await expect(fs.stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to clobber a non-empty xdg target without --yes, writing nothing; --yes proceeds", async () => {
    const root = await gitRepo("cq-migrate-nonempty-");

    // Seed the xdg TARGET first (backend = xdg), so it is non-empty.
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const target = await createLedgerStore(root);
    const preMilestone = await target.store.createMilestone({ title: "pre-existing xdg work" });
    const preItem = await target.store.createItem(TASKS_LEDGER, preMilestone.id, {
      status: "planned",
      fields: { headline: "pre-existing xdg task" },
    });
    await target.store.dispose();

    // Now point cq.toml at the LEGACY fs backend and seed it (state + logs).
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    const seed = await seedLegacy(root);
    await seedLogs(root);

    // Non-TTY, no --yes → refuse (exit EXIT_REFUSED), nothing written.
    const refusedIo = recordingIo();
    const refused = await dispatch(["migrate", "--cwd", root], refusedIo);
    expect(refused.exitCode).toBe(EXIT_REFUSED);

    // cq.toml still names the legacy backend; the xdg primary is untouched.
    expect(resolveLedgerBackend(root).backend).toBe("fs");
    const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
    const probe = new SqliteLedgerStore({
      dbPath: path.join(resolveStateDir(projectKey), XDG_DB_FILENAME),
      logsDir: resolveLogsDir(projectKey),
    });
    await probe.init();
    try {
      expect(probe.fetchItem(TASKS_LEDGER, preItem.id)).toEqual(preItem);
    } finally {
      await probe.dispose();
    }

    // --yes proceeds: the target is overwritten with the legacy content.
    const forced = await dispatch(["migrate", "--cwd", root, "--yes"], recordingIo());
    expect(forced.exitCode).toBe(0);
    await assertMigratedParity(root, seed);
  });
});
