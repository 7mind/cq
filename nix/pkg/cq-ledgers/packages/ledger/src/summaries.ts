/**
 * Shared `enumerate_ledgers` summary computation (G76 / T532).
 *
 * Both MCP surfaces (`./mcp/ledgerTools.ts` Claude-SDK factory and
 * `./mcp/stdioLedgerTools.ts` raw-SDK registration) previously carried
 * byte-identical private copies of this logic. Lifted here as the single
 * source of truth; both callers now delegate to `computeLedgerSummaries`.
 */

import type { LedgerStore } from "./store/LedgerStore.js";
import type { LedgerSchema, LedgerSummary } from "./types.js";
import { QUESTIONS_LEDGER } from "./constants.js";

/**
 * The answered status for the questions ledger. Kept as a named constant so
 * the completion logic is expressed once (mirror of ANSWERED_STATUS in the
 * web client's status.ts, but server-side where we have the schema).
 */
export const QUESTIONS_ANSWERED_STATUS = "answered";

/**
 * The withdrawn status for the questions ledger. Items in this terminal status
 * do not count toward the progress denominator (mirror of QUESTIONS_ANSWERED_STATUS).
 */
export const QUESTIONS_WITHDRAWN_STATUS = "withdrawn";

/**
 * Compute the number of active items that count as COMPLETED for this
 * ledger's progress bar, classified against its OWN schema:
 *  - questions ledger: only items in the "answered" status (NOT all terminals;
 *    "withdrawn" is also terminal but does not count as a positive completion).
 *  - every other ledger: items whose status is in schema.terminalStatuses.
 */
export function computeCompletedCount(
  ledgerName: string,
  sc: Record<string, number>,
  schema: LedgerSchema,
): number {
  if (ledgerName === QUESTIONS_LEDGER) {
    return sc[QUESTIONS_ANSWERED_STATUS] ?? 0;
  }
  let total = 0;
  for (const status of schema.terminalStatuses) {
    total += sc[status] ?? 0;
  }
  return total;
}

/**
 * Compute the denominator for this ledger's progress bar, classified against
 * its OWN schema:
 *  - questions ledger: open + answered (excludes the terminal `withdrawn`).
 *  - every other ledger: itemCount (all active items).
 */
export function computeProgressTotal(
  ledgerName: string,
  sc: Record<string, number>,
  _schema: LedgerSchema,
  itemCount: number,
): number {
  if (ledgerName === QUESTIONS_LEDGER) {
    return itemCount - (sc[QUESTIONS_WITHDRAWN_STATUS] ?? 0);
  }
  return itemCount;
}

/** Payload shape returned by the `enumerate_ledgers` MCP tool. */
export interface LedgerSummariesResult {
  ledgers: string[];
  counts: Record<string, number>;
  ledgerSummaries: LedgerSummary[];
}

/**
 * Compute the full `enumerate_ledgers` payload: ledger names, active-item
 * counts, and per-ledger summaries (statusCounts/completedCount/progressTotal),
 * from a `LedgerStore`. Shared by both MCP surfaces so the over-the-wire
 * response stays byte-identical across the Claude-SDK and stdio tool paths.
 */
export function computeLedgerSummaries(store: LedgerStore): LedgerSummariesResult {
  const ledgers = store.enumerate();
  const counts: Record<string, number> = {};
  const statusCounts: Record<string, Record<string, number>> = {};
  const completedCounts: Record<string, number> = {};
  const progressTotals: Record<string, number> = {};
  for (const name of ledgers) {
    const fetched = store.fetch(name);
    const sc: Record<string, number> = {};
    let total = 0;
    for (const group of fetched.milestones) {
      for (const item of group.items) {
        sc[item.status] = (sc[item.status] ?? 0) + 1;
        total++;
      }
    }
    counts[name] = total;
    statusCounts[name] = sc;
    completedCounts[name] = computeCompletedCount(name, sc, fetched.schema);
    progressTotals[name] = computeProgressTotal(name, sc, fetched.schema, total);
  }
  const ledgerSummaries = ledgers.map((name) => ({
    name,
    itemCount: counts[name] ?? 0,
    statusCounts: statusCounts[name] ?? {},
    completedCount: completedCounts[name] ?? 0,
    progressTotal: progressTotals[name] ?? 0,
  }));
  return { ledgers, counts, ledgerSummaries };
}
