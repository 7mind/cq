/**
 * `cq migrate --to postgres` (T581, G81/M250 — Q280) — the xdg -> postgres
 * leg, per the acceptance:
 *
 *   - seed an xdg primary with items + a log artifact;
 *   - run the migrate handler with `--to postgres`;
 *   - the postgres tenant carries identical items (fetch/archive parity) and
 *     the log round-trips via readLog;
 *   - cq.toml now says `[ledger] backend = "postgres"`;
 *   - the original xdg data is logically identical after the durable
 *     administrative admission closes;
 *   - re-running refuses (the tenant is now non-empty).
 *
 * PLUS an offline refusal test (`--to postgres` with backend != 'xdg') that
 * needs no Postgres server.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as every other
 * postgres-*.test.ts): no Postgres server in this sandbox/CI by default, so
 * the live describe block SKIPS cleanly offline — `bun run check` stays green.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  ensureSchema,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  PLAN_CURRENT_DRAFT_FIELD,
  openPgPool,
  PostgresLedgerStore,
  resolveDisplayName,
  resolveLedgerBackend,
  resolveLogsDir,
  resolveProjectKey,
  resolveStateDir,
  SqliteLedgerStore,
  TASKS_LEDGER,
  XDG_DB_FILENAME,
  readWorksetRootsEpoch,
  readCanonicalOwnership,
  startPostgresCoherenceWatcher,
  type ArchiveContent,
  type Item,
  type ResolvedPostgresHandle,
} from "@cq/ledger";
import { dispatch, EXIT_USAGE, type ConfirmIo, type DispatchIo } from "../src/main.js";

const exec = promisify(execFile);
const PG_URL = process.env.CQ_TEST_PG_URL;

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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return predicate();
}

/** A throwaway initialised git repo with one commit (the xdg/postgres identity key). */
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

describe("cq migrate --to postgres (T581) — offline refusal", () => {
  it("refuses --to postgres when [ledger] backend != 'xdg'", async () => {
    const root = await gitRepo("cq-migrate-pg-refuse-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root, "--to", "postgres"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toContain("not 'xdg'");
  });

  it("K117: refuses --to postgres on a cq.toml-less root with a clean usage error (default-xdg resolution must not fall through)", async () => {
    const root = await gitRepo("cq-migrate-pg-noconfig-");
    // NO cq.toml: resolution yields the K117 xdg DEFAULT (explicit=false).
    // This leg needs an explicit xdg config (the DSN/flip live in cq.toml) —
    // it must refuse with EXIT_USAGE, not throw an internal error.
    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root, "--to", "postgres"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toContain("no [ledger] backend configured");
  });

  it("rejects an unrecognised --to value with a usage error (no crash)", async () => {
    const root = await gitRepo("cq-migrate-pg-badflag-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root, "--to", "mysql"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toContain('"postgres"');
  });
});

const SESSION_LOG_REL = "20260721-0900-session.md";
const SESSION_LOG_BODY = "# session log\n\nT581 migrate --to postgres notes.\n";
const RAW_LOG_REL = "raw/20260721-0900-cli.jsonl";
const RAW_LOG_BODY = '{"type":"turn","n":1}\n{"type":"turn","n":2}\n';

/** What the xdg seed produced — the parity baseline for post-migrate reads. */
interface SeededState {
  milestone: Item;
  item: Item;
  archivedMilestoneId: string;
  tasksArchive: ArchiveContent;
  milestonesArchive: ArchiveContent;
  roots: string[];
  rootEpoch: number;
}

/**
 * Seed the xdg primary at `root` (cq.toml backend='xdg') via the live
 * factory: an active milestone + task, PLUS a fully archived milestone (a
 * done task, milestone done, archiveMilestone) so migrate parity covers
 * archives too.
 */
async function seedXdg(root: string): Promise<SeededState> {
  await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
  const resolved = await createLedgerStore(root);
  try {
    const milestone = await resolved.store.createMilestone({ title: "active work" });
    const item = await resolved.store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "seeded task" },
      author: "tester[1m]",
      session: "sess-581a",
    });

    const doneMilestone = await resolved.store.createMilestone({ title: "finished work" });
    const doneItem = await resolved.store.createItem(TASKS_LEDGER, doneMilestone.id, {
      status: "planned",
      fields: { headline: "finished task" },
    });
    await resolved.store.updateItem(TASKS_LEDGER, doneItem.id, { status: "done" });
    await resolved.store.updateMilestone(doneMilestone.id, { status: "done" });
    await resolved.store.archiveMilestone(doneMilestone.id, "finished for T581 test");

    const tasksArchive = await resolved.store.fetchArchive(TASKS_LEDGER, doneMilestone.id);
    const milestonesArchive = await resolved.store.fetchArchive(
      MILESTONES_LEDGER,
      doneMilestone.id,
    );
    const workset = resolved.store as typeof resolved.store & {
      worksetStore(): ReturnType<PostgresLedgerStore["worksetStore"]>;
    };
    const roots = ["ideas:I-seeded", "goals:G-seeded"];
    await workset.worksetStore().setRoots(roots);
    const rootState = await workset.worksetStore().setRoots(roots);
    return {
      milestone,
      item,
      archivedMilestoneId: doneMilestone.id,
      tasksArchive,
      milestonesArchive,
      roots,
      rootEpoch: rootState.epoch,
    };
  } finally {
    await resolved.store.dispose();
  }
}

