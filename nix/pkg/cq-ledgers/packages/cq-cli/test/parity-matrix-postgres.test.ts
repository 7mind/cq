/**
 * T584 (R690 split) — the FULL cq-cli subcommand x backend='postgres' parity
 * matrix. Every SUBCOMMAND (init/reset/erase/advance-gate/predicates/counts/
 * log/backup/restore/migrate) has an explicit, tested postgres expectation
 * here — either an OFFLINE fail-fast/refusal or a LIVE works-row — so nothing
 * regresses to an accidental LegacyBackendError-style crash: every offline
 * row asserts the SPECIFIC error/message, not just "it throws".
 *
 * Split (R690 review):
 *  - OFFLINE half (unconditional, no live server, no gate): missing-DSN
 *    fail-fast (PostgresDsnResolutionError, uncaught — the SAME propagation
 *    path every subcommand's createLedgerStore/resolvePostgresTenant call
 *    takes) + refused-combo usage errors (backup/restore's default
 *    backup="none"; migrate --to postgres when backend != 'xdg' — both
 *    checked BEFORE any DSN resolution, so no live server is needed either).
 *    Deterministic; keeps `bun run check` green with no Postgres available.
 *  - LIVE half (CQ_TEST_PG_URL-gated, SKIPs cleanly offline): backup/restore/
 *    migrate/log put SUCCEEDING against a real tenant — a lean cross-command
 *    SMOKE pass. The EXHAUSTIVE live acceptance for each already lives in its
 *    own dedicated suite (backup-restore-postgres.test.ts,
 *    migrate-postgres.test.ts, log-put-postgres.test.ts,
 *    reset-erase-postgres.test.ts, postgres-native-cmds.test.ts) — this file
 *    does not duplicate their depth, only closes the "does it actually work"
 *    row for the four subcommands R690 named.
 *
 * init/reset/erase/advance-gate/predicates/counts get their explicit postgres
 * expectation from the OFFLINE half only: their live "works" path is already
 * exhaustively covered by the dedicated suites above (reset-erase-postgres /
 * postgres-native-cmds), so re-proving it here would be pure duplication.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as every other
 * postgres-*.test.ts) for the live half only.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  ensureSchema,
  openPgPool,
  PostgresLedgerStore,
  resolveDisplayName,
  resolveLedgerBackend,
  resolveProjectKey,
  resolveStateDir,
  TASKS_LEDGER,
  XDG_DB_FILENAME,
} from "@cq/ledger";
import { dispatch, EXIT_USAGE, type ConfirmIo, type DispatchIo } from "../src/main.js";

const exec = promisify(execFile);
const PG_URL = process.env.CQ_TEST_PG_URL;
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/**
 * Every DSN-resolving env var dsn.ts considers (CQ_LEDGER_PG_URL/DATABASE_URL
 * plus the standard libpq PG* set). Stripped for the duration of each offline
 * row so an ambient host env can never leak a live DSN into a
 * "no DSN configured" fixture and silently turn a fail-fast row into a
 * live-server attempt.
 */
const DSN_ENV_VARS = [
  "CQ_LEDGER_PG_URL",
  "DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSERVICE",
  "PGSSLMODE",
  "PGOPTIONS",
  "PGPASSFILE",
  "PGAPPNAME",
] as const;

/** Run `fn` with every DSN-resolving env var (dsn.ts) deleted, then restore the originals. */
async function withoutDsnEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const k of DSN_ENV_VARS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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

/** A throwaway initialised git repo (stable projectKey) with cq.toml naming `cqToml` verbatim. */
async function pgRepo(tag: string, cqToml = '[ledger]\nbackend = "postgres"\n'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `cq-matrix-${tag}-`));
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

/** The PostgresDsnResolutionError message fragment (dsn.ts) — shared across every offline row below. */
const DSN_MESSAGE = "no Postgres connection info was found";

