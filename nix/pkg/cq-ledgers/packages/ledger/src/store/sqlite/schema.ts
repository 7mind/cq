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
 * - v3 (T1509/G155): `mcp_usage_stats` per-endpoint counters.
 * - v4 (T1957/G158): project workset roots/epoch plus durable admission rows
 *   and an exclusive-claim row so broker admissions survive across processes
 *   without a long-lived write transaction.
 * - v5: a coherence counter whose triggers exclude MCP usage telemetry.
 * - v6: normalized active-item reference edges for keyed closure/incident reads.
 */
export const SCHEMA_VERSION = 6;

const COHERENCE_TABLES = [
  "ledgers",
  "groups",
  "items",
  "archive_pointers",
  "archived_items",
  "plan_claims",
  "plan_operations",
  "workset_state",
  "workset_admissions",
  "workset_exclusive",
] as const;
const COHERENCE_OPERATIONS = ["INSERT", "UPDATE", "DELETE"] as const;

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

    CREATE INDEX IF NOT EXISTS items_milestone_membership
      ON items (milestone_id, ledger, id);

    CREATE INDEX IF NOT EXISTS items_ledger_status
      ON items (ledger, status, id);

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

    CREATE INDEX IF NOT EXISTS archived_items_target
      ON archived_items (ledger, id, pointer_id);

    CREATE TABLE IF NOT EXISTS item_references (
      source_ledger TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      field_name    TEXT NOT NULL,
      target_ledger TEXT NOT NULL,
      target_id     TEXT NOT NULL,
      PRIMARY KEY (source_ledger, source_id, field_name, target_ledger, target_id),
      FOREIGN KEY (source_ledger, source_id) REFERENCES items(ledger, id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS item_references_target
      ON item_references (target_ledger, target_id, field_name, source_ledger, source_id);

    CREATE TABLE IF NOT EXISTS plan_claims (
      scope       TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_operations (
      scope       TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coherence_state (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO coherence_state (id, version) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS mcp_usage_stats (
      endpoint    TEXT PRIMARY KEY,
      call_count  INTEGER NOT NULL,
      bytes_in    INTEGER NOT NULL,
      bytes_out   INTEGER NOT NULL
    );

    -- T1957: singleton roots/epoch + admit generation (revokes pre-grant admits).
    CREATE TABLE IF NOT EXISTS workset_state (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      epoch             INTEGER NOT NULL,
      roots_json        TEXT NOT NULL,
      admit_generation  INTEGER NOT NULL
    );

    -- Durable admissions: short write txns only; effective across processes.
    CREATE TABLE IF NOT EXISTS workset_admissions (
      id                         TEXT PRIMARY KEY,
      form                       TEXT NOT NULL,
      kind                       TEXT NOT NULL,
      epoch                      INTEGER NOT NULL,
      roots_json                 TEXT NOT NULL,
      targets_json               TEXT NOT NULL,
      target_ref                 TEXT,
      host                       TEXT NOT NULL,
      pid                        INTEGER NOT NULL,
      started_at                 INTEGER NOT NULL,
      pgid                       INTEGER,
      leader_pid                 INTEGER,
      settled                    INTEGER NOT NULL DEFAULT 0,
      process_group_registered   INTEGER NOT NULL DEFAULT 0
    );

    -- Exclusive set/admin claim held without a long-lived write transaction.
    CREATE TABLE IF NOT EXISTS workset_exclusive (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      holder_id   TEXT NOT NULL,
      host        TEXT NOT NULL,
      pid         INTEGER NOT NULL,
      started_at  INTEGER NOT NULL
    );

  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS item_references_items_delete
    AFTER DELETE ON items BEGIN
      DELETE FROM item_references
      WHERE source_ledger = OLD.ledger AND source_id = OLD.id;
    END;

    CREATE TRIGGER IF NOT EXISTS item_references_items_insert
    AFTER INSERT ON items BEGIN
      INSERT OR IGNORE INTO item_references (
        source_ledger, source_id, field_name, target_ledger, target_id
      )
      SELECT NEW.ledger, NEW.id, field.key,
             substr(value.value, 1, instr(value.value, ':') - 1),
             substr(value.value, instr(value.value, ':') + 1)
      FROM json_each(NEW.fields_json) AS field
      JOIN json_each(field.value) AS value
      WHERE field.key IN ('dependsOn', 'blockedBy', 'ledgerRefs', 'sourceRefs')
        AND field.type = 'array'
        AND value.type = 'text'
        AND instr(value.value, ':') > 1;

      INSERT OR IGNORE INTO item_references (
        source_ledger, source_id, field_name, target_ledger, target_id
      )
      SELECT NEW.ledger, NEW.id, 'worksetOwnerRef',
             substr(json_extract(NEW.fields_json, '$.worksetOwnerRef'), 1,
                    instr(json_extract(NEW.fields_json, '$.worksetOwnerRef'), ':') - 1),
             substr(json_extract(NEW.fields_json, '$.worksetOwnerRef'),
                    instr(json_extract(NEW.fields_json, '$.worksetOwnerRef'), ':') + 1)
      WHERE json_type(NEW.fields_json, '$.worksetOwnerRef') = 'text'
        AND instr(json_extract(NEW.fields_json, '$.worksetOwnerRef'), ':') > 1;
    END;

    CREATE TRIGGER IF NOT EXISTS item_references_items_update
    AFTER UPDATE OF fields_json ON items BEGIN
      DELETE FROM item_references
      WHERE source_ledger = NEW.ledger AND source_id = NEW.id;

      INSERT OR IGNORE INTO item_references (
        source_ledger, source_id, field_name, target_ledger, target_id
      )
      SELECT NEW.ledger, NEW.id, field.key,
             substr(value.value, 1, instr(value.value, ':') - 1),
             substr(value.value, instr(value.value, ':') + 1)
      FROM json_each(NEW.fields_json) AS field
      JOIN json_each(field.value) AS value
      WHERE field.key IN ('dependsOn', 'blockedBy', 'ledgerRefs', 'sourceRefs')
        AND field.type = 'array'
        AND value.type = 'text'
        AND instr(value.value, ':') > 1;

      INSERT OR IGNORE INTO item_references (
        source_ledger, source_id, field_name, target_ledger, target_id
      )
      SELECT NEW.ledger, NEW.id, 'worksetOwnerRef',
             substr(json_extract(NEW.fields_json, '$.worksetOwnerRef'), 1,
                    instr(json_extract(NEW.fields_json, '$.worksetOwnerRef'), ':') - 1),
             substr(json_extract(NEW.fields_json, '$.worksetOwnerRef'),
                    instr(json_extract(NEW.fields_json, '$.worksetOwnerRef'), ':') + 1)
      WHERE json_type(NEW.fields_json, '$.worksetOwnerRef') = 'text'
        AND instr(json_extract(NEW.fields_json, '$.worksetOwnerRef'), ':') > 1;
    END;

  `);
  for (const table of COHERENCE_TABLES) {
    for (const operation of COHERENCE_OPERATIONS) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS coherence_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} BEGIN
          UPDATE coherence_state SET version = version + 1 WHERE id = 1;
        END
      `);
    }
  }
  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    SCHEMA_VERSION,
  );
  db.query(
    "INSERT OR IGNORE INTO workset_state (id, epoch, roots_json, admit_generation) VALUES (1, 0, '[]', 0)",
  ).run();
}

