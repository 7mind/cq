/**
 * Finalize-flow planning (G83): snapshot types + the two PURE eligibility
 * predicates behind `apply-done` and `archive` sweeps.
 *
 * Browser-safe like `refs.ts` / `constants.ts`: NO I/O, NO store imports —
 * only `./types.js` (types + the `LedgerError` base class) and the canonical
 * name constants from `./constants.js`. The web bundle imports this module
 * directly (cf. dagData.ts's `@cq/ledger/refs` precedent), so it must stay
 * free of server-only imports. The executor that APPLIES a computed plan is
 * added by a sibling task (T615) in this same file — keep additions pure or
 * dependency-injected.
 *
 * Semantics implemented here (design locks):
 *  - Q288 — a milestone is COMPLETE iff EVERY item of EVERY ledger grouped
 *    under it is terminal per that ledger's OWN `terminalStatuses`. This is
 *    deliberately NOT `store/predicates.ts`'s `milestoneSatisfied`, which is
 *    tasks-only.
 *  - Q289 — the apply-done plan closes ONLY goals whose status is `building`
 *    and whose `fields.milestones` (id[] work-milestone list, cf.
 *    GOAL_MILESTONES_FIELD) ALL resolve to complete milestones; every other
 *    goal lands in `skipped[]` with a machine-readable reason.
 *  - R722 — the ambient milestone (`M-AMBIENT`) is EXCLUDED from the
 *    apply-done plan (it is live and immortal — `BootstrapViolationError` on
 *    archive, and `transitions.done = []` makes a close irreversible), and so
 *    are EMPTY milestones (zero items across all ledgers — a fresh milestone
 *    is vacuously all-items-terminal and must NOT be swept to `done`). Both
 *    land in `skipped[]` with explicit reasons.
 *  - Q290 — the archive plan mirrors the store's `archiveMilestone`
 *    precondition (`AbstractLedgerStore.performArchive`) so a planned archive
 *    can never be rejected: every item of every participating ledger is
 *    terminal (phase 1) AND the milestone-item itself is terminal (phase 1b);
 *    the ambient milestone is excluded (the server refuses it anyway). Note
 *    the asymmetry with apply-done: an EMPTY milestone with a terminal status
 *    IS archivable — phase 1 passes vacuously on the server too.
 */

import { GOALS_LEDGER, MILESTONES_AMBIENT_ID, MILESTONES_LEDGER } from "./constants.js";
import { LedgerError } from "./types.js";
import type { FetchedLedger, FieldValue, Item, LedgerSchema } from "./types.js";

/**
 * The goals-ledger field carrying a goal's WORK-milestone ids (id[]; distinct
 * from the goal item's own coordination attachment to `M-AMBIENT`). Mirrors
 * the reader constant in ledger-web's App.tsx.
 */
export const GOAL_MILESTONES_FIELD = "milestones" as const;

/** The goals-ledger phase from which the apply-done plan may close a goal (Q289). */
export const GOAL_BUILDING_STATUS = "building" as const;

/**
 * The done-like status name preferred when a schema's `terminalStatuses`
 * offers more than one candidate.
 */
const DONE_STATUS = "done";

/** Thrown for a snapshot/schema that cannot support plan computation. */
export class FinalizePlanError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = "FinalizePlanError";
  }
}

/**
 * Pure input for the plan predicates: the `milestones` ledger view plus every
 * OTHER fetched ledger view, exactly as `fetch(ledgerId)` returns them. Each
 * `FetchedLedger` already carries its own `LedgerSchema` — the per-ledger
 * `terminalStatuses` the Q288 completeness rule reads.
 */
export interface FinalizeSnapshot {
  /** The `milestones` ledger view (`id === MILESTONES_LEDGER`). */
  milestones: FetchedLedger;
  /** Every other ledger's view (tasks, defects, goals, …). */
  ledgers: FetchedLedger[];
}

/**
 * Partition fetched views into a {@link FinalizeSnapshot}. Throws
 * `FinalizePlanError` when the milestones view is missing or duplicated —
 * fail-fast, no silent defaults.
 */
