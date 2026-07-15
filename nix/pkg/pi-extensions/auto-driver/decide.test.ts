// decide.test.ts — unit tests for decideNextAction, predicatesEqual, and
// composeRedrivePrompt (from ./decide.ts).
//
// Test-location seam (option (a) per T464 spec): this file lives beside the
// module under nix/pkg/pi-extensions/auto-driver/, which has its own
// package.json with `"test": "bun test"`. It is NOT part of the cq-ledgers
// bun workspace — it is a standalone package that requires no workspace
// install. Run with: `cd nix/pkg/pi-extensions/auto-driver && bun test`.

import { describe, test, expect } from "bun:test";
import {
  decideNextAction,
  predicatesEqual,
  composeRedrivePrompt,
  COMPACT_THRESHOLD,
  DEFAULT_MAX_ITERATIONS,
  type AutoRunState,
  type AutoSignals,
  type DecideInput,
} from "./decide";
import {
  AutoAction,
  advanceAutoPreset,
  planAutoPreset,
  investigateAutoPreset,
  implementAutoPreset,
  type DerivedPredicates,
  type AutoPreset,
} from "./decision";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/** A "nothing to do" predicate snapshot: all stage preds FALSE, no gate. */
function emptyPredicates(): DerivedPredicates {
  return {
    pInvestigate: { value: false, items: [] },
    pSeed: { value: false, items: [] },
    pPlan: { value: false, items: [] },
    pImplement: { value: false, items: [] },
    openQuestionGate: { value: false, items: [] },
    belowFloor: { value: false, items: [] },
  };
}

/** Predicates with all four stage predicates TRUE and no gate. */
function allActivePredicates(items?: string[]): DerivedPredicates {
  const it = items ?? ["T1", "T2"];
  return {
    pInvestigate: { value: true, items: it },
    pSeed: { value: true, items: it },
    pPlan: { value: true, items: it },
    pImplement: { value: true, items: it },
    openQuestionGate: { value: false, items: [] },
    belowFloor: { value: false, items: [] },
  };
}

/**
 * Fill the two G77/M240 fields (pSeed + belowFloor) with all-false defaults for
 * the many inline fixtures below that predate them and don't exercise them.
 * A test that DOES exercise pSeed builds its snapshot explicitly instead.
 */
const SEED_DEFAULTS = {
  pSeed: { value: false, items: [] as string[] },
  belowFloor: { value: false, items: [] as string[] },
};

/** Default signals: not quota-hit, context unknown. */
function noSignals(): AutoSignals {
  return { contextPercent: null, quotaHit: false };
}

/** First-iteration run state (no prev predicates, no prev action). */
function firstIterState(max: number = DEFAULT_MAX_ITERATIONS): AutoRunState {
  return {
    iteration: 0,
    maxIterations: max,
    prevPredicates: null,
    prevAction: null,
  };
}

/**
 * Build a DecideInput from parts. Defaults: advanceAutoPreset terminal pred,
 * first-iteration state, and no signals.
 */
function buildInput(
  predicates: DerivedPredicates,
  overrides?: {
    terminalPredicate?: (p: DerivedPredicates) => boolean;
    runState?: Partial<AutoRunState>;
    signals?: Partial<AutoSignals>;
  },
): DecideInput {
  const baseState = firstIterState();
  return {
    predicates,
    terminalPredicate: overrides?.terminalPredicate ?? advanceAutoPreset.terminalPredicate,
    runState: overrides?.runState ? { ...baseState, ...overrides.runState } : baseState,
    signals: overrides?.signals ? { ...noSignals(), ...overrides.signals } : noSignals(),
  };
}

// ---------------------------------------------------------------------------
// Rule 1: STOP_QUOTA
// ---------------------------------------------------------------------------

