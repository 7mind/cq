/**
 * Cross-ledger snapshot (T143, Q75).
 *
 * A generic, flow-agnostic, compact view of every ACTIVE (non-archived) item
 * across every active ledger, grouped by ledger then status. Each item is
 * reduced to a `{ id, status, summary }` stub (NO long narrative fields) so the
 * snapshot stays well under the token-overflow threshold a full per-ledger
 * `fetch_ledger` sweep hits.
 *
 * Intentionally free of DAG / phase / predicate semantics (those stay in the
 * flow prompts): a pure projection over the resolved `FetchedLedger` views
 * (active items only), built on the store's `enumerate()` + `fetch()`.
 */

import type { FetchedLedger } from "./types.js";
import { summarize } from "./summarize.js";

/** The compact per-item stub: id, status, and the one-line summary only. */
export interface SnapshotItemStub {
  id: string;
  status: string;
  summary: string;
}

/** A single status bucket within one ledger: count + the item stubs. */
export interface SnapshotStatusBucket {
  count: number;
  items: SnapshotItemStub[];
}

/**
 * The full snapshot: `{ [ledger]: { [status]: { count, items } } }`.
 * Ledgers with no active items are omitted; status buckets are only present
 * when at least one active item carries that status.
 */
export type LedgerSnapshot = Record<
  string,
  Record<string, SnapshotStatusBucket>
>;

/**
 * Build a {@link LedgerSnapshot} from the resolved views of every active
 * ledger. Pure: no I/O, no store access. Items are taken from each ledger's
 * milestone-groups (active items only); each is grouped by status and reduced
 * to a `{ id, status, summary }` stub via the canonical {@link summarize}.
 *
 * Ledgers contributing no active items are dropped entirely so the result is
 * as compact as possible.
 */
export function buildSnapshot(ledgers: FetchedLedger[]): LedgerSnapshot {
  const out: LedgerSnapshot = {};
  for (const ledger of ledgers) {
    const byStatus: Record<string, SnapshotStatusBucket> = {};
    for (const group of ledger.milestones) {
      for (const item of group.items) {
        const bucket =
          byStatus[item.status] ?? (byStatus[item.status] = { count: 0, items: [] });
        bucket.items.push({
          id: item.id,
          status: item.status,
          summary: summarize(item),
        });
        bucket.count += 1;
      }
    }
    if (Object.keys(byStatus).length > 0) {
      out[ledger.id] = byStatus;
    }
  }
  return out;
}