export function buildFinalizeSnapshot(views: Iterable<FetchedLedger>): FinalizeSnapshot {
  let milestones: FetchedLedger | undefined;
  const ledgers: FetchedLedger[] = [];
  for (const view of views) {
    if (view.id === MILESTONES_LEDGER) {
      if (milestones !== undefined) {
        throw new FinalizePlanError(`duplicate "${MILESTONES_LEDGER}" view in snapshot input`);
      }
      milestones = view;
    } else {
      ledgers.push(view);
    }
  }
  if (milestones === undefined) {
    throw new FinalizePlanError(`snapshot input is missing the "${MILESTONES_LEDGER}" view`);
  }
  return { milestones, ledgers };
}

/** What a plan entry does when executed (T615). */
export type FinalizeAction = "close-milestone" | "close-goal" | "archive-milestone";

/**
 * One actionable plan entry. `targetStatus` is present on the two `close-*`
 * actions (the status the executor writes) and absent on `archive-milestone`
 * (archiving is not a status write). Shaped for direct rendering by preview
 * UIs.
 */
export interface FinalizePlanEntry {
  id: string;
  action: FinalizeAction;
  targetStatus?: string;
}

/**
 * One skipped (not actionable) id with a machine-readable `reason` — always
 * one of the `SKIP_*` constants below — plus an optional human-oriented
 * `detail` (e.g. the offending item or milestone id).
 */
export interface FinalizeSkippedEntry {
  id: string;
  reason: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Machine-readable skip reasons. Stable strings — preview UIs and tests match
// on them verbatim.
// ---------------------------------------------------------------------------

/** R722: the immortal ambient/bootstrap milestone (`M-AMBIENT`). */
export const SKIP_AMBIENT_GROUP = "ambient group";
/** R722: zero items across all ledgers — vacuous completeness, never swept. */
export const SKIP_EMPTY_MILESTONE = "empty milestone";
/** Q288 failed: at least one grouped item is non-terminal (see `detail`). */
export const SKIP_NON_TERMINAL_ITEMS = "non-terminal items";
/** Milestone already carries a terminal status — nothing to close. */
export const SKIP_ALREADY_TERMINAL = "already terminal";
/** Archive only: the milestone-item's own status is not terminal (phase 1b). */
export const SKIP_MILESTONE_NOT_TERMINAL = "milestone status not terminal";
/** Q289: goal is not in the `building` phase (see `detail` for its status). */
export const SKIP_WRONG_PHASE = "wrong phase";
/** Q289: a listed work milestone is not complete (see `detail` for which). */
export const SKIP_INCOMPLETE_MILESTONE = "incomplete work milestone";
/** Q289: the goal's work-milestone list is absent or empty. */
export const SKIP_NO_MILESTONES = "no work milestones recorded";
/** Schema `transitions` map forbids the close (defensive; canonical schemas never hit it). */
export const SKIP_TRANSITION_FORBIDDEN = "transition not permitted";

/**
 * Result of a plan computation: `affected` carries the entries the executor
 * would apply IN ORDER (milestone closes before goal closes in the apply-done
 * plan); `skipped` accounts for every other candidate id, so a preview UI can
 * render a total explanation of the sweep.
 */
export interface FinalizePlan {
  affected: FinalizePlanEntry[];
  skipped: FinalizeSkippedEntry[];
}

/** All milestone-items of the milestones view (its groups' items, flattened). */
function milestoneItems(snapshot: FinalizeSnapshot): Item[] {
  return snapshot.milestones.milestones.flatMap((group) => group.items);
}

/** Per-milestone work summary across every non-milestones ledger. */
interface WorkSummary {
  /** Total items grouped under the milestone across all ledgers. */
  itemCount: number;
  /** Items whose status is NOT in their own ledger's `terminalStatuses`. */
  nonTerminalCount: number;
  /** First offending item, as `<ledger>:<id>` — for skip details. */
  firstNonTerminal: string | undefined;
}

function summarizeWork(snapshot: FinalizeSnapshot, milestoneId: string): WorkSummary {
  let itemCount = 0;
  let nonTerminalCount = 0;
  let firstNonTerminal: string | undefined;
  for (const ledger of snapshot.ledgers) {
    const group = ledger.milestones.find((g) => g.id === milestoneId);
    if (group === undefined) continue;
    const terminal = new Set(ledger.schema.terminalStatuses);
    for (const item of group.items) {
      itemCount += 1;
      if (!terminal.has(item.status)) {
        nonTerminalCount += 1;
        firstNonTerminal ??= `${ledger.id}:${item.id}`;
      }
    }
  }
  return { itemCount, nonTerminalCount, firstNonTerminal };
}

/**
 * The done-like terminal status of a schema: `"done"` when listed in
 * `terminalStatuses`, else the first (and in practice only) terminal status.
 * Throws `FinalizePlanError` for a schema with no terminal statuses.
 */
function doneLikeTerminal(schema: LedgerSchema, ledgerId: string): string {
  if (schema.terminalStatuses.includes(DONE_STATUS)) return DONE_STATUS;
  const first = schema.terminalStatuses[0];
  if (first === undefined) {
    throw new FinalizePlanError(`ledger "${ledgerId}" declares no terminalStatuses`);
  }
  return first;
}

/**
 * Whether the schema's F1 `transitions` guard permits `from → to`. An absent
 * map means no enforcement (matches the store); a status missing from a
 * present map has no outgoing transitions.
 */
function transitionPermitted(schema: LedgerSchema, from: string, to: string): boolean {
  if (schema.transitions === undefined) return true;
  return (schema.transitions[from] ?? []).includes(to);
}

/**
 * A goal's work-milestone ids, normalized: tolerates a scalar string value
 * (same tolerance as the App.tsx reader) and strips an explicit
 * `milestones:` ledger prefix from each entry.
 */
function goalWorkMilestoneIds(goal: Item): string[] {
  const raw: FieldValue | undefined = goal.fields[GOAL_MILESTONES_FIELD];
  const entries = Array.isArray(raw) ? raw : typeof raw === "string" && raw.length > 0 ? [raw] : [];
  const prefix = `${MILESTONES_LEDGER}:`;
  return entries.map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry));
}

