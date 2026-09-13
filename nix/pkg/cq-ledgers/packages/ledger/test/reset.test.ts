/**
 * T123 — destructive SQLite reinitialization preserves a complete prior snapshot
 * and restores canonical empty state. The retired provider's reset command is
 * not part of the SQLite API.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteLedgerStore,
  CANONICAL_LEDGERS,
  DEFECTS_LEDGER,
  TASKS_LEDGER,
  createTrustedWorksetManagementAuthority,
} from "../src/index.js";
import { injectSqliteSchemaDivergence, sqliteDivergenceBackupPath } from "./sqliteSchemaFixture.js";

const dirs: string[] = [];
const stores: SqliteLedgerStore[] = [];
afterAll(async () => {
  for (const store of stores) await store.dispose();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("SQLite destructive reinitialization", () => {
  it("backs up prior state and item counts, then reinitializes the canonical empty set", async () => {
    const timestamp = "2026-06-01T12:34:56.000Z";
    const root = await mkdtemp(path.join(tmpdir(), "ledger-reset-"));
    dirs.push(root);
    const dbPath = path.join(root, "ledger.db");
    let store = new SqliteLedgerStore({ dbPath });
    stores.push(store);
    await store.init();
    const milestone = await store.createMilestone({ title: "reset target" });
    for (const [headline, severity] of [["d1", "minor"], ["d2", "major"]] as const) {
      await store.createItem(DEFECTS_LEDGER, milestone.id, {
        status: "open", fields: { headline, severity },
      });
    }
    await store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned", fields: { headline: "t1" },
    });
    const beforeCounts = new Map(store.enumerate().map((name) => [
      name, store.fetch(name).milestones.flatMap((group) => group.items).length,
    ]));
    await store.dispose();
    injectSqliteSchemaDivergence(dbPath);
    store = new SqliteLedgerStore({
      dbPath,
      now: () => timestamp,
      onSchemaDivergence: "backup-reinit",
      allowDestructiveReinitOfPopulatedStore: true,
      worksetAuthority: createTrustedWorksetManagementAuthority(),
    });
    stores.push(store);
    await store.init();

    const backupPath = sqliteDivergenceBackupPath(dbPath, timestamp);
    expect((await stat(backupPath)).isFile()).toBe(true);
    expect(path.basename(backupPath)).toBe("ledger.backup-2026-06-01T12-34-56.000Z.db");
    const backup = new Database(backupPath, { readonly: true });
    try {
      const counts = backup.query<{ name: string; itemCount: number }, []>(
        "SELECT ledgers.name, count(items.id) AS itemCount FROM ledgers " +
        "LEFT JOIN items ON items.ledger = ledgers.name GROUP BY ledgers.name ORDER BY ledgers.name",
      ).all();
      expect(counts.map(({ name }) => name)).toEqual(CANONICAL_LEDGERS.map(({ name }) => name).sort());
      for (const { name, itemCount } of counts) {
        const expectedCount = beforeCounts.get(name);
        if (expectedCount === undefined) throw new Error(`unexpected backed-up ledger ${name}`);
        expect(itemCount).toBe(expectedCount);
      }
      const byName = new Map(counts.map(({ name, itemCount }) => [name, itemCount]));
      expect(byName.get(DEFECTS_LEDGER)).toBe(2);
      expect(byName.get(TASKS_LEDGER)).toBe(1);
    } finally {
      backup.close();
    }
    expect(store.enumerate().sort()).toEqual(CANONICAL_LEDGERS.map(({ name }) => name).sort());
    expect(store.fetch(DEFECTS_LEDGER).milestones.flatMap((group) => group.items)).toHaveLength(0);
    expect(store.fetch(TASKS_LEDGER).milestones.flatMap((group) => group.items)).toHaveLength(0);
    expect(store.fetch(DEFECTS_LEDGER).schema.statusValues).toEqual([
      "open", "wip", "root-caused", "inconclusive", "resolved", "wontfix",
    ]);
  });
});
