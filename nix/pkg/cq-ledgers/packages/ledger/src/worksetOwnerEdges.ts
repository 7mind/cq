/**
 * Exhaustive lifecycle-owner edge matrix (T1951 / G158).
 *
 * One total typed policy table keyed by owner ledger, owner status (goal
 * phase is the goal's status), and lifecycle creation kind. Every canonical
 * ledger has an allow or explicit-deny cell for every planning and
 * implementation creation kind. Edges always point owner→child or
 * node→prerequisite; advisory `ledgerRefs` never establish ownership.
 *
 * Library-managed ownership metadata lives on the child item under
 * {@link WORKSET_OWNER_REF_FIELD} / {@link WORKSET_OWNER_EDGE_KIND_FIELD}.
 * Generic create/update mutations refuse those fields; typed lifecycle
 * capabilities derive them from the selected owner.
 */

import {
  CANONICAL_LEDGERS,
  DECISIONS_LEDGER,
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  HANDOFFS_LEDGER,
  HYPOTHESIS_LEDGER,
  IDEAS_LEDGER,
  MILESTONES_LEDGER,
  QUESTIONS_LEDGER,
  RESEARCHES_LEDGER,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  UPSTREAM_LEDGER,
  WORKSET_OWNED_FIELD_NAMES,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
  WORKSET_OWNERSHIP_SCHEMA_FIELDS,
  type WorksetOwnedFieldName,
} from "./constants.js";
import type { FieldValue, Item } from "./types.js";
import { LedgerError } from "./types.js";

// Re-export sealed-field constants so callers can import from one module.
export {
  WORKSET_OWNED_FIELD_NAMES,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
  WORKSET_OWNERSHIP_SCHEMA_FIELDS,
  type WorksetOwnedFieldName,
};

// ---------------------------------------------------------------------------
// Creation inventories and edge kinds
// ---------------------------------------------------------------------------

/**
 * Lifecycle creation kinds authorised (or denied) during planning flows
 * (plan claim/publish/finalize, clarifying questions, plan review, research
 * triage, idea→goal bootstrap, defect→fix-goal bootstrap).
 */
export const PLANNING_LIFECYCLE_CREATION_KINDS = [
  "idea-to-goal",
  "active-current-draft",
  "finalized-manifest",
  "exact-gate-question",
  "review",
  "review-filed-defect",
  "research",
  "hypothesis",
  "decision",
  "handoff",
  "fix-goal",
] as const;

export type PlanningLifecycleCreationKind =
  (typeof PLANNING_LIFECYCLE_CREATION_KINDS)[number];

/**
 * Lifecycle creation kinds authorised (or denied) during implementation
 * flows (implement start/advance/review, investigation fix branches).
 */
export const IMPLEMENTATION_LIFECYCLE_CREATION_KINDS = [
  "exact-gate-question",
  "review",
  "implementation-defect",
  "research",
  "hypothesis",
  "handoff",
  "fix-goal",
] as const;

export type ImplementationLifecycleCreationKind =
  (typeof IMPLEMENTATION_LIFECYCLE_CREATION_KINDS)[number];

/** Union of both inventories — every policy cell is keyed by one of these. */
export type LifecycleCreationKind =
  | PlanningLifecycleCreationKind
  | ImplementationLifecycleCreationKind;

/**
 * Directed edge kinds used by workset closure. Every creation kind is also an
 * edge kind; `prerequisite` is closure-only (dependsOn/blockedBy toward
 * prerequisites) and never a lifecycle creation kind.
 */
export const WORKSET_OWNER_EDGE_KINDS = [
  "idea-to-goal",
  "active-current-draft",
  "finalized-manifest",
  "prerequisite",
  "exact-gate-question",
  "review",
  "review-filed-defect",
  "implementation-defect",
  "research",
  "hypothesis",
  "decision",
  "fix-goal",
  "handoff",
] as const;

export type WorksetOwnerEdgeKind = (typeof WORKSET_OWNER_EDGE_KINDS)[number];

export const LIFECYCLE_CREATION_KIND_SET: ReadonlySet<string> = new Set([
  ...PLANNING_LIFECYCLE_CREATION_KINDS,
  ...IMPLEMENTATION_LIFECYCLE_CREATION_KINDS,
]);