describe("decideNextAction — rule 1: STOP_QUOTA", () => {
  test("quotaHit=true always returns STOP_QUOTA regardless of other signals", () => {
    // Even if terminal predicate is met and openQuestionGate is set,
    // quotaHit takes the highest priority.
    const predicates = emptyPredicates(); // would be STOP_DRAINED without quota
    const action = decideNextAction(
      buildInput(predicates, { signals: { quotaHit: true } }),
    );
    expect(action).toBe(AutoAction.STOP_QUOTA);
  });

  test("quotaHit=true overrides openQuestionGate", () => {
    const predicates: DerivedPredicates = {
      ...emptyPredicates(),
      openQuestionGate: { value: true, items: ["Q1"] },
    };
    const action = decideNextAction(
      buildInput(predicates, { signals: { quotaHit: true } }),
    );
    expect(action).toBe(AutoAction.STOP_QUOTA);
  });

  test("quotaHit=true overrides high contextPercent (not COMPACT_THEN_REDRIVE)", () => {
    const predicates = allActivePredicates();
    const action = decideNextAction(
      buildInput(predicates, {
        signals: { quotaHit: true, contextPercent: 0.99 },
      }),
    );
    expect(action).toBe(AutoAction.STOP_QUOTA);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: STOP_BLOCKED_ON_QUESTIONS
// ---------------------------------------------------------------------------

describe("decideNextAction — rule 2: STOP_BLOCKED_ON_QUESTIONS", () => {
  test("openQuestionGate.value=true returns STOP_BLOCKED_ON_QUESTIONS", () => {
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["T10"] },
      pPlan: { value: true, items: ["G1"] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: true, items: ["Q99"] },
    };
    const action = decideNextAction(buildInput(predicates));
    expect(action).toBe(AutoAction.STOP_BLOCKED_ON_QUESTIONS);
  });

  test("openQuestionGate overrides redrive: P-predicate still true but gate blocks", () => {
    // This is the explicit "openQuestionGate-overrides-redrive" fixture.
    // pImplement is true (work remains), so without the gate we'd REDRIVE.
    // With the gate set, we MUST return STOP_BLOCKED_ON_QUESTIONS, not REDRIVE.
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: false, items: [] },
      pPlan: { value: false, items: [] },
      pImplement: { value: true, items: ["T42"] }, // still true -> advance not terminal
      openQuestionGate: { value: true, items: ["Q1"] },
    };
    const action = decideNextAction(buildInput(predicates));
    expect(action).toBe(AutoAction.STOP_BLOCKED_ON_QUESTIONS);
    // Explicitly assert it does NOT REDRIVE despite pImplement being true.
    expect(action).not.toBe(AutoAction.REDRIVE);
  });

  test("openQuestionGate overrides STOP_DRAINED (gate wins over terminal predicate)", () => {
    // advanceAutoPreset terminal = all three FALSE — but gate is set, so gate wins.
    const predicates: DerivedPredicates = {
      ...emptyPredicates(),
      openQuestionGate: { value: true, items: ["Q5"] },
    };
    const action = decideNextAction(buildInput(predicates));
    expect(action).toBe(AutoAction.STOP_BLOCKED_ON_QUESTIONS);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: STOP_DRAINED — one fixture per preset
// ---------------------------------------------------------------------------

describe("decideNextAction — rule 3: STOP_DRAINED per preset", () => {
  test("advanceAutoPreset: all three stage preds FALSE => STOP_DRAINED", () => {
    const predicates = emptyPredicates();
    const action = decideNextAction(
      buildInput(predicates, {
        terminalPredicate: advanceAutoPreset.terminalPredicate,
      }),
    );
    expect(action).toBe(AutoAction.STOP_DRAINED);
  });

  test("advanceAutoPreset: any stage pred TRUE => NOT STOP_DRAINED", () => {
    // pInvestigate is still true — advance is not terminal
    const predicates: DerivedPredicates = {
      ...emptyPredicates(),
      pInvestigate: { value: true, items: ["D5"] },
    };
    const action = decideNextAction(
      buildInput(predicates, {
        terminalPredicate: advanceAutoPreset.terminalPredicate,
      }),
    );
    expect(action).not.toBe(AutoAction.STOP_DRAINED);
  });

  test("advanceAutoPreset: pSeed-ONLY TRUE (D94 regression) => NOT STOP_DRAINED", () => {
    // The false-DRAINED gap the P-seed predicate closes: a root-caused defect
    // owned by no goal makes ONLY pSeed TRUE; every other stage predicate is
    // FALSE. The advance preset must NOT treat this as drained.
    const predicates: DerivedPredicates = {
      ...emptyPredicates(),
      pSeed: { value: true, items: ["D94"] },
    };
    expect(advanceAutoPreset.terminalPredicate(predicates)).toBe(false);
    const action = decideNextAction(
      buildInput(predicates, {
        terminalPredicate: advanceAutoPreset.terminalPredicate,
      }),
    );
    expect(action).not.toBe(AutoAction.STOP_DRAINED);
    expect(action).toBe(AutoAction.REDRIVE);
  });

  test("planAutoPreset: pPlan.value=false => STOP_DRAINED", () => {
    // Only pPlan matters for plan preset; pInvestigate and pImplement can be true.
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D1"] },
      pPlan: { value: false, items: [] },
      pImplement: { value: true, items: ["T1"] },
      openQuestionGate: { value: false, items: [] },
    };
    const action = decideNextAction(
      buildInput(predicates, {
        terminalPredicate: planAutoPreset.terminalPredicate,
      }),
    );
    expect(action).toBe(AutoAction.STOP_DRAINED);
  });

  test("planAutoPreset: pPlan.value=true => NOT STOP_DRAINED", () => {
    const predicates: DerivedPredicates = {
      ...emptyPredicates(),
      pPlan: { value: true, items: ["G10"] },
    };
    const action = decideNextAction(
      buildInput(predicates, {
        terminalPredicate: planAutoPreset.terminalPredicate,
      }),
    );
    expect(action).not.toBe(AutoAction.STOP_DRAINED);
  });

  test("investigateAutoPreset: pInvestigate.value=false => STOP_DRAINED", () => {
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: false, items: [] },
      pPlan: { value: true, items: ["G1"] },
      pImplement: { value: true, items: ["T1"] },
      openQuestionGate: { value: false, items: [] },
    };
    const action = decideNextAction(
      buildInput(predicates, {
        terminalPredicate: investigateAutoPreset.terminalPredicate,
      }),
    );
    expect(action).toBe(AutoAction.STOP_DRAINED);
  });

  test("investigateAutoPreset: pInvestigate.value=true => NOT STOP_DRAINED", () => {
    const predicates: DerivedPredicates = {
      ...emptyPredicates(),
      pInvestigate: { value: true, items: ["D7"] },
    };
    const action = decideNextAction(
      buildInput(predicates, {
        terminalPredicate: investigateAutoPreset.terminalPredicate,
      }),
    );
    expect(action).not.toBe(AutoAction.STOP_DRAINED);
  });

  test("implementAutoPreset: pImplement.value=false => STOP_DRAINED", () => {
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D1"] },
      pPlan: { value: true, items: ["G1"] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    const action = decideNextAction(
      buildInput(predicates, {
        terminalPredicate: implementAutoPreset.terminalPredicate,
      }),
    );
    expect(action).toBe(AutoAction.STOP_DRAINED);
  });

  test("implementAutoPreset: pImplement.value=true => NOT STOP_DRAINED", () => {
    const predicates: DerivedPredicates = {
      ...emptyPredicates(),
      pImplement: { value: true, items: ["T50"] },
    };
    const action = decideNextAction(
      buildInput(predicates, {
        terminalPredicate: implementAutoPreset.terminalPredicate,
      }),
    );
    expect(action).not.toBe(AutoAction.STOP_DRAINED);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: STOP_NO_PROGRESS (iteration cap)
// ---------------------------------------------------------------------------

describe("decideNextAction — rule 4: STOP_NO_PROGRESS (iteration cap)", () => {
  test("iteration === maxIterations returns STOP_NO_PROGRESS", () => {
    const predicates = allActivePredicates(); // not terminal, not gated
    const action = decideNextAction(
      buildInput(predicates, {
        runState: { iteration: 25, maxIterations: 25, prevPredicates: null, prevAction: null },
      }),
    );
    expect(action).toBe(AutoAction.STOP_NO_PROGRESS);
  });

  test("iteration > maxIterations also returns STOP_NO_PROGRESS", () => {
    const predicates = allActivePredicates();
    const action = decideNextAction(
      buildInput(predicates, {
        runState: { iteration: 30, maxIterations: 25, prevPredicates: null, prevAction: null },
      }),
    );
    expect(action).toBe(AutoAction.STOP_NO_PROGRESS);
  });

  test("iteration < maxIterations does NOT trigger iteration-cap stop", () => {
    const predicates = allActivePredicates();
    const action = decideNextAction(
      buildInput(predicates, {
        runState: { iteration: 24, maxIterations: 25, prevPredicates: null, prevAction: null },
      }),
    );
    expect(action).not.toBe(AutoAction.STOP_NO_PROGRESS);
  });

  test("DEFAULT_MAX_ITERATIONS is 25", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Rule 5: COMPACT_THEN_REDRIVE
// ---------------------------------------------------------------------------

describe("decideNextAction — rule 5: COMPACT_THEN_REDRIVE", () => {
  test("contextPercent > COMPACT_THRESHOLD returns COMPACT_THEN_REDRIVE", () => {
    const predicates = allActivePredicates();
    const action = decideNextAction(
      buildInput(predicates, {
        signals: { contextPercent: 0.85, quotaHit: false },
      }),
    );
    expect(action).toBe(AutoAction.COMPACT_THEN_REDRIVE);
  });

  test("contextPercent exactly at COMPACT_THRESHOLD does NOT compact", () => {
    // Rule (5) requires STRICTLY GREATER THAN threshold.
    const predicates = allActivePredicates();
    const action = decideNextAction(
      buildInput(predicates, {
        signals: { contextPercent: COMPACT_THRESHOLD, quotaHit: false },
      }),
    );
    expect(action).not.toBe(AutoAction.COMPACT_THEN_REDRIVE);
  });

  test("contextPercent=null does NOT trigger compaction", () => {
    // Null means unknown — must not compact.
    const predicates = allActivePredicates();
    const action = decideNextAction(
      buildInput(predicates, {
        signals: { contextPercent: null, quotaHit: false },
      }),
    );
    expect(action).not.toBe(AutoAction.COMPACT_THEN_REDRIVE);
  });

  test("contextPercent=0 does NOT compact", () => {
    const predicates = allActivePredicates();
    const action = decideNextAction(
      buildInput(predicates, {
        signals: { contextPercent: 0, quotaHit: false },
      }),
    );
    expect(action).not.toBe(AutoAction.COMPACT_THEN_REDRIVE);
  });

  test("COMPACT_THRESHOLD constant is 0.80", () => {
    expect(COMPACT_THRESHOLD).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// Rule 6: STOP_NO_PROGRESS (no-progress predicate equality)
// ---------------------------------------------------------------------------

describe("decideNextAction — rule 6: STOP_NO_PROGRESS (predicate stall)", () => {
  const stablePredicates: DerivedPredicates = {
    ...SEED_DEFAULTS,
    pInvestigate: { value: true, items: ["D1", "D2"] },
    pPlan: { value: false, items: [] },
    pImplement: { value: false, items: [] },
    openQuestionGate: { value: false, items: [] },
  };

  test("(a) predicates unchanged across two cycles (prevAction != COMPACT) => STOP_NO_PROGRESS", () => {
    // iteration=1, prevPredicates identical, prevAction=REDRIVE -> no-progress fires.
    const action = decideNextAction(
      buildInput(stablePredicates, {
        runState: {
          iteration: 1,
          maxIterations: 25,
          prevPredicates: { ...stablePredicates },
          prevAction: AutoAction.REDRIVE,
        },
      }),
    );
    expect(action).toBe(AutoAction.STOP_NO_PROGRESS);
  });

  test("(b) IDENTICAL .value booleans but REORDERED items[] => treated as EQUAL => STOP_NO_PROGRESS", () => {
    // This fixture proves order-insensitivity: ["D2","D1"] vs ["D1","D2"].
    const prevPredicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D2", "D1"] }, // reversed order
      pPlan: { value: false, items: [] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    // stablePredicates has pInvestigate.items = ["D1", "D2"]; different order -> same SET.
    const action = decideNextAction(
      buildInput(stablePredicates, {
        runState: {
          iteration: 1,
          maxIterations: 25,
          prevPredicates,
          prevAction: AutoAction.REDRIVE,
        },
      }),
    );
    expect(action).toBe(AutoAction.STOP_NO_PROGRESS);
  });

  test("(c) cycle immediately AFTER compaction with unchanged predicates => NOT STOP_NO_PROGRESS", () => {
    // prevAction=COMPACT_THEN_REDRIVE suppresses the no-progress rule. Falls to REDRIVE.
    const action = decideNextAction(
      buildInput(stablePredicates, {
        runState: {
          iteration: 1,
          maxIterations: 25,
          prevPredicates: { ...stablePredicates },
          prevAction: AutoAction.COMPACT_THEN_REDRIVE,
        },
        signals: { contextPercent: null, quotaHit: false }, // context unknown post-compact
      }),
    );
    // Must NOT be STOP_NO_PROGRESS — falls through to REDRIVE (or COMPACT if context high).
    expect(action).not.toBe(AutoAction.STOP_NO_PROGRESS);
    expect(action).toBe(AutoAction.REDRIVE);
  });

  test("(c-variant) post-compaction with still-high context => COMPACT_THEN_REDRIVE again", () => {
    // prevAction=COMPACT but context is still above threshold -> compacts again.
    const action = decideNextAction(
      buildInput(stablePredicates, {
        runState: {
          iteration: 1,
          maxIterations: 25,
          prevPredicates: { ...stablePredicates },
          prevAction: AutoAction.COMPACT_THEN_REDRIVE,
        },
        signals: { contextPercent: 0.92, quotaHit: false },
      }),
    );
    expect(action).toBe(AutoAction.COMPACT_THEN_REDRIVE);
    expect(action).not.toBe(AutoAction.STOP_NO_PROGRESS);
  });

  test("first iteration (iteration=0) never triggers no-progress even with prevPredicates set", () => {
    // Rule (6) requires iteration > 0 — iteration=0 must not fire no-progress.
    const action = decideNextAction(
      buildInput(stablePredicates, {
        runState: {
          iteration: 0,
          maxIterations: 25,
          prevPredicates: { ...stablePredicates },
          prevAction: null,
        },
      }),
    );
    expect(action).not.toBe(AutoAction.STOP_NO_PROGRESS);
  });

  test("changed items[] (different set) => NOT equal => no STOP_NO_PROGRESS", () => {
    const prevPredicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D1"] }, // only one item
      pPlan: { value: false, items: [] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    // stablePredicates has ["D1","D2"] — sets differ, so NOT equal -> falls to REDRIVE
    const action = decideNextAction(
      buildInput(stablePredicates, {
        runState: {
          iteration: 1,
          maxIterations: 25,
          prevPredicates,
          prevAction: AutoAction.REDRIVE,
        },
      }),
    );
    expect(action).toBe(AutoAction.REDRIVE);
  });
});

// ---------------------------------------------------------------------------
// Rule 7: REDRIVE (default)
// ---------------------------------------------------------------------------

describe("decideNextAction — rule 7: REDRIVE (default)", () => {
  test("no signals, not terminal, first iteration => REDRIVE", () => {
    const predicates = allActivePredicates();
    const action = decideNextAction(buildInput(predicates));
    expect(action).toBe(AutoAction.REDRIVE);
  });

  test("iteration=1 with different predicates => REDRIVE (progress made)", () => {
    const prevPredicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D1", "D2"] },
      pPlan: { value: true, items: ["G1"] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    // Current: D2 cleared from pInvestigate -> predicates differ -> REDRIVE.
    const currentPredicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D1"] },
      pPlan: { value: true, items: ["G1"] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    const action = decideNextAction(
      buildInput(currentPredicates, {
        runState: {
          iteration: 1,
          maxIterations: 25,
          prevPredicates,
          prevAction: AutoAction.REDRIVE,
        },
      }),
    );
    expect(action).toBe(AutoAction.REDRIVE);
  });
});

// ---------------------------------------------------------------------------
// All AutoAction values are asserted by at least one test above.
// Explicit coverage enumeration:
// ---------------------------------------------------------------------------

describe("AutoAction coverage: all values exercised", () => {
  // This test is informational — it fails if the enum is extended without tests.
  const covered = new Set([
    AutoAction.STOP_QUOTA,            // rule 1
    AutoAction.STOP_BLOCKED_ON_QUESTIONS, // rule 2
    AutoAction.STOP_DRAINED,          // rule 3
    AutoAction.STOP_NO_PROGRESS,      // rules 4 & 6
    AutoAction.COMPACT_THEN_REDRIVE,  // rule 5
    AutoAction.REDRIVE,               // rule 7
  ]);

  test("all six AutoAction values have at least one fixture", () => {
    const allValues = Object.values(AutoAction);
    for (const v of allValues) {
      expect(covered.has(v)).toBe(true);
    }
    // Exactly six values.
    expect(allValues.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// predicatesEqual — canonical no-progress equality
// ---------------------------------------------------------------------------

describe("predicatesEqual", () => {
  const base: DerivedPredicates = {
    ...SEED_DEFAULTS,
    pInvestigate: { value: true, items: ["D1", "D2"] },
    pPlan: { value: false, items: [] },
    pImplement: { value: true, items: ["T10"] },
    openQuestionGate: { value: false, items: [] },
  };

  test("null a => false", () => {
    expect(predicatesEqual(null, base)).toBe(false);
  });

  test("identical objects => true", () => {
    expect(predicatesEqual(base, { ...base })).toBe(true);
  });

  test("deep-equal clones => true", () => {
    const clone: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D1", "D2"] },
      pPlan: { value: false, items: [] },
      pImplement: { value: true, items: ["T10"] },
      openQuestionGate: { value: false, items: [] },
    };
    expect(predicatesEqual(base, clone)).toBe(true);
  });

  test("reordered items[] => true (order-insensitive set equality)", () => {
    const reordered: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D2", "D1"] }, // reversed
      pPlan: { value: false, items: [] },
      pImplement: { value: true, items: ["T10"] },
      openQuestionGate: { value: false, items: [] },
    };
    expect(predicatesEqual(base, reordered)).toBe(true);
  });

  test("different value boolean => false", () => {
    const different: DerivedPredicates = {
      ...base,
      pPlan: { value: true, items: ["G1"] }, // was false
    };
    expect(predicatesEqual(base, different)).toBe(false);
  });

  test("different items (different set) => false", () => {
    const different: DerivedPredicates = {
      ...base,
      pInvestigate: { value: true, items: ["D1", "D3"] }, // D3 instead of D2
    };
    expect(predicatesEqual(base, different)).toBe(false);
  });

  test("different items count => false", () => {
    const different: DerivedPredicates = {
      ...base,
      pInvestigate: { value: true, items: ["D1"] }, // only one item
    };
    expect(predicatesEqual(base, different)).toBe(false);
  });

  test("openQuestionGate value differs => false", () => {
    const different: DerivedPredicates = {
      ...base,
      openQuestionGate: { value: true, items: ["Q1"] },
    };
    expect(predicatesEqual(base, different)).toBe(false);
  });

  test("all empty => equal", () => {
    const e1 = emptyPredicates();
    const e2 = emptyPredicates();
    expect(predicatesEqual(e1, e2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// composeRedrivePrompt
// ---------------------------------------------------------------------------

describe("composeRedrivePrompt", () => {
  test("returns early message when terminal predicate is already satisfied", () => {
    const predicates = emptyPredicates();
    const msg = composeRedrivePrompt(predicates, advanceAutoPreset.terminalPredicate);
    expect(msg).toContain("already satisfied");
    expect(msg).toContain("STOP_DRAINED");
  });

  test("mentions the still-violated predicate id(s) — advance preset: pInvestigate violated", () => {
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D99"] },
      pPlan: { value: false, items: [] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    const msg = composeRedrivePrompt(predicates, advanceAutoPreset.terminalPredicate);
    expect(msg).toContain("pInvestigate");
    expect(msg).toContain("D99");
    // Should NOT mention drained predicates.
    expect(msg).not.toContain("pPlan");
    expect(msg).not.toContain("pImplement");
  });

  test("mentions exactly the still-violated predicate ids — plan preset: pPlan violated", () => {
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: false, items: [] },
      pPlan: { value: true, items: ["G42"] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    const msg = composeRedrivePrompt(predicates, planAutoPreset.terminalPredicate);
    expect(msg).toContain("pPlan");
    expect(msg).toContain("G42");
    // pInvestigate and pImplement are not violated for plan preset.
    expect(msg).not.toContain("pInvestigate");
    expect(msg).not.toContain("pImplement");
  });

  test("mentions exactly the still-violated predicate ids — investigate preset: pInvestigate violated", () => {
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D7"] },
      pPlan: { value: false, items: [] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    const msg = composeRedrivePrompt(predicates, investigateAutoPreset.terminalPredicate);
    expect(msg).toContain("pInvestigate");
    expect(msg).toContain("D7");
  });

  test("mentions exactly the still-violated predicate ids — implement preset: pImplement violated", () => {
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: false, items: [] },
      pPlan: { value: false, items: [] },
      pImplement: { value: true, items: ["T55"] },
      openQuestionGate: { value: false, items: [] },
    };
    const msg = composeRedrivePrompt(predicates, implementAutoPreset.terminalPredicate);
    expect(msg).toContain("pImplement");
    expect(msg).toContain("T55");
  });

  test("advance preset with multiple violated predicates: all mentioned", () => {
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D1"] },
      pPlan: { value: true, items: ["G2"] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    const msg = composeRedrivePrompt(predicates, advanceAutoPreset.terminalPredicate);
    expect(msg).toContain("pInvestigate");
    expect(msg).toContain("D1");
    expect(msg).toContain("pPlan");
    expect(msg).toContain("G2");
  });

  test("stage predicate TRUE with no items => '(no specific items reported)'", () => {
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: [] }, // true but no item ids
      pPlan: { value: false, items: [] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    const msg = composeRedrivePrompt(predicates, advanceAutoPreset.terminalPredicate);
    expect(msg).toContain("(no specific items reported)");
  });

  test("prompt contains instruction to re-drive", () => {
    const predicates: DerivedPredicates = {
      ...SEED_DEFAULTS,
      pInvestigate: { value: true, items: ["D5"] },
      pPlan: { value: false, items: [] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    };
    const msg = composeRedrivePrompt(predicates, advanceAutoPreset.terminalPredicate);
    // Should instruct orchestrator to re-drive.
    expect(msg.toLowerCase()).toContain("re-drive");
  });
});
