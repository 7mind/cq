/**
 * `cq reset` / `cq erase` — postgres backend tenant scoping (T583, Q275
 * context). A shared Postgres database (T572) holds EVERY tenant's rows —
 * these acceptance tests confirm `reset`/`erase` on tenant A never touches
 * tenant B's rows, that `reset` leaves A with exactly the canonical bootstrap
 * set, that `erase` also drops A's `projects` registry row, and that both
 * subcommands still refuse without confirmation.
 *
 * Env-gated on CQ_TEST_PG_URL (same gate as every other postgres-backend
 * suite, Q286): no Postgres server in this sandbox/CI by default, so this
 * file SKIPS cleanly offline — `bun run check` stays green.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { openPgPool, ensureSchema, CANONICAL_LEDGERS, MILESTONES_AMBIENT_ID } from "@cq/ledger";
import { dispatch, type ConfirmIo, type DispatchIo } from "../src/main.js";

const exec = promisify(execFile);
const PG_URL = process.env.CQ_TEST_PG_URL;
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/** A throwaway initialised git repo (for a stable projectKey) with cq.toml selecting postgres. */
async function postgresRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-reset-erase-pg-"));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  // Unique content per repo so each gets a distinct first-commit SHA (projectKey).
  await writeFile(path.join(dir, "README.md"), `# repo ${randomUUID()}\n`);
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  await writeFile(path.join(dir, "cq.toml"), '[ledger]\nbackend = "postgres"\nbackup = "none"\n', "utf8");
  return dir;
}

async function projectKeyOf(dir: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  });
  return stdout.trim();
}

/** A DispatchIo whose ConfirmIo records output and answers the prompt fixed. */
function recordingIo(isTty: boolean, answer = ""): DispatchIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  const confirm: ConfirmIo = {
    isTty,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    prompt: async () => answer,
  };
  return { outs, errs, out: (l) => outs.push(l), err: (l) => errs.push(l), confirm };
}

interface TenantSnapshot {
  ledgers: unknown[];
  groups: unknown[];
  items: unknown[];
  archivePointers: unknown[];
  archivedItems: unknown[];
  logs: unknown[];
  project: unknown[];
  worksetRoots: unknown[];
  worksetAdmissions: unknown[];
}

/** Full row-level snapshot of every table for one project_key, ordered deterministically. */
async function snapshotTenant(pool: ReturnType<typeof openPgPool>, projectKey: string): Promise<TenantSnapshot> {
  const [ledgers, groups, items, archivePointers, archivedItems, logs, project, worksetRoots, worksetAdmissions] =
    await Promise.all([
      pool`SELECT * FROM ledgers WHERE project_key = ${projectKey} ORDER BY name`,
      pool`SELECT * FROM groups WHERE project_key = ${projectKey} ORDER BY ledger, seq`,
      pool`SELECT * FROM items WHERE project_key = ${projectKey} ORDER BY ledger, seq`,
      pool`SELECT * FROM archive_pointers WHERE project_key = ${projectKey} ORDER BY ledger, seq`,
      pool`SELECT * FROM archived_items WHERE project_key = ${projectKey} ORDER BY ledger, pointer_id, seq`,
      pool`SELECT * FROM logs WHERE project_key = ${projectKey} ORDER BY path`,
      pool`SELECT * FROM projects WHERE project_key = ${projectKey}`,
      pool`SELECT project_key, roots_json, epoch FROM workset_roots WHERE project_key = ${projectKey}`,
      pool`SELECT admission_id, form FROM workset_admissions WHERE project_key = ${projectKey} ORDER BY admission_id`,
    ]);
  return {
    ledgers,
    groups,
    items,
    archivePointers,
    archivedItems,
    logs,
    project,
    worksetRoots,
    worksetAdmissions,
  };
}

