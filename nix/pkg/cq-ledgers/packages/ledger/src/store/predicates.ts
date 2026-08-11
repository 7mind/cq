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
 *    `planning`; in BOTH cases the goal must carry NO active plan claim (G99 /
 *    D134: an active claim means a planner already owns the goal's planning
 *    round — the goal is reported on the informational `planBusy` companion
 *    instead) AND NO active research wait (T848's `activePlanResearchWaits`)
 *    AND NO active task wait (T1267's `activePlanTaskWaits`).
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
 *    linked open question. ADDITIONALLY (G99 / D134 / H117, T853), when the
 *    owning goal is PROTOCOL-MANAGED (carries a `planGeneration` field), the
 *    task must ALSO be a member of the goal's FINALIZED manifest and the goal
 *    must carry NO active (follow-up) claim — draft, superseded, and
 *    off-manifest tasks (the Q337 duplicate-DAG leak) never execute. LEGACY
 *    goals (no `planGeneration`) follow their DECLARED `milestones` manifest
 *    when one is present (D166/T855: the write-side selection fence for
 *    concurrent legacy planning sessions — only the selected DAG is
 *    actionable); a legacy goal with NO declared `milestones` field keeps the
 *    pre-G99 goal-ref readiness rule verbatim.
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
 *  - goalDrift (G84 / D113) — a goal still at `planned` whose owned tasks (task
 *    `ledgerRefs` naming `goals:<G>`, the same ownership pattern P-implement
 *    reads) already show execution progress (`wip`/`done`). REPORT-ONLY, like
 *    belowFloor: it never participates in any stop condition.
 *  - planBusy (G99 / D134, T853) — a goal carrying an ACTIVE plan claim (the
 *    public `planActiveClaim` field is present, which the lifecycle maintains
 *    in lockstep with claim state: set at claim, cleared at release/finalize).
 *    Such goals are SUPPRESSED from P-plan (and their tasks from P-implement),
 *    so a second planner never picks up an owned planning round (the H117
 *    stale-writer race). REPORT-ONLY, like belowFloor/goalDrift: it never
 *    feeds the open-question gate and never participates in any stop
 *    condition.
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
import {
  PLAN_ACTIVE_CLAIM_FIELD,
  PLAN_FINALIZED_MANIFEST_FIELD,
  PLAN_GENERATION_FIELD,
  PlanPublishedManifestSchema,
  PLAN_WAITING_RESEARCHES_FIELD,
  PLAN_WAITING_TASKS_FIELD,
} from "../planLifecycle.js";
import { buildPrefixRegistry, canonicalizeRef, parseRef } from "../refs.js";
import type { LedgerStore } from "./LedgerStore.js";
import { operatorActionDirectiveForTask } from "../operatorActions.js";

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
  /** Parent-executed operator gates; these items never enter `pImplement`. */
  pOperatorAction: PredicateVerdict;
  openQuestionGate: PredicateVerdict;
  belowFloor: PredicateVerdict;
  /**
   * REPORT-ONLY busy signal (G99 / D134, T853): TRUE with the ids of goals
   * carrying an ACTIVE plan claim. An active claim suppresses the goal from
   * P-plan (a planner already owns its planning round) and its managed tasks
   * from P-implement. Like `belowFloor`/`goalDrift`, this signal NEVER
   * participates in any stop condition and never feeds the open-question
   * gate.
   */
  planBusy: PredicateVerdict;
  /**
   * REPORT-ONLY phase-drift signal (G84 / D113): TRUE with the ids of goals
   * still at `planned` whose owned tasks (task `ledgerRefs` naming
   * `goals:<G>`) already show execution progress (`wip`/`done`) — the goal's
   * phase lags its tasks. Like `belowFloor`, this signal NEVER participates
   * in any stop condition (it neither gates a stop nor feeds the
   * open-question gate). Known limitation: `derivePredicates` walks ACTIVE
   * items only, so a drifted goal whose milestone is already archived is
   * invisible to this signal — the one-time migration sweep covers those.
   */
  goalDrift: PredicateVerdict;
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
/** Goal phase that should NOT yet show task execution progress (goalDrift). */
const GOAL_PLANNED_STATUS = "planned";
/** Task statuses that count as EXECUTION PROGRESS for the goalDrift signal. */
const TASK_PROGRESS_STATUSES = new Set(["wip", "done"]);
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
type PredicateStoreReader = Pick<LedgerStore, "enumerate" | "fetch">;

function activeItems(store: PredicateStoreReader, ledgerId: string): Item[] {
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

/**
 * The single owner of research-wait status interpretation. Missing and
 * archived researches are absent from `activeResearches`, so they resume
 * planning along with the explicit concluded/abandoned terminal statuses.
 */
export function activePlanResearchWaits(
  goal: Item,
  activeResearches: readonly Item[],
): string[] {
  const raw = goal.fields[PLAN_WAITING_RESEARCHES_FIELD];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const byId = new Map(activeResearches.map((research) => [research.id, research]));
  const activeStatuses = new Set(["open", "wip", "inconclusive"]);
  return raw
    .map((ref) =>
      ref.startsWith(`${RESEARCHES_LEDGER}:`)
        ? ref.slice(RESEARCHES_LEDGER.length + 1)
        : ref,
    )
    .filter((id) => {
      const research = byId.get(id);
      return research !== undefined && activeStatuses.has(research.status);
    });
}

/**
 * The single owner of task-wait status interpretation (T1267 / D192).
 * planned/wip/blocked keep the wait active; done/abandoned satisfy it;
 * missing and archived tasks are absent from `activeTasks`, so they resume
 * planning the same way a deleted research wait does.
 */
export function activePlanTaskWaits(
  goal: Item,
  activeTasks: readonly Item[],
): string[] {
  const raw = goal.fields[PLAN_WAITING_TASKS_FIELD];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const byId = new Map(activeTasks.map((task) => [task.id, task]));
  const activeStatuses = new Set(["planned", "wip", "blocked"]);
  return raw
    .map((ref) =>
      ref.startsWith(`${TASKS_LEDGER}:`)
        ? ref.slice(TASKS_LEDGER.length + 1)
        : ref,
    )
    .filter((id) => {
      const task = byId.get(id);
      return task !== undefined && activeStatuses.has(task.status);
    });
}

/**
 * The goal's plan-lifecycle gate state, read tolerantly from the public plan
 * fields (T853 / G99). Field PRESENCE — not parseability — is the operative
 * signal, mirroring the write-side guards in planLifecycleGuards.ts: the
 * lifecycle keeps `planActiveClaim` in lockstep with claim state (set at
 * claim, deleted at release/finalize), so a present field means an ACTIVE
 * claim. A missing or corrupt finalized manifest yields a null task set,
 * which is FAIL-SAFE: a managed goal without a readable finalized manifest
 * authorizes no task start (the same posture the write-side fence takes).
 * Never throws — corrupt managed state suppresses rather than crashes.
 */
interface GoalPlanGate {
  /** The goal entered the guarded plan protocol (planGeneration present). */
  readonly managed: boolean;
  /** An active claim holds the goal (planActiveClaim present). */
  readonly claimActive: boolean;
  /** Task ids of the FINALIZED manifest; null when absent or unreadable. */
  readonly finalizedTaskIds: ReadonlySet<string> | null;
  /**
   * The LEGACY goal's DECLARED work-milestone manifest (`milestones` field),
   * with any `milestones:` prefix tolerated; null when the field is ABSENT.
   * A present-but-malformed value yields an EMPTY set — the same fail-safe
   * posture as the managed manifest: a declared selection authorizes only
   * its members (D166/T855).
   */
  readonly legacyMilestoneIds: ReadonlySet<string> | null;
}

function goalPlanGate(goal: Item): GoalPlanGate {
  const managed = goal.fields[PLAN_GENERATION_FIELD] !== undefined;
  const claimActive = goal.fields[PLAN_ACTIVE_CLAIM_FIELD] !== undefined;
  let finalizedTaskIds: ReadonlySet<string> | null = null;
  const rawManifest = goal.fields[PLAN_FINALIZED_MANIFEST_FIELD];
  if (typeof rawManifest === "string") {
    try {
      const manifest = PlanPublishedManifestSchema.parse(JSON.parse(rawManifest));
      finalizedTaskIds = new Set(manifest.tasks.map(({ id }) => id));
    } catch {
      finalizedTaskIds = null;
    }
  }
  const rawMilestones = goal.fields["milestones"];
  const legacyMilestoneIds =
    rawMilestones === undefined
      ? null
      : new Set(
          (Array.isArray(rawMilestones) ? rawMilestones : [])
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) =>
              entry.startsWith(`${MILESTONES_LEDGER}:`)
                ? entry.slice(MILESTONES_LEDGER.length + 1)
                : entry,
            ),
        );
  return { managed, claimActive, finalizedTaskIds, legacyMilestoneIds };
}

function buildTaskDependencyReadiness(
  store: PredicateStoreReader,
  tasks: readonly Item[],
  milestones: readonly Item[],
): (task: Item) => boolean {
  const ledgerNames = store.enumerate();
  const registry = buildPrefixRegistry(
    ledgerNames.map((name) => ({ name, schema: store.fetch(name).schema })),
  );
  const canonicalSchemaByName = new Map<string, LedgerSchema>(
    CANONICAL_LEDGERS.map((canonical) => [canonical.name, canonical.schema]),
  );
  const activeItemsByLedger = new Map<string, Map<string, Item>>();
  const satisfyingByLedger = new Map<string, Set<string>>();
  for (const name of ledgerNames) {
    const idIndex = new Map<string, Item>();
    for (const item of activeItems(store, name)) idIndex.set(item.id, item);
    activeItemsByLedger.set(name, idIndex);
    const schema = canonicalSchemaByName.get(name) ?? store.fetch(name).schema;
    satisfyingByLedger.set(
      name,
      new Set(schema.satisfiesDependencyStatuses ?? schema.terminalStatuses),
    );
  }

  function resolveRef(raw: string): { ledger: string; id: string } | undefined {
    let canonical: string;
    try {
      canonical = canonicalizeRef(raw, registry);
    } catch {
      return undefined;
    }
    const parsed = parseRef(canonical);
    if (parsed.kind !== "prefixed") return undefined;
    return { ledger: parsed.ledger, id: parsed.id };
  }

  const tasksByMilestone = new Map<string, Item[]>();
  for (const task of tasks) {
    const grouped = tasksByMilestone.get(task.milestoneId) ?? [];
    grouped.push(task);
    tasksByMilestone.set(task.milestoneId, grouped);
  }
  const milestoneDependsOn = new Map<string, string[]>();
  for (const milestone of milestones) {
    milestoneDependsOn.set(milestone.id, refList(milestone, "dependsOn"));
  }

  function milestoneSatisfied(milestoneId: string): boolean {
    const grouped = tasksByMilestone.get(milestoneId) ?? [];
    return grouped.every((task) => TASK_TERMINAL_STATUSES.has(task.status));
  }

  function dependencySatisfied(raw: string): boolean {
    const target = resolveRef(raw);
    if (target === undefined) return true;
    if (target.ledger === MILESTONES_LEDGER) return milestoneSatisfied(target.id);
    const item = activeItemsByLedger.get(target.ledger)?.get(target.id);
    if (item === undefined) return true;
    return satisfyingByLedger.get(target.ledger)?.has(item.status) ?? false;
  }

  return (task: Item): boolean => {
    if (!refList(task, "dependsOn").every((raw) => dependencySatisfied(raw))) {
      return false;
    }
    return (milestoneDependsOn.get(task.milestoneId) ?? []).every((raw) => {
      const target = resolveRef(raw);
      return target === undefined || milestoneSatisfied(target.id);
    });
  };
}

export function taskDependenciesSatisfied(
  store: PredicateStoreReader,
  task: Item,
): boolean {
  return buildTaskDependencyReadiness(
    store,
    activeItems(store, TASKS_LEDGER),
    activeItems(store, MILESTONES_LEDGER),
  )(task);
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

  // --- P-plan (+ planBusy) ---------------------------------------------------
  // A goal carrying an ACTIVE claim is BUSY: a planner already owns its
  // planning round (H117's stale-writer race is what the claim fence closes),
  // so it is suppressed from P-plan and reported on the report-only planBusy
  // companion instead.
  const planItems: string[] = [];
  const busyGoalIds: string[] = [];
  for (const g of goals) {
    if (goalPlanGate(g).claimActive) {
      busyGoalIds.push(g.id);
      continue;
    }
    if (activePlanResearchWaits(g, researches).length > 0) continue;
    if (activePlanTaskWaits(g, tasks).length > 0) continue;
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
  const dependenciesSatisfied = buildTaskDependencyReadiness(
    store,
    tasks,
    milestones,
  );

  const buildableGoalIds = new Set(
    goals.filter((g) => GOAL_BUILDABLE_STATUSES.has(g.status)).map((g) => g.id),
  );
  const goalsById = new Map(goals.map((g) => [g.id, g]));
  const planGatesByGoalId = new Map<string, GoalPlanGate>();
  function planGateFor(goalId: string): GoalPlanGate | undefined {
    let gate = planGatesByGoalId.get(goalId);
    if (gate === undefined) {
      const goal = goalsById.get(goalId);
      if (goal === undefined) return undefined;
      gate = goalPlanGate(goal);
      planGatesByGoalId.set(goalId, gate);
    }
    return gate;
  }
  const implementItems: string[] = [];
  const operatorActionItems: string[] = [];
  for (const t of tasks) {
    // Authorized by an owning goal? A goal authorizes its task iff ALL hold:
    //  - the goal is in planned/building;
    //  - the goal is LEGACY (no planGeneration) with NO declared `milestones`
    //    manifest (pre-G99 goal-ref readiness, verbatim) or with the task's
    //    milestone a MEMBER of the declared one (D166/T855: the loser's DAG
    //    of a concurrent legacy planning race never executes), OR
    //    PROTOCOL-MANAGED with NO active (follow-up) claim AND the task a
    //    member of the goal's FINALIZED manifest (draft, superseded, and
    //    off-manifest tasks — the Q337 duplicate-DAG leak — never execute).
    const authorized = refList(t, "ledgerRefs").some((ref) => {
      if (!ref.startsWith(`${GOALS_LEDGER}:`)) return false;
      const goalId = ref.slice(GOALS_LEDGER.length + 1);
      if (!buildableGoalIds.has(goalId)) return false;
      const gate = planGateFor(goalId);
      if (gate === undefined) return false;
      if (!gate.managed) {
        return (
          gate.legacyMilestoneIds === null || gate.legacyMilestoneIds.has(t.milestoneId)
        );
      }
      if (gate.claimActive) return false;
      return gate.finalizedTaskIds?.has(t.id) === true;
    });
    if (!authorized) continue;
    // Non-terminal and NOT blocked.
    if (TASK_TERMINAL_STATUSES.has(t.status) || t.status === TASK_BLOCKED_STATUS) continue;
    if (!dependenciesSatisfied(t)) continue;
    // No linked open question.
    const blockingQs = questionsGating(TASKS_LEDGER, t.id);
    if (blockingQs.length > 0) {
      for (const qid of blockingQs) gatingQuestionIds.add(qid);
      continue;
    }
    if (operatorActionDirectiveForTask(t) === null) implementItems.push(t.id);
    else operatorActionItems.push(t.id);
  }

  // --- goalDrift (REPORT-ONLY, G84 / D113) ----------------------------------
  // A goal still at `planned` whose owned tasks (task ledgerRefs `goals:<G>`,
  // the same ownership pattern P-implement reads above) already show execution
  // progress (wip/done). Purely informational — nothing below consults it for
  // gating, mirroring belowFloor. ACTIVE items only: a drifted goal under an
  // archived milestone is invisible here (the migration sweep covers those).
  const plannedGoalIds = new Set(
    goals.filter((g) => g.status === GOAL_PLANNED_STATUS).map((g) => g.id),
  );
  const driftedGoalIds = new Set<string>();
  for (const t of tasks) {
    if (!TASK_PROGRESS_STATUSES.has(t.status)) continue;
    for (const ref of refList(t, "ledgerRefs")) {
      if (!ref.startsWith(`${GOALS_LEDGER}:`)) continue;
      const goalId = ref.slice(GOALS_LEDGER.length + 1);
      if (plannedGoalIds.has(goalId)) driftedGoalIds.add(goalId);
    }
  }
  const goalDriftItems = [...driftedGoalIds];

  return {
    pInvestigate: { value: investigateItems.length > 0, items: investigateItems },
    pSeed: { value: seedItems.length > 0, items: seedItems },
    pPlan: { value: planItems.length > 0, items: planItems },
    pResearch: { value: researchItems.length > 0, items: researchItems },
    pImplement: { value: implementItems.length > 0, items: implementItems },
    pOperatorAction: {
      value: operatorActionItems.length > 0,
      items: operatorActionItems,
    },
    openQuestionGate: {
      value: gatingQuestionIds.size > 0,
      items: [...gatingQuestionIds],
    },
    belowFloor: { value: belowFloorItems.length > 0, items: belowFloorItems },
    planBusy: { value: busyGoalIds.length > 0, items: busyGoalIds },
    goalDrift: { value: goalDriftItems.length > 0, items: goalDriftItems },
  };
}
