/**
 * Shared flow-detection predicates (T361 / G44, fixes D50; P-seed T542 / G77 /
 * M240, fixes D94).
 *
 * The SINGLE SOURCE OF TRUTH for the `/cq:advance` flow's five detection
 * predicates — P-investigate, P-seed, P-plan, P-research, P-implement — plus the
 * open-question gate and the informational `belowFloor` companion. Both
 * `@cq/cli` and `@cq/ledger-mcp` import this so the flow's actionability
 * semantics are derived in exactly ONE place rather than re-implemented per
 * harness.
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
 *  - P-seed (Q259 option A, fixes D94) — a `root-caused` defect at/above the
 *    severity floor (critical/high, matched case-insensitively after trim) that
 *    is NOT owned by any LIVE goal (clarifying/planning/planned/building,
 *    bidirectionally: the defect's `ledgerRefs` naming a live `goals:<G>`, OR a
 *    live goal's `ledgerRefs`/`sourceRefs` naming this `defects:<D>`) AND NOT
 *    gated by an open linked question. This is the fix-owning gap: a root-caused
 *    defect owned by no clarifying/planning goal matched NONE of the other three
 *    predicates, so the flow falsely reported DRAINED.
 *  - P-plan — a goal in `clarifying` with NO open linked question, OR a goal in
 *    `planning`.
 *  - P-research (G80/M246, Q265/Q261) — a `researches` item in an ACTIONABLE
 *    status (open/wip/inconclusive, mirroring DEFECT_ACTIONABLE_STATUSES: an
 *    answered question can revive an inconclusive research) that is NOT gated
 *    solely by an open linked question (an open `questions` item whose
 *    `ledgerRefs` name `researches:<RS>`). Because RESEARCHES_SCHEMA declares
 *    `satisfiesDependencyStatuses ["concluded"]`, the dependency resolver
 *    separately gates research-dependent tasks in P-implement.
 *  - P-implement — a goal in `planned`/`building` with a DAG-READY non-terminal
 *    task: status non-terminal and not `blocked`; every entry in its `dependsOn`
 *    is SATISFIED (see the dependency-resolution spec below); its milestone's
 *    `dependsOn` milestones are satisfied (all their tasks terminal); and no
 *    linked open question.
 *  - openQuestionGate — the open `questions` items gating the above.
 *
 * Dependency-resolution spec (G80/M245, read-side of the `<ledger>:<id>`
 * migration). Every `dependsOn` entry — on a TASK or on a milestone item — is
 * resolved through `refs.ts` and tolerates BOTH the legacy bare form ("T523")
 * and the canonical prefixed form ("tasks:T523"). A bare id resolves by its
 * exact alpha idPrefix against the store's prefix registry; a prefixed ref
 * names its ledger explicitly. An entry is SATISFIED when:
 *   - it does not parse as a ref at all (legacy free-text) — advisory, satisfied;
 *   - it resolves to a ledger/id with NO ACTIVE item (unknown or archived id,
 *     or an unregistered/unknown ledger) — the archived-never-strands leniency,
 *     satisfied;
 *   - it targets the `milestones` ledger (bare "M<n>" or "milestones:<M>") and
 *     that milestone's tasks are all terminal (the computed all-tasks-terminal
 *     rule, reusing `milestoneSatisfied` — milestones carry no fixed
 *     satisfies-status set);
 *   - otherwise, the resolved ACTIVE target item's status is in that ledger's
 *     SATISFY-DEPENDENCY status set. That set comes from the CANONICAL CONSTANT
 *     for a canonical ledger name (rule (a) in the `LedgerSchema` JSDoc —
 *     persisted schemas predate the field), else the persisted schema for a
 *     custom ledger; a ledger with NO `satisfiesDependencyStatuses` declaration
 *     falls back to its `terminalStatuses` (rule (b)).
 * An ACTIVE target in a non-satisfying status (including a terminal-but-
 * non-satisfying status such as a task's `abandoned` or a defect's `wontfix`)
 * does NOT satisfy — the dependent task stays out of the ready-set. The
 * resolver never throws: an unresolvable entry is treated as satisfied.
 *  - belowFloor — the SAME conditions as P-seed EXCEPT the severity is BELOW the
 *    floor (medium/low/unrecognized/empty). INFORMATIONAL only: it reports the
 *    root-caused defects that would seed a fix but for their sub-floor severity,
 *    and MUST NOT gate any stop (it never contributes to the open-question gate).
 */