// ---------------------------------------------------------------------------
// Exclusions and policy rows
// ---------------------------------------------------------------------------

/**
 * Relations and states that never join a selected owner's closure, even when
 * a superficial reference exists.
 */
export const OWNER_EDGE_EXCLUSIONS = [
  "archived-or-inactive-owner",
  "ambiguous-legacy-ownership",
  "stale-draft",
  "superseded-review",
  "reverse-edge",
  "dependant",
  "sibling",
  "unrelated-reference",
  "ledger-refs-only",
] as const;

export type OwnerEdgeExclusion = (typeof OWNER_EDGE_EXCLUSIONS)[number];

const DEFAULT_ALLOW_EXCLUSIONS: readonly OwnerEdgeExclusion[] = OWNER_EDGE_EXCLUSIONS;

export type OwnerEdgeDirection = "owner-to-child";

export interface AllowedOwnerEdgeRow {
  readonly decision: "allow";
  readonly ownerLedger: string;
  /** Owner statuses that authorise this creation kind. */
  readonly ownerStatuses: readonly string[];
  readonly creationKind: LifecycleCreationKind;
  /** Edge kind recorded on the child; equals creationKind for all allow rows. */
  readonly edgeKind: WorksetOwnerEdgeKind;
  /** One or more child ledgers sealed under this owner edge (e.g. draft milestones+tasks). */
  readonly childLedgers: readonly string[];
  readonly direction: OwnerEdgeDirection;
  /**
   * Live children already sealed under this edge remain selected across
   * re-derivation while the owner stays selected (phase may advance).
   */
  readonly preservesLiveOwnedBranch: true;
  readonly exclusions: readonly OwnerEdgeExclusion[];
}

export interface DeniedOwnerEdgeRow {
  readonly decision: "deny";
  readonly ownerLedger: string;
  readonly creationKind: LifecycleCreationKind;
  readonly reason: string;
}

export type OwnerEdgePolicyRow = AllowedOwnerEdgeRow | DeniedOwnerEdgeRow;