describe.skipIf(!PG_URL)("cq reset / cq erase — postgres tenant scoping (T583)", () => {
  let originalPgUrl: string | undefined;
  const pool = PG_URL !== undefined ? openPgPool(PG_URL) : undefined;

  beforeEach(async () => {
    originalPgUrl = process.env["CQ_LEDGER_PG_URL"];
    process.env["CQ_LEDGER_PG_URL"] = PG_URL;
    if (pool !== undefined) await ensureSchema(pool);
  });

  afterEach(() => {
    if (originalPgUrl === undefined) {
      delete process.env["CQ_LEDGER_PG_URL"];
    } else {
      process.env["CQ_LEDGER_PG_URL"] = originalPgUrl;
    }
  });

  afterAll(async () => {
    await pool?.close();
  });

  /** Seed a tenant: `cq init` (registers + provisions canonical), then a custom ledger + item + log row. */
  async function seedTenant(root: string): Promise<string> {
    const io = recordingIo(false);
    const outcome = await dispatch(["init", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);
    const projectKey = await projectKeyOf(root);
    await pool!`
      INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at)
      VALUES (${projectKey}, 'tasks', ${`T-seed-${randomUUID().slice(0, 8)}`}, ${MILESTONES_AMBIENT_ID},
              'planned', ${JSON.stringify({ headline: "seeded task" })}, now()::text, now()::text)
    `;
    await pool!`
      INSERT INTO logs (project_key, path, content) VALUES (${projectKey}, ${"raw/seed.md"}, ${"seed log"})
    `;
    // T1959: seed configured workset roots so reset/erase prove root-state wipe.
    await pool!`
      INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation)
      VALUES (${projectKey}, ${JSON.stringify(["goals:G-seed"])}, ${2}, ${2})
      ON CONFLICT (project_key) DO UPDATE
        SET roots_json = EXCLUDED.roots_json, epoch = EXCLUDED.epoch, admit_generation = EXCLUDED.admit_generation
    `;
    return projectKey;
  }

  it("erase on tenant A removes ALL and ONLY A's rows; tenant B is byte-identical before/after", async () => {
    const rootA = await postgresRepo();
    const rootB = await postgresRepo();
    const pkA = await seedTenant(rootA);
    const pkB = await seedTenant(rootB);

    const beforeA = await snapshotTenant(pool!, pkA);
    expect(beforeA.items.length).toBeGreaterThan(0);
    expect(beforeA.project.length).toBe(1);
    const beforeB = await snapshotTenant(pool!, pkB);
    expect(beforeB.items.length).toBeGreaterThan(0);

    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", rootA, "--yes"], io);
    expect(outcome.exitCode).toBe(0);

    const afterA = await snapshotTenant(pool!, pkA);
    expect(afterA.ledgers).toHaveLength(0);
    expect(afterA.groups).toHaveLength(0);
    expect(afterA.items).toHaveLength(0);
    expect(afterA.archivePointers).toHaveLength(0);
    expect(afterA.archivedItems).toHaveLength(0);
    expect(afterA.logs).toHaveLength(0);
    expect(afterA.project).toHaveLength(0);
    expect(afterA.worksetRoots).toHaveLength(0);
    expect(afterA.worksetAdmissions).toHaveLength(0);

    const afterB = await snapshotTenant(pool!, pkB);
    expect(afterB).toEqual(beforeB);
  });

  it("reset on tenant A leaves exactly the canonical bootstrap set; tenant B untouched", async () => {
    const rootA = await postgresRepo();
    const rootB = await postgresRepo();
    const pkA = await seedTenant(rootA);
    const pkB = await seedTenant(rootB);
    const beforeB = await snapshotTenant(pool!, pkB);

    const io = recordingIo(false);
    const outcome = await dispatch(["reset", "--cwd", rootA, "--yes"], io);
    expect(outcome.exitCode).toBe(0);

    const afterA = await snapshotTenant(pool!, pkA);
    // Exactly the canonical ledgers, nothing extra.
    const ledgerNames = afterA.ledgers.map((r) => (r as { name: string }).name).sort();
    expect(ledgerNames).toEqual(CANONICAL_LEDGERS.map((c) => c.name).sort());
    // Every ledger empty except the immortal M-AMBIENT milestone item.
    expect(afterA.items).toHaveLength(1);
    expect((afterA.items[0] as { id: string }).id).toBe(MILESTONES_AMBIENT_ID);
    expect(afterA.archivePointers).toHaveLength(0);
    expect(afterA.archivedItems).toHaveLength(0);
    expect(afterA.logs).toHaveLength(0);
    // Registry entry SURVIVES reset (unlike erase).
    expect(afterA.project).toHaveLength(1);
    // T1959: live roots become unrestricted empty (row may be absent or empty).
    if (afterA.worksetRoots.length > 0) {
      const row = afterA.worksetRoots[0] as { roots_json: string; epoch: number | string };
      expect(JSON.parse(row.roots_json)).toEqual([]);
      expect(Number(row.epoch)).toBe(0);
    }
    expect(afterA.worksetAdmissions).toHaveLength(0);

    const afterB = await snapshotTenant(pool!, pkB);
    expect(afterB).toEqual(beforeB);
  });

  it("erase refuses without confirmation (non-TTY, no --yes): exit 2, nothing touched", async () => {
    const root = await postgresRepo();
    const pk = await seedTenant(root);
    const before = await snapshotTenant(pool!, pk);

    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root], io);
    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toContain("--yes");

    const after = await snapshotTenant(pool!, pk);
    expect(after).toEqual(before);
  });

  it("reset refuses without confirmation (non-TTY, no --yes): exit 2, nothing touched", async () => {
    const root = await postgresRepo();
    const pk = await seedTenant(root);
    const before = await snapshotTenant(pool!, pk);

    const io = recordingIo(false);
    const outcome = await dispatch(["reset", "--cwd", root], io);
    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toContain("--yes");

    const after = await snapshotTenant(pool!, pk);
    expect(after).toEqual(before);
  });

  it("erase refuses (nothing to erase) when the resolved project_key has no `projects` registry row", async () => {
    // A cq.toml naming postgres, but `cq init`/seedTenant never ran — the
    // resolved project_key genuinely has no `projects` row.
    const root = await postgresRepo();
    const pk = await projectKeyOf(root);

    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toContain("nothing to erase");

    const rows = await pool!`SELECT project_key FROM projects WHERE project_key = ${pk}`;
    expect(rows).toHaveLength(0);
  });
});

