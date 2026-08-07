/**
 * Pure pagination helper for ledger item lists (T142).
 *
 * Compact item projection for MCP reads is owned exclusively by the wire
 * allowlist in `mcp/wireResponseContract.ts` (`projectCompactItemDto` /
 * `COMPACT_ITEM_FIELD_NAMES`). The legacy denylist projector was removed under
 * G152/D221 (K227) after G150 put `answer` on the wire allowlist.
 */

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
  items: readonly T[],
  offset: number,
  limit?: number,
): PaginateResult<T> {
  const total = items.length;
  const start = Math.max(0, Math.min(offset, total));
  if (limit === undefined || limit <= 0) {
    return { items: items.slice(start) as T[], total };
  }
  return { items: items.slice(start, start + limit) as T[], total };
}
