// cq auto-driver decision function (T462, G-auto-driver).
//
// The PURE, side-effect-free core of the auto-driver: given the current derived
// predicates, the wrapped command's terminal oracle, the run state, and the
// runtime signals, decide the SINGLE next action. This module is referentially
// transparent — it performs NO I/O, makes NO Pi calls, and imports NOTHING from
// `@earendil-works/pi-*`, `@cq/*`, `node:fs`, or `node:child_process`. It only
// imports the typed vocabulary from the sibling pure contract `./decision`.
//
// T464 wires the package.json + bun test around these exports; this file is kept
// trivially unit-testable for that reason.

import { AutoAction, type DerivedPredicates } from "./decision";

// ---------------------------------------------------------------------------
// Named constants.
// ---------------------------------------------------------------------------

/**
 * Context-window utilisation fraction (0..1) above which the driver compacts
 * before redriving. `signals.contextPercent` is expressed as the same fraction.
 * A run only compacts when contextPercent is non-null AND strictly greater than
 * this threshold.
 */
export const COMPACT_THRESHOLD = 0.8;

/**
 * Default hard iteration bound for a single auto-driver run. The driver stops
 * with STOP_NO_PROGRESS once `iteration >= maxIterations`, regardless of any
 * other signal except the higher-priority stop rules (quota / questions /
 * drained).
 */
export const DEFAULT_MAX_ITERATIONS = 25;

// ---------------------------------------------------------------------------
// decideNextAction — the pure decision core.
// ---------------------------------------------------------------------------

/**
 * The mutable-across-iterations bookkeeping the decision core reads to detect
 * iteration exhaustion and lack of forward progress.
 *
 *  - `iteration` — zero-based count of redrives already performed (0 on the
 *    first decision of a run).
 *  - `maxIterations` — the hard upper bound for this run (see
 *    DEFAULT_MAX_ITERATIONS).
 *  - `prevPredicates` — the derived predicates observed on the PREVIOUS
 *    iteration, or null on the first decision (nothing to compare against).
 *  - `prevAction` — the action selected on the PREVIOUS iteration, or null on
 *    the first decision. Used to suppress the no-progress stop in the cycle
 *    immediately following a compaction.
 */
export interface AutoRunState {
  iteration: number;
  maxIterations: number;
  prevPredicates: DerivedPredicates | null;
  prevAction: AutoAction | null;
}

/**
 * Runtime signals sampled from the host (NOT derived from the ledger): the
 * current context-window utilisation fraction (null when unknown — e.g. token
 * counts are unavailable just after a compaction) and whether a run budget /
 * quota has been hit.
 */
export interface AutoSignals {
  contextPercent: number | null;
  quotaHit: boolean;
}

/**
 * The full, side-effect-free input to a single decision.
 */
export interface DecideInput {
  predicates: DerivedPredicates;
  terminalPredicate: (p: DerivedPredicates) => boolean;
  runState: AutoRunState;
  signals: AutoSignals;
}

/**
 * Decide the next auto-driver action by applying the FIRST matching rule, in
 * this exact priority order (per the corrected G-auto-driver rule list):
 *
 *  (1) signals.quotaHit                          -> STOP_QUOTA
 *  (2) openQuestionGate.value (non-empty gate)   -> STOP_BLOCKED_ON_QUESTIONS
 *  (3) terminalPredicate(predicates)             -> STOP_DRAINED
 *  (4) iteration >= maxIterations                -> STOP_NO_PROGRESS
 *  (5) contextPercent != null && > THRESHOLD     -> COMPACT_THEN_REDRIVE
 *  (6) no-progress (see below)                   -> STOP_NO_PROGRESS
 *  (7) otherwise                                 -> REDRIVE
 *
 * Rule (5) — compaction — is evaluated BEFORE rule (6) — no-progress — so a
 * full context window is compacted rather than mistaken for a stall.
 *
 * Rule (6) fires only when predicatesEqual(prevPredicates, predicates) AND
 * iteration > 0 AND prevAction !== COMPACT_THEN_REDRIVE. The prevAction guard
 * EXCLUDES the cycle immediately after a compaction: a compaction is expected
 * to leave the predicates unchanged, so that single unchanged step must not be
 * read as a stall.
 *
 * Referentially transparent: same input -> same output, no side effects.
 */
export function decideNextAction(input: DecideInput): AutoAction {
  const { predicates, terminalPredicate, runState, signals } = input;

  // (1) Quota exhausted — highest priority.
  if (signals.quotaHit) {
    return AutoAction.STOP_QUOTA;
  }

  // (2) Blocked solely on open questions — never re-drive a user-blocked run.
  if (predicates.openQuestionGate.value) {
    return AutoAction.STOP_BLOCKED_ON_QUESTIONS;
  }

  // (3) Terminal — the wrapped command has drained its stage.
  if (terminalPredicate(predicates)) {
    return AutoAction.STOP_DRAINED;
  }

  // (4) Hard iteration bound.
  if (runState.iteration >= runState.maxIterations) {
    return AutoAction.STOP_NO_PROGRESS;
  }

  // (5) Context window too full — compact, then redrive. Evaluated BEFORE the
  //     no-progress rule. Null contextPercent means "unknown" -> do not compact.
  if (signals.contextPercent !== null && signals.contextPercent > COMPACT_THRESHOLD) {
    return AutoAction.COMPACT_THEN_REDRIVE;
  }

  // (6) No observable forward progress since the previous iteration — but not
  //     in the cycle immediately following a compaction (which is expected to
  //     leave predicates unchanged).
  if (
    runState.iteration > 0 &&
    runState.prevAction !== AutoAction.COMPACT_THEN_REDRIVE &&
    predicatesEqual(runState.prevPredicates, predicates)
  ) {
    return AutoAction.STOP_NO_PROGRESS;
  }

  // (7) Default — progress is still possible; redrive.
  return AutoAction.REDRIVE;
}

