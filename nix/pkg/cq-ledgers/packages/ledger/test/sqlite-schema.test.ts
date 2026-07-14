/**
 * Foundation test for the SQLite store (G67-C1 / T525): connection pragmas +
 * normalized DDL + schema-version meta + the data_version cross-connection
 * coherence mechanism (K102). NO FTS5 assertions — search is a later task
 * (T528), per the R-note on T525.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BUSY_TIMEOUT_MS, dataVersion, openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema, SCHEMA_VERSION } from "../src/store/sqlite/schema.js";

const NORMALIZED_TABLES = [
  "ledgers",
  "groups",
  "items",
  "archive_pointers",
  "archived_items",
  "meta",
];

const dirs: string[] = [];

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-sqlite-"));
  dirs.push(dir);
  return path.join(dir, "ledger.db");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("sqlite connection + schema (T525)", () => {
  test("pragmas: WAL, busy_timeout, foreign_keys ON", async () => {
    const db = openLedgerDb(await freshDbPath());
    try {
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: BUSY_TIMEOUT_MS });
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });

  test("ensureSchema creates all normalized tables + schema_version meta row", async () => {
    const db = openLedgerDb(await freshDbPath());
    try {
      ensureSchema(db);

      const rows = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(rows.map((r) => r.name));
      for (const t of NORMALIZED_TABLES) {
        expect(tableNames.has(t)).toBe(true);
      }
      // R-note: no persisted FTS5 virtual table (search is derived, later task).
      expect(tableNames.has("items_fts")).toBe(false);

      const meta = db
        .query("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: number };
      expect(meta.value).toBe(1);
      expect(meta.value).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test("ensureSchema is idempotent (re-running the DDL does not throw or duplicate rows)", async () => {
    const db = openLedgerDb(await freshDbPath());
    try {
      ensureSchema(db);
      ensureSchema(db);
      ensureSchema(db);

      const metaRows = db.query("SELECT key, value FROM meta").all() as Array<{
        key: string;
        value: number;
      }>;
      expect(metaRows).toEqual([{ key: "schema_version", value: 1 }]);
    } finally {
      db.close();
    }
  });

  test("data_version: a commit on connection A is observed on connection B; stable with no writes", async () => {
    const dbPath = await freshDbPath();
    const a = openLedgerDb(dbPath);
    ensureSchema(a);
    const b = openLedgerDb(dbPath);
    try {
      // Stable while no writes occur.
      const bBefore = dataVersion(b);
      expect(dataVersion(b)).toBe(bBefore);
      expect(dataVersion(b)).toBe(bBefore);

      // A commits a write ...
      a.query(
        "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, ?, ?)",
      ).run("tasks", "{}", 0, 0);

      // ... B observes a bumped data_version without re-reading the file itself.
      const bAfter = dataVersion(b);
      expect(bAfter).not.toBe(bBefore);
    } finally {
      a.close();
      b.close();
    }
  });
});
