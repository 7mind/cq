/**
 * Regression guard for the 2026-07-25 ledger-wipe incident.
 *
 * An OLDER build opening a store written by a NEWER one sees persisted fields
 * its own CANONICAL_LEDGERS lacks. `schemaCompatible` only tolerates safe
 * FORWARD direction (canon added an optional field or status); this BACKWARD direction is
 * classed divergent, and under the historical `'backup-reinit'` DEFAULT the
 * store silently wiped every row after taking a sibling backup — 750 active +
 * 2278 archived items lost in the real incident, announced only by a stderr
 * WARNING.
 *
 * The default is now `'abort'`: a divergent store REFUSES to open and leaves
 * every row untouched. `'backup-reinit'` remains available as an explicit
 * opt-in for an operator who genuinely wants the reinit.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BootstrapViolationError, type LedgerSchema } from "../src/types.js";
import { REVIEWS_LEDGER, REVIEWS_SCHEMA } from "../src/constants.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { createTrustedWorksetManagementAuthority } from "../src/worksetInvocationAuthority.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const now = (): string => FIXED_NOW;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-older-build-"));
  dirs.push(dir);
  return path.join(dir, "ledger.db");
}

/**
 * Seed a store holding one review item, then rewrite the persisted `reviews`
 * schema so it carries an optional field the CURRENT canon does not know —
 * exactly what an older binary sees when a newer one has widened the schema.
 * Returns the db path and the seeded item id.
 */
async function seedStoreWrittenByNewerBuild(): Promise<{ dbPath: string; itemId: string }> {
  const dbPath = await freshDbPath();
  const seeded = new SqliteLedgerStore({ dbPath, now });
  await seeded.init();
  const milestone = await seeded.createMilestone({ title: "pre-incident work" });
  const review = await seeded.createItem(REVIEWS_LEDGER, milestone.id, {
    status: "go-ahead",
    fields: { summary: "row written before the older build opened the store" },
  });
  await seeded.dispose();

  const widened = JSON.parse(JSON.stringify(REVIEWS_SCHEMA)) as LedgerSchema;
  widened.fields["fieldFromANewerBuild"] = { type: "string", required: false };
  const db = openLedgerDb(dbPath);
  db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?").run(
    JSON.stringify(widened),
    REVIEWS_LEDGER,
  );
  db.close();

  return { dbPath, itemId: review.id };
}

/** Rows still physically present in the db, independent of any store instance. */
function countItems(dbPath: string): number {
  const db = openLedgerDb(dbPath);
  const row = db.query("SELECT count(*) AS c FROM items").get() as { c: number };
  db.close();
  return row.c;
}

async function backupSiblings(dbPath: string): Promise<string[]> {
  const entries = await readdir(path.dirname(dbPath));
  return entries.filter((e) => e.includes(".backup-"));
}

describe("older build opening a newer store (default policy)", () => {
  test("init() refuses to open a backward-divergent store", async () => {
    const { dbPath } = await seedStoreWrittenByNewerBuild();
    const older = new SqliteLedgerStore({ dbPath, now });

    await expect(older.init()).rejects.toThrow(BootstrapViolationError);
  });

  test("every row survives the refused open", async () => {
    const { dbPath, itemId } = await seedStoreWrittenByNewerBuild();
    const before = countItems(dbPath);
    const older = new SqliteLedgerStore({ dbPath, now });

    await older.init().catch(() => undefined);

    expect(countItems(dbPath)).toBe(before);
    const db = openLedgerDb(dbPath);
    const row = db
      .query("SELECT fields_json FROM items WHERE ledger = ? AND id = ?")
      .get(REVIEWS_LEDGER, itemId) as { fields_json: string } | null;
    db.close();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.fields_json).summary).toBe(
      "row written before the older build opened the store",
    );
  });

  test("no backup sibling is written, because nothing was destroyed", async () => {
    const { dbPath } = await seedStoreWrittenByNewerBuild();
    const older = new SqliteLedgerStore({ dbPath, now });

    await older.init().catch(() => undefined);

    expect(await backupSiblings(dbPath)).toEqual([]);
  });

  test("counters are left intact rather than reset to zero", async () => {
    const { dbPath } = await seedStoreWrittenByNewerBuild();
    const older = new SqliteLedgerStore({ dbPath, now });

    await older.init().catch(() => undefined);

    const db = openLedgerDb(dbPath);
    const row = db
      .query("SELECT item_counter FROM ledgers WHERE name = ?")
      .get(REVIEWS_LEDGER) as { item_counter: number } | null;
    db.close();
    expect(row?.item_counter).toBeGreaterThan(0);
  });
});

describe("explicit backup-reinit opt-in still available", () => {
  test("an operator who asks for backup-reinit still gets it", async () => {
    const { dbPath } = await seedStoreWrittenByNewerBuild();
    const store = new SqliteLedgerStore({
      dbPath,
      now,
      onSchemaDivergence: "backup-reinit",
      // D170: this test DELIBERATELY reinitialises a populated store.
      allowDestructiveReinitOfPopulatedStore: true,
      worksetAuthority: createTrustedWorksetManagementAuthority(),
    });

    await expect(store.init()).resolves.toBeUndefined();
    await store.dispose();

    expect((await backupSiblings(dbPath)).length).toBe(1);
  });
});
