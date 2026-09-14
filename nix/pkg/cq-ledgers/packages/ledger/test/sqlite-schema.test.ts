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
  "item_references",
  "archive_pointers",
  "archived_items",
  "plan_claims",
  "plan_operations",
  "coherence_state",
  "coherence_vector",
  "mcp_usage_stats",
  "meta",
  "workset_state",
  "workset_admissions",
  "workset_exclusive",
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
      const indexes = db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all() as Array<{ name: string }>;
      const indexNames = new Set(indexes.map(({ name }) => name));
      for (const name of [
        "item_references_target",
        "items_milestone_membership",
        "items_ledger_status",
        "archived_items_target",
      ]) {
        expect(indexNames.has(name)).toBe(true);
      }
      // R-note: no persisted FTS5 virtual table (search is derived, later task).
      expect(tableNames.has("items_fts")).toBe(false);

      const meta = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: number;
      };
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
      expect(metaRows).toEqual([{ key: "schema_version", value: SCHEMA_VERSION }]);
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

  test("private lifecycle identities are stored, indexed, and reject duplicate logical records [T5541]", async () => {
    const db = openLedgerDb(await freshDbPath());
    try {
      ensureSchema(db);
      const columns = db.query("PRAGMA table_xinfo(plan_claims)").all() as Array<{ name: string; hidden: number }>;
      expect(columns.filter(({ hidden }) => hidden === 3).map(({ name }) => name)).toEqual([
        "goal_id", "claim_id", "claim_request_id", "generation", "state",
      ]);
      const claim = JSON.stringify({
        goalId: "G1", claimId: "claim_G1_1", claimRequestId: "request", generation: 1, state: "active",
      });
      const insertClaim = db.query("INSERT INTO plan_claims (scope, record_json) VALUES (?, ?)");
      insertClaim.run("first", claim);
      expect(() => insertClaim.run("different-scope", claim)).toThrow("UNIQUE constraint failed");
      expect(db.query("SELECT goal_id, claim_id, claim_request_id, generation, state FROM plan_claims").get()).toEqual({
        goal_id: "G1", claim_id: "claim_G1_1", claim_request_id: "request", generation: 1, state: "active",
      });
      db.query("UPDATE plan_claims SET record_json = ? WHERE scope = 'first'").run(
        JSON.stringify({ ...JSON.parse(claim), state: "released" }),
      );
      expect(db.query("SELECT state FROM plan_claims WHERE scope = 'first'").get()).toEqual({ state: "released" });
      const operation = JSON.stringify({ replay: {
        goalId: "G1", claimId: "claim_G1_1", generation: 1, operation: "release", operationId: "op-1",
      }, acknowledgement: { retained: true } });
      const insertOperation = db.query("INSERT INTO plan_operations (scope, record_json) VALUES (?, ?)");
      insertOperation.run("first", operation);
      expect(() => insertOperation.run("different-scope", operation)).toThrow("UNIQUE constraint failed");
      expect(db.query("SELECT goal_id, claim_id, generation, operation_kind, operation_id FROM plan_operations").get()).toEqual({
        goal_id: "G1", claim_id: "claim_G1_1", generation: 1, operation_kind: "release", operation_id: "op-1",
      });
      for (const sql of [
        "SELECT record_json FROM plan_claims WHERE goal_id = 'G1' AND claim_request_id = 'request'",
        "SELECT record_json FROM plan_claims WHERE goal_id = 'G1' AND claim_id = 'claim_G1_1' AND generation = 1",
        "SELECT record_json FROM plan_claims WHERE goal_id = 'G1' AND state = 'active'",
        "SELECT record_json FROM plan_operations WHERE goal_id = 'G1' AND claim_id = 'claim_G1_1' AND generation = 1 AND operation_kind = 'release' AND operation_id = 'op-1'",
      ]) {
        const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
        expect(plan.every(({ detail }) => detail.startsWith("SEARCH ") && detail.includes("USING INDEX"))).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  test("duplicate legacy lifecycle identities reject migration atomically [T5541]", async () => {
    const db = openLedgerDb(await freshDbPath());
    try {
      ensureSchema(db);
      db.exec(`DROP TABLE plan_claims;
        CREATE TABLE plan_claims (scope TEXT PRIMARY KEY, record_json TEXT NOT NULL);
        DROP TABLE plan_operations;
        CREATE TABLE plan_operations (scope TEXT PRIMARY KEY, record_json TEXT NOT NULL);`);
      db.query("UPDATE meta SET value = 7 WHERE key = 'schema_version'").run();
      const claim = JSON.stringify({
        goalId: "G1", claimId: "claim_G1_1", claimRequestId: "request", generation: 1, state: "active",
      });
      const insert = db.query("INSERT INTO plan_claims VALUES (?, ?)");
      insert.run("first", claim);
      insert.run("duplicate", claim);
      const before = db.query("SELECT scope, record_json FROM plan_claims ORDER BY scope").all();
      expect(() => ensureSchema(db)).toThrow("UNIQUE constraint failed");
      expect(db.query("SELECT scope, record_json FROM plan_claims ORDER BY scope").all()).toEqual(before);
      for (const table of ["plan_claims", "plan_operations"]) {
        const columns = db.query(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>;
        expect(columns.map(({ name }) => name)).toEqual(["scope", "record_json"]);
      }
      expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'plan_%_v7'").all()).toEqual([]);
      expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: 7 });
    } finally {
      db.close();
    }
  });
});
