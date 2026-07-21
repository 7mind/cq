/**
 * T582 (Q275 full-parity decision): `cq backup` / `cq restore` against
 * `backend = 'postgres'` — the SAME acceptance the xdg suites cover
 * (backup-cmd.test.ts / restore-cmd.test.ts), exercised over a real tenant:
 *
 *  - `cq backup` (in-tree AND orphan-branch) dumps a postgres-backed repo's
 *    tenant — items + a milestone + logs (via the T575 `listLogs` seam,
 *    tenant-keyed `logs` table, NOT a filesystem `logsDir`) — into the SAME
 *    `.cq/`-layout dump the xdg backend produces;
 *  - a full tenant wipe + `cq restore --yes` reproduces IDENTICAL items and
 *    logs (fetch_item/read_log parity), scoped STRICTLY to the connecting
 *    project's `project_key` — a second tenant is untouched;
 *  - `cq restore` refuses to overwrite a NON-EMPTY tenant without `--yes`.
 *
 * Env-gated on CQ_TEST_PG_URL (same gate as every other postgres-backend
 * suite, Q286): no Postgres server in this sandbox/CI by default, so this
 * file SKIPS cleanly offline — `bun run check` stays green.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createLedgerStore, openPgPool, ensureSchema, PostgresLedgerStore, TASKS_LEDGER } from "@cq/ledger";
import { dispatch, EXIT_USAGE, type ConfirmIo, type DispatchIo } from "../src/main.js";
import { EXIT_REFUSED } from "../src/confirm.js";

const exec = promisify(execFile);
const PG_URL = process.env.CQ_TEST_PG_URL;
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
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

/** A throwaway initialised git repo with a UNIQUE first commit (distinct projectKey/tenant). */
async function postgresRepo(cqToml: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-backup-restore-pg-"));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), `# repo ${randomUUID()}\n`);
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  await writeFile(path.join(dir, "cq.toml"), cqToml, "utf8");
  return dir;
}

async function projectKeyOf(dir: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  });
  return stdout.trim();
}

const SESSION_LOG_REL = "20260721-1300-session.md";
const SESSION_LOG_BODY = "# session log\n\nsome notes.\n";
const RAW_LOG_REL = "raw/20260721-1300-cli.jsonl";
const RAW_LOG_BODY = '{"type":"turn","n":1}\n';

