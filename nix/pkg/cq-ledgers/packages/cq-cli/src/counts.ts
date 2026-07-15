/**
 * `cq counts` (T533 / G76) — the read-only, UNCONDITIONAL ledger-summaries
 * emitter, mirroring `cq predicates` (T476) exactly.
 *
 * Like `cq predicates`, this subcommand has NO session resolution and NO
 * marker check: it ALWAYS reads the ledger via the shared
 * `computeLedgerSummaries(store)` engine (T532; the same computation
 * `enumerate_ledgers` uses over MCP) and ALWAYS prints the resulting
 * `{ ledgers, counts, ledgerSummaries }` object, ALWAYS exiting 0.
 *
 * The store is built IN-PROCESS via `createLedgerStore(cwd)` (exactly like
 * `runPredicates`) and disposed in a `finally`.
 */

import { createLedgerStore, computeLedgerSummaries, type LedgerSummariesResult } from "@cq/ledger";

/** Exit code for `cq counts` — ALWAYS success (it never blocks). */
export const EXIT_COUNTS = 0;

/** Inputs the emitter needs: just the resolved ledger root. */
export interface CountsArgs {
  /** Resolved ledger root (--cwd > $LEDGER_ROOT > CWD, absolute). */
  readonly cwd: string;
}

/** IO seam so tests can capture stdout (mirrors PredicatesIo). */
export interface CountsIo {
  out(line: string): void;
  err(line: string): void;
}

/** The dispatcher's outcome — the exit code main() propagates. */
export interface CountsOutcome {
  exitCode: number;
}

/**
 * `cq counts`: build the ledger-backed store in-process, compute the ledger
 * summaries via the shared engine, dispose the store (try/finally), and print
 * `{ ledgers, counts, ledgerSummaries }` to stdout UNCONDITIONALLY. ALWAYS
 * exits 0 — no session, no marker, no block.
 */
export async function runCounts(
  args: CountsArgs,
  io: CountsIo,
): Promise<CountsOutcome> {
  const { store } = await createLedgerStore(args.cwd);
  let summaries: LedgerSummariesResult;
  try {
    summaries = computeLedgerSummaries(store);
  } finally {
    await store.dispose();
  }
  io.out(JSON.stringify(summaries));
  return { exitCode: EXIT_COUNTS };
}