export type OwnerEdgeResolution =
  | AllowedOwnerEdgeRow
  | {
      readonly decision: "deny";
      readonly ownerLedger: string;
      readonly creationKind: LifecycleCreationKind;
      readonly ownerStatus: string;
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Status sets per owner ledger
// ---------------------------------------------------------------------------

const IDEA_LIVE_STATUSES = ["open", "postponed"] as const;
const GOAL_DRAFT_PHASES = ["clarifying", "planning"] as const;
const GOAL_FINALIZED_PHASES = ["planned", "building"] as const;
const GOAL_LIVE_PHASES = [
  "clarifying",
  "planning",
  "planned",
  "building",
] as const;
const GOAL_PLANNING_DECISION_PHASES = [
  "clarifying",
  "planning",
  "planned",
] as const;
const DEFECT_LIVE_STATUSES = [
  "open",
  "wip",
  "root-caused",
  "inconclusive",
] as const;
const TASK_LIVE_STATUSES = ["planned", "wip", "blocked"] as const;
const RESEARCH_LIVE_STATUSES = ["open", "wip", "inconclusive"] as const;
const HYPOTHESIS_LIVE_STATUSES = ["open", "uncertain"] as const;
const REVIEW_LIVE_STATUSES = ["go-ahead", "revise"] as const;

function allow(row: {
  ownerLedger: string;
  ownerStatuses: readonly string[];
  creationKind: LifecycleCreationKind;
  childLedgers: readonly string[];
}): AllowedOwnerEdgeRow {
  if (row.childLedgers.length === 0) {
    throw new Error(`allow row for ${row.ownerLedger}/${row.creationKind} needs childLedgers`);
  }
  return {
    decision: "allow",
    ownerLedger: row.ownerLedger,
    ownerStatuses: row.ownerStatuses,
    creationKind: row.creationKind,
    edgeKind: row.creationKind,
    childLedgers: row.childLedgers,
    direction: "owner-to-child",
    preservesLiveOwnedBranch: true,
    exclusions: DEFAULT_ALLOW_EXCLUSIONS,
  };
}

/**
 * Explicit allow rows. Every other (canonical ledger × creation kind) cell is
 * an explicit deny via {@link DENIED_OWNER_EDGE_ROWS} / {@link resolveOwnerEdgePolicy}.
 * At most one allow row exists per (ownerLedger, creationKind).
 */
export const ALLOWED_OWNER_EDGE_ROWS: readonly AllowedOwnerEdgeRow[] = [
  // ideas → goal bootstrap
  allow({
    ownerLedger: IDEAS_LEDGER,
    ownerStatuses: IDEA_LIVE_STATUSES,
    creationKind: "idea-to-goal",
    childLedgers: [GOALS_LEDGER],
  }),

  // goals — phase-aware draft / finalized manifest
  allow({
    ownerLedger: GOALS_LEDGER,
    ownerStatuses: GOAL_DRAFT_PHASES,
    creationKind: "active-current-draft",
    childLedgers: [MILESTONES_LEDGER, TASKS_LEDGER],
  }),
  allow({
    ownerLedger: GOALS_LEDGER,
    ownerStatuses: GOAL_FINALIZED_PHASES,
    creationKind: "finalized-manifest",
    childLedgers: [MILESTONES_LEDGER, TASKS_LEDGER],
  }),
  allow({
    ownerLedger: GOALS_LEDGER,
    ownerStatuses: GOAL_LIVE_PHASES,
    creationKind: "exact-gate-question",
    childLedgers: [QUESTIONS_LEDGER],
  }),
  allow({
    ownerLedger: GOALS_LEDGER,
    ownerStatuses: GOAL_LIVE_PHASES,
    creationKind: "review",
    childLedgers: [REVIEWS_LEDGER],
  }),
  allow({
    ownerLedger: GOALS_LEDGER,
    ownerStatuses: GOAL_LIVE_PHASES,
    creationKind: "review-filed-defect",
    childLedgers: [DEFECTS_LEDGER],
  }),
  allow({
    ownerLedger: GOALS_LEDGER,
    ownerStatuses: GOAL_LIVE_PHASES,
    creationKind: "research",
    childLedgers: [RESEARCHES_LEDGER],
  }),
  allow({
    ownerLedger: GOALS_LEDGER,
    ownerStatuses: GOAL_PLANNING_DECISION_PHASES,
    creationKind: "decision",
    childLedgers: [DECISIONS_LEDGER],
  }),
  allow({
    ownerLedger: GOALS_LEDGER,
    ownerStatuses: GOAL_LIVE_PHASES,
    creationKind: "handoff",
    childLedgers: [HANDOFFS_LEDGER],
  }),

  // defects — investigation / fix-goal bootstrap
  allow({
    ownerLedger: DEFECTS_LEDGER,
    ownerStatuses: DEFECT_LIVE_STATUSES,
    creationKind: "fix-goal",
    childLedgers: [GOALS_LEDGER],
  }),
  allow({
    ownerLedger: DEFECTS_LEDGER,
    ownerStatuses: DEFECT_LIVE_STATUSES,
    creationKind: "research",
    childLedgers: [RESEARCHES_LEDGER],
  }),
  allow({
    ownerLedger: DEFECTS_LEDGER,
    ownerStatuses: DEFECT_LIVE_STATUSES,
    creationKind: "hypothesis",
    childLedgers: [HYPOTHESIS_LEDGER],
  }),
  allow({
    ownerLedger: DEFECTS_LEDGER,
    ownerStatuses: DEFECT_LIVE_STATUSES,
    creationKind: "exact-gate-question",
    childLedgers: [QUESTIONS_LEDGER],
  }),
  allow({
    ownerLedger: DEFECTS_LEDGER,
    ownerStatuses: DEFECT_LIVE_STATUSES,
    creationKind: "handoff",
    childLedgers: [HANDOFFS_LEDGER],
  }),

  // researches — hypothesis tree + gates
  allow({
    ownerLedger: RESEARCHES_LEDGER,
    ownerStatuses: RESEARCH_LIVE_STATUSES,
    creationKind: "hypothesis",
    childLedgers: [HYPOTHESIS_LEDGER],
  }),
  allow({
    ownerLedger: RESEARCHES_LEDGER,
    ownerStatuses: RESEARCH_LIVE_STATUSES,
    creationKind: "exact-gate-question",
    childLedgers: [QUESTIONS_LEDGER],
  }),
  allow({
    ownerLedger: RESEARCHES_LEDGER,
    ownerStatuses: RESEARCH_LIVE_STATUSES,
    creationKind: "handoff",
    childLedgers: [HANDOFFS_LEDGER],
  }),

  // hypotheses — nested hypothesis children + gates
  allow({
    ownerLedger: HYPOTHESIS_LEDGER,
    ownerStatuses: HYPOTHESIS_LIVE_STATUSES,
    creationKind: "hypothesis",
    childLedgers: [HYPOTHESIS_LEDGER],
  }),
  allow({
    ownerLedger: HYPOTHESIS_LEDGER,
    ownerStatuses: HYPOTHESIS_LIVE_STATUSES,
    creationKind: "exact-gate-question",
    childLedgers: [QUESTIONS_LEDGER],
  }),

  // tasks — implementation-owned branches
  allow({
    ownerLedger: TASKS_LEDGER,
    ownerStatuses: TASK_LIVE_STATUSES,
    creationKind: "implementation-defect",
    childLedgers: [DEFECTS_LEDGER],
  }),
  allow({
    ownerLedger: TASKS_LEDGER,
    ownerStatuses: TASK_LIVE_STATUSES,
    creationKind: "review",
    childLedgers: [REVIEWS_LEDGER],
  }),
  allow({
    ownerLedger: TASKS_LEDGER,
    ownerStatuses: TASK_LIVE_STATUSES,
    creationKind: "exact-gate-question",
    childLedgers: [QUESTIONS_LEDGER],
  }),
  allow({
    ownerLedger: TASKS_LEDGER,
    ownerStatuses: TASK_LIVE_STATUSES,
    creationKind: "research",
    childLedgers: [RESEARCHES_LEDGER],
  }),
  allow({
    ownerLedger: TASKS_LEDGER,
    ownerStatuses: TASK_LIVE_STATUSES,
    creationKind: "handoff",
    childLedgers: [HANDOFFS_LEDGER],
  }),

  // reviews → review-filed defects (immutable verdict still owns its filings)
  allow({
    ownerLedger: REVIEWS_LEDGER,
    ownerStatuses: REVIEW_LIVE_STATUSES,
    creationKind: "review-filed-defect",
    childLedgers: [DEFECTS_LEDGER],
  }),
];

/** Deny reasons for owner ledgers that never authorise lifecycle creation. */
const OWNER_LEDGER_DENY_REASON: Readonly<Record<string, string>> = {
  [MILESTONES_LEDGER]:
    "milestones are never lifecycle owners; draft/manifest nodes are goal-owned and explicit milestone roots only expand live tasks in closure",
  [QUESTIONS_LEDGER]: "questions never own lifecycle children",
  [DECISIONS_LEDGER]: "decisions never own lifecycle children",
  [HANDOFFS_LEDGER]: "handoffs never own lifecycle children",
  [UPSTREAM_LEDGER]: "upstream records never own lifecycle children",
};

function defaultDenyReason(ownerLedger: string, creationKind: LifecycleCreationKind): string {
  const ledgerReason = OWNER_LEDGER_DENY_REASON[ownerLedger];
  if (ledgerReason !== undefined) return ledgerReason;
  return `${ownerLedger} does not authorise lifecycle creation kind ${creationKind}`;
}

/**
 * Explicit deny rows for every (canonical ledger × creation-kind) pair that
 * has no allow row. Status is not part of the deny key — wrong-status allows
 * resolve to deny at {@link resolveOwnerEdgePolicy} time.
 */
export const DENIED_OWNER_EDGE_ROWS: readonly DeniedOwnerEdgeRow[] = (() => {
  const allowedKeys = new Set(
    ALLOWED_OWNER_EDGE_ROWS.map((row) => `${row.ownerLedger}\0${row.creationKind}`),
  );
  const kinds = [
    ...PLANNING_LIFECYCLE_CREATION_KINDS,
    ...IMPLEMENTATION_LIFECYCLE_CREATION_KINDS.filter(
      (k) => !(PLANNING_LIFECYCLE_CREATION_KINDS as readonly string[]).includes(k),
    ),
  ];
  const rows: DeniedOwnerEdgeRow[] = [];
  for (const { name } of CANONICAL_LEDGERS) {
    for (const creationKind of kinds) {
      const key = `${name}\0${creationKind}`;
      if (allowedKeys.has(key)) continue;
      rows.push({
        decision: "deny",
        ownerLedger: name,
        creationKind,
        reason: defaultDenyReason(name, creationKind),
      });
    }
  }
  return rows;
})();

const ALLOWED_BY_OWNER_KIND = new Map<string, AllowedOwnerEdgeRow>();
for (const row of ALLOWED_OWNER_EDGE_ROWS) {
  const key = `${row.ownerLedger}\0${row.creationKind}`;
  if (ALLOWED_BY_OWNER_KIND.has(key)) {
    throw new Error(`duplicate allow row for ${row.ownerLedger}/${row.creationKind}`);
  }
  ALLOWED_BY_OWNER_KIND.set(key, row);
}

const DENY_BY_OWNER_KIND = new Map<string, DeniedOwnerEdgeRow>();
for (const row of DENIED_OWNER_EDGE_ROWS) {
  DENY_BY_OWNER_KIND.set(`${row.ownerLedger}\0${row.creationKind}`, row);
}

/**
 * Resolve the policy cell for one owner ledger + status + creation kind.
 * Total over every canonical ledger and both creation inventories.
 */
export function resolveOwnerEdgePolicy(input: {
  ownerLedger: string;
  ownerStatus: string;
  creationKind: LifecycleCreationKind;
}): OwnerEdgeResolution {
  const key = `${input.ownerLedger}\0${input.creationKind}`;
  const allowed = ALLOWED_BY_OWNER_KIND.get(key);
  if (allowed !== undefined) {
    if (allowed.ownerStatuses.includes(input.ownerStatus)) return allowed;
    return {
      decision: "deny",
      ownerLedger: input.ownerLedger,
      creationKind: input.creationKind,
      ownerStatus: input.ownerStatus,
      reason: `${input.ownerLedger} status ${input.ownerStatus} does not authorise ${input.creationKind}`,
    };
  }
  const denied = DENY_BY_OWNER_KIND.get(key);
  if (denied !== undefined) {
    return {
      decision: "deny",
      ownerLedger: denied.ownerLedger,
      creationKind: denied.creationKind,
      ownerStatus: input.ownerStatus,
      reason: denied.reason,
    };
  }
  // Non-canonical owner ledger — still total, always deny.
  return {
    decision: "deny",
    ownerLedger: input.ownerLedger,
    creationKind: input.creationKind,
    ownerStatus: input.ownerStatus,
    reason: defaultDenyReason(input.ownerLedger, input.creationKind),
  };
}

/**
 * Coverage cells used by exhaustiveness tests: one cell per
 * (canonical ledger × creation kind × inventory membership).
 */
export interface OwnerEdgeCoverageCell {
  readonly ownerLedger: string;
  readonly creationKind: LifecycleCreationKind;
  readonly inventory: "planning" | "implementation";
  /** Whether any status of this owner can allow this kind. */
  readonly hasAllowRow: boolean;
}

export function ownerEdgeCoverageCells(): readonly OwnerEdgeCoverageCell[] {
  const cells: OwnerEdgeCoverageCell[] = [];
  for (const { name } of CANONICAL_LEDGERS) {
    for (const creationKind of PLANNING_LIFECYCLE_CREATION_KINDS) {
      cells.push({
        ownerLedger: name,
        creationKind,
        inventory: "planning",
        hasAllowRow: ALLOWED_BY_OWNER_KIND.has(`${name}\0${creationKind}`),
      });
    }
    for (const creationKind of IMPLEMENTATION_LIFECYCLE_CREATION_KINDS) {
      cells.push({
        ownerLedger: name,
        creationKind,
        inventory: "implementation",
        hasAllowRow: ALLOWED_BY_OWNER_KIND.has(`${name}\0${creationKind}`),
      });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Ownership metadata helpers
// ---------------------------------------------------------------------------

export interface CanonicalOwnership {
  readonly ownerRef: string;
  readonly edgeKind: WorksetOwnerEdgeKind;
}

/**
 * Derive sealed ownership metadata from a selected owner and an allow row.
 * Typed lifecycle capabilities call this; generic mutations never do.
 */
export function deriveCanonicalOwnership(
  ownerLedger: string,
  ownerId: string,
  row: AllowedOwnerEdgeRow,
): CanonicalOwnership {
  if (row.ownerLedger !== ownerLedger) {
    throw new LedgerError(
      `ownership derivation owner ledger mismatch: selected ${ownerLedger}, row ${row.ownerLedger}`,
    );
  }
  return {
    ownerRef: `${ownerLedger}:${ownerId}`,
    edgeKind: row.edgeKind,
  };
}

export function ownershipFieldsFrom(
  ownership: CanonicalOwnership,
): Record<WorksetOwnedFieldName, string> {
  return {
    [WORKSET_OWNER_REF_FIELD]: ownership.ownerRef,
    [WORKSET_OWNER_EDGE_KIND_FIELD]: ownership.edgeKind,
  };
}

export function readCanonicalOwnership(item: Item): CanonicalOwnership | null {
  const ownerRef = item.fields[WORKSET_OWNER_REF_FIELD];
  const edgeKind = item.fields[WORKSET_OWNER_EDGE_KIND_FIELD];
  if (typeof ownerRef !== "string" || typeof edgeKind !== "string") return null;
  if (!(WORKSET_OWNER_EDGE_KINDS as readonly string[]).includes(edgeKind)) return null;
  if (!ownerRef.includes(":")) return null;
  return { ownerRef, edgeKind: edgeKind as WorksetOwnerEdgeKind };
}

/**
 * Advisory `ledgerRefs` never establish ownership — always returns null.
 * Kept as an explicit total function so call sites and tests cannot "forget"
 * the rule.
 */
export function ownershipFromLedgerRefs(
  _ledgerRefs: readonly string[] | undefined,
): null {
  return null;
}

/**
 * Legacy inference: only an already-sealed pair of owner fields counts.
 * Partial fields, ledgerRefs-only links, and conflicting signals are
 * ambiguous and yield null (fail closed — excluded from workset ownership).
 */
export function inferLegacyOwnership(item: Item): CanonicalOwnership | null {
  const ownerRef = item.fields[WORKSET_OWNER_REF_FIELD];
  const edgeKind = item.fields[WORKSET_OWNER_EDGE_KIND_FIELD];
  const hasRef = typeof ownerRef === "string" && ownerRef.includes(":");
  const hasKind =
    typeof edgeKind === "string" &&
    (WORKSET_OWNER_EDGE_KINDS as readonly string[]).includes(edgeKind);
  if (hasRef !== hasKind) return null; // partial = ambiguous
  if (!hasRef || !hasKind) {
    // ledgerRefs-only or no signal — never infer
    return null;
  }
  return {
    ownerRef: ownerRef as string,
    edgeKind: edgeKind as WorksetOwnerEdgeKind,
  };
}

export function isAmbiguousLegacyOwnership(item: Item): boolean {
  const ownerRef = item.fields[WORKSET_OWNER_REF_FIELD];
  const edgeKind = item.fields[WORKSET_OWNER_EDGE_KIND_FIELD];
  const hasRef = typeof ownerRef === "string" && ownerRef.length > 0;
  const hasKind = typeof edgeKind === "string" && edgeKind.length > 0;
  if (hasRef !== hasKind) return true;
  if (hasRef && hasKind) {
    return (
      !ownerRef.includes(":") ||
      !(WORKSET_OWNER_EDGE_KINDS as readonly string[]).includes(edgeKind as string)
    );
  }
  // ledgerRefs present without sealed fields is NOT ownership — not ambiguous,
  // simply non-owning.
  return false;
}

// ---------------------------------------------------------------------------
// Generic mutation fence
// ---------------------------------------------------------------------------

export class WorksetOwnershipFieldError extends LedgerError {
  readonly fieldName: string;
  constructor(fieldName: string, message?: string) {
    super(
      message ??
        `workset ownership field "${fieldName}" is library-managed and cannot be set via generic mutation`,
    );
    this.name = "WorksetOwnershipFieldError";
    this.fieldName = fieldName;
  }
}

/**
 * Refuse generic create/update inputs that attempt to set or change sealed
 * ownership metadata. Call from every generic mutation path.
 *
 * @param fields patch or create fields (may be undefined on field-less update)
 * @param existing current item on update; omit on create
 */
export function assertWorksetOwnershipFieldsAbsent(
  fields: Record<string, FieldValue> | undefined,
  existing?: Item,
): void {
  if (fields === undefined) return;
  for (const name of WORKSET_OWNED_FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(fields, name)) continue;
    const next = fields[name];
    if (existing === undefined) {
      // create: any presence is forbidden
      throw new WorksetOwnershipFieldError(name);
    }
    const prev = existing.fields[name];
    // update: setting, clearing, or changing is forbidden
    if (next !== prev) {
      throw new WorksetOwnershipFieldError(name);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture descriptors for allowed rows
// ---------------------------------------------------------------------------

export type OwnerEdgeRelation =
  | "positive"
  | "reverse"
  | "sibling"
  | "unrelated";

export interface OwnerEdgeFixture {
  readonly row: AllowedOwnerEdgeRow;
  readonly relation: OwnerEdgeRelation;
  /** Synthetic owner ref used by the fixture. */
  readonly ownerRef: string;
  /** Synthetic child ref that would carry sealed ownership on the positive path. */
  readonly childRef: string;
  /** Extra ref for sibling / unrelated negative cases. */
  readonly otherRef?: string;
  /**
   * Whether workset closure may include `childRef` under `ownerRef` for this
   * relation. Only `positive` is true.
   */
  readonly included: boolean;
}

function sampleId(ledger: string, n: number): string {
  const entry = CANONICAL_LEDGERS.find((c) => c.name === ledger);
  const prefix = entry?.schema.idPrefix ?? ledger.slice(0, 1).toUpperCase();
  return `${prefix}${n}`;
}

function sampleRef(ledger: string, n: number): string {
  return `${ledger}:${sampleId(ledger, n)}`;
}

/**
 * Build the required positive + reverse/sibling/unrelated negative fixtures
 * for one allow row. Multi-child rows emit one fixture quartet per child ledger.
 */
export function fixturesForAllowedRow(row: AllowedOwnerEdgeRow): readonly OwnerEdgeFixture[] {
  const ownerRef = sampleRef(row.ownerLedger, 1);
  const fixtures: OwnerEdgeFixture[] = [];
  for (const childLedger of row.childLedgers) {
    const childRef = sampleRef(childLedger, 1);
    const siblingChildRef = sampleRef(childLedger, 2);
    const unrelatedRef = sampleRef(
      childLedger === UPSTREAM_LEDGER ? TASKS_LEDGER : UPSTREAM_LEDGER,
      9,
    );
    fixtures.push(
      {
        row,
        relation: "positive",
        ownerRef,
        childRef,
        included: true,
      },
      {
        row,
        relation: "reverse",
        // Reverse edge: treat the child as "owner" and the owner as "child".
        ownerRef: childRef,
        childRef: ownerRef,
        included: false,
      },
      {
        row,
        relation: "sibling",
        ownerRef,
        childRef,
        otherRef: siblingChildRef,
        included: false,
      },
      {
        row,
        relation: "unrelated",
        ownerRef,
        childRef,
        otherRef: unrelatedRef,
        included: false,
      },
    );
  }
  return fixtures;
}

/**
 * Whether a fixture relation is admitted into the owner's closure.
 * Positive sealed owner→child only; reverse, sibling, and unrelated never.
 */
export function fixtureIncludedInOwnerClosure(fixture: OwnerEdgeFixture): boolean {
  if (fixture.relation !== "positive") return false;
  if (fixture.row.direction !== "owner-to-child") return false;
  return fixture.included;
}

/**
 * Prerequisite edges are node→prerequisite only. Dependants (reverse of
 * dependsOn/blockedBy) never join via the prerequisite edge kind.
 */
export const PREREQUISITE_EDGE = {
  edgeKind: "prerequisite" as const,
  direction: "node-to-prerequisite" as const,
  excludesDependants: true,
  excludesSiblings: true,
  excludesUnrelated: true,
} as const;
