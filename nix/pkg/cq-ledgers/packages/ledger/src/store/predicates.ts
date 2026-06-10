/**
 * Shared flow-detection predicates (T361 / G44, fixes D50).
 *
 * The SINGLE SOURCE OF TRUTH for the `/cq:advance` flow's three detection
 * predicates — P-investigate, P-plan, P-implement — plus the open-question
 * gate. Both `@cq/cli` and `@cq/ledger-mcp` import this so the flow's
 * actionability semantics are derived in exactly ONE place rather than
 * re-implemented per harness.
 *
 * Pure over the store's SYNCHRONOUS reads — no I/O, no MCP dependency. It
 * reads only `store.fetch(<ledgerId>)` (the in-memory resolved view) and
 * cross-references items' `fields.ledgerRefs`, mirroring the pure-helper style
 * of `assertHandoffInvariants` / `assertGoalPhasePreconditions` in `core.ts`.
 *
 * Semantics are taken VERBATIM from `nix/pkg/cq-assets/commands/cq/advance.md`
 * §Detection predicates:
 *  - P-investigate — an ACTIONABLE defect (open/wip/inconclusive) that is NOT
 *    solely blocked on an open linked question AND NOT owned by a goal in a
 *    movable planning phase (clarifying/planning).
 *  - P-plan — a goal in `clarifying` with NO open linked question, OR a goal in
 *    `planning`.
 *  - P-implement — a goal in `planned`/`building` with a DAG-READY non-terminal
 *    task: status non-terminal and not `blocked`; every task in its `dependsOn`
 *    is `done`; its milestone's `dependsOn` milestones are satisfied (all their
 *    tasks terminal); and no linked open question.
 *  - openQuestionGate — the open `questions` items gating the above.
 */

import type { Item } from "../types.js";
import {
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_LEDGER,
  QUESTIONS_LEDGER,
  TASKS_LEDGER,
} from "../constants.js";
import type { LedgerStore } from "./LedgerStore.js";

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
 * three mirror the `/cq:advance` cycle stages; `openQuestionGate` enumerates the
 * open questions that gate any of them.
 */
export interface DerivedPredicates {
  pInvestigate: PredicateVerdict;
  pPlan: PredicateVerdict;
  pImplement: PredicateVerdict;
  openQuestionGate: PredicateVerdict;
}

// --- lifecycle constants (mirror the schemas in constants.ts) --------------

/** Defect statuses that are ACTIONABLE by investigate-flow. */
const DEFECT_ACTIONABLE_STATUSES = new Set(["open", "wip", "inconclusive"]);
/** Goal phases that count as a MOVABLE planning phase. */
const GOAL_CLARIFYING_STATUS = "clarifying";
const GOAL_PLANNING_STATUS = "planning";
/** Goal phases in which implement-flow may build DAG-ready tasks. */
const GOAL_BUILDABLE_STATUSES = new Set(["planned", "building"]);
/** Status an `open` question carries. */
const QUESTION_OPEN_STATUS = "open";
/** Task statuses that are TERMINAL (per TASKS_SCHEMA). */
const TASK_TERMINAL_STATUSES = new Set(["done", "abandoned"]);
/** Task status that holds it OUT of the implement ready-set. */
const TASK_BLOCKED_STATUS = "blocked";
/** Task status meaning a dependency is satisfied. */
const TASK_DONE_STATUS = "done";

// --- store-read helpers ----------------------------------------------------

/**
 * Flatten every ACTIVE item of `ledgerId` out of the store's resolved view.
 * A ledger that is not registered yields no items (mirrors the
 * "undefined ledger → no linking items" precedent in core.ts), so a partial
 * store never throws here.
 */
function activeItems(store: LedgerStore, ledgerId: string): Item[] {
  let fetched;
  try {
    fetched = store.fetch(ledgerId);
  } catch {
    return [];
  }
  const out: Item[] = [];
  for (const group of fetched.milestones) {
    for (const item of group.items) out.push(item);
  }
  return out;
}