/**
 * Compute the apply-done plan (Q288/Q289 + R722 exclusions).
 *
 * Affected entries, in execution order:
 *  1. `close-milestone` — every non-terminal, non-ambient, NON-EMPTY milestone
 *     whose grouped items are ALL terminal (Q288), closed to the milestones
 *     schema's done-like terminal status.
 *  2. `close-goal` — every `building` goal whose work milestones are all
 *     complete (Q289), closed to the goals schema's done-like terminal status.
 *
 * For goal gating, a work milestone counts as COMPLETE when it is a non-empty
 * all-items-terminal active milestone (whether or not its status is already
 * terminal) OR an already-ARCHIVED milestone (archiving presupposes full
 * terminality). An EMPTY active milestone does NOT complete a goal — no work
 * was recorded under it (same conservatism as the R722 sweep exclusion) — and
 * a dangling/unknown milestone id likewise gates the goal shut.
 *
 * Every non-affected candidate (milestone or goal) lands in `skipped` with a
 * `SKIP_*` reason, so `affected ∪ skipped` covers the whole snapshot.
 */
export function computeApplyDonePlan(snapshot: FinalizeSnapshot): FinalizePlan {
  const affected: FinalizePlanEntry[] = [];
  const skipped: FinalizeSkippedEntry[] = [];

  const msSchema = snapshot.milestones.schema;
  const msTerminal = new Set(msSchema.terminalStatuses);
  const msTarget = doneLikeTerminal(msSchema, snapshot.milestones.id);

  /** Milestone ids that count as complete for Q289 goal gating. */
  const completeForGoals = new Set<string>();
  for (const pointer of snapshot.milestones.archivePointers) {
    completeForGoals.add(pointer.id);
  }

  for (const item of milestoneItems(snapshot)) {
    if (item.id === MILESTONES_AMBIENT_ID) {
      skipped.push({ id: item.id, reason: SKIP_AMBIENT_GROUP });
      continue;
    }
    const work = summarizeWork(snapshot, item.id);
    if (work.itemCount === 0) {
      skipped.push({ id: item.id, reason: SKIP_EMPTY_MILESTONE });
      continue;
    }
    if (work.nonTerminalCount > 0) {
      const entry: FinalizeSkippedEntry = { id: item.id, reason: SKIP_NON_TERMINAL_ITEMS };
      if (work.firstNonTerminal !== undefined) entry.detail = work.firstNonTerminal;
      skipped.push(entry);
      continue;
    }
    completeForGoals.add(item.id);
    if (msTerminal.has(item.status)) {
      skipped.push({ id: item.id, reason: SKIP_ALREADY_TERMINAL, detail: item.status });
      continue;
    }
    if (!transitionPermitted(msSchema, item.status, msTarget)) {
      skipped.push({
        id: item.id,
        reason: SKIP_TRANSITION_FORBIDDEN,
        detail: `${item.status} -> ${msTarget}`,
      });
      continue;
    }
    affected.push({ id: item.id, action: "close-milestone", targetStatus: msTarget });
  }

  const goalsView = snapshot.ledgers.find((ledger) => ledger.id === GOALS_LEDGER);
  if (goalsView !== undefined) {
    const goalSchema = goalsView.schema;
    const goalTarget = doneLikeTerminal(goalSchema, goalsView.id);
    for (const goal of goalsView.milestones.flatMap((group) => group.items)) {
      if (goal.status !== GOAL_BUILDING_STATUS) {
        skipped.push({ id: goal.id, reason: SKIP_WRONG_PHASE, detail: goal.status });
        continue;
      }
      const workMilestones = goalWorkMilestoneIds(goal);
      if (workMilestones.length === 0) {
        skipped.push({ id: goal.id, reason: SKIP_NO_MILESTONES });
        continue;
      }
      const incomplete = workMilestones.find((id) => !completeForGoals.has(id));
      if (incomplete !== undefined) {
        skipped.push({ id: goal.id, reason: SKIP_INCOMPLETE_MILESTONE, detail: incomplete });
        continue;
      }
      if (!transitionPermitted(goalSchema, goal.status, goalTarget)) {
        skipped.push({
          id: goal.id,
          reason: SKIP_TRANSITION_FORBIDDEN,
          detail: `${goal.status} -> ${goalTarget}`,
        });
        continue;
      }
      affected.push({ id: goal.id, action: "close-goal", targetStatus: goalTarget });
    }
  }

  return { affected, skipped };
}

