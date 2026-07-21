/**
 * coherenceWatcher.ts — the `backend = 'postgres'` coherence watcher (T578,
 * G81/M250), the PUSH-based analogue of the xdg backend's `PRAGMA
 * data_version` poll (`startXdgCoherenceWatcher`, createLedgerStore.ts:304).
 *
 * The store already `NOTIFY`s post-commit on {@link LEDGER_CHANGE_CHANNEL}
 * with payload = its own `project_key` (PostgresLedgerStore.notify() →
 * connection.ts `notifyProjectChanged`). This watcher opens a DEDICATED LISTEN
 * connection, subscribes to that channel, filters notifications to THIS
 * store's own tenant (`pgHandle.projectKey`), bulk-invalidates every ledger
 * the store knows (`store.enumerate()` → `store.invalidate()`, the SAME shape
 * as the xdg watcher), then fires `onChange(null)` — the exact D89 callback
 * contract so ledger-mcp's `startLedgerCoherenceWatcher`
 * (ledger-mcp/src/main.ts:366) forwards it uniformly across all backends.
 *
 * ── LOCKED DECISION (Q281 lock: push, not poll; RS1 driver fallback) ─────────
 * The LISTEN connection uses the porsager `postgres` package (v3.4.9, zero
 * runtime deps) — NOT Bun's builtin `Bun.sql` — for ONE reason: research RS1
 * CONCLUDED that `Bun.sql` implements NO LISTEN/NOTIFY in any released Bun
 * (official docs: "haven't implemented"; the implementing PR
 * oven-sh/bun#32089 is open/unmerged as of this writing). Everything ELSE in
 * the postgres backend stays on `Bun.sql` (connection.ts / PostgresLedgerStore
 * / schema.ts); this file is the SOLE porsager entry point, kept as a narrow
 * transport seam so an alternative — a poll-a-version-table fallback, or a
 * future native `Bun.sql.listen` — can slot in behind the same
 * `startPostgresCoherenceWatcher` signature.
 *
 * RETIRE-WHEN-MERGED: once oven-sh/bun#32089 ships in a released Bun,
 * re-evaluate collapsing this onto `Bun.sql` and dropping the porsager
 * dependency (re-run RS1's feasibility check against that Bun version first).
 *
 * `porsager` auto-reconnects a dropped LISTEN connection with backoff, and
 * invokes the `onlisten` callback on the INITIAL connect AND on EVERY
 * reconnect. We use that hook to run a FULL invalidate each time — the
 * missed-notification safety: any NOTIFY emitted while the LISTEN connection
 * was down is covered by the post-reconnect full re-read (a bump carries no
 * per-ledger scope anyway, so a whole-store invalidate is the correct
 * granularity — same as the xdg watcher).
 */

import postgres from "postgres";
import type { LedgerStore } from "../LedgerStore.js";
import type { ResolvedPostgresHandle } from "../createLedgerStore.js";
import { LEDGER_CHANGE_CHANNEL } from "./connection.js";

/** Grace period (seconds) for tearing down the LISTEN connection on close(). */
const CLOSE_TIMEOUT_S = 5;

/** Handle returned by {@link startPostgresCoherenceWatcher}. */
export interface PostgresCoherenceWatcher {
  /**
   * Stop listening and release the dedicated LISTEN connection. Synchronous
   * (parity with {@link import("../createLedgerStore.js").XdgCoherenceWatcher}
   * and `LedgerWatcher` `close(): void`) — the underlying `unlisten()` /
   * `end()` are fire-and-forget so the host wires shutdown identically across
   * backends.
   */
  close(): void;
}

/**
 * Start the postgres LISTEN/NOTIFY coherence watcher for `store` (T578).
 *
 * `onChange`, when given, fires ONCE per invalidate pass with `null` (never a
 * ledger id) — the NOTIFY payload carries only the tenant `project_key`, no
 * per-ledger scope, matching the bulk-invalidate granularity. Same callback
 * shape as `startXdgCoherenceWatcher` / `startLedgerWatcher`, so the
 * construction site forwards it uniformly (D89).
 *
 * A dropped LISTEN connection is re-established by porsager's auto-reconnect;
 * the `onlisten` hook runs a full invalidate on the initial connect AND on
 * every reconnect (missed-notification safety).
 */
