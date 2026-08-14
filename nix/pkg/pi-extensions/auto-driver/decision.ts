// cq auto-driver decision core (T461, G-auto-driver).
//
// The PURE, Pi-free, framework-agnostic decision contract for the cq
// auto-driver Pi extension. This is the FIRST module of the auto-driver: it
// establishes the typed vocabulary that later tasks consume — T462 implements
// `decideNextAction` over this contract, T464 wires the package.json + tests.
//
// This module is DELIBERATELY pure and unit-testable. Its only package import is
// a type-only link to @cq/ledger's canonical predicate contract; runtime
// delivery remains a bare store-path directory with local value imports only.

// ---------------------------------------------------------------------------
// Base oracle — the canonical ledger-MCP `derive_predicates` shape.
// ---------------------------------------------------------------------------

import type { DerivedPredicates, PredicateVerdict } from "@cq/ledger";

export type { DerivedPredicates, PredicateVerdict };

/**
 * The `DerivedPredicates` member keys, in canonical interface order — the
 * SINGLE shared list consumed by BOTH the oracle parser (./oracle.ts, which
 * requires every key in the live `cq predicates` JSON) and the drift guard
 * (oracle.test.ts, which compares this list against the CANONICAL
 * @cq/ledger predicates.ts interface). Sharing one list is the point: a key
 * added to the canonical interface turns the drift guard red, and a key added
 * here without the interface fails the compile-time tie below.
 */
export const DERIVED_PREDICATE_KEYS = [
  "pInvestigate",
  "pSeed",
  "pPlan",
  "pResearch",
  "pImplement",
  "pOperatorAction",
  "openQuestionGate",
  "belowFloor",
  "planBusy",
  "goalDrift",
] as const satisfies readonly (keyof DerivedPredicates)[];

// Compile-time tie: DERIVED_PREDICATE_KEYS must name EVERY DerivedPredicates
// member (the `satisfies` above already rejects a key the interface does not
// carry). A member added to the interface without updating the list makes
// this assignment fail tsc.
type MissingDerivedPredicateKey = Exclude<
  keyof DerivedPredicates,
  (typeof DERIVED_PREDICATE_KEYS)[number]
>;
const _assertDerivedPredicateKeysExhaustive: MissingDerivedPredicateKey extends never ? true : never = true;
void _assertDerivedPredicateKeysExhaustive;

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
 * `cq:advance:auto` — drains the whole flow. Terminal when ALL SIX actionable
 * P-predicates are FALSE (no investigate, seed, plan, research, implement, or
 * operator-action work remains). The informational `belowFloor` companion is
 * intentionally NOT part of the terminal check — a sub-floor defect never keeps
 * the run alive. Wraps `/cq:advance`; registered as `cq:advance:auto`.
 */
export const advanceAutoPreset: AutoPreset = {
  wrappedCommand: "cq:advance",
  terminalPredicate: (p) =>
    !p.pInvestigate.value &&
    !p.pSeed.value &&
    !p.pPlan.value &&
    !p.pResearch.value &&
    !p.pImplement.value &&
    !p.pOperatorAction.value,
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
 * `cq:implement:auto` — drains implement-flow. Terminal when both
 * `pImplement` and `pOperatorAction` are FALSE (`implement:advance` owns both).
 * Wraps `/cq:implement:advance`; registered as `cq:implement:auto`.
 */
export const implementAutoPreset: AutoPreset = {
  wrappedCommand: "cq:implement:advance",
  commandName: "cq:implement:auto",
  terminalPredicate: (p) => !p.pImplement.value && !p.pOperatorAction.value,
};

/**
 * `cq:research:auto` — drains research-flow. Terminal when `pResearch.value`
 * is FALSE.
 * Wraps `/cq:research:advance`; registered as `cq:research:auto`.
 */
export const researchAutoPreset: AutoPreset = {
  wrappedCommand: "cq:research:advance",
  commandName: "cq:research:auto",
  terminalPredicate: (p) => !p.pResearch.value,
};
