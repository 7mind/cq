/**
 * Pure projection helpers for compact ledger representations (T142, Q76).
 *
 * `projectCompact` strips large narrative fields from an Item so that
 * fetch_ledger can return a smaller payload when the caller only needs
 * a summary view. It imports LONG_FIELD_DENYLIST from columns.ts (the
 * column-eligibility concern) and extends it with additional large
 * narrative fields that are specific to the projection use-case.
 *
 * `paginate` slices an Item array with stable ordering and returns both
 * the slice and the total item count — a building block for pagination
 * support in fetch_ledger.
 *
 * Both functions are pure and side-effect-free.
 */

import type { Item } from "./types.js";
import { LONG_FIELD_DENYLIST } from "./columns.js";

/**
 * Additional fields to strip on top of LONG_FIELD_DENYLIST when producing
 * a compact projection. These are large narrative fields that don't belong
 * in the column-eligibility concern of columns.ts but DO bloat fetch_ledger
 * responses:
 *
 * - `grounding` (goals): per-goal repo-grounding blob persisted by the
 *   plan-flow; primary cause of the 51.8 KB goals overflow.
 * - `recommendation` (questions): long advisory text on a question item.
 * - `suggestions` (questions): array of suggestion strings that can be large.
 */
export const PROJECTION_EXTRA_DENYLIST: ReadonlySet<string> = new Set([
  "grounding",
  "recommendation",
  "suggestions",
]);

/**
 * The union of the column-eligibility denylist and the projection-specific
 * extra denylist. This is the full set of field names stripped by
 * `projectCompact`.
 */
export const COMPACT_PROJECTION_DENYLIST: ReadonlySet<string> = new Set([
  ...LONG_FIELD_DENYLIST,
  ...PROJECTION_EXTRA_DENYLIST,
]);

/**
 * Returns a shallow copy of `item` with all fields in COMPACT_PROJECTION_DENYLIST
 * removed from `item.fields`. The item's intrinsic properties (id, status,
 * milestoneId, createdAt, updatedAt, author, session) are preserved unchanged.
 *
 * The projected item retains all summary-source fields (headline, title,
 * question) and all short ref/tag fields so callers can still identify and
 * navigate items.
 */
export function projectCompact(item: Item): Item {
  const projected: Record<string, Item["fields"][string]> = {};
  for (const [key, value] of Object.entries(item.fields)) {
    if (!COMPACT_PROJECTION_DENYLIST.has(key)) {
      projected[key] = value;
    }
  }
  return { ...item, fields: projected };
}

/**
 * Result of a `paginate` call.
 */
export interface PaginateResult<T> {
  /** The requested slice of items. */
  items: T[];
  /** Total number of items before slicing (ignoring offset/limit). */
  total: number;
}

/**
 * Returns a stable slice of `items` together with the total count before
 * slicing. Ordering is stable: items are assumed to arrive in their natural
 * store order (which is createdAt / id ascending); this function does NOT
 * re-sort — it slices the array as-is.
 *
 * - `offset` — zero-based index of the first item to include. Clamped to
 *   `[0, total]` so out-of-range values never throw.
 * - `limit` — maximum number of items to return. When `undefined` or
 *   `<= 0`, all items from `offset` to the end are returned.
 */
export function paginate<T>(
  items: T[],
  offset: number,
  limit?: number,
): PaginateResult<T> {
  const total = items.length;
  const start = Math.max(0, Math.min(offset, total));
  const end =
    limit !== undefined && limit > 0 ? Math.min(start + limit, total) : total;
  return { items: items.slice(start, end), total };
}
