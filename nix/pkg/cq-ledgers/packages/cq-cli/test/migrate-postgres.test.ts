/**
 * `cq migrate --to postgres` (T581, G81/M250 — Q280) — the xdg -> postgres
 * leg, per the acceptance:
 *
 *   - seed an xdg primary with items + a log artifact;
 *   - run the migrate handler with `--to postgres`;
 *   - the postgres tenant carries identical items (fetch/archive parity) and
 *     the log round-trips via readLog;
 *   - cq.toml now says `[ledger] backend = "postgres"`;
 *   - the original xdg `ledger.db` is byte-identical before and after
 *     (read-only source);
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
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  ensureSchema,
  MILESTONES_LEDGER,
  openPgPool,
  PostgresLedgerStore,
  resolveDisplayName,
  resolveLedgerBackend,
  resolveProjectKey,
  resolveStateDir,
  TASKS_LEDGER,
  XDG_DB_FILENAME,
  type ArchiveContent,
  type Item,
} from "@cq/ledger";
import { dispatch, EXIT_USAGE, type ConfirmIo, type DispatchIo } from "../src/main.js";

const exec = promisify(execFile);
const PG_URL = process.env.CQ_TEST_PG_URL;

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
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
    const milestonesArchive = await resolved.store.fetchArchive(MILESTONES_LEDGER, doneMilestone.id);
    return {
      milestone,
      item,
      archivedMilestoneId: doneMilestone.id,
      tasksArchive,
      milestonesArchive,
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

  it(
    "migrates the xdg primary into postgres: item/archive/log parity, cq.toml flips, xdg ledger.db untouched, re-run refuses",
    async () => {
      const root = await gitRepo("cq-migrate-pg-");
      const seed = await seedXdg(root);
      await seedLogs(root);

      const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
      const dbPath = path.join(resolveStateDir(projectKey), XDG_DB_FILENAME);
      const dbBytesBefore = await fs.readFile(dbPath);

      const io = recordingIo();
      const outcome = await dispatch(["migrate", "--cwd", root, "--to", "postgres"], io);
      expect(outcome.exitCode).toBe(0);
      expect(io.errs).toEqual([]);
      expect(io.outs.join("\n")).toContain("UNTOUCHED");

      // cq.toml flipped.
      expect(resolveLedgerBackend(root).backend).toBe("postgres");

      // The xdg source ledger.db is byte-identical before/after (read-only source).
      const dbBytesAfter = await fs.readFile(dbPath);
      expect(dbBytesAfter.equals(dbBytesBefore)).toBe(true);

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
      // the xdg source is still on disk, untouched — to isolate the
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
    },
    30_000,
  );
});