export function backfillActiveItemReferences(db: Database): void {
  db.exec(`
    INSERT OR IGNORE INTO item_references (
      source_ledger, source_id, field_name, target_ledger, target_id
    )
    SELECT items.ledger, items.id, field.key,
           substr(value.value, 1, instr(value.value, ':') - 1),
           substr(value.value, instr(value.value, ':') + 1)
    FROM items
    JOIN json_each(items.fields_json) AS field
    JOIN json_each(field.value) AS value
    WHERE field.key IN ('dependsOn', 'blockedBy', 'ledgerRefs', 'sourceRefs')
      AND field.type = 'array'
      AND value.type = 'text'
      AND instr(value.value, ':') > 1;

    INSERT OR IGNORE INTO item_references (
      source_ledger, source_id, field_name, target_ledger, target_id
    )
    SELECT items.ledger, items.id, 'worksetOwnerRef',
           substr(json_extract(items.fields_json, '$.worksetOwnerRef'), 1,
                  instr(json_extract(items.fields_json, '$.worksetOwnerRef'), ':') - 1),
           substr(json_extract(items.fields_json, '$.worksetOwnerRef'),
                  instr(json_extract(items.fields_json, '$.worksetOwnerRef'), ':') + 1)
    FROM items
    WHERE json_type(items.fields_json, '$.worksetOwnerRef') = 'text'
      AND instr(json_extract(items.fields_json, '$.worksetOwnerRef'), ':') > 1;
  `);
}