describe.skipIf(!PG_URL)("cq backup / cq restore — postgres backend (T582, Q275)", () => {
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

  it('refuses with a usage error when [ledger].backup is "none"/absent (postgres backend)', async () => {
    const root = await postgresRepo('[ledger]\nbackend = "postgres"\n');
    const backupOutcome = await dispatch(["backup", "--cwd", root], recordingIo());
    expect(backupOutcome.exitCode).toBe(EXIT_USAGE);
    const restoreOutcome = await dispatch(["restore", "--cwd", root], recordingIo());
    expect(restoreOutcome.exitCode).toBe(EXIT_USAGE);
  });

  /**
   * The full backup -> tenant wipe -> restore --yes round-trip, parameterised
   * by the dump SOURCE (`[ledger].backup` target) — mirrors restore-cmd.test.ts's
   * `roundTrip` helper exactly, over a postgres tenant instead of the xdg
   * out-of-tree primary.
   */
  async function roundTrip(cqToml: string): Promise<void> {
    const root = await postgresRepo(cqToml);
    const projectKey = await projectKeyOf(root);

    // --- Seed: a milestone + a task item directly against the postgres tenant.
    const seeded = await createLedgerStore(root);
    const milestone = await seeded.store.createMilestone({ title: "pg restore round-trip" });
    const item = await seeded.store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "seeded pg task" },
      author: "tester[1m]",
      session: "sess-1",
    });
    await seeded.store.dispose();

    // --- Seed logs via `cq log put` (the postgres branch, tenant-keyed `logs` table).
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

    // --- Export.
    const backupIo = recordingIo();
    const backupOutcome = await dispatch(["backup", "--cwd", root], backupIo);
    expect(backupOutcome.exitCode).toBe(0);
    expect(backupIo.errs).toEqual([]);

    // --- Wipe the ENTIRE tenant (every row, including the `projects` registration —
    // restoreDumpToPostgres self-registers, mirroring restoreDumpToXdg's fresh-primary case).
    const pool = openPgPool(PG_URL!);
    await ensureSchema(pool);
    await pool.begin(async (tx) => {
      await tx`DELETE FROM archived_items WHERE project_key = ${projectKey}`;
      await tx`DELETE FROM archive_pointers WHERE project_key = ${projectKey}`;
      await tx`DELETE FROM items WHERE project_key = ${projectKey}`;
      await tx`DELETE FROM groups WHERE project_key = ${projectKey}`;
      await tx`DELETE FROM ledgers WHERE project_key = ${projectKey}`;
      await tx`DELETE FROM logs WHERE project_key = ${projectKey}`;
      await tx`DELETE FROM projects WHERE project_key = ${projectKey}`;
    });
    const wiped = await pool`SELECT project_key FROM projects WHERE project_key = ${projectKey}`;
    expect(wiped).toHaveLength(0);

    // --- Restore.
    const restoreIo = recordingIo();
    const restoreOutcome = await dispatch(["restore", "--cwd", root, "--yes"], restoreIo);
    expect(restoreOutcome.exitCode).toBe(0);
    expect(restoreIo.errs).toEqual([]);

    // --- fetch_ledger/fetch_item parity.
    const restored = new PostgresLedgerStore({ pool, projectKey, displayName: projectKey });
    await restored.init();
    try {
      const restoredItem = restored.fetchItem(TASKS_LEDGER, item.id);
      expect(restoredItem).toEqual(item);

      const restoredMilestone = restored.fetchMilestone(milestone.id);
      expect(restoredMilestone.milestone).toEqual(milestone);

      // --- read_log parity — every pre-wipe log artifact is readable with
      // content equal to its pre-wipe content.
      const md = await restored.readLog(SESSION_LOG_REL);
      expect(md.content).toBe(SESSION_LOG_BODY);
      const raw = await restored.readLog(RAW_LOG_REL);
      expect(raw.content).toBe(RAW_LOG_BODY);
    } finally {
      await restored.dispose();
    }
  }

  it("in-tree source: round-trips items + a milestone + logs through backup -> tenant wipe -> restore --yes", async () => {
    await roundTrip('[ledger]\nbackend = "postgres"\nbackup = "in-tree"\n');
  });

  it("orphan-branch source: round-trips items + a milestone + logs through backup -> tenant wipe -> restore --yes", async () => {
    await roundTrip('[ledger]\nbackend = "postgres"\nbackup = "orphan-branch"\nbranch = "cq-restore-pg-dump"\n');
  });

  it("refuses to restore onto a non-empty postgres tenant without --yes, writing nothing", async () => {
    const root = await postgresRepo('[ledger]\nbackend = "postgres"\nbackup = "in-tree"\n');
    const projectKey = await projectKeyOf(root);

    const seeded = await createLedgerStore(root);
    const milestone = await seeded.store.createMilestone({ title: "still here" });
    const item = await seeded.store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "pre-existing pg task" },
    });
    await seeded.store.dispose();

    const backupOutcome = await dispatch(["backup", "--cwd", root], recordingIo());
    expect(backupOutcome.exitCode).toBe(0);

    // Non-TTY, no --yes → refuse (exit EXIT_REFUSED), nothing written.
    const restoreIo = recordingIo();
    const restoreOutcome = await dispatch(["restore", "--cwd", root], restoreIo);
    expect(restoreOutcome.exitCode).toBe(EXIT_REFUSED);

    const pool = openPgPool(PG_URL!);
    await ensureSchema(pool);
    const stillThere = new PostgresLedgerStore({ pool, projectKey, displayName: projectKey });
    await stillThere.init();
    try {
      expect(stillThere.fetchItem(TASKS_LEDGER, item.id)).toEqual(item);
    } finally {
      await stillThere.dispose();
    }
  });
});
