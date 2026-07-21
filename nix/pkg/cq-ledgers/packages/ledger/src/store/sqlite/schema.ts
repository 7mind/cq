/**
 * schema.ts — idempotent DDL for the normalized SQLite ledger store (G67-C1).
 *
 * Per K102, rows are NORMALIZED (one row per item/group/pointer) — there is
 * no serialized ledger blob column, unlike the fs/git backends' whole-file
 * markdown. This extends the T492 prototype shape
 * (bench/proto/sqliteProtoStore.ts) to the full domain model in ../../types.ts:
 * ledgers, groups (milestone-groups), items, archive_pointers, archived_items,
 * plus a `meta` table carrying the on-disk schema version.
 *
 * R-note: deliberately NO FTS5 virtual table here. Search is a DERIVED
 * in-memory LedgerSearchIndex (MiniSearch), built + maintained from these rows
 * by a later task (T528) — the conformance suite needs edit-distance fuzzy /
 * field-boost rank / matchedFields semantics that FTS5 MATCH alone can't give.
 */

import type { Database } from "bun:sqlite";

/**
 * On-disk normalized-row schema version, recorded in meta('schema_version').
 *
 * - v1: initial normalized-row layout (G67-C1).
 * - v2 (T553, G80/M245): `dependsOn`/`blockedBy` entries settled on the
 *   canonical `<ledger>:<id>` ref form and canonical ledgers' `schema_json`
 *   carrying `satisfiesDependencyStatuses`. A store opened at v1 is migrated
 *   in place by {@link SqliteLedgerStore.init}; a store born here starts at v2
 *   (its bootstrap writes are already canonical, so there is nothing to
 *   normalize).
 */
export const SCHEMA_VERSION = 2;

/**
 * Apply the normalized-row DDL to `db`. Idempotent: every statement is
 * `CREATE TABLE IF NOT EXISTS`, and the schema-version marker row is inserted
 * with `INSERT OR IGNORE` — safe to call on every `openLedgerDb()`.
 */
export function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledgers (
      name              TEXT PRIMARY KEY,
      schema_json       TEXT NOT NULL,
      milestone_counter INTEGER NOT NULL,
      item_counter      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      ledger      TEXT NOT NULL REFERENCES ledgers(name),
      id          TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      PRIMARY KEY (ledger, id)
    );

    CREATE TABLE IF NOT EXISTS items (
      ledger       TEXT NOT NULL REFERENCES ledgers(name),
      id           TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      status       TEXT NOT NULL,
      fields_json  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      author       TEXT,
      session      TEXT,
      PRIMARY KEY (ledger, id)
    );

    CREATE TABLE IF NOT EXISTS archive_pointers (
      ledger      TEXT NOT NULL REFERENCES ledgers(name),
      id          TEXT NOT NULL,
      summary     TEXT NOT NULL,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL,
      archived_at TEXT NOT NULL,
      PRIMARY KEY (ledger, id)
    );

    CREATE TABLE IF NOT EXISTS archived_items (
      ledger       TEXT NOT NULL,
      pointer_id   TEXT NOT NULL,
      id           TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      status       TEXT NOT NULL,
      fields_json  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      author       TEXT,
      session      TEXT,
      PRIMARY KEY (ledger, pointer_id, id),
      FOREIGN KEY (ledger, pointer_id) REFERENCES archive_pointers(ledger, id)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value NOT NULL
    );
  `);
  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    SCHEMA_VERSION,
  );
}
