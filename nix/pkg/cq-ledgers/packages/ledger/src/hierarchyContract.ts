/**
 * Placement, ownership, and archive-state contract (T2929 / G184).
 *
 * One executable policy for where every canonical ledger's items may live,
 * which parent a milestone has, and which archive/unarchive orders keep the
 * hierarchy resolvable. It is persistence-free: callers project their store
 * into a {@link HierarchySnapshot} and ask the contract for a verdict.
 *
 * The hierarchy is `goal → milestone → work item`:
 *
 * - Goals are always detached. Generic create, import, and restore reject a
 *   goal carrying any milestone attachment, real (`M<n>`) or synthetic
 *   (`M-AMBIENT`).
 * - Root ideas/defects/memories/upstream reports and planning coordination
 *   artifacts are detached.
 * - Work-scoped implementation artifacts may retain an explicitly supplied
 *   live work milestone; tasks require one.
 * - Every milestone has exactly one sealed `goals:<G>` parent. A defect never
 *   parents a milestone; it produces milestones only through a detached fix
 *   goal.
 * - Archival is child-before-parent; unarchive is parent-before-child. No
 *   active or archived state may hold a milestone parent that cannot be
 *   resolved, and no active child may sit under an archived parent.
 *
 * `goals.fields.milestones` and the coordination placement (`M-AMBIENT`) are
 * legacy migration inputs only ({@link HIERARCHY_LEGACY_MIGRATION_INPUTS}).
 */

import {
  DECISIONS_LEDGER,
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  HANDOFFS_LEDGER,
  HYPOTHESIS_LEDGER,
  IDEAS_LEDGER,
  MEMORIES_LEDGER,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  OPERATOR_ACTIONS_LEDGER,
  QUESTIONS_LEDGER,
  RESEARCHES_LEDGER,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  UPSTREAM_LEDGER,
} from "./constants.js";
import { GOAL_MILESTONES_FIELD } from "./finalize.js";
import type { FieldValue } from "./types.js";
import { LedgerError } from "./types.js";

// ---------------------------------------------------------------------------
// Placement vocabulary
// ---------------------------------------------------------------------------

/** Where an item lives: nowhere (detached) or inside one milestone. */
export type HierarchyPlacement =
  { readonly kind: "detached" } | { readonly kind: "milestone"; readonly milestoneId: string };

export const DETACHED_PLACEMENT: HierarchyPlacement = { kind: "detached" };

/**
 * Why an item exists. `root` items stand alone; `planning-coordination`
 * artifacts coordinate a goal's planning; `work-implementation` artifacts
 * belong to a work milestone's implementation.
 */
export const HIERARCHY_ARTIFACT_ROLES = [
  "root",
  "planning-coordination",
  "work-implementation",
] as const;

export type HierarchyArtifactRole = (typeof HIERARCHY_ARTIFACT_ROLES)[number];

/**
 * Per-ledger placement rule.
 *
 * - `milestone-node` — the ledger IS the milestone layer; each node has one
 *   sealed parent in `parentLedger`.
 * - `always-detached` — every item is detached, whatever its role.
 * - `requires-work-milestone` — every item lives in a real, live milestone.
 * - `role-scoped` — the item's role selects the rule: `root` and
 *   `planning-coordination` are detached; `work-implementation` is detached or
 *   in an explicitly supplied live work milestone.
 */
export type LedgerPlacementRule =
  | { readonly kind: "milestone-node"; readonly parentLedger: typeof GOALS_LEDGER }
  | { readonly kind: "always-detached"; readonly roles: readonly HierarchyArtifactRole[] }
  | { readonly kind: "requires-work-milestone"; readonly roles: readonly HierarchyArtifactRole[] }
  | { readonly kind: "role-scoped"; readonly roles: readonly HierarchyArtifactRole[] };

/**
 * The total per-ledger placement matrix. Every canonical ledger has exactly
 * one row; {@link resolveLedgerPlacementRule} rejects any other ledger.
 */
export const LEDGER_PLACEMENT_MATRIX: ReadonlyMap<string, LedgerPlacementRule> = new Map<
  string,
  LedgerPlacementRule