// ---------------------------------------------------------------------------
// predicatesEqual — canonical no-progress equality.
// ---------------------------------------------------------------------------

/**
 * The predicate keys compared for no-progress equality. `belowFloor` is
 * intentionally EXCLUDED: it is informational, so a change confined to it is
 * not "forward progress" for the stall detector.
 */
const PREDICATE_KEYS: ReadonlyArray<keyof DerivedPredicates> = [
  "pInvestigate",
  "pSeed",
  "pPlan",
  "pImplement",
  "openQuestionGate",
];

/**
 * Canonical no-progress equality between two predicate snapshots.
 *
 * Returns true iff, for ALL FOUR keys (pInvestigate, pPlan, pImplement,
 * openQuestionGate):
 *   (i)  a[key].value === b[key].value, AND
 *   (ii) the SET of a[key].items[] ids equals the set of b[key].items[] ids,
 *        compared as SORTED id arrays (order-insensitive).
 *
 * Only the `value` boolean and the item-id SET are compared — never positional
 * order, never any other field. A null `a` (no previous snapshot) is NOT equal.
 */
export function predicatesEqual(a: DerivedPredicates | null, b: DerivedPredicates): boolean {
  if (a === null) {
    return false;
  }
  for (const key of PREDICATE_KEYS) {
    const va = a[key];
    const vb = b[key];
    if (va.value !== vb.value) {
      return false;
    }
    if (!sameIdSet(va.items, vb.items)) {
      return false;
    }
  }
  return true;
}

/**
 * Order-insensitive set equality over two id arrays: equal iff they have the
 * same length and the same ids once each is sorted. Inputs are not mutated.
 */
function sameIdSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// composeRedrivePrompt — corrective redrive prompt.
// ---------------------------------------------------------------------------

/**
 * Compose a corrective prompt for a REDRIVE, naming which predicates are still
 * violated relative to the wrapped command's `terminalPredicate` intent and
 * instructing the orchestrator on what to do next.
 *
 * "Violated" = a stage predicate that is still TRUE (work remains) AND that the
 * wrapped command's `terminalPredicate` actually depends on. We probe the oracle
 * against a baseline in which every still-TRUE stage predicate is cleared (the
 * "would-be drained" snapshot); a predicate is named as a blocker iff, starting
 * from that baseline, re-setting just that one predicate to TRUE flips the
 * oracle back to non-terminal. This names exactly the predicates the specific
 * preset (advance vs plan vs investigate vs implement) cares about, without this
 * pure module knowing which preset it is.
 */
export function composeRedrivePrompt(
  predicates: DerivedPredicates,
  terminalPredicate: (p: DerivedPredicates) => boolean,
): string {
  if (terminalPredicate(predicates)) {
    return "The terminal predicate is already satisfied — no redrive is needed; STOP_DRAINED.";
  }

  const stageKeys: ReadonlyArray<StageKey> = ["pInvestigate", "pSeed", "pPlan", "pImplement"];

  // Baseline: every still-TRUE stage predicate cleared. If the oracle depends on
  // a given stage, re-asserting it from this baseline will flip the oracle.
  const baseline: DerivedPredicates = { ...predicates };
  for (const key of stageKeys) {
    if (predicates[key].value) {
      baseline[key] = { value: false, items: [] };
    }
  }

  const blockers: Array<{ key: StageKey; items: string[] }> = [];

  for (const key of stageKeys) {
    const verdict = predicates[key];
    if (!verdict.value) {
      continue; // already drained for this stage — not a blocker
    }
    const reasserted: DerivedPredicates = { ...baseline, [key]: verdict };
    // Blocker iff re-setting just this predicate breaks an otherwise-terminal
    // baseline. Falls back to naming it when the baseline itself is not terminal
    // (the oracle depends on predicates outside our control), so the prompt is
    // never silent about a still-TRUE stage.
    if (!terminalPredicate(reasserted) || !terminalPredicate(baseline)) {
      blockers.push({ key, items: [...verdict.items] });
    }
  }

  if (blockers.length === 0) {
    return (
      "The terminal predicate is not yet satisfied, but no stage predicate is " +
      "TRUE. Re-drive the wrapped command to make progress toward the terminal state."
    );
  }

  const lines = blockers.map(({ key, items }) => {
    const label = STAGE_LABELS[key];
    const idList = items.length > 0 ? items.join(", ") : "(no specific items reported)";
    return `- ${key} (${label}) is still TRUE — outstanding items: ${idList}`;
  });

  return [
    "The wrapped command has NOT reached its terminal state. The following stage",
    "predicates remain violated (work still outstanding):",
    ...lines,
    "",
    "Re-drive the wrapped command, focusing on the outstanding items above, until",
    "these predicates clear and the terminal predicate is satisfied.",
  ].join("\n");
}

/** The four stage predicates the redrive prompt may name as blockers. */
type StageKey = "pInvestigate" | "pSeed" | "pPlan" | "pImplement";

/** Human-readable labels for the four stage predicates, for prompt text. */
const STAGE_LABELS: Record<StageKey, string> = {
  pInvestigate: "investigate-flow work remains",
  pSeed: "seed-flow work remains (root-caused defect awaiting a fix goal)",
  pPlan: "plan-flow work remains",
  pImplement: "implement-flow work remains",
};