/**
 * Compute the archive plan (Q290): every non-archived, non-ambient milestone
 * whose grouped items across ALL ledgers are terminal AND whose OWN status is
 * terminal becomes an `archive-milestone` entry. This mirrors the server's
 * `performArchive` precondition exactly (phase 1: no non-terminal items in
 * any ledger, vacuous for an empty milestone; phase 1b: milestone-item
 * terminal; ambient refused with `BootstrapViolationError`), so a planned
 * archive can never be rejected. The bootstrap GROUP id ("active") never
 * appears here — it is a group, not a milestone-item, so the snapshot cannot
 * produce it as a candidate.
 */
export function computeArchivePlan(snapshot: FinalizeSnapshot): FinalizePlan {
  const affected: FinalizePlanEntry[] = [];
  const skipped: FinalizeSkippedEntry[] = [];

  const msTerminal = new Set(snapshot.milestones.schema.terminalStatuses);

  for (const item of milestoneItems(snapshot)) {
    if (item.id === MILESTONES_AMBIENT_ID) {
      skipped.push({ id: item.id, reason: SKIP_AMBIENT_GROUP });
      continue;
    }
    const work = summarizeWork(snapshot, item.id);
    if (work.nonTerminalCount > 0) {
      const entry: FinalizeSkippedEntry = { id: item.id, reason: SKIP_NON_TERMINAL_ITEMS };
      if (work.firstNonTerminal !== undefined) entry.detail = work.firstNonTerminal;
      skipped.push(entry);
      continue;
    }
    if (!msTerminal.has(item.status)) {
      skipped.push({ id: item.id, reason: SKIP_MILESTONE_NOT_TERMINAL, detail: item.status });
      continue;
    }
    affected.push({ id: item.id, action: "archive-milestone" });
  }

  return { affected, skipped };
}