describe("cq subcommand x backend='postgres' parity matrix — OFFLINE (unconditional, R690)", () => {
  it("init: missing DSN fails fast with PostgresDsnResolutionError (createLedgerStore runs unconditionally, even for an existing cq.toml)", async () => {
    await withoutDsnEnv(async () => {
      const root = await pgRepo("init");
      await expect(dispatch(["init", "--cwd", root], recordingIo())).rejects.toThrow(DSN_MESSAGE);
    });
  });

  it("reset: missing DSN fails fast BEFORE any confirmation prompt (resolvePostgresTenant runs ahead of confirmDestructive)", async () => {
    await withoutDsnEnv(async () => {
      const root = await pgRepo("reset");
      await expect(dispatch(["reset", "--cwd", root], recordingIo())).rejects.toThrow(DSN_MESSAGE);
    });
  });

  it("erase: missing DSN degrades GRACEFULLY — best-effort postgres tenant resolution swallows it, falling back to the bounded fs+config delete (NOT a crash, per the erase module doc)", async () => {
    await withoutDsnEnv(async () => {
      const root = await pgRepo("erase");
      const io = recordingIo();
      const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
      expect(outcome.exitCode).toBe(0);
      expect(io.errs).toEqual([]);
      expect(io.outs.join("\n")).toContain("removed");
      await expect(stat(path.join(root, "cq.toml"))).rejects.toThrow();
    });
  });

  it("advance-gate: an ACTIVE marker forces the ledger read (step 4); missing DSN fails fast (createLedgerStore)", async () => {
    await withoutDsnEnv(async () => {
      const root = await pgRepo("advgate");
      const runtimeDir = await mkdtemp(path.join(tmpdir(), "cq-matrix-advgate-rt-"));
      dirs.push(runtimeDir);
      const prevRuntimeDir = process.env["XDG_RUNTIME_DIR"];
      process.env["XDG_RUNTIME_DIR"] = runtimeDir;
      const session = `matrix-advgate-${randomUUID()}`;
      // A marker with NO external-signal line: computeVerdict proceeds past
      // steps 2/3 into step 4's createLedgerStore call.
      await writeFile(path.join(runtimeDir, `cq-advance-active-${session}`), "active\n", "utf8");
      try {
        await expect(
          dispatch(["advance-gate", "--cwd", root, "--session", session], recordingIo()),
        ).rejects.toThrow(DSN_MESSAGE);
      } finally {
        if (prevRuntimeDir === undefined) delete process.env["XDG_RUNTIME_DIR"];
        else process.env["XDG_RUNTIME_DIR"] = prevRuntimeDir;
      }
    });
  });

  it("predicates: missing DSN fails fast (createLedgerStore, unconditional read)", async () => {
    await withoutDsnEnv(async () => {
      const root = await pgRepo("predicates");
      await expect(dispatch(["predicates", "--cwd", root], recordingIo())).rejects.toThrow(DSN_MESSAGE);
    });
  });

  it("counts: missing DSN fails fast (createLedgerStore, unconditional read)", async () => {
    await withoutDsnEnv(async () => {
      const root = await pgRepo("counts");
      await expect(dispatch(["counts", "--cwd", root], recordingIo())).rejects.toThrow(DSN_MESSAGE);
    });
  });

  it("log put: missing DSN fails fast (createLedgerStore, the postgres branch — AFTER redaction/JSONL validation, before any write)", async () => {
    await withoutDsnEnv(async () => {
      const root = await pgRepo("logput");
      await expect(
        dispatch(["log", "put", "--stdin", "--dest", "logs/x.md", "--cwd", root], recordingIo("hi\n")),
      ).rejects.toThrow(DSN_MESSAGE);
    });
  });

  it('backup: refuses (EXIT_USAGE) when [ledger].backup is "none" (the default) — checked BEFORE createLedgerStore, so no DSN is even needed', async () => {
    await withoutDsnEnv(async () => {
      const root = await pgRepo("backup-none");
      const io = recordingIo();
      const outcome = await dispatch(["backup", "--cwd", root], io);
      expect(outcome.exitCode).toBe(EXIT_USAGE);
      expect(io.errs.join("\n")).toContain('[ledger].backup is "none"');
    });
  });

  it('restore: refuses (EXIT_USAGE) when [ledger].backup is "none" (the default) — checked BEFORE createLedgerStore, so no DSN is even needed', async () => {
    await withoutDsnEnv(async () => {
      const root = await pgRepo("restore-none");
      const io = recordingIo();
      const outcome = await dispatch(["restore", "--cwd", root], io);
      expect(outcome.exitCode).toBe(EXIT_USAGE);
      expect(io.errs.join("\n")).toContain('[ledger].backup is "none"');
    });
  });

  it("migrate --to postgres: refuses (EXIT_USAGE) when backend != 'xdg' — checked BEFORE resolvePostgresDsn, so no DSN is even needed", async () => {
    await withoutDsnEnv(async () => {
      // backend is already 'postgres' — the leg only migrates FROM xdg.
      const root = await pgRepo("migrate-refuse");
      const io = recordingIo();
      const outcome = await dispatch(["migrate", "--to", "postgres", "--cwd", root], io);
      expect(outcome.exitCode).toBe(EXIT_USAGE);
      expect(io.errs.join("\n")).toContain("not 'xdg'");
    });
  });
});