>([
  [MILESTONES_LEDGER, { kind: "milestone-node", parentLedger: GOALS_LEDGER }],
  [GOALS_LEDGER, { kind: "always-detached", roles: ["root"] }],
  [IDEAS_LEDGER, { kind: "always-detached", roles: ["root"] }],
  [MEMORIES_LEDGER, { kind: "always-detached", roles: ["root"] }],
  [UPSTREAM_LEDGER, { kind: "always-detached", roles: ["root"] }],
  [DECISIONS_LEDGER, { kind: "always-detached", roles: ["planning-coordination"] }],
  [TASKS_LEDGER, { kind: "requires-work-milestone", roles: ["work-implementation"] }],
  [
    DEFECTS_LEDGER,
    { kind: "role-scoped", roles: ["root", "planning-coordination", "work-implementation"] },
  ],
  [
    QUESTIONS_LEDGER,
    { kind: "role-scoped", roles: ["planning-coordination", "work-implementation"] },
  ],
  [
    REVIEWS_LEDGER,
    { kind: "role-scoped", roles: ["planning-coordination", "work-implementation"] },
  ],
  [
    HANDOFFS_LEDGER,
    { kind: "role-scoped", roles: ["planning-coordination", "work-implementation"] },
  ],
  [
    RESEARCHES_LEDGER,
    { kind: "role-scoped", roles: ["planning-coordination", "work-implementation"] },
  ],
  [
    HYPOTHESIS_LEDGER,
    { kind: "role-scoped", roles: ["planning-coordination", "work-implementation"] },
  ],
  [OPERATOR_ACTIONS_LEDGER, { kind: "role-scoped", roles: ["work-implementation"] }],
]);

/**
 * Inputs that only a legacy migration may read. Generic writers never author
 * them and the contract never derives placement from them.
 */
export const HIERARCHY_LEGACY_MIGRATION_INPUTS = [
  { kind: "goal-milestones-field", ledger: GOALS_LEDGER, field: GOAL_MILESTONES_FIELD },
  { kind: "coordination-placement", milestoneId: MILESTONES_AMBIENT_ID },
] as const;

/** Generic write paths that must honour the placement matrix. */
export const HIERARCHY_WRITE_OPERATIONS = ["create", "import", "restore"] as const;

export type HierarchyWriteOperation = (typeof HIERARCHY_WRITE_OPERATIONS)[number];

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

export const HIERARCHY_VIOLATION_CODES = [
  "non-canonical-ledger",
  "role-not-permitted",
  "attached-goal",
  "synthetic-placement",
  "detached-required",
  "work-milestone-required",
  "legacy-goal-milestones-field",
  "milestone-not-live",
  "milestone-parent-missing",
  "milestone-parent-not-goal",
  "milestone-parent-unresolved",
  "item-milestone-unresolved",
  "active-child-of-archived-parent",
  "archive-with-active-children",
  "unarchive-under-archived-parent",
  "node-not-found",
  "node-already-in-state",
] as const;

export type HierarchyViolationCode = (typeof HIERARCHY_VIOLATION_CODES)[number];

export interface HierarchyViolation {
  readonly code: HierarchyViolationCode;
  /** Canonical `<ledger>:<id>` of the offending node. */
  readonly ref: string;
  readonly detail: string;
}

export type HierarchyVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly HierarchyViolation[] };

export class HierarchyContractError extends LedgerError {
  readonly violations: readonly HierarchyViolation[];

  constructor(violations: readonly HierarchyViolation[]) {
    super(
      `hierarchy contract violated: ${violations
        .map((v) => `${v.code} ${v.ref} (${v.detail})`)
        .join("; ")}`,
    );
    this.name = "HierarchyContractError";
    this.violations = violations;
  }
}

/** Throws {@link HierarchyContractError} on a failing verdict. */
export function assertHierarchyVerdict(verdict: HierarchyVerdict): void {
  if (!verdict.ok) throw new HierarchyContractError(verdict.violations);
}

