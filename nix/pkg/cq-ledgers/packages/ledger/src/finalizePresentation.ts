/**
 * Browser-safe presentation contract for Finalize previews. It deliberately
 * only describes already-computed plans: predicate and executor semantics
 * remain in `finalize.ts`.
 */

import { SKIP_NON_TERMINAL_ITEMS } from "./finalize.js";
import type { FinalizeSkippedEntry } from "./finalize.js";

export type FinalizeScope = "global" | "goals";

export interface FinalizePresentation {
  scope: FinalizeScope;
  caption: string;
}

/**
 * Scope-specific copy shared by the web and TUI Finalize previews. The global
 * scope keeps the existing all-ledger predicates intact; the goals scope
 * describes the separate selected-goal operation graph.
 */
export const FINALIZE_PRESENTATION: Record<FinalizeScope, FinalizePresentation> = {
  global: {
    scope: "global",
    caption: "This is a store-wide milestone sweep across all ledgers.",
  },
  goals: {
    scope: "goals",
    caption:
      "This finalizes selected completed goals and their related work and coordination milestones; only milestones eligible under Q290 are archived.",
  },
};

/**
 * Explain why a plan with no actions has no executable entries. Structured
 * skip reasons remain exhaustive and unchanged; this derives only a summary.
 */
export function describeFinalizeEmptyPlan(skipped: readonly FinalizeSkippedEntry[]): string {
  const nonTerminalCount = skipped.filter(
    (entry) => entry.reason === SKIP_NON_TERMINAL_ITEMS,
  ).length;
  if (nonTerminalCount > 0) {
    const noun = nonTerminalCount === 1 ? "milestone" : "milestones";
    return `No actions are eligible: ${nonTerminalCount} ${noun} still have non-terminal items.`;
  }
  return "No actions are eligible for this Finalize operation.";
}