import type { Item, LedgerSchema } from "../types.js";
import {
  CANONICAL_LEDGERS,
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_LEDGER,
  QUESTIONS_LEDGER,
  RESEARCHES_LEDGER,
  TASKS_LEDGER,
} from "../constants.js";
import { buildPrefixRegistry, canonicalizeRef, parseRef } from "../refs.js";
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
 * The flow-detection verdicts derived from one store snapshot. `pInvestigate`,
 * `pSeed`, `pPlan`, `pResearch`, and `pImplement` mirror the `/cq:advance` cycle
 * stages (in flow order); `openQuestionGate` enumerates the open questions that
 * gate any of them; `belowFloor` is an INFORMATIONAL companion to `pSeed`
 * (root-caused, unowned, un-gated defects whose severity is below the seed
 * floor) that MUST NOT gate any stop.
 */
export interface DerivedPredicates {
  pInvestigate: PredicateVerdict;
  pSeed: PredicateVerdict;
  pPlan: PredicateVerdict;
  pResearch: PredicateVerdict;
  pImplement: PredicateVerdict;
  openQuestionGate: PredicateVerdict;
  belowFloor: PredicateVerdict;
}

// --- lifecycle constants (mirror the schemas in constants.ts) --------------

/** Defect statuses that are ACTIONABLE by investigate-flow. */
const DEFECT_ACTIONABLE_STATUSES = new Set(["open", "wip", "inconclusive"]);
/**
 * Research statuses that are ACTIONABLE by research-flow (P-research). Mirrors
 * DEFECT_ACTIONABLE_STATUSES: `inconclusive` is re-openable, so an answered
 * question can revive an inconclusive research.
 */
const RESEARCH_ACTIONABLE_STATUSES = new Set(["open", "wip", "inconclusive"]);
/** The defect status that makes a defect a P-seed candidate (fix-owning gap). */
const DEFECT_SEED_STATUS = "root-caused";
/**
 * Severity floor for P-seed. DEFECTS_SCHEMA.severity is FREE-TEXT (not an enum),
 * so a defect qualifies iff `severity.trim().toLowerCase()` is in this set;
 * everything else (medium/low/unrecognized/empty) falls BELOW the floor.
 */
const SEED_SEVERITY_FLOOR = new Set(["critical", "high"]);
/**
 * Goal phases that count as LIVE for P-seed ownership: a defect owned by a goal
 * in any of these is that goal's to fix, so it is NOT an unowned seed.
 */
const GOAL_LIVE_STATUSES = new Set(["clarifying", "planning", "planned", "building"]);
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