export function startPostgresCoherenceWatcher(
  store: LedgerStore,
  pgHandle: ResolvedPostgresHandle,
  onChange?: (ledgerId: string | null) => void,
): PostgresCoherenceWatcher {
  // Dedicated LISTEN connection. An empty resolved dsn means "let the driver
  // read its own PG* env defaults" (the PG_DRIVER_DEFAULTS convention, same as
  // Bun.sql elsewhere) — porsager's no-argument form does exactly that.
  const listenSql = pgHandle.dsn === "" ? postgres() : postgres(pgHandle.dsn);

  // Coalesced invalidate: a single pass at a time, with a trailing re-run if a
  // notification (or reconnect) arrived mid-pass, so the last event is never
  // dropped. `store.invalidate` is cheap + idempotent for an unchanged ledger
  // (abstract-suite contract), so an extra pass is harmless.
  let invalidating = false;
  let pending = false;
  const invalidateAll = (): void => {
    if (invalidating) {
      pending = true;
      return;
    }
    invalidating = true;
    void (async () => {
      try {
        do {
          pending = false;
          for (const ledgerId of store.enumerate()) {
            await store.invalidate(ledgerId);
          }
          onChange?.(null);
        } while (pending);
      } finally {
        invalidating = false;
      }
    })();
  };

  const subscription = listenSql.listen(
    LEDGER_CHANGE_CHANNEL,
    (payload: string): void => {
      // Tenant filter: one shared channel carries every tenant's changes, so a
      // write to a DIFFERENT project_key must NOT invalidate this store.
      if (payload !== pgHandle.projectKey) return;
      invalidateAll();
    },
    // onlisten: fires on initial connect AND every reconnect — the
    // missed-notification safety hook (full invalidate covers any NOTIFY lost
    // while the connection was down).
    (): void => {
      invalidateAll();
    },
  );
  // A rejected initial LISTEN must not surface as an unhandled rejection; the
  // watcher stays inert until porsager reconnects (which re-runs onlisten).
  void subscription.catch(() => undefined);

  return {
    close(): void {
      void subscription.then((meta) => meta.unlisten()).catch(() => undefined);
      void listenSql.end({ timeout: CLOSE_TIMEOUT_S }).catch(() => undefined);
    },
  };
}

/**
 * Callbacks for {@link startPostgresHubCoherenceWatcher}, the MULTI-PROJECT
 * dispatch variant used by the `cq serve` hub (T587). Where the single-store
 * {@link startPostgresCoherenceWatcher} filters the shared channel down to ONE
 * tenant and bulk-invalidates that store itself, the hub owns MANY tenants over
 * one shared pool, so it wants ONE LISTEN connection that dispatches every
 * notification to the right project by its payload `project_key` — rather than
 * N per-store LISTEN connections — and does the per-project invalidate +
 * publish itself.
 */
export interface PostgresHubWatcherCallbacks {
  /**
   * A NOTIFY arrived on {@link LEDGER_CHANGE_CHANNEL}; `projectKey` is its
   * payload (the tenant whose data changed). The hub uses it to invalidate that
   * project's store (if constructed) and publish a change frame to that
   * project's pub/sub topic. Called for EVERY tenant's notification — the hub
   * decides what (if anything) to do per key.
   */
  onProjectChange: (projectKey: string) => void;
  /**
   * Fires on the INITIAL connect AND on EVERY reconnect (porsager `onlisten`) —
   * the missed-notification safety hook. On a reconnect the hub re-invalidates
   * every constructed store, since any NOTIFY emitted while the LISTEN
   * connection was down carries no per-tenant scope to replay. On the initial
   * connect (no stores constructed yet) it is a no-op for the hub.
   */
  onListen: () => void;
}

/**
 * Start the MULTI-PROJECT hub LISTEN/NOTIFY dispatcher (T587) — the SAME
 * porsager primitive and {@link LEDGER_CHANGE_CHANNEL} as the single-store
 * {@link startPostgresCoherenceWatcher}, but WITHOUT the per-tenant filter or
 * the built-in bulk-invalidate: the hub owns many tenants sharing one pool, so
 * it dispatches raw notifications by payload `project_key` back to
 * {@link PostgresHubWatcherCallbacks} and does the per-project invalidate +
 * publish itself. Exactly ONE such connection serves the whole hub.
 *
 * `dsn` is the hub's resolved DSN; an empty string means "let porsager read its
 * own PG* env defaults" (the no-argument form), matching the single-store path.
 * The returned handle shares {@link PostgresCoherenceWatcher}'s `close()`
 * contract so the host tears it down identically.
 */
export function startPostgresHubCoherenceWatcher(
  dsn: string,
  callbacks: PostgresHubWatcherCallbacks,
): PostgresCoherenceWatcher {
  const listenSql = dsn === "" ? postgres() : postgres(dsn);
  const subscription = listenSql.listen(
    LEDGER_CHANGE_CHANNEL,
    (payload: string): void => {
      callbacks.onProjectChange(payload);
    },
    (): void => {
      callbacks.onListen();
    },
  );
  void subscription.catch(() => undefined);
  return {
    close(): void {
      void subscription.then((meta) => meta.unlisten()).catch(() => undefined);
      void listenSql.end({ timeout: CLOSE_TIMEOUT_S }).catch(() => undefined);
    },
  };
}
