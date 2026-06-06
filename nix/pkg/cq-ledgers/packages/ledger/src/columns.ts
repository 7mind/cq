/**
 * Pure column-model helpers (T60). Field-LEVEL rules deciding which schema
 * field names may ever be a table column, distinct from the per-value
 * `isShortField` cell-formatting heuristic. Side-effect-free; shared by the
 * web (T61) and TUI (T62) clients.
 *
 * Per Q29/Q30:
 *  - `eligibleColumnFields(schema)` — every schema field name EXCEPT the
 *    long/narrative denylist and EXCEPT the always-shown intrinsic
 *    `id`/`status`/`summary` columns.
 *  - `defaultColumns(ledgerName)` — per-ledger default extra columns: `tasks`
 *    defaults to `suggestedModel`; every other ledger to none.
 */

import type { LedgerSchema } from "./types.js";
import { TASKS_LEDGER } from "./constants.js";

/**
 * Schema field names that are long/narrative free-text and therefore never
 * eligible to be shown as a (necessarily narrow) table column. Drawn from the
 * canonical ledger schemas in `constants.ts`.
 */
export const LONG_FIELD_DENYLIST: ReadonlySet<string> = new Set([
  "description",
  "rationale",
  "criticism",
  "context",
  "alternatives",
  "evidence",
  "completion",
  "answer",
  "rootCause",
  "suggestedFix",
  "fix",
]);

/**
 * Intrinsic columns that every table ALWAYS shows. They are excluded from the
 * eligible-fields set because they are not toggleable extra columns. `id` and
 * `status` are intrinsic Item properties; `summary` is the conventional
 * headline-ish field name (e.g. the reviews ledger's `summary`).
 */
export const ALWAYS_SHOWN_COLUMNS: ReadonlySet<string> = new Set([
  "id",
  "status",
  "summary",
]);

/**
 * Schema field names that source the summary cell. Excluded from the
 * eligible-fields set to avoid duplicating the summary cell, which already
 * renders one of these via summarize() (headline ?? title ?? question ?? summary).
 */
export const SUMMARY_SOURCE_FIELDS: ReadonlySet<string> = new Set([
  "headline",
  "title",
  "question",
]);

/**
 * Returns the schema field names that may be offered as toggleable table
 * columns: every declared field name, minus the long/narrative denylist,
 * minus the always-shown intrinsic columns, and minus the summary-source fields
 * that would duplicate the summary cell. Order follows the schema's field
 * declaration order.
 */
export function eligibleColumnFields(schema: LedgerSchema): string[] {
  return Object.keys(schema.fields).filter(
    (name) =>
      !LONG_FIELD_DENYLIST.has(name) &&
      !ALWAYS_SHOWN_COLUMNS.has(name) &&
      !SUMMARY_SOURCE_FIELDS.has(name),
  );
}

/**
 * Per-ledger default extra columns (beyond the always-shown intrinsic ones).
 * `tasks` defaults to showing `suggestedModel`; every other ledger defaults
 * to no extra columns.
 */
export function defaultColumns(ledgerName: string): string[] {
  if (ledgerName === TASKS_LEDGER) return ["suggestedModel"];
  return [];
}
