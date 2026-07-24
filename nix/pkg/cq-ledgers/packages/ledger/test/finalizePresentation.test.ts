/**
 * T645 — Behavioral-Active, Blackbox-Atomic coverage for the shared Finalize
 * presentation contract. The frontends consume this contract in T646/T647.
 */

import { describe, expect, it } from "bun:test";
import {
  FINALIZE_PRESENTATION,
  describeFinalizeEmptyPlan,
} from "../src/index.js";
import { SKIP_NON_TERMINAL_ITEMS } from "../src/finalize.js";

describe("Finalize presentation", () => {
  it("distinguishes the store-wide sweep from the goals-aware action", () => {
    expect(FINALIZE_PRESENTATION.global.caption).toContain("all ledgers");
    expect(FINALIZE_PRESENTATION.global.caption).toContain("store-wide");

    expect(FINALIZE_PRESENTATION.goals.caption).toContain("selected completed goals");
    expect(FINALIZE_PRESENTATION.goals.caption).toContain("work and coordination milestones");
    expect(FINALIZE_PRESENTATION.goals.caption).toContain("Q290");
  });

  it("counts non-terminal blockers in an empty-plan explanation", () => {
    expect(
      describeFinalizeEmptyPlan([
        { id: "M1", reason: SKIP_NON_TERMINAL_ITEMS },
        { id: "M2", reason: SKIP_NON_TERMINAL_ITEMS, detail: "tasks:T2" },
        { id: "M3", reason: "ambient group" },
      ]),
    ).toBe("No actions are eligible: 2 milestones still have non-terminal items.");
  });

  it("returns a non-empty fallback when an empty plan has no non-terminal skips", () => {
    expect(describeFinalizeEmptyPlan([])).toBe("No actions are eligible for this Finalize operation.");
  });
});