/** Seed both log artifacts through `cq log put` (backend-routed — writes to the xdg logsDir). */
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

describe.skipIf(!PG_URL)("cq migrate --to postgres (T581) — live", () => {
  let originalXdgStateHome: string | undefined;
  let originalPgUrl: string | undefined;
  const pool = PG_URL !== undefined ? openPgPool(PG_URL) : undefined;

  beforeEach(async () => {
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "cq-migrate-pg-xdg-home-"));
    dirs.push(xdgHome);
    process.env["XDG_STATE_HOME"] = xdgHome;

    originalPgUrl = process.env["CQ_LEDGER_PG_URL"];
    process.env["CQ_LEDGER_PG_URL"] = PG_URL;
    if (pool !== undefined) await ensureSchema(pool);
  });

  afterEach(() => {
    if (originalXdgStateHome === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = originalXdgStateHome;
    }
    if (originalPgUrl === undefined) {
      delete process.env["CQ_LEDGER_PG_URL"];
    } else {
      process.env["CQ_LEDGER_PG_URL"] = originalPgUrl;
    }
  });

  afterAll(async () => {
    await pool?.close();
  });

  it("migrates the xdg primary into postgres: item/archive/log parity, cq.toml flips, xdg source data intact, re-run refuses", async () => {
    const root = await gitRepo("cq-migrate-pg-");
    const seed = await seedXdg(root);
    await seedLogs(root);

    const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
    const dbPath = path.join(resolveStateDir(projectKey), XDG_DB_FILENAME);
    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root, "--to", "postgres"], io);
    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);
    expect(io.outs.join("\n")).toContain("INTACT");

    // cq.toml flipped.
    expect(resolveLedgerBackend(root).backend).toBe("postgres");

    // Durable admission may change SQLite's physical bytes. The source's
    // logical data remains exact and no admission survives migration.
    const source = new SqliteLedgerStore({ dbPath, logsDir: resolveLogsDir(projectKey) });
    await source.init();
    try {
      expect(source.fetchItem(TASKS_LEDGER, seed.item.id)).toEqual(seed.item);
      expect(source.fetchMilestone(seed.milestone.id).milestone).toEqual(seed.milestone);
      expect(await source.fetchArchive(TASKS_LEDGER, seed.archivedMilestoneId)).toEqual(
        seed.tasksArchive,
      );
      expect(await source.fetchArchive(MILESTONES_LEDGER, seed.archivedMilestoneId)).toEqual(
        seed.milestonesArchive,
      );
      expect(await readWorksetRootsEpoch(source.worksetStore())).toEqual({
        roots: seed.roots,
        epoch: seed.rootEpoch,
      });
      expect(source.worksetStore().activeAdmissionCount()).toBe(0);
      expect((await source.readLog(SESSION_LOG_REL)).content).toBe(SESSION_LOG_BODY);
      expect((await source.readLog(RAW_LOG_REL)).content).toBe(RAW_LOG_BODY);
    } finally {
      await source.dispose();
    }

    // Item / archive / log parity on the postgres tenant.
    const displayName = resolveDisplayName({
      projectName: null,
      projectId: null,
      repoBasename: path.basename(root),
      projectKey,
    });
    const migrated = new PostgresLedgerStore({
      pool: openPgPool(PG_URL!),
      projectKey,
      displayName,
    });
    await migrated.init();
    try {
      expect(migrated.fetchItem(TASKS_LEDGER, seed.item.id)).toEqual(seed.item);
      expect(migrated.fetchMilestone(seed.milestone.id).milestone).toEqual(seed.milestone);
      expect(await migrated.fetchArchive(TASKS_LEDGER, seed.archivedMilestoneId)).toEqual(
        seed.tasksArchive,
      );
      expect(await migrated.fetchArchive(MILESTONES_LEDGER, seed.archivedMilestoneId)).toEqual(
        seed.milestonesArchive,
      );
      expect(await readWorksetRootsEpoch(migrated.worksetStore())).toEqual({
        roots: seed.roots,
        epoch: seed.rootEpoch,
      });

      const md = await migrated.readLog(SESSION_LOG_REL);
      expect(md.content).toBe(SESSION_LOG_BODY);
      const raw = await migrated.readLog(RAW_LOG_REL);
      expect(raw.content).toBe(RAW_LOG_BODY);

      // Counters continue without collision: the next createItem must
      // allocate T3 (T1/T2 already used by the xdg seed), not collide.
      const next = await migrated.createItem(TASKS_LEDGER, seed.milestone.id, {
        status: "planned",
        fields: { headline: "post-migrate task" },
      });
      expect(next.id).toBe("T3");
    } finally {
      await migrated.dispose();
    }

    // Re-running refuses because the TENANT is non-empty (not merely
    // because cq.toml no longer names 'xdg'): revert cq.toml to 'xdg' —
    // the xdg source data is still on disk — to isolate the
    // non-empty-tenant refusal from the earlier "backend must be xdg"
    // guard, then attempt the postgres leg again against the SAME
    // (now non-empty) tenant.
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const secondIo = recordingIo();
    const second = await dispatch(["migrate", "--cwd", root, "--to", "postgres"], secondIo);
    expect(second.exitCode).toBe(EXIT_USAGE);
    expect(secondIo.errs.join("\n")).toContain("non-empty");
    // The refusal reverted nothing further and wrote nothing: cq.toml
    // still names 'xdg' (the refusal never reaches setLedgerBackend).
    expect(resolveLedgerBackend(root).backend).toBe("xdg");
  }, 30_000);

  it("infers exact legacy manifest ownership before target mutation and notifies an open peer", async () => {
    const root = await gitRepo("cq-migrate-owner-pg-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const source = await createLedgerStore(root);
    const projectKey = source.projectKey!;
    const dbPath = source.dbPath!;
    const milestone = await source.store.createMilestone({ title: "owned legacy manifest" });
    const task = await source.store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "infer on migration" },
    });
    const goal = await source.store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "planning",
      fields: { title: "Legacy goal", description: "Exact manifest evidence" },
    });
    const sourceRoots = [`goals:${goal.id}`];
    const sourceWorkset = source.store as typeof source.store & {
      worksetStore(): ReturnType<PostgresLedgerStore["worksetStore"]>;
    };
    const rootsBefore = await sourceWorkset.worksetStore().setRoots(sourceRoots);
    await source.store.dispose();

    // Legacy fixture: exact plan manifest exists, sealed ownership fields do
    // not. Direct row setup represents a pre-T1951 primary.
    const db = new Database(dbPath);
    const goalRow = db
      .query<{ fields_json: string }, [string]>(
        "SELECT fields_json FROM items WHERE ledger = 'goals' AND id = ?",
      )
      .get(goal.id);
    if (goalRow === null) throw new Error("legacy goal row missing");
    const fields = JSON.parse(goalRow.fields_json) as Record<string, unknown>;
    fields[PLAN_CURRENT_DRAFT_FIELD] = JSON.stringify({
      identity: { goalId: goal.id, claimId: "legacy-claim", generation: 1, revision: 1 },
      manifest: {
        revision: 1,
        milestones: [{ key: "delivery", id: milestone.id }],
        tasks: [{ key: "task", id: task.id }],
      },
    });
    db.query("UPDATE items SET fields_json = ? WHERE ledger = 'goals' AND id = ?").run(
      JSON.stringify(fields),
      goal.id,
    );
    db.close();

    const peerPool = openPgPool(PG_URL!);
    const peer = new PostgresLedgerStore({
      pool: peerPool,
      projectKey,
      displayName: projectKey,
    });
    await peer.init();
    let changes = 0;
    const watcher = startPostgresCoherenceWatcher(
      peer,
      { pool: peerPool, dsn: PG_URL!, projectKey } satisfies ResolvedPostgresHandle,
      () => {
        changes += 1;
      },
    );
    await waitFor(() => changes > 0);
    const beforeMigrationChanges = changes;
    try {
      const outcome = await dispatch(
        ["migrate", "--cwd", root, "--to", "postgres"],
        recordingIo(),
      );
      expect(outcome.exitCode).toBe(0);
      expect(resolveLedgerBackend(root).backend).toBe("postgres");
      expect(
        await waitFor(() => {
          if (changes <= beforeMigrationChanges) return false;
          try {
            return readCanonicalOwnership(peer.fetchItem(TASKS_LEDGER, task.id)) !== null;
          } catch {
            return false;
          }
        }),
      ).toBe(true);
      expect(readCanonicalOwnership(peer.fetchItem(TASKS_LEDGER, task.id))).toEqual({
        ownerRef: `goals:${goal.id}`,
        edgeKind: "active-current-draft",
      });
      expect(readCanonicalOwnership(peer.fetchItem(MILESTONES_LEDGER, milestone.id))).toEqual({
        ownerRef: `goals:${goal.id}`,
        edgeKind: "active-current-draft",
      });
      expect(await readWorksetRootsEpoch(peer.worksetStore())).toEqual({
        roots: sourceRoots,
        epoch: rootsBefore.epoch,
      });
    } finally {
      watcher.close();
      await peer.dispose();
    }
  }, 30_000);
});