describe.skipIf(!PG_URL)(
  "cq subcommand x backend='postgres' parity matrix — LIVE smoke (CQ_TEST_PG_URL, R690)",
  () => {
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

    it("log put succeeds against a live tenant; content round-trips via store.readLog", async () => {
      const root = await pgRepo("live-logput");
      const io = recordingIo("hello from the parity matrix\n");
      const outcome = await dispatch(
        ["log", "put", "--stdin", "--dest", "logs/matrix.md", "--cwd", root],
        io,
      );
      expect(outcome.exitCode).toBe(0);
      expect(io.errs).toEqual([]);

      const projectKey = await projectKeyOf(root);
      const pool = openPgPool(PG_URL!);
      await ensureSchema(pool);
      const store = new PostgresLedgerStore({ pool, projectKey, displayName: projectKey });
      await store.init();
      try {
        const res = await store.readLog("matrix.md");
        expect(res.content).toBe("hello from the parity matrix\n");
      } finally {
        await store.dispose();
      }
    });

    it("backup then restore round-trips a seeded item against a live tenant", async () => {
      const root = await pgRepo("live-backup", '[ledger]\nbackend = "postgres"\nbackup = "in-tree"\n');
      const projectKey = await projectKeyOf(root);

      const seeded = await createLedgerStore(root);
      const milestone = await seeded.store.createMilestone({ title: "parity matrix backup/restore" });
      const item = await seeded.store.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "matrix seeded task" },
        author: "tester[1m]",
        session: "matrix-sess",
      });
      await seeded.store.dispose();

      const backupOutcome = await dispatch(["backup", "--cwd", root], recordingIo());
      expect(backupOutcome.exitCode).toBe(0);

      // Wipe the ENTIRE tenant (mirrors backup-restore-postgres.test.ts's roundTrip).
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

      const restoreOutcome = await dispatch(["restore", "--cwd", root, "--yes"], recordingIo());
      expect(restoreOutcome.exitCode).toBe(0);

      const restored = new PostgresLedgerStore({ pool, projectKey, displayName: projectKey });
      await restored.init();
      try {
        expect(restored.fetchItem(TASKS_LEDGER, item.id)).toEqual(item);
      } finally {
        await restored.dispose();
      }
    });

    it("migrate --to postgres migrates a fresh xdg primary; cq.toml flips; re-run refuses (non-empty tenant)", async () => {
      const originalXdgStateHome = process.env["XDG_STATE_HOME"];
      const xdgHome = await mkdtemp(path.join(tmpdir(), "cq-matrix-migrate-xdg-home-"));
      dirs.push(xdgHome);
      process.env["XDG_STATE_HOME"] = xdgHome;
      try {
        const root = await pgRepo("live-migrate", '[ledger]\nbackend = "xdg"\n');
        const resolved = await createLedgerStore(root);
        const milestone = await resolved.store.createMilestone({ title: "matrix migrate" });
        const item = await resolved.store.createItem(TASKS_LEDGER, milestone.id, {
          status: "planned",
          fields: { headline: "matrix migrate task" },
        });
        await resolved.store.dispose();

        const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
        const dbPath = path.join(resolveStateDir(projectKey), XDG_DB_FILENAME);

        const io = recordingIo();
        const outcome = await dispatch(["migrate", "--cwd", root, "--to", "postgres"], io);
        expect(outcome.exitCode).toBe(0);
        expect(io.errs).toEqual([]);
        expect(resolveLedgerBackend(root).backend).toBe("postgres");

        const displayName = resolveDisplayName({
          projectName: null,
          projectId: null,
          repoBasename: path.basename(root),
          projectKey,
        });
        const pool = openPgPool(PG_URL!);
        await ensureSchema(pool);
        const migrated = new PostgresLedgerStore({ pool, projectKey, displayName });
        await migrated.init();
        try {
          expect(migrated.fetchItem(TASKS_LEDGER, item.id)).toEqual(item);
        } finally {
          await migrated.dispose();
        }

        // Re-run refuses: the tenant is now non-empty. Revert cq.toml to
        // 'xdg' (untouched source, still on disk) to isolate this from the
        // "backend must be xdg" guard.
        await writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n', "utf8");
        const second = await dispatch(["migrate", "--cwd", root, "--to", "postgres"], recordingIo());
        expect(second.exitCode).toBe(EXIT_USAGE);

        // The xdg source stayed on disk (read-only), untouched by the refusal.
        await stat(dbPath);
      } finally {
        if (originalXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
        else process.env["XDG_STATE_HOME"] = originalXdgStateHome;
      }
    });
  },
);
