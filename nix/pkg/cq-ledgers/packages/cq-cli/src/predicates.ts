/**
 * `cq predicates` (T476 / Q241) — the HARNESS-AGNOSTIC, UNCONDITIONAL predicate
 * emitter for the auto-driver oracle.
 *
 * Unlike `cq advance-gate` (advanceGate.ts), this subcommand has NO session
 * resolution and NO marker check: it ALWAYS reads the ledger via the shared
 * `derivePredicates(store)` engine and ALWAYS prints the TRUE predicates,
 * ALWAYS exiting 0. It exists so a harness with no per-session advance marker
 * (the "pi situation" — see advance-gate-false-drained.test.ts) can still read
 * the REAL ledger actionability rather than the gate's false-DRAINED verdict.
 *
 * The emitted JSON mirrors advance-gate's `verdict.predicates` shape exactly —
 * `{ "predicates": { pInvestigate, pPlan, pImplement, openQuestionGate } }` —
 * so the auto-driver oracle's `parseAdvanceGateOutput` (which reads
 * `parsed.predicates`) parses `cq predicates` output UNCHANGED.
 *
 * The store is built IN-PROCESS via `createLedgerStore(cwd)` (exactly like
 * `runAdvanceGate`'s step 4 and `runInit`) and disposed in a `finally`.
 */

import { createLedgerStore, derivePredicates, type DerivedPredicates } from "@cq/ledger";

/** Exit code for `cq predicates` — ALWAYS success (it never blocks). */
export const EXIT_PREDICATES = 0;

/** Inputs the emitter needs: just the resolved ledger root. */
export interface PredicatesArgs {
  /** Resolved ledger root (--cwd > $LEDGER_ROOT > CWD, absolute). */
  readonly cwd: string;
}

/** IO seam so tests can capture stdout (mirrors AdvanceGateIo). */
export interface PredicatesIo {
  out(line: string): void;
  err(line: string): void;
}

/** The dispatcher's outcome — the exit code main() propagates. */
export interface PredicatesOutcome {
  exitCode: number;
}

/**
 * The object serialised to stdout — the SAME `predicates` shape advance-gate
 * emits, so the oracle's `parseAdvanceGateOutput` reads `parsed.predicates`
 * identically.
 */
export interface PredicatesOutput {
  predicates: DerivedPredicates;
}

/**
 * `cq predicates`: build the fs-backed store in-process, derive the predicates
 * via the shared engine, dispose the store (try/finally), and print
 * `{ predicates }` to stdout UNCONDITIONALLY. ALWAYS exits 0 — no session, no
 * marker, no block.
 */
export async function runPredicates(
  args: PredicatesArgs,
  io: PredicatesIo,
): Promise<PredicatesOutcome> {
  const { store } = await createLedgerStore(args.cwd);
  let predicates: DerivedPredicates;
  try {
    predicates = derivePredicates(store);
  } finally {
    await store.dispose();
  }
  const output: PredicatesOutput = { predicates };
  io.out(JSON.stringify(output));
  return { exitCode: EXIT_PREDICATES };
}
