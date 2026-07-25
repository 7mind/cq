/**
 * connection.ts — Bun.sql connection helper for the multi-tenant Postgres
 * ledger store (T572, G81/M248).
 *
 * Mirrors the role of ../sqlite/connection.ts, but for Postgres: pool
 * construction from a DSN, advisory-lock helpers (Q271 — the DDL/migration
 * pass in schema.ts must run under a lock so concurrent connecting instances
 * never race CREATE TABLE), a NOTIFY helper for the LISTEN/NOTIFY coherence
 * mechanism (Q281), and transaction helpers with bounded retry on Postgres
 * serialization/deadlock failures (the PG analogue of the sqlite store's
 * SQLITE_BUSY retry in ../sqlite/connection.ts).
 *
 * Driver: Bun's builtin `Bun.sql` / `SQL` class (Q277) — zero new npm
 * dependency, tagged-template query API, connection pooling, and a native
 * `.reserve()` for pinning one physical connection (needed so a session-level
 * advisory lock is taken and released on the SAME connection).
 */

import { SQL } from "bun";

/**
 * Open a Bun.sql connection pool against `dsn` (a `postgres://...` DSN). Does
 * NOT apply the DDL — callers pair this with `ensureSchema` (schema.ts).
 */
export function openPgPool(dsn: string): SQL {
  return new SQL(dsn);
}

/** A session-level advisory lock retained on one dedicated PostgreSQL connection. */
export interface PgAdvisoryLockLease {
  /** Unlock once, release the reserved connection, and close its one-connection pool. */
  release(): Promise<void>;
}

/**
 * Try to retain `lockKey` on a dedicated reserved connection until the
 * returned lease is released. Unlike {@link withAdvisoryLock}, this helper
 * does not wait for a contended lock and does not delimit a short critical
 * section: it supports a process-lifetime ownership invariant.
 *
 * The dedicated pool has exactly one connection and disables idle/lifetime
 * expiry. If PostgreSQL closes that connection after the lock was acquired,
 * `onConnectionLost` runs immediately; callers must fail-stop because
 * PostgreSQL released the session-level lock at the same instant.
 */
export async function tryAcquireDedicatedAdvisoryLock(
  dsn: string,
  lockKey: number,
  onConnectionLost: (error: Error) => void,
): Promise<PgAdvisoryLockLease | null> {
  let lockHeld = false;
  let closing = false;
  let lossReported = false;
  const pool = new SQL({
    url: dsn,
    max: 1,
    idleTimeout: 0,
    maxLifetime: 0,
    onclose: (error: Error | null): void => {
      if (!closing && lockHeld && !lossReported) {
        lossReported = true;
        onConnectionLost(
          error ?? new Error("PostgreSQL closed the dedicated advisory-lock connection"),
        );
      }
    },
  });
  let reserved: Awaited<ReturnType<SQL["reserve"]>> | null = null;
  try {
    reserved = await pool.reserve();
    const rows = await reserved<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(${lockKey}::bigint) AS acquired
    `;
    if (rows[0]?.acquired !== true) {
      closing = true;
      reserved.release();
      await pool.close();
      return null;
    }
    lockHeld = true;
  } catch (error) {
    closing = true;
    reserved?.release();
    await pool.close({ timeout: 0 });
    throw error;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      closing = true;
      try {
        if (lockHeld) {
          const rows = await reserved<Array<{ released: boolean }>>`
            SELECT pg_advisory_unlock(${lockKey}::bigint) AS released
          `;
          if (rows[0]?.released !== true) {
            throw new Error(`PostgreSQL advisory lock ${String(lockKey)} was not held at release`);
          }
          lockHeld = false;
        }
      } finally {
        reserved.release();
        await pool.close();
      }
    },
  };
}

/**
 * Run `fn` with a lock reserved via `pg_advisory_lock`, on the exact
 * connection that acquired it (Q271): a plain `pool\`select
 * pg_advisory_lock(...)\`` would let the pool hand the lock-holding
 * connection back to someone else, or run the matching unlock on a
 * DIFFERENT connection (a no-op — session-level advisory locks are tied to
 * the connection that took them). `pool.reserve()` pins one connection for
 * the whole critical section; the lock is released and the connection
 * returned to the pool even if `fn` throws.
 */
export async function withAdvisoryLock<T>(
  pool: SQL,
  lockKey: number,
  fn: (locked: SQL) => Promise<T>,
): Promise<T> {
  const reserved = await pool.reserve();
  try {
    await reserved`select pg_advisory_lock(${lockKey}::bigint)`;
    try {
      return await fn(reserved);
    } finally {
      await reserved`select pg_advisory_unlock(${lockKey}::bigint)`;
    }
  } finally {
    reserved.release();
  }
}

/**
 * LISTEN/NOTIFY channel carrying ledger-change coherence events (Q281): the
 * PG analogue of the sqlite backend's `PRAGMA data_version` poll
 * (../sqlite/connection.ts `dataVersion`), but push-based. Payload is the
 * `project_key` whose data changed, so a single shared connection can LISTEN
 * once and dispatch to the right project's watchers.
 */
export const LEDGER_CHANGE_CHANNEL = "cq_ledger_changed";

/**
 * Notify `LEDGER_CHANGE_CHANNEL` that `projectKey` changed. Uses
 * `pg_notify(channel, payload)` rather than the `NOTIFY channel, payload`
 * statement so both arguments are bound query parameters (NOTIFY's own
 * syntax does not accept a parameter for the channel name).
 */
export async function notifyProjectChanged(sql: SQL, projectKey: string): Promise<void> {
  await sql`select pg_notify(${LEDGER_CHANGE_CHANNEL}, ${projectKey})`;
}

/** Bound on write-transaction attempts under contention (mirrors sqlite's WRITE_TXN_MAX_ATTEMPTS). */
export const WRITE_TXN_MAX_ATTEMPTS = 5;

/**
 * Is `err` a Postgres serialization failure (SQLSTATE 40001) or deadlock
 * (40P01)? Both are safe to retry a whole transaction from scratch; any
 * other error propagates immediately.
 */
export function isPgSerializationError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code } = err as { code?: unknown };
  return code === "40001" || code === "40P01";
}

/**
 * Run `attempt` up to `maxAttempts` times, retrying ONLY on
 * {@link isPgSerializationError}; any other error propagates immediately.
 * Exhausting the bound rethrows the last error — loud, per the fail-fast
 * rule, rather than spinning unbounded.
 */
export async function withSerializationRetry<T>(
  attempt: () => Promise<T>,
  maxAttempts: number = WRITE_TXN_MAX_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isPgSerializationError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Run `fn` as one transaction (`sql.begin`), with the whole transaction
 * retried under {@link withSerializationRetry} on a serialization/deadlock
 * failure. `fn` must therefore be safe to re-run from scratch (each retry
 * re-reads and re-writes).
 */
export function writeTransaction<T>(
  pool: SQL,
  fn: SQL.TransactionContextCallback<T>,
  maxAttempts: number = WRITE_TXN_MAX_ATTEMPTS,
): Promise<SQL.ContextCallbackResult<T>> {
  return withSerializationRetry(() => pool.begin(fn), maxAttempts);
}
