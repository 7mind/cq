/**
 * T580 — `restoreDumpToPostgres`, the postgres analogue of `restoreDumpToXdg`
 * (restore-cmd.test.ts / dependency-ref-migration.test.ts's xdg round trips).
 *
 * Acceptance (verbatim): `buildBackupDump` over a seeded sqlite store ->
 * `restoreDumpToPostgres` -> a `PostgresLedgerStore` over that tenant returns
 * byte-equal items (ids, timestamps, provenance, counters continue without
 * collision on next `createItem`); restoring into a non-empty tenant is
 * refused.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as every other
 * postgres-*.test.ts): no Postgres server in this sandbox/CI, so the suite
 * SKIPS cleanly offline.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ArchiveContent } from "../src/store/LedgerStore.js";
import { MILESTONES_AMBIENT_ID, MILESTONES_LEDGER, TASKS_LEDGER } from "../src/constants.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { buildBackupDump } from "../src/store/backupExporter.js";
import { openPgPool } from "../src/store/postgres/connection.js";
import { ensureSchema } from "../src/store/postgres/schema.js";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import {
  isPostgresTenantEmpty,
  restoreDumpToPostgres,
} from "../src/store/postgres/restoreImporter.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const SESSION_LOG_REL = "20260720-1200-session.md";
const SESSION_LOG_BODY = "# session\n\nsome notes for T580.\n";
const RAW_LOG_REL = "raw/20260720-1200-worker.jsonl";
const RAW_LOG_BODY = '{"type":"turn","n":1}\n{"type":"turn","n":2}\n';

/**
 * Seed a fresh sqlite store: a milestone with two task items (one updated
 * post-creation so createdAt != updatedAt, both eventually terminal), the
 * milestone archived (exercising the archive_pointers/archived_items path
 * too), plus two out-of-tree log artifacts.
 */
async function seedSqliteFixture(): Promise<{
  dump: Awaited<ReturnType<typeof buildBackupDump>>;
  milestoneId: string;
  taskArchive: ArchiveContent;
  milestoneArchive: ArchiveContent;
}> {
  const dir = await freshDir("t580-src-");
  const dbPath = path.join(dir, "ledger.db");
  const logsDir = path.join(dir, "logs");
  await mkdir(path.join(logsDir, "raw"), { recursive: true });
  await writeFile(path.join(logsDir, SESSION_LOG_REL), SESSION_LOG_BODY);
  await writeFile(path.join(logsDir, RAW_LOG_REL), RAW_LOG_BODY);

  const seeded = new SqliteLedgerStore({ dbPath, logsDir });
  await seeded.init();

  const milestone = await seeded.createMilestone({ title: "T580 restore fixture" });
  const item1 = await seeded.createItem(TASKS_LEDGER, milestone.id, {
    status: "planned",
    fields: { headline: "keep this task" },
    author: "tester[1m]",
    session: "sess-580a",
  });
  await seeded.createItem(TASKS_LEDGER, milestone.id, {
    status: "abandoned",
    fields: { headline: "second task" },
    author: "tester[1m]",
    session: "sess-580b",
  });
  // Bump item1 to terminal via a SEPARATE update, so createdAt != updatedAt
  // and provenance survives a second author/session write too.
  await seeded.updateItem(TASKS_LEDGER, item1.id, {
    status: "done",
    author: "reviewer[1m]",
    session: "sess-580c",
  });

  await seeded.updateMilestone(milestone.id, { status: "done" });
  await seeded.archiveMilestone(milestone.id, "T580 fixture archived");

  const taskArchive = await seeded.fetchArchive(TASKS_LEDGER, milestone.id);
  const milestoneArchive = await seeded.fetchArchive(MILESTONES_LEDGER, milestone.id);

  const dump = await buildBackupDump(seeded, logsDir);
  await seeded.dispose();

  return { dump, milestoneId: milestone.id, taskArchive, milestoneArchive };
}

describe.skipIf(!PG_URL)("restoreDumpToPostgres (T580)", () => {
  const setupPool = PG_URL !== undefined ? openPgPool(PG_URL) : undefined;
  const schemaReady = setupPool !== undefined ? ensureSchema(setupPool) : Promise.resolve();

  afterAll(async () => {
    await setupPool?.close();
  });

  test(
    "round trip: byte-equal items/archives/logs, counters continue without collision",
    async () => {
      await schemaReady;
      const fixture = await seedSqliteFixture();
      const projectKey = `t580-${randomUUID()}`;

      // Fresh, never-registered tenant is vacuously empty.
      expect(await isPostgresTenantEmpty(setupPool!, projectKey)).toBe(true);

      const summary = await restoreDumpToPostgres({
        pool: setupPool!,
        projectKey,
        displayName: projectKey,
        dump: fixture.dump,
      });
      expect(summary.fileCount).toBe(fixture.dump.length);
      expect(summary.logCount).toBe(2);

      const restored = new PostgresLedgerStore({
        pool: openPgPool(PG_URL!),
        projectKey,
        displayName: projectKey,
      });
      await restored.init();
      try {
        // Active item parity (id, timestamps, provenance, status, fields).
        // item2 was archived along with the milestone, so only item1's
        // final (post-update) shape is checked as an ACTIVE fetch here —
        // both are checked below via the archive.
        const taskArchive = await restored.fetchArchive(TASKS_LEDGER, fixture.milestoneId);
        expect(taskArchive).toEqual(fixture.taskArchive);

        const milestoneArchive = await restored.fetchArchive(MILESTONES_LEDGER, fixture.milestoneId);
        expect(milestoneArchive).toEqual(fixture.milestoneArchive);

        // Log artifacts imported byte-identically.
        const md = await restored.readLog(SESSION_LOG_REL);
        expect(md.content).toBe(SESSION_LOG_BODY);
        const raw = await restored.readLog(RAW_LOG_REL);
        expect(raw.content).toBe(RAW_LOG_BODY);

        // Counters continue without collision: item_counter was 2 (T1, T2)
        // before restore — the next createItem must allocate T3, not
        // collide with either restored id.
        const next = await restored.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
          status: "planned",
          fields: { headline: "post-restore task" },
        });
        expect(next.id).toBe("T3");
      } finally {
        await restored.dispose();
      }
    },
    30_000,
  );

  test(
    "refuses to restore into a non-empty tenant, leaving it untouched",
    async () => {
      await schemaReady;
      const fixtureA = await seedSqliteFixture();
      const fixtureB = await seedSqliteFixture();
      const projectKey = `t580-nonempty-${randomUUID()}`;

      await restoreDumpToPostgres({
        pool: setupPool!,
        projectKey,
        dump: fixtureA.dump,
      });
      expect(await isPostgresTenantEmpty(setupPool!, projectKey)).toBe(false);

      await expect(
        restoreDumpToPostgres({ pool: setupPool!, projectKey, dump: fixtureB.dump }),
      ).rejects.toThrow(/non-empty tenant/);

      // The FIRST restore's data survives untouched.
      const survivor = new PostgresLedgerStore({
        pool: openPgPool(PG_URL!),
        projectKey,
        displayName: projectKey,
      });
      await survivor.init();
      try {
        const taskArchive = await survivor.fetchArchive(TASKS_LEDGER, fixtureA.milestoneId);
        expect(taskArchive).toEqual(fixtureA.taskArchive);
      } finally {
        await survivor.dispose();
      }
    },
    30_000,
  );
});