describe("cq erase — D102 postgres connection failure fails loud", () => {
  it("closed-port DSN: non-zero exit + NOT erased line; cq.toml survives", async () => {
    // Closed port: backend=postgres resolved, pool I/O throws.
    // Must NOT fold into the silent fs-only degrade (D102).
    const root = await postgresRepo();
    const io = recordingIo(false);
    const prev = process.env["CQ_LEDGER_PG_URL"];
    const prevDb = process.env["DATABASE_URL"];
    process.env["CQ_LEDGER_PG_URL"] = "postgres://cq:cq@127.0.0.1:1/cq_test";
    delete process.env["DATABASE_URL"];
    try {
      const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
      expect(outcome.exitCode).toBe(2);
      const err = io.errs.join("\n");
      expect(err).toContain("postgres tenant NOT erased");
      expect(err).toMatch(/could not reach the database/i);
      // cq.toml must still be present — erase aborted before the fs wipe.
      const { readFile } = await import("node:fs/promises");
      await expect(readFile(path.join(root, "cq.toml"), "utf8")).resolves.toContain("postgres");
    } finally {
      if (prev === undefined) delete process.env["CQ_LEDGER_PG_URL"];
      else process.env["CQ_LEDGER_PG_URL"] = prev;
      if (prevDb === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDb;
    }
  });

  it("missing DSN on backend=postgres still degrades (PostgresDsnResolutionError path)", async () => {
    const root = await postgresRepo();
    const io = recordingIo(false);
    const prev = process.env["CQ_LEDGER_PG_URL"];
    const prevDb = process.env["DATABASE_URL"];
    // Ensure no ambient DSN can satisfy resolvePostgresDsn.
    delete process.env["CQ_LEDGER_PG_URL"];
    delete process.env["DATABASE_URL"];
    // Also clear libpq vars that the driver might pick up.
    const cleared: Array<[string, string | undefined]> = [];
    for (const k of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSERVICE"]) {
      cleared.push([k, process.env[k]]);
      delete process.env[k];
    }
    try {
      const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
      // Missing DSN degrades: erase still removes cq.toml (fs-only path) and exits 0.
      expect(outcome.exitCode).toBe(0);
      expect(io.errs.join("\n")).not.toContain("postgres tenant NOT erased");
    } finally {
      if (prev === undefined) delete process.env["CQ_LEDGER_PG_URL"];
      else process.env["CQ_LEDGER_PG_URL"] = prev;
      if (prevDb === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDb;
      for (const [k, v] of cleared) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

