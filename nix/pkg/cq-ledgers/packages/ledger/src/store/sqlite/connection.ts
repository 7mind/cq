/**
 * connection.ts — bun:sqlite connection helper for the SQLite ledger store
 * (G67-C1, extending the T492 prototype in bench/proto/sqliteProtoStore.ts
 * into the real module).
 *
 * `openLedgerDb` opens a WAL-mode connection with the pragma set every `cq`
 * process needs to safely share one ledger.db file: a busy_timeout so a
 * writer retries instead of failing immediately on SQLITE_BUSY (Q246),
 * foreign_keys enforcement, and NORMAL synchronous (safe once WAL is on).
 *
 * The store location (a concrete db file path) is an explicit caller input —
 * XDG/root resolution stays OUT of this module so tests/harnesses can point
 * it at a temp dir.
 */

import { Database } from "bun:sqlite";

/** Cross-process write-lock timeout (ms) — a writer waits this long on SQLITE_BUSY (Q246). */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * Open a bun:sqlite connection to the ledger database at `dbPath` (created if
 * absent) with the standard pragma set applied. Does NOT apply the DDL —
 * callers pair this with `ensureSchema` (schema.ts).
 */
export function openLedgerDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/**
 * Read this connection's current `PRAGMA data_version` counter: it is bumped
 * whenever ANY connection (this one, or another process/connection on the
 * same file) commits a change, and stays stable while no writes occur. This
 * is the K102 currentSourceToken mechanism — a cheap remote-coherence check
 * that avoids re-reading the whole file to detect a peer's write.
 */
export function dataVersion(db: Database): number {
  const row = db.query("PRAGMA data_version").get() as { data_version: number };
  return row.data_version;
}
