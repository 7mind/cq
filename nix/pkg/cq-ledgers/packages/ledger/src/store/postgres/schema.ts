/**
 * schema.ts — idempotent DDL for the multi-tenant Postgres ledger store
 * (T572, G81/M248).
 *
 * Mirrors the normalized-row shape of ../sqlite/schema.ts (ledgers, groups,
 * items, archive_pointers, archived_items, meta) with one structural change
 * per Q271/Q279: every shared table's primary key gains a leading
 * `project_key` column, since ONE Postgres database now holds every tenant's
 * rows instead of one sqlite file per project. Two tables are new:
 *
 * - `projects` — the tenant registry (Q279): project_key, display_name,
 *   created_at, updated_at. Registration (INSERT) is the connecting store's
 *   job, not this module's — schema.ts only owns the table shape.
 * - `logs` — tenant-keyed raw log-artifact storage (Q274/Q285): log content
 *   (JSONL/markdown transcripts, per CLAUDE.md's artifact-format doc) is
 *   textual, hence TEXT rather than BYTEA.
 *
 * `meta(schema_version)` stays PER-DATABASE, not per-tenant (Q280): schema
 * version describes the physical database's DDL generation, shared by every
 * project stored in it — exactly like ../sqlite/schema.ts's meta table
 * (one row, no ledger/project dimension).
 *
 * ensureSchema is idempotent — every statement is `CREATE TABLE IF NOT
 * EXISTS`, and the schema-version marker row is `INSERT ... ON CONFLICT DO
 * NOTHING` — safe to call on every connecting instance's startup. The whole
 * DDL pass runs under a `pg_advisory_lock` (see connection.ts
 * `withAdvisoryLock`) so two instances connecting at once never race the
 * CREATE TABLE statements (Q271).
 */

import type { SQL } from "bun";
import { withAdvisoryLock } from "./connection.js";

/**
 * On-disk (per-database) schema version, recorded in meta('schema_version').
 *
 * - v1 (T572, G81/M248): initial multi-tenant normalized-row layout.
 */
export const PG_SCHEMA_VERSION = 1;

/**
 * Advisory-lock key guarding the DDL/migration pass (Q271). Arbitrary but
 * fixed — every `ensureSchema` caller across every process must agree on it
 * so they contend for the SAME lock. Distinct from any lock key an
 * application-level feature might use.
 */
const SCHEMA_DDL_LOCK_KEY = 847_501_001;

/**
 * Apply the multi-tenant normalized-row DDL to the database `pool` is
 * connected to. Idempotent and safe to call concurrently from multiple
 * connecting instances — the whole pass runs under a `pg_advisory_lock`
 * (Q271).
 */
export async function ensureSchema(pool: SQL): Promise<void> {
  await withAdvisoryLock(pool, SCHEMA_DDL_LOCK_KEY, async (locked) => {
    await locked`
      CREATE TABLE IF NOT EXISTS projects (
        project_key  TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    await locked`
      CREATE TABLE IF NOT EXISTS ledgers (
        project_key       TEXT NOT NULL REFERENCES projects(project_key),
        name              TEXT NOT NULL,
        schema_json       TEXT NOT NULL,
        milestone_counter INTEGER NOT NULL,
        item_counter      INTEGER NOT NULL,
        PRIMARY KEY (project_key, name)
      )
    `;

    await locked`
      CREATE TABLE IF NOT EXISTS groups (
        project_key TEXT NOT NULL,
        ledger      TEXT NOT NULL,
        id          TEXT NOT NULL,
        title       TEXT NOT NULL,
        description TEXT NOT NULL,
        PRIMARY KEY (project_key, ledger, id),
        FOREIGN KEY (project_key, ledger) REFERENCES ledgers(project_key, name)
      )
    `;

    await locked`
      CREATE TABLE IF NOT EXISTS items (
        project_key  TEXT NOT NULL,
        ledger       TEXT NOT NULL,
        id           TEXT NOT NULL,
        milestone_id TEXT NOT NULL,
        status       TEXT NOT NULL,
        fields_json  TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        author       TEXT,
        session      TEXT,
        PRIMARY KEY (project_key, ledger, id),
        FOREIGN KEY (project_key, ledger) REFERENCES ledgers(project_key, name)
      )
    `;

    await locked`
      CREATE TABLE IF NOT EXISTS archive_pointers (
        project_key TEXT NOT NULL,
        ledger      TEXT NOT NULL,
        id          TEXT NOT NULL,
        summary     TEXT NOT NULL,
        title       TEXT NOT NULL,
        status      TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        PRIMARY KEY (project_key, ledger, id),
        FOREIGN KEY (project_key, ledger) REFERENCES ledgers(project_key, name)
      )
    `;

    await locked`
      CREATE TABLE IF NOT EXISTS archived_items (
        project_key  TEXT NOT NULL,
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
        PRIMARY KEY (project_key, ledger, pointer_id, id),
        FOREIGN KEY (project_key, ledger, pointer_id)
          REFERENCES archive_pointers(project_key, ledger, id)
      )
    `;

    await locked`
      CREATE TABLE IF NOT EXISTS logs (
        project_key TEXT NOT NULL REFERENCES projects(project_key),
        path        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (project_key, path)
      )
    `;

    await locked`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;

    await locked`
      INSERT INTO meta (key, value) VALUES ('schema_version', ${String(PG_SCHEMA_VERSION)})
      ON CONFLICT (key) DO NOTHING
    `;
  });
}