function verdictOf(violations: readonly HierarchyViolation[]): HierarchyVerdict {
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

/** One milestone as the contract sees it. */
export interface HierarchyMilestoneNode {
  readonly id: string;
  /** The sealed parent ref; must be exactly one canonical `goals:<G>`. */
  readonly parentRef: string | null;
  readonly archived: boolean;
  readonly terminal: boolean;
}

/** One non-milestone item (goals included) as the contract sees it. */
export interface HierarchyItemNode {
  readonly ledger: string;
  readonly id: string;
  readonly role: HierarchyArtifactRole;
  readonly placement: HierarchyPlacement;
  readonly archived: boolean;
}

export interface HierarchySnapshot {
  readonly milestones: readonly HierarchyMilestoneNode[];
  readonly items: readonly HierarchyItemNode[];
}

/** A generic create/import/restore request for one non-milestone item. */
export interface HierarchyPlacementRequest {
  readonly ledger: string;
  readonly id: string;
  readonly role: HierarchyArtifactRole;
  readonly placement: HierarchyPlacement;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

/** Identifies one node for archive/unarchive checks. */
export interface HierarchyNodeRef {
  readonly ledger: string;
  readonly id: string;
}

function refOf(ledger: string, id: string): string {
  return `${ledger}:${id}`;
}

const SEALED_GOAL_PARENT_RE = /^goals:G\d+$/;

// ---------------------------------------------------------------------------
// Matrix resolution and static placement
// ---------------------------------------------------------------------------

/** The rule for `ledger`; throws for a non-canonical ledger (total matrix). */
export function resolveLedgerPlacementRule(ledger: string): LedgerPlacementRule {
  const rule = LEDGER_PLACEMENT_MATRIX.get(ledger);
  if (rule === undefined) {
    throw new HierarchyContractError([
      { code: "non-canonical-ledger", ref: ledger, detail: "no placement rule" },
    ]);
  }
  return rule;
}

/**
 * Snapshot-free placement check for one non-milestone item: ledger role,
 * detachment, synthetic placement, and the task milestone requirement.
 */
export function checkStaticPlacement(
  ledger: string,
  id: string,
  role: HierarchyArtifactRole,
  placement: HierarchyPlacement,
): HierarchyViolation[] {
  const ref = refOf(ledger, id);
  const rule = LEDGER_PLACEMENT_MATRIX.get(ledger);
  if (rule === undefined) {
    return [{ code: "non-canonical-ledger", ref, detail: "no placement rule" }];
  }
  if (rule.kind === "milestone-node") {
    return [
      { code: "non-canonical-ledger", ref, detail: "milestones are hierarchy nodes, not items" },
    ];
  }
  const violations: HierarchyViolation[] = [];
  if (!rule.roles.includes(role)) {
    violations.push({ code: "role-not-permitted", ref, detail: `role ${role} not permitted` });
  }
  if (placement.kind === "milestone" && placement.milestoneId === MILESTONES_AMBIENT_ID) {
    violations.push({
      code: ledger === GOALS_LEDGER ? "attached-goal" : "synthetic-placement",
      ref,
      detail: `${MILESTONES_AMBIENT_ID} is a legacy migration input, not a placement`,
    });
    return violations;
  }
  switch (rule.kind) {
    case "always-detached":
      if (placement.kind !== "detached") {
        violations.push({
          code: ledger === GOALS_LEDGER ? "attached-goal" : "detached-required",
          ref,
          detail: `attached to ${placement.milestoneId}`,
        });
      }
      break;
    case "requires-work-milestone":
      if (placement.kind !== "milestone") {
        violations.push({ code: "work-milestone-required", ref, detail: "detached" });
      }
      break;
    case "role-scoped":
      if (placement.kind === "milestone" && role !== "work-implementation") {
        violations.push({
          code: "detached-required",
          ref,
          detail: `${role} artifact attached to ${placement.milestoneId}`,
        });
      }
      break;
  }
  return violations;
}

/**
 * Generic create/import/restore check. Every operation enforces the static
 * matrix and refuses legacy `goals.fields.milestones`; a `create` additionally
 * requires an explicitly supplied milestone to be live (active, non-terminal).
 * Import and restore resolve against {@link validateHierarchyState}.
 */
export function checkPlacementRequest(
  snapshot: HierarchySnapshot,
  operation: HierarchyWriteOperation,
  request: HierarchyPlacementRequest,
): HierarchyVerdict {
  const ref = refOf(request.ledger, request.id);
  const violations = checkStaticPlacement(
    request.ledger,
    request.id,
    request.role,
    request.placement,
  );
  if (request.ledger === GOALS_LEDGER && GOAL_MILESTONES_FIELD in request.fields) {
    violations.push({
      code: "legacy-goal-milestones-field",
      ref,
      detail: `${GOAL_MILESTONES_FIELD} is a legacy migration input only`,
    });
  }
  if (operation === "create" && violations.length === 0 && request.placement.kind === "milestone") {
    const milestoneId = request.placement.milestoneId;
    const milestone = snapshot.milestones.find((m) => m.id === milestoneId);
    if (milestone === undefined || milestone.archived || milestone.terminal) {
      violations.push({
        code: "milestone-not-live",
        ref,
        detail: `milestone ${milestoneId} is ${
          milestone === undefined ? "absent" : milestone.archived ? "archived" : "terminal"
        }`,
      });
    }
  }
  return verdictOf(violations);
}

// ---------------------------------------------------------------------------
// State invariants
// ---------------------------------------------------------------------------

function findGoal(snapshot: HierarchySnapshot, goalId: string): HierarchyItemNode | undefined {
  return snapshot.items.find((i) => i.ledger === GOALS_LEDGER && i.id === goalId);
}

function milestoneParentViolations(
  snapshot: HierarchySnapshot,
  milestone: HierarchyMilestoneNode,
): HierarchyViolation[] {
  const ref = refOf(MILESTONES_LEDGER, milestone.id);
  if (milestone.parentRef === null) {
    return [{ code: "milestone-parent-missing", ref, detail: "no sealed goal parent" }];
  }
  if (!SEALED_GOAL_PARENT_RE.test(milestone.parentRef)) {
    return [
      {
        code: "milestone-parent-not-goal",
        ref,
        detail: `parent ${milestone.parentRef} is not a canonical goals:<G> ref`,
      },
    ];
  }
  const goalId = milestone.parentRef.slice(`${GOALS_LEDGER}:`.length);
  const goal = findGoal(snapshot, goalId);
  if (goal === undefined) {
    return [
      {
        code: "milestone-parent-unresolved",
        ref,
        detail: `parent ${milestone.parentRef} is neither active nor archived`,
      },
    ];
  }
  if (!milestone.archived && goal.archived) {
    return [
      {
        code: "active-child-of-archived-parent",
        ref,
        detail: `parent ${milestone.parentRef} is archived`,
      },
    ];
  }
  return [];
}

function itemMilestoneViolations(
  snapshot: HierarchySnapshot,
  item: HierarchyItemNode,
): HierarchyViolation[] {
  if (item.placement.kind !== "milestone") return [];
  const ref = refOf(item.ledger, item.id);
  const milestoneId = item.placement.milestoneId;
  const milestone = snapshot.milestones.find((m) => m.id === milestoneId);
  if (milestone === undefined) {
    return [
      {
        code: "item-milestone-unresolved",
        ref,
        detail: `milestone ${milestoneId} is neither active nor archived`,
      },
    ];
  }
  if (!item.archived && milestone.archived) {
    return [
      {
        code: "active-child-of-archived-parent",
        ref,
        detail: `milestone ${milestoneId} is archived`,
      },
    ];
  }
  return [];
}

/**
 * Whole-state check over active and archived nodes alike: every item obeys
 * the matrix, every milestone resolves its one sealed goal parent, every
 * attached item resolves its milestone, and no active child has an archived
 * parent.
 */
export function validateHierarchyState(snapshot: HierarchySnapshot): HierarchyVerdict {
  const violations: HierarchyViolation[] = [];
  for (const item of snapshot.items) {
    const placementViolations = checkStaticPlacement(
      item.ledger,
      item.id,
      item.role,
      item.placement,
    );
    violations.push(
      ...(placementViolations.length > 0
        ? placementViolations
        : itemMilestoneViolations(snapshot, item)),
    );
  }
  for (const milestone of snapshot.milestones) {
    violations.push(...milestoneParentViolations(snapshot, milestone));
  }
  return verdictOf(violations);
}

// ---------------------------------------------------------------------------
// Archive ordering
// ---------------------------------------------------------------------------

interface ResolvedNode {
  readonly archived: boolean;
  /** Active children that block archival (child-before-parent). */
  readonly activeChildRefs: readonly string[];
  /** Parent refs that are archived and block unarchive (parent-before-child). */
  readonly archivedParentRefs: readonly string[];
}

function resolveNode(snapshot: HierarchySnapshot, node: HierarchyNodeRef): ResolvedNode | null {
  if (node.ledger === MILESTONES_LEDGER) {
    const milestone = snapshot.milestones.find((m) => m.id === node.id);
    if (milestone === undefined) return null;
    const goalRef = milestone.parentRef;
    const goal =
      goalRef !== null && SEALED_GOAL_PARENT_RE.test(goalRef)
        ? findGoal(snapshot, goalRef.slice(`${GOALS_LEDGER}:`.length))
        : undefined;
    return {
      archived: milestone.archived,
      activeChildRefs: snapshot.items
        .filter(
          (i) =>
            !i.archived && i.placement.kind === "milestone" && i.placement.milestoneId === node.id,
        )
        .map((i) => refOf(i.ledger, i.id)),
      // An unresolvable parent is reported as blocking: unarchive may never
      // produce an active milestone whose parent cannot be resolved.
      archivedParentRefs: goal === undefined || goal.archived ? [goalRef ?? "<none>"] : [],
    };
  }
  const item = snapshot.items.find((i) => i.ledger === node.ledger && i.id === node.id);
  if (item === undefined) return null;
  const goalRef = refOf(GOALS_LEDGER, item.id);
  const placement = item.placement;
  const milestone =
    placement.kind === "milestone"
      ? snapshot.milestones.find((m) => m.id === placement.milestoneId)
      : undefined;
  return {
    archived: item.archived,
    activeChildRefs:
      item.ledger === GOALS_LEDGER
        ? snapshot.milestones
            .filter((m) => !m.archived && m.parentRef === goalRef)
            .map((m) => refOf(MILESTONES_LEDGER, m.id))
        : [],
    archivedParentRefs:
      placement.kind === "milestone" && (milestone === undefined || milestone.archived)
        ? [refOf(MILESTONES_LEDGER, placement.milestoneId)]
        : [],
  };
}

/** Child-before-parent: a node may be archived only once no active child remains. */
export function checkArchive(
  snapshot: HierarchySnapshot,
  node: HierarchyNodeRef,
): HierarchyVerdict {
  const ref = refOf(node.ledger, node.id);
  const resolved = resolveNode(snapshot, node);
  if (resolved === null) return verdictOf([{ code: "node-not-found", ref, detail: "absent" }]);
  if (resolved.archived) {
    return verdictOf([{ code: "node-already-in-state", ref, detail: "already archived" }]);
  }
  return verdictOf(
    resolved.activeChildRefs.map((child) => ({
      code: "archive-with-active-children" as const,
      ref,
      detail: `active child ${child}`,
    })),
  );
}

/** Parent-before-child: a node may be unarchived only under an active parent. */
export function checkUnarchive(
  snapshot: HierarchySnapshot,
  node: HierarchyNodeRef,
): HierarchyVerdict {
  const ref = refOf(node.ledger, node.id);
  const resolved = resolveNode(snapshot, node);
  if (resolved === null) return verdictOf([{ code: "node-not-found", ref, detail: "absent" }]);
  if (!resolved.archived) {
    return verdictOf([{ code: "node-already-in-state", ref, detail: "already active" }]);
  }
  return verdictOf(
    resolved.archivedParentRefs.map((parent) => ({
      code: "unarchive-under-archived-parent" as const,
      ref,
      detail: `parent ${parent} is archived or unresolved`,
    })),
  );
}