/** `item.fields[name]` as a string (empty when absent or non-string). */
function stringField(item: Item, name: string): string {
  const value = item.fields[name];
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------
// derivePredicates
// ---------------------------------------------------------------------------

/**
 * Derive the flow's four detection predicates (P-investigate, P-seed, P-plan,
 * P-implement) + the open-question gate + the informational belowFloor
 * companion from the store's synchronous reads. Pure: no I/O beyond the
 * in-memory `store.fetch` reads, no MCP dependency.
 *
 * `items[]` on each verdict lists exactly the ids that make the predicate
 * TRUE-and-unblocked (so a verdict can name them); `openQuestionGate.items`
 * lists the open questions whose owning items would otherwise be actionable;
 * `belowFloor.items` lists sub-floor root-caused defects and gates NOTHING.
 */
export function derivePredicates(store: LedgerStore): DerivedPredicates {
  const defects = activeItems(store, DEFECTS_LEDGER);
  const goals = activeItems(store, GOALS_LEDGER);
  const tasks = activeItems(store, TASKS_LEDGER);
  const questions = activeItems(store, QUESTIONS_LEDGER);
  const milestones = activeItems(store, MILESTONES_LEDGER);
  const researches = activeItems(store, RESEARCHES_LEDGER);

  // --- dependency-resolution indexes (G80/M245), built ONCE up front --------
  // A single snapshot of every registered ledger: its active items keyed by id
  // (for target resolution) plus its SATISFY-DEPENDENCY status set. Building
  // these here keeps the resolver free of per-dep store round-trips.
  const ledgerNames = store.enumerate();
  const registry = buildPrefixRegistry(
    ledgerNames.map((name) => ({ name, schema: store.fetch(name).schema })),
  );
  const canonicalSchemaByName = new Map<string, LedgerSchema>(
    CANONICAL_LEDGERS.map((c) => [c.name, c.schema]),
  );
  const activeItemsByLedger = new Map<string, Map<string, Item>>();
  const satisfyingByLedger = new Map<string, Set<string>>();
  for (const name of ledgerNames) {
    const idIndex = new Map<string, Item>();
    for (const item of activeItems(store, name)) idIndex.set(item.id, item);
    activeItemsByLedger.set(name, idIndex);
    // Rule (a): a canonical ledger name reads the canonical CONSTANT's schema
    // (persisted schemas predate `satisfiesDependencyStatuses`); a custom
    // ledger reads its persisted schema. Rule (b): absent declaration falls
    // back to `terminalStatuses`.
    const schema = canonicalSchemaByName.get(name) ?? store.fetch(name).schema;
    satisfyingByLedger.set(
      name,
      new Set(schema.satisfiesDependencyStatuses ?? schema.terminalStatuses),
    );
  }

  /**
   * Resolve one raw `dependsOn` entry to its target `{ledger, id}`, tolerating
   * BOTH the bare ("T523") and prefixed ("tasks:T523") forms. Returns
   * `undefined` for any entry that does not parse as a ref OR whose bare alpha
   * prefix / prefixed ledger name is not registered — i.e. an advisory / legacy
   * free-text entry the caller treats as SATISFIED. Never throws.
   */
  function resolveRef(raw: string): { ledger: string; id: string } | undefined {
    let canonical: string;
    try {
      canonical = canonicalizeRef(raw, registry);
    } catch {
      return undefined;
    }
    const parsed = parseRef(canonical);
    // canonicalizeRef always yields the prefixed form; the bare branch is
    // unreachable but keeps the function total.
    if (parsed.kind !== "prefixed") return undefined;
    return { ledger: parsed.ledger, id: parsed.id };
  }

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

  // --- P-seed + belowFloor -------------------------------------------------
  // A P-seed is a root-caused defect at/above the severity floor that no LIVE
  // goal owns and no open question gates — the fix-owning gap D94. Ownership is
  // BIDIRECTIONAL: the defect's ledgerRefs naming a live goals:<G>, OR a live
  // goal's ledgerRefs/sourceRefs naming this defects:<D> (real investigate-seeded
  // goals carry only the goal-side link). belowFloor mirrors P-seed for
  // sub-floor severities and is INFORMATIONAL — it never feeds the stop gate.
  const liveGoalIds = new Set(
    goals.filter((g) => GOAL_LIVE_STATUSES.has(g.status)).map((g) => g.id),
  );
  // defects:<D> ids named by a LIVE goal's ledgerRefs/sourceRefs (goal-side link).
  const goalOwnedDefectIds = new Set<string>();
  for (const g of goals) {
    if (!GOAL_LIVE_STATUSES.has(g.status)) continue;
    for (const ref of [...refList(g, "ledgerRefs"), ...refList(g, "sourceRefs")]) {
      if (ref.startsWith(`${DEFECTS_LEDGER}:`)) {
        goalOwnedDefectIds.add(ref.slice(DEFECTS_LEDGER.length + 1));
      }
    }
  }

  const seedItems: string[] = [];
  const belowFloorItems: string[] = [];
  for (const d of defects) {
    if (d.status !== DEFECT_SEED_STATUS) continue;
    // Owned by a live goal, either direction → that goal's fix, not a seed.
    const ownedByLiveGoal =
      refList(d, "ledgerRefs").some((ref) => {
        if (!ref.startsWith(`${GOALS_LEDGER}:`)) return false;
        return liveGoalIds.has(ref.slice(GOALS_LEDGER.length + 1));
      }) || goalOwnedDefectIds.has(d.id);
    if (ownedByLiveGoal) continue;
    const atFloor = SEED_SEVERITY_FLOOR.has(stringField(d, "severity").trim().toLowerCase());
    // Gated by an open linked question (mirror P-investigate). ONLY a seed-
    // eligible (at-floor) candidate surfaces its question in the gate; a
    // below-floor defect is informational and must never introduce a stop gate.
    const blockingQs = questionsGating(DEFECTS_LEDGER, d.id);
    if (blockingQs.length > 0) {
      if (atFloor) for (const qid of blockingQs) gatingQuestionIds.add(qid);
      continue;
    }
    if (atFloor) seedItems.push(d.id);
    else belowFloorItems.push(d.id);
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

  // --- P-research ----------------------------------------------------------
  // A P-research is a `researches` item in an ACTIONABLE status that is not
  // gated solely by an open linked question (mirrors P-investigate's gating).
  // The T552 dependency resolver separately gates research-dependent tasks
  // (RESEARCHES_SCHEMA.satisfiesDependencyStatuses = ["concluded"]).
  const researchItems: string[] = [];
  for (const r of researches) {
    if (!RESEARCH_ACTIONABLE_STATUSES.has(r.status)) continue;
    const blockingQs = questionsGating(RESEARCHES_LEDGER, r.id);
    if (blockingQs.length > 0) {
      for (const qid of blockingQs) gatingQuestionIds.add(qid);
      continue;
    }
    researchItems.push(r.id);
  }

  // --- P-implement ---------------------------------------------------------
  // Lookup tables P-implement needs:
  //  - tasks grouped by milestone (for milestone-dependsOn satisfaction);
  //  - milestone dependsOn (raw entries from the milestones-ledger item fields,
  //    resolved through refs.ts at check time to tolerate both ref forms).
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

  /**
   * Is one raw `dependsOn` entry SATISFIED? Resolves the ref (both forms),
   * then applies the dependency-resolution spec in the module docblock:
   * unresolvable / free-text → satisfied; unknown-or-archived target (no active
   * item) → satisfied (archived-never-strands); a `milestones:<M>` / bare "M<n>"
   * target → the all-tasks-terminal rule; otherwise the ACTIVE target's status
   * must be in its ledger's satisfy-dependency set.
   */
  function dependencySatisfied(raw: string): boolean {
    const target = resolveRef(raw);
    if (target === undefined) return true; // free-text / unresolvable → advisory
    if (target.ledger === MILESTONES_LEDGER) return milestoneSatisfied(target.id);
    const item = activeItemsByLedger.get(target.ledger)?.get(target.id);
    if (item === undefined) return true; // unknown / archived → never strands
    return satisfyingByLedger.get(target.ledger)?.has(item.status) ?? false;
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
    // Every entry in its dependsOn is satisfied (both ref forms; cross-ledger).
    if (!refList(t, "dependsOn").every((raw) => dependencySatisfied(raw))) continue;
    // Its milestone's dependsOn milestones are satisfied. Milestone-item
    // dependsOn entries are resolved through refs.ts and keyed by the parsed
    // bare milestone id, so a prefixed "milestones:<M>" entry no longer misses
    // the tasksByMilestone lookup and vacuously passes.
    const milestoneDeps = milestoneDependsOn.get(t.milestoneId) ?? [];
    const milestoneDepsReady = milestoneDeps.every((raw) => {
      const target = resolveRef(raw);
      // Unresolvable milestone-dep entry → advisory, satisfied.
      return target === undefined || milestoneSatisfied(target.id);
    });
    if (!milestoneDepsReady) continue;
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
    pSeed: { value: seedItems.length > 0, items: seedItems },
    pPlan: { value: planItems.length > 0, items: planItems },
    pResearch: { value: researchItems.length > 0, items: researchItems },
    pImplement: { value: implementItems.length > 0, items: implementItems },
    openQuestionGate: {
      value: gatingQuestionIds.size > 0,
      items: [...gatingQuestionIds],
    },
    belowFloor: { value: belowFloorItems.length > 0, items: belowFloorItems },
  };
}
