// cq auto-driver decision core (T461, G-auto-driver).
//
// The PURE, Pi-free, framework-agnostic decision contract for the cq
// auto-driver Pi extension. This is the FIRST module of the auto-driver: it
// establishes the typed vocabulary that later tasks consume — T462 implements
// `decideNextAction` over this contract, T464 wires the package.json + tests.
//
// This module is DELIBERATELY pure and unit-testable: it imports NOTHING from
// `@earendil-works/pi-*` and NOTHING from `@cq/*`. It is a standalone
// store-path file OUTSIDE the cq-ledgers bun workspace, so — exactly like the
// other pi-extensions files — it follows the copy-not-import discipline of
// cq-subagent-dispatch.ts: types it needs from @cq/ledger are COPIED here, not
// imported, with a pointer back to the source to keep in sync.

// ---------------------------------------------------------------------------
// Base oracle — the ledger-MCP `derive_predicates` shape (Q233 + Q236).
// ---------------------------------------------------------------------------
//
// COPIED VERBATIM from the @cq/ledger source of truth:
//   nix/pkg/cq-ledgers/packages/ledger/src/store/predicates.ts
// (interfaces `PredicateVerdict` and `DerivedPredicates`). This module CANNOT
// import @cq/ledger (standalone store-path extension), so the shape is
// duplicated. KEEP IN SYNC with predicates.ts when that contract changes.

/**
 * One detection predicate's verdict: its boolean `value` plus the ids of the
 * items that make it TRUE-and-unblocked, so a caller can NAME them in a report.
 * When `value` is false, `items` is empty.
 */
export interface PredicateVerdict {
  value: boolean;
  items: string[];
}

/**
 * The four flow-detection verdicts derived from one store snapshot. The first
 * three mirror the `/cq:advance` cycle stages; `openQuestionGate` enumerates
 * the open questions that gate any of them.
 */
export interface DerivedPredicates {
  pInvestigate: PredicateVerdict;
  pPlan: PredicateVerdict;
  pImplement: PredicateVerdict;
  openQuestionGate: PredicateVerdict;
}

// ---------------------------------------------------------------------------
// Decision-action vocabulary (Q233 + Q236).
// ---------------------------------------------------------------------------

/**
 * The actions the auto-driver's decision core may select for the next step.
 *
 *  - REDRIVE — re-run the wrapped command; the terminal predicate is not yet
 *    met and progress is still possible.
 *  - STOP_DRAINED — the terminal predicate is met; there is no more work.
 *  - STOP_BLOCKED_ON_QUESTIONS — remaining work is gated solely on open
 *    questions for the user (openQuestionGate is set).
 *  - STOP_QUOTA — a configured run budget (turns / cost / wall-clock) is
 *    exhausted.
 *  - STOP_NO_PROGRESS — a redrive produced no observable forward movement.
 *  - COMPACT_THEN_REDRIVE — compact the context window, then redrive.
 */
export enum AutoAction {
  REDRIVE = "REDRIVE",
  STOP_DRAINED = "STOP_DRAINED",
  STOP_BLOCKED_ON_QUESTIONS = "STOP_BLOCKED_ON_QUESTIONS",
  STOP_QUOTA = "STOP_QUOTA",
  STOP_NO_PROGRESS = "STOP_NO_PROGRESS",
  COMPACT_THEN_REDRIVE = "COMPACT_THEN_REDRIVE",
}

// ---------------------------------------------------------------------------
// Per-:auto preset descriptors (Q236).
// ---------------------------------------------------------------------------

/**
 * A preset descriptor for one `<command>:auto` wrapper: the command the driver
 * redrives, plus the postcondition oracle that decides when the run is DRAINED.
 *
 * `wrappedCommand` is the name of the slash command to invoke (without the
 * leading `/`), e.g. `"cq:advance"` or `"cq:plan:advance"`. The driver sends
 * `/${wrappedCommand}` into the live Pi session to start each redrive.
 *
 * `commandName` is the name the `:auto` command is registered under (without
 * the leading `/`), e.g. `"cq:advance:auto"`. When absent, it defaults to
 * `${wrappedCommand}:auto`. Provide it explicitly when the registration name
 * must differ from the `${wrappedCommand}:auto` form (e.g. `cq:plan:auto`
 * wraps `cq:plan:advance`, so `commandName` is `"cq:plan:auto"`).
 *
 * `terminalPredicate` returns TRUE when the wrapped command has reached its
 * terminal state for the given derived predicates (no movable work remains for
 * that command's stage), i.e. the driver should STOP_DRAINED rather than
 * REDRIVE.
 */
export interface AutoPreset {
  wrappedCommand: string;
  commandName?: string;
  terminalPredicate: (p: DerivedPredicates) => boolean;
}

/**
 * `cq:advance:auto` — drains the whole flow. Terminal when ALL THREE P-predicates
 * are FALSE (no investigate, plan, or implement work remains).
 * Wraps `/cq:advance`; registered as `cq:advance:auto`.
 */
export const advanceAutoPreset: AutoPreset = {
  wrappedCommand: "cq:advance",
  terminalPredicate: (p) => !p.pInvestigate.value && !p.pPlan.value && !p.pImplement.value,
};

/**
 * `cq:plan:auto` — drains plan-flow. Terminal when `pPlan.value` is FALSE: no
 * movable goal remains (the target goal has reached `planned`).
 * Wraps `/cq:plan:advance`; registered as `cq:plan:auto`.
 */
export const planAutoPreset: AutoPreset = {
  wrappedCommand: "cq:plan:advance",
  commandName: "cq:plan:auto",
  terminalPredicate: (p) => !p.pPlan.value,
};

/**
 * `cq:investigate:auto` — drains investigate-flow. Terminal when
 * `pInvestigate.value` is FALSE.
 * Wraps `/cq:investigate:advance`; registered as `cq:investigate:auto`.
 */
export const investigateAutoPreset: AutoPreset = {
  wrappedCommand: "cq:investigate:advance",
  commandName: "cq:investigate:auto",
  terminalPredicate: (p) => !p.pInvestigate.value,
};

/**
 * `cq:implement:auto` — drains implement-flow. Terminal when `pImplement.value`
 * is FALSE.
 * Wraps `/cq:implement:advance`; registered as `cq:implement:auto`.
 */
export const implementAutoPreset: AutoPreset = {
  wrappedCommand: "cq:implement:advance",
  commandName: "cq:implement:auto",
  terminalPredicate: (p) => !p.pImplement.value,
};
