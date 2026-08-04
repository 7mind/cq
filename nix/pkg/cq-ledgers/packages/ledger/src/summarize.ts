/**
 * Canonical item-summary helper (T143, Q75).
 *
 * The single source of truth for the one-line summary of a ledger item:
 * the precedence `headline ?? title ?? question ?? summary` (the
 * SUMMARY_SOURCE_FIELDS in declaration order, plus the `summary` field as
 * the final source), with a legacy fallback for items that carry none of
 * those (e.g. reviews keyed only by a `criticism[]` list) and a last-resort
 * first-field stringification.
 *
 * The TUI (`ledger-tui/src/app.tsx`) carries its own private copy of this
 * logic for rendering the summary cell; the web (`ledger-web/src/App.tsx`)
 * imports this module via the `@cq/ledger/summarize` leaf subpath (D222).
 * This module exposes the same algorithm at the library level so
 * store-level callers (e.g. `LedgerStore.snapshot`) reuse it rather than
 * reimplement the precedence.
 */

import type { FieldValue, Item } from "./types.js";
import { SUMMARY_SOURCE_FIELDS } from "./columns.js";

/** Max characters of the legacy criticism-line fallback before truncation. */
const SUMMARIZE_MAX = 80;

/** The `summary` field, appended after SUMMARY_SOURCE_FIELDS in the precedence. */
const SUMMARY_FALLBACK_FIELD = "summary";

/**
 * The ordered list of source fields the summary is drawn from:
 * `headline`, `title`, `question` (SUMMARY_SOURCE_FIELDS, declaration order),
 * then `summary`. First defined value wins.
 */
const SUMMARY_PRECEDENCE: readonly string[] = [
  ...SUMMARY_SOURCE_FIELDS,
  SUMMARY_FALLBACK_FIELD,
];

/** Render a field value as a single string (arrays are comma-joined). */
export function fieldToString(v: FieldValue | undefined): string {
  if (v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : v;
}

/**
 * The one-line summary of `item`, matching the TUI's private `summarize()`:
 *  1. the first defined field in `headline ?? title ?? question ?? summary`;
 *  2. else the first line of the first `criticism[]` entry (truncated);
 *  3. else the first field's stringified value (empty string if no fields).
 */
export function summarize(item: Item): string {
  const f = item.fields;
  for (const name of SUMMARY_PRECEDENCE) {
    const v = f[name];
    if (v !== undefined) return fieldToString(v);
  }
  // Legacy fallback for reviews with no summary: truncate the first criticism line.
  const crit = f["criticism"];
  if (Array.isArray(crit) && crit.length > 0) {
    const line = String(crit[0]).split("\n")[0] ?? "";
    return line.length > SUMMARIZE_MAX ? line.slice(0, SUMMARIZE_MAX) + "…" : line;
  }
  return fieldToString(Object.values(f)[0]);
}
