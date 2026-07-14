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
 * Bound on write-transaction attempts under contention (T527). busy_timeout
 * already makes a single BEGIN IMMEDIATE wait up to {@link BUSY_TIMEOUT_MS},
 * so this bounds the number of whole-transaction retries, not the wait.
 */
export const WRITE_TXN_MAX_ATTEMPTS = 5;

/**
 * Is `err` a bun:sqlite SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT error? bun:sqlite
 * throws `SQLiteError` carrying `code` (e.g. "SQLITE_BUSY") and `errno`; the
 * extended BUSY_SNAPSHOT code (517) shares primary code 5, so match either the
 * code string or the primary errno.
 */
export function isSqliteBusyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, errno } = err as { code?: unknown; errno?: unknown };
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT") return true;
  return typeof errno === "number" && (errno & 0xff) === 5;
}

/**
 * Run `attempt` up to `maxAttempts` times, retrying ONLY on
 * SQLITE_BUSY(-SNAPSHOT) ({@link isSqliteBusyError}); any other error
 * propagates immediately. Exhausting the bound rethrows the last busy error —
 * loud, per the fail-fast rule, rather than spinning unbounded.
 */
export function withBusyRetry<T>(
  attempt: () => T,
  maxAttempts: number = WRITE_TXN_MAX_ATTEMPTS,
): T {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return attempt();
    } catch (err) {
      if (!isSqliteBusyError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Run `fn` as ONE write transaction: `BEGIN IMMEDIATE` … `COMMIT`, with the
 * whole transaction retried under {@link withBusyRetry}.
 *
 * WAL isolation (T527, load-bearing): the write lock MUST be acquired at
 * BEGIN — BEFORE the read snapshot — hence IMMEDIATE. A DEFERRED begin that
 * reads and then upgrades to a write returns SQLITE_BUSY_SNAPSHOT immediately
 * (busy_timeout is NOT invoked for that case) whenever a peer connection
 * committed since the read snapshot — exactly the T497 >=2-writer scenario.
 * With IMMEDIATE, contention surfaces at BEGIN as plain SQLITE_BUSY, which
 * busy_timeout absorbs and the bounded retry covers residually.
 *
 * On any throw from `fn` (or COMMIT) the transaction is rolled back; `fn`
 * must therefore be safe to re-run from scratch (each retry re-reads).
 */
export function immediateWriteTransaction<T>(
  db: Database,
  fn: () => T,
  maxAttempts: number = WRITE_TXN_MAX_ATTEMPTS,
): T {
  return withBusyRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // No transaction active (BEGIN itself failed) — nothing to roll back.
      }
      throw err;
    }
  }, maxAttempts);
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