/** `item.fields[name]` as a string[] (empty when absent or non-array). */
function refList(item: Item, name: string): string[] {
  const value = item.fields[name];
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// derivePredicates
// ---------------------------------------------------------------------------

/**
 * Derive the flow's three detection predicates + the open-question gate from
 * the store's synchronous reads. Pure: no I/O beyond the in-memory
 * `store.fetch` reads, no MCP dependency.
 *
 * `items[]` on each verdict lists exactly the ids that make the predicate
 * TRUE-and-unblocked (so a verdict can name them); `openQuestionGate.items`
 * lists the open questions whose owning items would otherwise be actionable.
 */
export function derivePredicates(store: LedgerStore): DerivedPredicates {
  const defects = activeItems(store, DEFECTS_LEDGER);
  const goals = activeItems(store, GOALS_LEDGER);
  const tasks = activeItems(store, TASKS_LEDGER);
  const questions = activeItems(store, QUESTIONS_LEDGER);
  const milestones = activeItems(store, MILESTONES_LEDGER);

  // The open questions, indexed by the cross-ledger refs they carry, so a
  // single pass answers "is item X gated by an open question?".
  const openQuestions = questions.filter((q) => q.status === QUESTION_OPEN_STATUS);
  const openQuestionRefs = new Map<string, string[]>(); // ref -> question ids
  for (const q of openQuestions) {
    for (const ref of refList(q, "ledgerRefs")) {
      const list = openQuestionRefs.get(ref) ?? [];
      list.push(q.id);
      openQuestionRefs.set(ref, list);
    }
  }
  const gatingQuestionIds = new Set<string>();
  /** Open-question ids gating item `<ledger>:<id>`. */
  function questionsGating(ledger: string, id: string): string[] {
    return openQuestionRefs.get(`${ledger}:${id}`) ?? [];
  }

  // Goal phases (movable planning) used by P-investigate's ownership exclusion.
  const planningGoalIds = new Set(
    goals
      .filter((g) => g.status === GOAL_CLARIFYING_STATUS || g.status === GOAL_PLANNING_STATUS)
      .map((g) => g.id),
  );

  // --- P-investigate -------------------------------------------------------
  const investigateItems: string[] = [];
  for (const d of defects) {
    if (!DEFECT_ACTIONABLE_STATUSES.has(d.status)) continue;
    // Owned by a goal in a movable planning phase → plan-flow's to triage.
    const ownedByPlanningGoal = refList(d, "ledgerRefs").some((ref) => {
      if (!ref.startsWith(`${GOALS_LEDGER}:`)) return false;
      return planningGoalIds.has(ref.slice(GOALS_LEDGER.length + 1));
    });
    if (ownedByPlanningGoal) continue;
    // Blocked SOLELY on an open linked question → not actionable.
    const blockingQs = questionsGating(DEFECTS_LEDGER, d.id);
    if (blockingQs.length > 0) {
      for (const qid of blockingQs) gatingQuestionIds.add(qid);
      continue;
    }
    investigateItems.push(d.id);
  }

  // --- P-plan --------------------------------------------------------------
  const planItems: string[] = [];
  for (const g of goals) {
    if (g.status === GOAL_PLANNING_STATUS) {
      planItems.push(g.id);
      continue;
    }
    if (g.status === GOAL_CLARIFYING_STATUS) {
      const blockingQs = questionsGating(GOALS_LEDGER, g.id);
      if (blockingQs.length > 0) {
        for (const qid of blockingQs) gatingQuestionIds.add(qid);
        continue;
      }
      planItems.push(g.id);
    }
  }

  // --- P-implement ---------------------------------------------------------
  // Lookup tables P-implement needs:
  //  - task by id (for dependsOn resolution);
  //  - tasks grouped by milestone (for milestone-dependsOn satisfaction);
  //  - milestone dependsOn (from the milestones-ledger item fields).
  const taskById = new Map<string, Item>();
  for (const t of tasks) taskById.set(t.id, t);
  const tasksByMilestone = new Map<string, Item[]>();
  for (const t of tasks) {
    const list = tasksByMilestone.get(t.milestoneId) ?? [];
    list.push(t);
    tasksByMilestone.set(t.milestoneId, list);
  }
  const milestoneDependsOn = new Map<string, string[]>();
  for (const m of milestones) milestoneDependsOn.set(m.id, refList(m, "dependsOn"));

  /** A milestone is satisfied when every task under it is terminal. */
  function milestoneSatisfied(milestoneId: string): boolean {
    const ts = tasksByMilestone.get(milestoneId) ?? [];
    return ts.every((t) => TASK_TERMINAL_STATUSES.has(t.status));
  }

  const buildableGoalIds = new Set(
    goals.filter((g) => GOAL_BUILDABLE_STATUSES.has(g.status)).map((g) => g.id),
  );
  const implementItems: string[] = [];
  for (const t of tasks) {
    // Belongs to a goal in planned/building?
    const ownedByBuildableGoal = refList(t, "ledgerRefs").some((ref) => {
      if (!ref.startsWith(`${GOALS_LEDGER}:`)) return false;
      return buildableGoalIds.has(ref.slice(GOALS_LEDGER.length + 1));
    });
    if (!ownedByBuildableGoal) continue;
    // Non-terminal and NOT blocked.
    if (TASK_TERMINAL_STATUSES.has(t.status) || t.status === TASK_BLOCKED_STATUS) continue;
    // Every task in its dependsOn is done.
    const depsReady = refList(t, "dependsOn").every((depId) => {
      const dep = taskById.get(depId);
      // A dependency on a task that is no longer active (e.g. archived) is
      // treated as satisfied — an unknown id never holds a task back.
      return dep === undefined || dep.status === TASK_DONE_STATUS;
    });
    if (!depsReady) continue;
    // Its milestone's dependsOn milestones are satisfied.
    const milestoneDeps = milestoneDependsOn.get(t.milestoneId) ?? [];
    if (!milestoneDeps.every((depMid) => milestoneSatisfied(depMid))) continue;
    // No linked open question.
    const blockingQs = questionsGating(TASKS_LEDGER, t.id);
    if (blockingQs.length > 0) {
      for (const qid of blockingQs) gatingQuestionIds.add(qid);
      continue;
    }
    implementItems.push(t.id);
  }

  return {
    pInvestigate: { value: investigateItems.length > 0, items: investigateItems },
    pPlan: { value: planItems.length > 0, items: planItems },
    pImplement: { value: implementItems.length > 0, items: implementItems },
    openQuestionGate: {
      value: gatingQuestionIds.size > 0,
      items: [...gatingQuestionIds],
    },
  };
}
