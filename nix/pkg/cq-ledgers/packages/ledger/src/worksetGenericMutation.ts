/**
 * T1961 — guarded generic-mutation gateway and strict in-memory contract.
 *
 * Splits public ledger reads from raw persistence writes behind one
 * ledger-layer gateway. Every ordinary graph- or eligibility-changing
 * mutation acquires a fresh t3 {@link WorksetAdmissionCoordinator}
 * ledger-mutation admission (`generic-write`), resolves affected items and
 * newly introduced closure-forming references inside the same critical
 * section, rejects mixed or excluded targets atomically, and holds
 * admission through commit acknowledgement.
 *
 * Opaque admissions cannot be forged ({@link isLiveWorksetAdmission} /
 * WeakSet membership). The public surface exposes reads + gateway methods
 * only — never the underlying adapter's raw write methods.
 *
 * Under non-empty (restrictive) roots, ordinary mutations retain the default
 * membership policy while two semantic worksets remain available:
 *  - idea-only create/update/reopen/unarchive/archive operations are exempt
 *  - a question update is exempt only when its effective delta is a pure answer
 *  - other generic creation (`createItem` / `createMilestone`) is denied
 *  - `createLedger` is denied
 *  - `unarchiveItem` is limited to an exact configured inactive root
 *  - `archiveMilestone` requires every swept active member in the graph
 *  - sealed ownership fields are rejected
 *
 * Empty roots remain unrestricted parity with the raw store (still fenced
 * against sealed ownership via the shared core write path).
 *
 * Backend legs (T1972+) implement the same {@link WorksetGenericMutationGateway}
 * over durable adapters; the in-memory dummy below is the Behavioral-Active
 * Blackbox reference.
 */

import {
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
  WORKSET_OWNED_FIELD_NAMES,
  GOALS_LEDGER,
  IDEAS_LEDGER,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_LEDGER,
  QUESTIONS_ANSWER_FIELD,
  QUESTIONS_LEDGER,
} from "./constants.js";
import { closeWorkset, defaultWorksetPrefixRegistry, type WorksetGraph } from "./worksetGraph.js";
import {
  assertWorksetOwnershipFieldsAbsent,
  PREREQUISITE_EDGE,
  readCanonicalOwnership,
  WorksetOwnershipFieldError,
  type CanonicalOwnership,
} from "./worksetOwnerEdges.js";
import type { FinalizeBatchOperation } from "./finalize.js";
import { ledgerItemRevisionV1 } from "./itemRevision.js";
import {
  createInMemoryWorksetStore,
  readWorksetRootsEpoch,
  type WorksetStore,
} from "./worksetStore.js";
import {
  WorksetAdmissionError,
  isLiveWorksetAdmission,
  type WorksetAdmissionCoordinatorHooks,
  type WorksetLedgerMutationAdmission,
  type WorksetRootsEpoch,
} from "./worksetEffectAdmission.js";
import {
  createObserveOnlyWorksetInvocationAuthority,
  createTrustedWorksetManagementAuthority,
  type WorksetInvocationAuthority,
} from "./worksetInvocationAuthority.js";
import { DEPENDENCY_REF_FIELDS, canonicalizeRef } from "./refs.js";
import { closedGraphIsTargetAdmitted } from "./worksetAccess.js";
export { buildActiveStateFromLedgerStore, closedGraphIsTargetAdmitted } from "./worksetAccess.js";
import { InMemoryLedgerStore } from "./store/InMemoryLedgerStore.js";
import type {
  ArchiveContent,
  ArchivedItemGeneration,
  CreateItemInit,
  CreateMilestoneItemInit,
  FetchedMilestoneItem,
  FtsSearchHit,
  FtsSearchOpts,
  LedgerStore,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "./store/LedgerStore.js";
import type { ArchivePointer, FetchedLedger, FieldValue, Item, LedgerSchema } from "./types.js";
import { LedgerError } from "./types.js";
import type { LedgerSnapshot } from "./snapshot.js";
import type { UsageStatsSnapshot } from "./usageStats.js";
import type {
  ArchiveTerminalItemsGatePolicy,
  ArchiveTerminalItemsResult,
  WorksetGenericMutationTx,
} from "./store/genericMutationTransaction.js";
import { CANONICAL_LEDGERS } from "./constants.js";
import type {
  SqliteOperationAccessClass,
  SqliteOperationAccessScope,
  SqliteOperationMeasurement,
} from "./store/sqlite/operationObservability.js";

// ---------------------------------------------------------------------------
// Inventory — every LedgerStore mutation + closure-forming field
// ---------------------------------------------------------------------------

/**
 * Ordinary graph- or eligibility-changing LedgerStore mutation operations
 * that the gateway must classify. Telemetry / cache ops (`recordMcpUsage`,
 * `invalidate`, `dispose`) are out of scope.
 */
export const WORKSET_GENERIC_MUTATION_OPERATION_KINDS = [
  "create-ledger",
  "create-milestone",
  "create-item",
  "update-milestone",
  "update-item",
  "reopen-item",
  "unarchive-item",
  "archive-terminal-items",
  "execute-finalize",
  "archive-milestone",
] as const;

export type WorksetGenericMutationOperationKind =
  (typeof WORKSET_GENERIC_MUTATION_OPERATION_KINDS)[number];

/**
 * Restrictive-root policy for one inventoried operation.
 *
 * - `deny` — refused entirely while roots are non-empty
 * - `require-target-in-graph` — primary target must be a closed-graph member
 * - `require-exact-inactive-root` — target ref must equal one configured inactive root
 * - `require-affected-targets-in-graph` — enumerate the batch before writing
 *   and require every non-exempt affected ref to be admitted
 * - `require-sweep-in-graph` — every archive sweep member must be in the graph
 */
export type WorksetGenericMutationRestrictivePolicy =
  | "deny"
  | "require-target-in-graph"
  | "require-exact-inactive-root"
  | "require-affected-targets-in-graph"
  | "require-sweep-in-graph";

export type WorksetGenericMutationSemanticExemption =
  | "idea-only"
  | "pure-question-answer";

export interface WorksetGenericMutationOperationClause {
  readonly kind: WorksetGenericMutationOperationKind;
  /** Guarded gateway method name this clause covers. */
  readonly method: keyof Omit<WorksetGenericMutationGateway, "form">;
  readonly restrictive: WorksetGenericMutationRestrictivePolicy;
  readonly exemptions: readonly WorksetGenericMutationSemanticExemption[];
  readonly unrestricted: "allow";
}

/**
 * Total allow-or-deny inventory for every ordinary LedgerStore mutation.
 * One clause per operation; no operation is left unclassified.
 */
export const WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES: readonly WorksetGenericMutationOperationClause[] =
  [
    {
      kind: "create-ledger",
      method: "createLedger",
      restrictive: "deny",
      exemptions: [],
      unrestricted: "allow",
    },
    {
      kind: "create-milestone",
      method: "createMilestone",
      restrictive: "deny",
      exemptions: [],
      unrestricted: "allow",
    },
    {
      kind: "create-item",
      method: "createItem",
      restrictive: "deny",
      exemptions: ["idea-only"],
      unrestricted: "allow",
    },
    {
      kind: "update-milestone",
      method: "updateMilestone",
      restrictive: "require-target-in-graph",
      exemptions: [],
      unrestricted: "allow",
    },
    {
      kind: "update-item",
      method: "updateItem",
      restrictive: "require-target-in-graph",
      exemptions: ["idea-only", "pure-question-answer"],
      unrestricted: "allow",
    },
    {
      kind: "reopen-item",
      method: "reopenItem",
      restrictive: "require-target-in-graph",
      exemptions: ["idea-only"],
      unrestricted: "allow",
    },
    {
      kind: "unarchive-item",
      method: "unarchiveItem",
      restrictive: "require-exact-inactive-root",
      exemptions: ["idea-only"],
      unrestricted: "allow",
    },
    {
      kind: "archive-terminal-items",
      method: "archiveTerminalItems",
      restrictive: "require-affected-targets-in-graph",
      exemptions: ["idea-only"],
      unrestricted: "allow",
    },
    {
      kind: "execute-finalize",
      method: "executeFinalize",
      restrictive: "require-affected-targets-in-graph",
      exemptions: ["idea-only"],
      unrestricted: "allow",
    },
    {
      kind: "archive-milestone",
      method: "archiveMilestone",
      restrictive: "require-sweep-in-graph",
      exemptions: [],
      unrestricted: "allow",
    },
  ] as const;

/** Field classification for generic create/update payloads. */
export type WorksetGenericMutationFieldKind =
  "eligibility" | "closure-forming" | "advisory" | "sealed-ownership" | "ordinary";

export type WorksetGenericMutationFieldRestrictivePolicy =
  "require-target-in-graph" | "require-introduced-refs-in-graph" | "allow" | "reject";

export interface WorksetGenericMutationFieldClause {
  readonly field: string;
  readonly kind: WorksetGenericMutationFieldKind;
  readonly restrictive: WorksetGenericMutationFieldRestrictivePolicy;
}

/**
 * Inventory of status, dependency, advisory, and sealed-ownership fields
 * that generic mutations may touch. Closure-forming fields additionally
 * require every newly introduced reference to already be in the admitted
 * graph (no silent workset expansion via dependsOn/blockedBy).
 */
export const WORKSET_GENERIC_MUTATION_FIELD_CLAUSES: readonly WorksetGenericMutationFieldClause[] =
  [
    {
      field: "status",
      kind: "eligibility",
      restrictive: "require-target-in-graph",
    },
    {
      field: "dependsOn",
      kind: "closure-forming",
      restrictive: "require-introduced-refs-in-graph",
    },
    {
      field: "blockedBy",
      kind: "closure-forming",
      restrictive: "require-introduced-refs-in-graph",
    },
    {
      field: "ledgerRefs",
      kind: "advisory",
      restrictive: "allow",
    },
    {
      field: "sourceRefs",
      kind: "advisory",
      restrictive: "allow",
    },
    {
      field: WORKSET_OWNER_REF_FIELD,
      kind: "sealed-ownership",
      restrictive: "reject",
    },
    {
      field: WORKSET_OWNER_EDGE_KIND_FIELD,
      kind: "sealed-ownership",
      restrictive: "reject",
    },
  ] as const;

/** Closure-forming field names (subset of DEPENDENCY_REF_FIELDS). */
export const WORKSET_GENERIC_MUTATION_CLOSURE_FIELDS = DEPENDENCY_REF_FIELDS;

export function clauseForGenericMutationOperation(
  kind: WorksetGenericMutationOperationKind,
): WorksetGenericMutationOperationClause {
  const clause = WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES.find((c) => c.kind === kind);
  if (clause === undefined) {
    throw new LedgerError(`unknown generic mutation operation: ${kind}`);
  }
  return clause;
}

export function clauseForGenericMutationField(
  field: string,
): WorksetGenericMutationFieldClause | undefined {
  return WORKSET_GENERIC_MUTATION_FIELD_CLAUSES.find((c) => c.field === field);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type WorksetGenericMutationErrorCode =
  | "creation-denied"
  | "create-ledger-denied"
  | "target-excluded"
  | "introduced-ref-excluded"
  | "unarchive-not-exact-inactive-root"
  | "archive-terminal-items-denied"
  | "archive-sweep-incomplete"
  | "sealed-ownership"
  | "mixed-or-excluded-targets"
  | "caller-minted-admission"
  | "raw-write-escape";

export class WorksetGenericMutationError extends Error {
  readonly code: WorksetGenericMutationErrorCode;
  constructor(code: WorksetGenericMutationErrorCode, message: string) {
    super(message);
    this.name = "WorksetGenericMutationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public surfaces — reads + gateway; no raw adapter writes
// ---------------------------------------------------------------------------

/**
 * Public read surface of a ledger. Deliberately omits every raw write method
 * from {@link LedgerStore} so MCP/orchestration cannot bypass the gateway.
 */
export interface WorksetLedgerReadSurface {
  init(): Promise<void>;
  enumerate(): string[];
  fetch(ledgerId: string): FetchedLedger;
  fetchArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent>;
  fetchArchivedItems(
    ledgerId: string,
    itemId: string,
  ): Promise<readonly ArchivedItemGeneration[]>;
  fetchItem(ledgerId: string, itemId: string): Item;
  fetchMilestone(milestoneId: string): FetchedMilestoneItem;
  search(ledgerId: string, query: string): Item[];
  ftsSearch(query: string, opts?: FtsSearchOpts): Promise<FtsSearchHit[]>;
  listMilestoneItems(milestoneId: string): Record<string, Item[]>;
  snapshot(): LedgerSnapshot;
  invalidate(ledgerId: string): Promise<void>;
  recordMcpUsage(endpoint: string, bytesIn: number, bytesOut: number): Promise<void>;
  fetchMcpUsageStats(): Promise<UsageStatsSnapshot>;
  dispose(): Promise<void>;
}

/**
 * Ledger-layer generic-mutation gateway. All ordinary graph/eligibility
 * mutations enter here; none escape as raw adapter calls on the public type.
 */
export interface WorksetGenericMutationGateway {
  readonly form: "workset-generic-mutation-gateway";
  updateMilestone(
    milestoneId: string,
    patch: UpdateMilestoneItemPatch,
    measurement?: SqliteOperationMeasurement,
  ): Promise<Item>;
  updateItem(
    ledgerId: string,
    itemId: string,
    patch: UpdateItemPatch,
    measurement?: SqliteOperationMeasurement,
  ): Promise<Item>;
  createItem(
    ledgerId: string,
    milestoneId: string,
    init: CreateItemInit,
    measurement?: SqliteOperationMeasurement,
  ): Promise<Item>;
  createMilestone(
    init: CreateMilestoneItemInit,
    measurement?: SqliteOperationMeasurement,
  ): Promise<Item>;
  createLedger(
    name: string,
    schema: LedgerSchema,
    measurement?: SqliteOperationMeasurement,
  ): Promise<FetchedLedger>;
  reopenItem(
    ledgerId: string,
    itemId: string,
    toStatus: string,
    measurement?: SqliteOperationMeasurement,
  ): Promise<Item>;
  unarchiveItem(
    ledgerId: string,
    milestoneId: string,
    itemId: string,
    measurement?: SqliteOperationMeasurement,
  ): Promise<Item>;
  archiveTerminalItems(
    ledgerIds: readonly string[],
    summary: string,
    gatePolicy: ArchiveTerminalItemsGatePolicy,
    measurement?: SqliteOperationMeasurement,
  ): Promise<ArchiveTerminalItemsResult>;
  executeFinalize(
    operations: readonly FinalizeBatchOperation[],
    measurement?: SqliteOperationMeasurement,
  ): Promise<{ applied: number }>;
  archiveMilestone(
    milestoneId: string,
    summary: string,
    measurement?: SqliteOperationMeasurement,
  ): Promise<ArchivePointer>;
}

/**
 * Full public guarded ledger: reads + workset root ops + generic mutations.
 * Raw {@link LedgerStore} write methods are not part of this surface.
 */
export interface WorksetGuardedLedger extends WorksetLedgerReadSurface {
  readonly mutations: WorksetGenericMutationGateway;
  setRoots(roots: readonly string[]): Promise<WorksetRootsEpoch>;
  snapshotRoots(): WorksetRootsEpoch | Promise<WorksetRootsEpoch>;
  /** Observation: held admissions (test/contract). */
  activeAdmissionCount(): number;
}

/** Methods that must NEVER appear on the public guarded surface. */
export const WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS = [
  "updateMilestone",
  "updateItem",
  "createItem",
  "createMilestone",
  "createLedger",
  "reopenItem",
  "unarchiveItem",
  "archiveMilestone",
] as const satisfies readonly (keyof LedgerStore)[];

/**
 * Structural guard: a public surface must not expose raw LedgerStore writes
 * as own enumerable methods (they live only under `.mutations`).
 */
export function assertNoPublicRawWriteEscape(surface: object): void {
  for (const method of WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS) {
    if (Object.prototype.hasOwnProperty.call(surface, method)) {
      throw new WorksetGenericMutationError(
        "raw-write-escape",
        `public guarded ledger must not expose raw write method "${method}"`,
      );
    }
    const value = (surface as Record<string, unknown>)[method];
    if (typeof value === "function") {
      throw new WorksetGenericMutationError(
        "raw-write-escape",
        `public guarded ledger must not expose raw write method "${method}"`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Active-state / membership helpers
// ---------------------------------------------------------------------------

export function worksetMemberRefSet(graph: WorksetGraph): ReadonlySet<string> {
  return new Set(graph.nodes.map((n) => n.ref));
}

function itemRef(ledgerId: string, itemId: string): string {
  return `${ledgerId}:${itemId}`;
}

function splitRefParts(ref: string): { readonly ledger: string; readonly id: string } {
  const colon = ref.indexOf(":");
  return colon === -1
    ? { ledger: ref, id: "" }
    : { ledger: ref.slice(0, colon), id: ref.slice(colon + 1) };
}

function asStringArray(value: FieldValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function fieldValuesEqual(left: FieldValue | undefined, right: FieldValue | undefined): boolean {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

export interface WorksetGenericMutationEffectiveDelta {
  readonly statusChanged: boolean;
  readonly changedFields: readonly string[];
}

/** Semantic item delta after removing fields resent unchanged by a client. */
export function effectiveGenericMutationDelta(
  existing: Item,
  patch: UpdateItemPatch,
): WorksetGenericMutationEffectiveDelta {
  const changedFields = Object.entries(patch.fields ?? {})
    .filter(([field, value]) => !fieldValuesEqual(existing.fields[field], value))
    .map(([field]) => field)
    .sort();
  return {
    statusChanged: patch.status !== undefined && patch.status !== existing.status,
    changedFields,
  };
}

export type WorksetGenericMutationSemanticClass =
  | "ordinary"
  | "idea-only"
  | "pure-question-answer";

/** Classify one item update from its stored value and effective semantic delta. */
export function classifyGenericItemUpdate(
  ledgerId: string,
  existing: Item,
  patch: UpdateItemPatch,
): WorksetGenericMutationSemanticClass {
  if (ledgerId === IDEAS_LEDGER) return "idea-only";
  if (ledgerId !== QUESTIONS_LEDGER) return "ordinary";
  const delta = effectiveGenericMutationDelta(existing, patch);
  const answerOnly =
    delta.changedFields.length === 1 && delta.changedFields[0] === QUESTIONS_ANSWER_FIELD;
  if (!delta.statusChanged) return answerOnly ? "pure-question-answer" : "ordinary";
  if (patch.status !== "answered") return "ordinary";
  if (answerOnly) return "pure-question-answer";
  if (delta.changedFields.length !== 0) return "ordinary";
  const storedAnswer = existing.fields[QUESTIONS_ANSWER_FIELD];
  return typeof storedAnswer === "string" && storedAnswer.trim().length > 0
    ? "pure-question-answer"
    : "ordinary";
}

function canonicalizeRefList(
  refs: readonly string[],
  prefixRegistry: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const raw of refs) {
    try {
      out.push(canonicalizeRef(raw, prefixRegistry));
    } catch {
      // Free-text / unknown-prefix entries are not closure members.
    }
  }
  return out;
}

function referenceCandidates(fields: Record<string, FieldValue> | undefined): string[] {
  if (fields === undefined) return [];
  const refs: string[] = [];
  for (const field of [
    ...WORKSET_GENERIC_MUTATION_CLOSURE_FIELDS,
    "ledgerRefs",
    WORKSET_OWNER_REF_FIELD,
  ]) {
    const value = fields[field];
    if (typeof value === "string") refs.push(value);
    else if (Array.isArray(value)) {
      refs.push(...value.filter((entry): entry is string => typeof entry === "string"));
    }
  }
  return refs;
}

/**
 * Newly introduced closure-forming refs: present in `next` but not in `prev`
 * (after canonicalization).
 */
export function introducedClosureRefs(
  previousFields: Record<string, FieldValue> | undefined,
  nextFields: Record<string, FieldValue> | undefined,
  prefixRegistry: ReadonlyMap<string, string>,
): string[] {
  if (nextFields === undefined) return [];
  const introduced: string[] = [];
  const seen = new Set<string>();
  for (const field of WORKSET_GENERIC_MUTATION_CLOSURE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(nextFields, field)) continue;
    const prevSet = new Set(
      canonicalizeRefList(asStringArray(previousFields?.[field]), prefixRegistry),
    );
    for (const ref of canonicalizeRefList(asStringArray(nextFields[field]), prefixRegistry)) {
      if (prevSet.has(ref)) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      introduced.push(ref);
    }
  }
  return introduced;
}


// ---------------------------------------------------------------------------
// D487 — terminal-cleanup closure
// ---------------------------------------------------------------------------

/**
 * Archival cleanup and runnable traversal are different authorities.
 *
 * `closeWorkset` deliberately drops an ANSWERED exact-gate question and a DONE
 * task's children: neither is executable, so neither belongs to a runnable
 * workset. But a milestone only becomes archivable once its members ARE
 * terminal, so that same readiness filter removes precisely the members an
 * archival sweep has to cover — and the sweep then refuses, with no legal way
 * to finish the cleanup short of adding every child as a root.
 *
 * These two predicates admit an exact canonically owned TERMINAL descendant of
 * admitted work into its own owner's archival sweep. They never widen ordinary
 * execution or generic intake: they are consulted only by `archiveMilestone`,
 * and only for members of the milestone being archived.
 */
function terminalCleanupShape(
  schemaOf: (ledgerId: string) => LedgerSchema | undefined,
  item: Item,
  ledgerId: string,
): CanonicalOwnership | null {
  // The milestone boundary needs no check here: every ref this is asked about
  // comes from `collectArchiveSweepRefs(milestoneId)`, which returns only that
  // group's members plus the milestone item itself — and the milestone item
  // carries no sealed ownership, so it fails below like any other unowned row.
  // Terminal only — live work is never cleanup.
  const schema = schemaOf(ledgerId);
  if (schema === undefined || !schema.terminalStatuses.includes(item.status)) return null;
  // Forged, partial and advisory-only links fail closed: `readCanonicalOwnership`
  // is total and returns null for a missing or non-string field, an ownerRef
  // with no `<ledger>:` prefix, and an unknown edge kind — which is exactly the
  // set `isAmbiguousLegacyOwnership` flags, so one check settles both. An
  // advisory `ledgerRefs` link never reaches here at all.
  const ownership = readCanonicalOwnership(item);
  if (ownership === null) return null;
  // `prerequisite` is an ordering edge, never sealed ownership.
  if (ownership.edgeKind === PREREQUISITE_EDGE.edgeKind) return null;
  return ownership;
}

/**
 * Pre-admission half: owner-agnostic, so a candidate can be withheld from the
 * admission targets before the admitted graph is known. Withholding a target
 * never grants authority — the in-transaction half below re-derives it.
 */
function isTerminalCleanupCandidate(
  store: Pick<LedgerStore, "fetch" | "fetchItem">,
  ref: string,
): boolean {
  const { ledger: ledgerId, id } = splitRefParts(ref);
  let item: Item;
  try {
    item = store.fetchItem(ledgerId, id);
  } catch {
    return false;
  }
  const schemaOf = (name: string): LedgerSchema | undefined => {
    try {
      return store.fetch(name).schema;
    } catch {
      return undefined;
    }
  };
  return terminalCleanupShape(schemaOf, item, ledgerId) !== null;
}

/**
 * Authoritative half: decided inside the critical section against the live
 * graph, so the owner must be an admitted member at the admitted epoch.
 */
function terminalCleanupAdmissible(
  store: Pick<LedgerStore, "fetch">,
  tx: WorksetGenericMutationTx,
  ctx: ValidationContext,
  ref: string,
): boolean {
  const { ledger: ledgerId, id } = splitRefParts(ref);
  let item: Item;
  try {
    item = tx.fetchItem(ledgerId, id);
  } catch {
    return false;
  }
  const schemaOf = (name: string): LedgerSchema | undefined => {
    try {
      return store.fetch(name).schema;
    } catch {
      return undefined;
    }
  };
  const ownership = terminalCleanupShape(schemaOf, item, ledgerId);
  return ownership !== null && ctx.members.has(ownership.ownerRef);
}

function collectArchiveSweepRefs(
  store: Pick<LedgerStore, "enumerate" | "listMilestoneItems" | "fetchItem">,
  milestoneId: string,
): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const push = (ref: string): void => {
    if (seen.has(ref)) return;
    seen.add(ref);
    refs.push(ref);
  };
  // Milestone item itself (when still active).
  try {
    store.fetchItem(MILESTONES_LEDGER, milestoneId);
    push(itemRef(MILESTONES_LEDGER, milestoneId));
  } catch {
    // Absent / already archived milestone — sweep still covers children.
  }
  const byLedger = store.listMilestoneItems(milestoneId);
  for (const [ledgerId, items] of Object.entries(byLedger)) {
    for (const item of items) {
      push(itemRef(ledgerId, item.id));
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Validation inside the critical section
// ---------------------------------------------------------------------------

interface ValidationContext {
  readonly restrictive: boolean;
  readonly roots: readonly string[];
  readonly graph: WorksetGraph;
  readonly members: ReadonlySet<string>;
  readonly prefixRegistry: ReadonlyMap<string, string>;
}

function buildTransactionValidationContext(
  tx: WorksetGenericMutationTx,
  rootsEpoch: WorksetRootsEpoch,
): ValidationContext {
  const state = tx.activeState();
  const graph = closeWorkset(rootsEpoch.roots, state);
  const prefixRegistry = state.prefixRegistry ?? defaultWorksetPrefixRegistry();
  return {
    restrictive: graph.restrictive,
    roots: graph.roots,
    graph,
    members: worksetMemberRefSet(graph),
    prefixRegistry,
  };
}

function assertTargetInGraph(ctx: ValidationContext, ref: string): void {
  if (!ctx.restrictive) return;
  if (!ctx.members.has(ref)) {
    throw new WorksetGenericMutationError(
      "target-excluded",
      `generic mutation target "${ref}" is outside the admitted workset`,
    );
  }
}

function assertAffectedTargetsInGraph(
  ctx: ValidationContext,
  refs: readonly string[],
  isExempt: (ref: string) => boolean,
): void {
  if (!ctx.restrictive) return;
  const excluded = refs.filter(
    (ref) =>
      !isExempt(ref) &&
      !ctx.members.has(ref) &&
      !ctx.graph.inactiveRoots.includes(ref),
  );
  if (excluded.length === 0) return;
  throw new WorksetGenericMutationError(
    "mixed-or-excluded-targets",
    `generic mutation rejects excluded target(s): ${excluded.join(", ")}`,
  );
}

function assertIntroducedRefsInGraph(ctx: ValidationContext, introduced: readonly string[]): void {
  if (!ctx.restrictive) return;
  const excluded = introduced.filter((ref) => !ctx.members.has(ref));
  if (excluded.length === 0) return;
  throw new WorksetGenericMutationError(
    "introduced-ref-excluded",
    `closure-forming reference(s) outside the admitted workset: ${excluded.join(", ")}`,
  );
}

function assertSealedOwnershipAbsent(
  fields: Record<string, FieldValue> | undefined,
  existing?: Item,
): void {
  try {
    assertWorksetOwnershipFieldsAbsent(fields, existing);
  } catch (error) {
    if (error instanceof WorksetOwnershipFieldError) {
      throw new WorksetGenericMutationError("sealed-ownership", error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Gateway implementation over a raw LedgerStore + WorksetStore
// ---------------------------------------------------------------------------

export interface AdmittedGenericMutation {
  readonly admission: WorksetLedgerMutationAdmission;
  readonly scope: SqliteOperationAccessScope;
  readonly allocation: { readonly ledgerId: string; readonly requestedId: string | null } | null;
}

const admittedGenericMutationBindingBrand: unique symbol = Symbol("AdmittedGenericMutationBinding");
const admittedGenericMutationBindingKey: unique symbol = Symbol("AdmittedGenericMutationBindingKey");

/** Opaque per-gateway authority used by a persistence adapter to verify descriptors. */
export interface AdmittedGenericMutationBinding {
  readonly [admittedGenericMutationBindingBrand]: true;
}

class AdmittedGenericMutationBindingToken implements AdmittedGenericMutationBinding {
  readonly [admittedGenericMutationBindingBrand] = true;
  readonly #bound = new WeakSet<object>();

  constructor(key: typeof admittedGenericMutationBindingKey) {
    if (key !== admittedGenericMutationBindingKey) {
      throw new TypeError("generic mutation binding constructor is private");
    }
    Object.freeze(this);
  }

  static bind(
    key: typeof admittedGenericMutationBindingKey,
    binding: AdmittedGenericMutationBindingToken,
    value: AdmittedGenericMutation,
  ): void {
    if (key !== admittedGenericMutationBindingKey) {
      throw new TypeError("generic mutation binding verifier is private");
    }
    binding.#bound.add(value);
  }

  static owns(
    key: typeof admittedGenericMutationBindingKey,
    binding: unknown,
    value: unknown,
  ): value is AdmittedGenericMutation {
    return key === admittedGenericMutationBindingKey &&
      typeof binding === "object" &&
      binding !== null &&
      #bound in binding &&
      typeof value === "object" &&
      value !== null &&
      binding.#bound.has(value);
  }
}

Object.freeze(AdmittedGenericMutationBindingToken.prototype);
Object.freeze(AdmittedGenericMutationBindingToken);

class AdmittedGenericMutationBindingOwner {
  readonly binding = new AdmittedGenericMutationBindingToken(
    admittedGenericMutationBindingKey,
  );

  bind(
    admission: WorksetLedgerMutationAdmission,
    scope: SqliteOperationAccessScope,
    allocation: AdmittedGenericMutation["allocation"],
  ): AdmittedGenericMutation {
    Object.freeze(admission.roots);
    Object.freeze(admission.targets);
    Object.freeze(admission);
    const boundScope: SqliteOperationAccessScope = Object.freeze({
      ...scope,
      targetRefs: Object.freeze([...scope.targetRefs]),
      ledgerIds: Object.freeze([...scope.ledgerIds]),
      milestoneIds: Object.freeze([...scope.milestoneIds]),
      referenceCandidates: Object.freeze([...scope.referenceCandidates]),
    });
    const bound: AdmittedGenericMutation = Object.freeze({
      admission,
      scope: boundScope,
      allocation: allocation === null ? null : Object.freeze({ ...allocation }),
    });
    AdmittedGenericMutationBindingToken.bind(
      admittedGenericMutationBindingKey,
      this.binding,
      bound,
    );
    return bound;
  }
}

/** True only for an immutable descriptor minted by this exact gateway owner. */
export function isBoundAdmittedGenericMutation(
  binding: AdmittedGenericMutationBinding,
  value: unknown,
): value is AdmittedGenericMutation {
  return AdmittedGenericMutationBindingToken.owns(
    admittedGenericMutationBindingKey,
    binding,
    value,
  );
}

export interface WorksetGenericMutationGatewayHost {
  /** Raw persistence adapter — never exposed on the public surface. */
  readonly rawStore: LedgerStore;
  /** Workset roots + t3 admission coordinator. */
  readonly worksetStore: WorksetStore;
  /** Runtime authority carried outside invocation arguments. */
  readonly invocationAuthority?: WorksetInvocationAuthority;
  readonly runGenericTransaction?: <T>(
    mutate: (tx: WorksetGenericMutationTx, roots: WorksetRootsEpoch) => T,
    measurement: SqliteOperationMeasurement | undefined,
    accessScope: SqliteOperationAccessScope,
    context: AdmittedGenericMutation,
    binding: AdmittedGenericMutationBinding,
  ) => Promise<T>;
  /**
   * Test/instrumentation latch: runs after admit and before validation/write,
   * while the ledger-mutation admission is still held. Used to prove setRoots
   * waits on live generic admissions.
   */
  readonly afterGenericAdmit?: () => Promise<void> | void;
}

/**
 * Build the guarded gateway methods bound to a host. Admission is acquired
 * per call; validation runs after grant so epoch/roots are the admitted pair.
 */
export function createWorksetGenericMutationGateway(
  host: WorksetGenericMutationGatewayHost,
): WorksetGenericMutationGateway {
  const { rawStore, worksetStore, afterGenericAdmit } = host;
  const atomicStore = rawStore as LedgerStore & {
    runAtomicGenericMutation<T>(
      mutate: (tx: WorksetGenericMutationTx, roots: WorksetRootsEpoch) => T,
      readRoots: (() => Promise<WorksetRootsEpoch>) | undefined,
      measurement: SqliteOperationMeasurement | undefined,
      accessScope: SqliteOperationAccessScope,
      context: AdmittedGenericMutation,
      binding: AdmittedGenericMutationBinding,
    ): Promise<T>;
  };
  const bindingOwner = new AdmittedGenericMutationBindingOwner();
  const runGenericTransaction =
    host.runGenericTransaction ??
    (<T>(
      mutate: (tx: WorksetGenericMutationTx, roots: WorksetRootsEpoch) => T,
      measurement: SqliteOperationMeasurement | undefined,
      accessScope: SqliteOperationAccessScope,
      context: AdmittedGenericMutation,
      transactionBinding: AdmittedGenericMutationBinding,
    ) =>
      atomicStore.runAtomicGenericMutation(
        mutate,
        () => readWorksetRootsEpoch(worksetStore),
        measurement,
        accessScope,
        context,
        transactionBinding,
      ));

  async function withGenericAdmission<T>(
    targets: readonly string[],
    operation: string,
    accessClass: SqliteOperationAccessClass,
    suppliedMeasurement: SqliteOperationMeasurement | undefined,
    validateAndRun: (
      tx: WorksetGenericMutationTx,
      admission: WorksetLedgerMutationAdmission,
      ctx: ValidationContext,
    ) => T,
    options: {
      /** Map coordinator target-excluded into a gateway-specific code. */
      readonly onTargetExcluded?: (cause: WorksetAdmissionError) => WorksetGenericMutationError;
      readonly allocation?: NonNullable<AdmittedGenericMutation["allocation"]>;
      /** Persistence read scope; independent from restrictive admission targets. */
      readonly scopeTargetRefs?: readonly string[];
      readonly accessScope?: Omit<
        SqliteOperationAccessScope,
        "operation" | "accessClass" | "targetRefs"
      >;
    } = {},
  ): Promise<T> {
    const observable = rawStore as LedgerStore & {
      beginObservedOperation?: (endpoint: string) => SqliteOperationMeasurement | undefined;
    };
    const measurement =
      suppliedMeasurement ?? observable.beginObservedOperation?.(operation.replaceAll("-", "_"));
    const ownsMeasurement = suppliedMeasurement === undefined && measurement !== undefined;
    measurement?.setOperation(operation);
    measurement?.setAccessClass(accessClass);
    const accessScope: SqliteOperationAccessScope = {
      operation,
      accessClass,
      targetRefs: options.scopeTargetRefs ?? targets,
      ledgerIds: options.accessScope?.ledgerIds ?? [],
      milestoneIds: options.accessScope?.milestoneIds ?? [],
      referenceCandidates: options.accessScope?.referenceCandidates ?? [],
    };
    measurement?.setAccessScope(accessScope);
    let admission: WorksetLedgerMutationAdmission;
    try {
      const admit = () =>
        worksetStore.admitLedgerMutation({
          kind: "generic-write",
          targets: [...targets],
        });
      admission =
        measurement === undefined
          ? await admit()
          : await measurement.measureAsync("queueDelayMs", admit);
    } catch (error) {
      if (ownsMeasurement) measurement.finish("error");
      if (error instanceof WorksetAdmissionError && error.code === "target-excluded") {
        if (options.onTargetExcluded !== undefined) {
          throw options.onTargetExcluded(error);
        }
        throw new WorksetGenericMutationError("target-excluded", error.message);
      }
      throw error;
    }
    if (!isLiveWorksetAdmission(admission)) {
      if (ownsMeasurement) measurement.finish("error");
      throw new WorksetGenericMutationError(
        "caller-minted-admission",
        "generic mutation requires a coordinator-granted live admission",
      );
    }
    let result: T | undefined;
    let failed = false;
    let failure: unknown;
    try {
      if (afterGenericAdmit !== undefined) {
        await afterGenericAdmit();
      }
      const boundContext = bindingOwner.bind(
        admission,
        accessScope,
        options.allocation ?? null,
      );
      result = await runGenericTransaction(
        (tx, snap) => {
          if (snap.epoch !== admission.epoch) {
            throw new WorksetAdmissionError(
              "stale-epoch",
              "workset epoch advanced before generic mutation critical section",
            );
          }
          const ctx = buildTransactionValidationContext(tx, snap);
          if (ctx.restrictive && targets.length > 0) {
            const excluded = targets.filter((t) => {
              if (ctx.members.has(t)) return false;
              if (ctx.graph.inactiveRoots.includes(t)) return false;
              return true;
            });
            if (excluded.length > 0) {
              throw new WorksetGenericMutationError(
                "mixed-or-excluded-targets",
                `generic mutation rejects excluded target(s): ${excluded.join(", ")}`,
              );
            }
          }
          return validateAndRun(tx, admission, ctx);
        },
        measurement,
        boundContext.scope,
        boundContext,
        bindingOwner.binding,
      );
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await admission.acknowledge();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    if (ownsMeasurement) measurement.finish(failed ? "error" : "success");
    if (failed) throw failure;
    return result as T;
  }

  const gateway: WorksetGenericMutationGateway = {
    form: "workset-generic-mutation-gateway",

    async updateMilestone(milestoneId, patch, measurement) {
      const ref = itemRef(MILESTONES_LEDGER, milestoneId);
      const fieldBag: Record<string, FieldValue> = {};
      if (patch.title !== undefined) fieldBag.title = patch.title;
      if (patch.description !== undefined) fieldBag.description = patch.description;
      if (patch.blockedBy !== undefined) fieldBag.blockedBy = patch.blockedBy;
      if (patch.dependsOn !== undefined) fieldBag.dependsOn = patch.dependsOn;

      return withGenericAdmission(
        [ref],
        "update-milestone",
        "ordinary",
        measurement,
        (tx, _adm, ctx) => {
          assertTargetInGraph(ctx, ref);
          let existing: Item | undefined;
          try {
            existing = tx.fetchItem(MILESTONES_LEDGER, milestoneId);
          } catch {
            existing = undefined;
          }
          assertSealedOwnershipAbsent(fieldBag, existing);
          const introduced = introducedClosureRefs(
            existing?.fields,
            Object.keys(fieldBag).length > 0 ? fieldBag : undefined,
            ctx.prefixRegistry,
          );
          // Introduced refs become additional targets that must already be members.
          assertIntroducedRefsInGraph(ctx, introduced);
          if (ctx.restrictive && introduced.some((r) => !ctx.members.has(r))) {
            throw new WorksetGenericMutationError(
              "mixed-or-excluded-targets",
              "update-milestone rejects mixed admitted/excluded closure refs",
            );
          }
          return tx.updateMilestone(milestoneId, patch);
        },
        {
          scopeTargetRefs: [ref],
          accessScope: {
            ledgerIds: [MILESTONES_LEDGER],
            milestoneIds: [milestoneId],
            referenceCandidates: referenceCandidates(fieldBag),
          },
        },
      );
    },

    async updateItem(ledgerId, itemId, patch, measurement) {
      const ref = itemRef(ledgerId, itemId);
      return withGenericAdmission(
        ledgerId === IDEAS_LEDGER || ledgerId === QUESTIONS_LEDGER ? [] : [ref],
        "update-item",
        "ordinary",
        measurement,
        (tx, _adm, ctx) => {
          let existing: Item | undefined;
          try {
            existing = tx.fetchItem(ledgerId, itemId);
          } catch {
            existing = undefined;
          }
          const semanticClass =
            existing === undefined
              ? "ordinary"
              : classifyGenericItemUpdate(ledgerId, existing, patch);
          if (semanticClass === "ordinary") assertTargetInGraph(ctx, ref);
          assertSealedOwnershipAbsent(patch.fields, existing);
          const introduced = introducedClosureRefs(
            existing?.fields,
            patch.fields,
            ctx.prefixRegistry,
          );
          if (semanticClass === "ordinary") assertIntroducedRefsInGraph(ctx, introduced);
          // Include introduced refs in the atomic mixed-target check.
          if (ctx.restrictive && semanticClass === "ordinary") {
            const all = [ref, ...introduced];
            const excluded = all.filter((t) => !ctx.members.has(t));
            if (excluded.length > 0) {
              throw new WorksetGenericMutationError(
                "mixed-or-excluded-targets",
                `update-item rejects excluded target(s): ${excluded.join(", ")}`,
              );
            }
          }
          return tx.updateItem(ledgerId, itemId, patch);
        },
        {
          scopeTargetRefs: [ref],
          accessScope: {
            ledgerIds: [ledgerId],
            milestoneIds: [],
            referenceCandidates: referenceCandidates(patch.fields),
          },
        },
      );
    },

    async createItem(ledgerId, milestoneId, init, measurement) {
      // Restrictive denial uses admission.roots inside the held t3 section
      // (not a pre-admit read) so concurrent setRoots cannot TOCTOU create.
      // Sealed-ownership is checked after creation-denied so the deny code is
      // stable under restrictive roots.
      return withGenericAdmission(
        [],
        "create-item",
        "ordinary",
        measurement,
        (tx, adm) => {
          if (adm.roots.length > 0 && ledgerId !== IDEAS_LEDGER) {
            throw new WorksetGenericMutationError(
              "creation-denied",
              "generic createItem is denied under non-empty workset roots; use owner-scoped lifecycle writes",
            );
          }
          assertSealedOwnershipAbsent(init.fields);
          return tx.createItem(ledgerId, milestoneId, init);
        },
        {
          allocation: { ledgerId, requestedId: init.id ?? null },
          accessScope: {
            ledgerIds: [ledgerId, MILESTONES_LEDGER],
            milestoneIds: [milestoneId],
            referenceCandidates: [
              ...referenceCandidates(init.fields),
              ...(init.id === undefined ? [] : [`${ledgerId}:${init.id}`]),
            ],
          },
        },
      );
    },

    async createMilestone(init, measurement) {
      const fields: Record<string, FieldValue> = { title: init.title };
      if (init.description !== undefined) fields.description = init.description;
      if (init.blockedBy !== undefined) fields.blockedBy = init.blockedBy;
      if (init.dependsOn !== undefined) fields.dependsOn = init.dependsOn;
      return withGenericAdmission(
        [],
        "create-milestone",
        "ordinary",
        measurement,
        (tx, adm) => {
          if (adm.roots.length > 0) {
            throw new WorksetGenericMutationError(
              "creation-denied",
              "generic createMilestone is denied under non-empty workset roots; use owner-scoped lifecycle writes",
            );
          }
          assertSealedOwnershipAbsent(fields);
          return tx.createMilestone(init);
        },
        {
          allocation: { ledgerId: MILESTONES_LEDGER, requestedId: init.id ?? null },
          accessScope: {
            ledgerIds: [MILESTONES_LEDGER],
            milestoneIds: [MILESTONES_ACTIVE_GROUP_ID],
            referenceCandidates: [
              ...referenceCandidates(fields),
              ...(init.id === undefined ? [] : [`${MILESTONES_LEDGER}:${init.id}`]),
            ],
          },
        },
      );
    },

    async createLedger(name, schema, measurement) {
      return withGenericAdmission(
        [],
        "create-ledger",
        "ordinary",
        measurement,
        (tx, adm) => {
          if (adm.roots.length > 0) {
            throw new WorksetGenericMutationError(
              "create-ledger-denied",
              "createLedger is denied under non-empty workset roots",
            );
          }
          return tx.createLedger(name, schema);
        },
        {
          accessScope: {
            ledgerIds: [name],
            milestoneIds: [],
            referenceCandidates: [],
          },
        },
      );
    },

    async reopenItem(ledgerId, itemId, toStatus, measurement) {
      const ref = itemRef(ledgerId, itemId);
      return withGenericAdmission(
        ledgerId === IDEAS_LEDGER ? [] : [ref],
        "reopen-item",
        "ordinary",
        measurement,
        (tx, _adm, ctx) => {
          if (ledgerId !== IDEAS_LEDGER) assertTargetInGraph(ctx, ref);
          return tx.reopenItem(ledgerId, itemId, toStatus);
        },
        {
          scopeTargetRefs: [ref],
          accessScope: {
            ledgerIds: [ledgerId, MILESTONES_LEDGER],
            milestoneIds: [],
            referenceCandidates: [],
          },
        },
      );
    },

    async unarchiveItem(ledgerId, milestoneId, itemId, measurement) {
      const ref = itemRef(ledgerId, itemId);
      return withGenericAdmission(
        ledgerId === IDEAS_LEDGER ? [] : [ref],
        "unarchive-item",
        "ordinary",
        measurement,
        (tx, _adm, ctx) => {
          if (ctx.restrictive && ledgerId !== IDEAS_LEDGER) {
            if (!ctx.graph.inactiveRoots.includes(ref)) {
              throw new WorksetGenericMutationError(
                "unarchive-not-exact-inactive-root",
                `unarchiveItem is limited to an exact configured inactive root; "${ref}" is not one`,
              );
            }
          }
          return tx.unarchiveItem(ledgerId, milestoneId, itemId);
        },
        {
          scopeTargetRefs: [ref],
          accessScope: {
            ledgerIds: [ledgerId, MILESTONES_LEDGER],
            milestoneIds: [milestoneId],
            referenceCandidates: [],
          },
          ...(ledgerId === IDEAS_LEDGER
            ? {}
            : {
                onTargetExcluded: (cause: WorksetAdmissionError) =>
                  new WorksetGenericMutationError(
                    "unarchive-not-exact-inactive-root",
                    `unarchiveItem is limited to an exact configured inactive root; "${ref}" is not one (${cause.message})`,
                  ),
              }),
        },
      );
    },

    async archiveTerminalItems(ledgerIds, summary, gatePolicy, measurement) {
      return withGenericAdmission(
        [],
        "archive-terminal-items",
        "archive_terminal_items",
        measurement,
        (tx, _adm, ctx) => {
          const affected = tx.collectArchiveTerminalItemRefs(ledgerIds, gatePolicy);
          assertAffectedTargetsInGraph(
            ctx,
            affected,
            (ref) => ref.startsWith(`${IDEAS_LEDGER}:`),
          );
          return tx.archiveTerminalItems(ledgerIds, summary, gatePolicy);
        },
        {
          accessScope: {
            ledgerIds,
            milestoneIds: [],
            referenceCandidates: [],
          },
        },
      );
    },

    async executeFinalize(operations, measurement) {
      const exactRefs = new Set<string>();
      const wholeMilestones = new Set(operations
        .filter((operation) => operation.action === "archive-milestone")
        .map((operation) => operation.targetId));
      for (const operation of operations) {
        if (operation.action !== "archive-terminal-item") continue;
        if (operation.version !== 1 || operation.targetId.split(":").length !== 2 ||
            operation.targetId.startsWith(`${MILESTONES_LEDGER}:`)) {
          throw new LedgerError("exact terminal archive requires a versioned non-milestone ref");
        }
        if (exactRefs.has(operation.targetId) || wholeMilestones.has(operation.expectedMilestoneId)) {
          throw new LedgerError("exact terminal archive selections overlap");
        }
        exactRefs.add(operation.targetId);
      }
      const scopeTargetRefs = operations.flatMap((operation) => {
        switch (operation.action) {
          case "archive-terminal-item":
            return [operation.targetId];
          case "close-milestone":
            return [itemRef(MILESTONES_LEDGER, operation.targetId)];
          case "close-goal":
            return [itemRef("goals", operation.targetId)];
          case "archive-milestone": {
            const sweep = collectArchiveSweepRefs(rawStore, operation.targetId);
            return sweep.length > 0 ? sweep : [itemRef(MILESTONES_LEDGER, operation.targetId)];
          }
        }
      });
      const admissionTargets = scopeTargetRefs.filter((ref) =>
        !(exactRefs.has(ref) && ref.startsWith(`${IDEAS_LEDGER}:`)));
      const accessClass = operations.some(({ action }) =>
        action === "archive-milestone" || action === "archive-terminal-item")
        ? "archive_milestone"
        : "ordinary";
      return withGenericAdmission(
        admissionTargets,
        "execute-finalize",
        accessClass,
        measurement,
        (tx, _adm, ctx) => {
          const ids = new Set<string>();
          for (const operation of operations) {
            if (operation.id.length === 0 || operation.targetId.length === 0) {
              throw new LedgerError("finalize operation ids must be non-empty");
            }
            if (ids.has(operation.id)) {
              throw new LedgerError(`duplicate finalize operation id "${operation.id}"`);
            }
            ids.add(operation.id);
            switch (operation.action) {
              case "archive-terminal-item": {
                const separator = operation.targetId.indexOf(":");
                const ledgerId = operation.targetId.slice(0, separator);
                const itemId = operation.targetId.slice(separator + 1);
                if (ledgerId !== IDEAS_LEDGER) assertTargetInGraph(ctx, operation.targetId);
                const item = tx.fetchItem(ledgerId, itemId);
                if (item.milestoneId !== operation.expectedMilestoneId ||
                    item.updatedAt !== operation.expectedUpdatedAt ||
                    ledgerItemRevisionV1(operation.targetId, item) !== operation.expectedItemDigest) {
                  throw new LedgerError(`exact terminal archive item "${operation.targetId}" changed`);
                }
                tx.archiveTerminalItems([ledgerId], operation.summary, "fail-on-active-gate", [operation.targetId]);
                break;
              }
              case "close-milestone":
                assertTargetInGraph(ctx, itemRef(MILESTONES_LEDGER, operation.targetId));
                if (operation.targetStatus === undefined) {
                  throw new LedgerError(`finalize operation ${operation.id} requires targetStatus`);
                }
                tx.updateMilestone(operation.targetId, { status: operation.targetStatus });
                break;
              case "close-goal":
                assertTargetInGraph(ctx, itemRef("goals", operation.targetId));
                if (operation.targetStatus === undefined) {
                  throw new LedgerError(`finalize operation ${operation.id} requires targetStatus`);
                }
                tx.updateItem("goals", operation.targetId, { status: operation.targetStatus });
                break;
              case "archive-milestone": {
                if (operation.summary === undefined) {
                  throw new LedgerError(`finalize operation ${operation.id} requires summary`);
                }
                if (ctx.restrictive) {
                  const missing = tx
                    .collectArchiveSweepRefs(operation.targetId)
                    .filter((ref) => !ctx.members.has(ref));
                  if (missing.length > 0) {
                    throw new WorksetGenericMutationError(
                      "archive-sweep-incomplete",
                      `archiveMilestone requires every swept active member in the admitted graph; missing: ${missing.join(", ")}`,
                    );
                  }
                }
                tx.archiveMilestone(operation.targetId, operation.summary);
                break;
              }
            }
          }
          return { applied: operations.length };
        },
        {
          scopeTargetRefs,
          accessScope: {
            ledgerIds: [
              ...new Set(
                operations.map((operation) =>
                  operation.action === "archive-terminal-item"
                    ? operation.targetId.slice(0, operation.targetId.indexOf(":"))
                    : operation.action === "close-goal" ? GOALS_LEDGER : MILESTONES_LEDGER,
                ),
              ),
            ],
            milestoneIds: operations.flatMap((operation) =>
              operation.action === "archive-terminal-item" ? [operation.expectedMilestoneId]
                : operation.action === "archive-milestone" ? [operation.targetId] : []),
            referenceCandidates: [],
          },
        },
      );
    },

    async archiveMilestone(milestoneId, summary, measurement) {
      // Resolve the live sweep first so admission targets cover every member;
      // re-check inside the critical section for linearizability.
      const preSweep = collectArchiveSweepRefs(rawStore, milestoneId);
      // D487: withhold terminal-cleanup candidates from the ADMISSION targets.
      // The coordinator probe is shared by every mutation kind and cannot be
      // told which operation is asking, so the operation-specific relaxation
      // has to happen where the operation is known. Withholding a target
      // grants nothing on its own: the critical section below re-derives
      // eligibility from the live graph at the admitted epoch, and any ref
      // that fails there still ends the archive as `archive-sweep-incomplete`.
      const withheld = new Set(
        preSweep.filter((ref) => isTerminalCleanupCandidate(rawStore, ref)),
      );
      const presented = preSweep.filter((ref) => !withheld.has(ref));
      const admitTargets =
        presented.length > 0 ? presented : [itemRef(MILESTONES_LEDGER, milestoneId)];
      return withGenericAdmission(
        admitTargets,
        "archive-milestone",
        "archive_milestone",
        measurement,
        (tx, _adm, ctx) => {
          const sweep = tx.collectArchiveSweepRefs(milestoneId);
          if (ctx.restrictive) {
            const missing = sweep.filter(
              (ref) =>
                !ctx.members.has(ref) &&
                !terminalCleanupAdmissible(rawStore, tx, ctx, ref),
            );
            if (missing.length > 0) {
              throw new WorksetGenericMutationError(
                "archive-sweep-incomplete",
                `archiveMilestone requires every swept active member in the admitted graph; missing: ${missing.join(", ")}`,
              );
            }
            if (sweep.length === 0) {
              assertTargetInGraph(ctx, itemRef(MILESTONES_LEDGER, milestoneId));
            }
          }
          return tx.archiveMilestone(milestoneId, summary);
        },
        {
          scopeTargetRefs: preSweep,
          accessScope: {
            ledgerIds: [MILESTONES_LEDGER],
            milestoneIds: [milestoneId],
            referenceCandidates: [],
          },
          onTargetExcluded: (cause) =>
            new WorksetGenericMutationError(
              "archive-sweep-incomplete",
              `archiveMilestone requires every swept active member in the admitted graph (${cause.message})`,
            ),
        },
      );
    },
  };

  Object.freeze(gateway);
  return gateway;
}

/**
 * Wrap a raw store + workset store as a public {@link WorksetGuardedLedger}.
 * Raw write methods are not copied onto the returned object.
 */
export function createWorksetGuardedLedger(
  host: WorksetGenericMutationGatewayHost,
): WorksetGuardedLedger {
  const { rawStore, worksetStore } = host;
  const invocationAuthority =
    host.invocationAuthority ?? createObserveOnlyWorksetInvocationAuthority();
  const mutations = createWorksetGenericMutationGateway(host);

  const surface: WorksetGuardedLedger = {
    init: () => rawStore.init(),
    enumerate: () => rawStore.enumerate(),
    fetch: (id) => rawStore.fetch(id),
    fetchArchive: (ledgerId, archiveId) => rawStore.fetchArchive(ledgerId, archiveId),
    fetchArchivedItems: (ledgerId, itemId) => rawStore.fetchArchivedItems(ledgerId, itemId),
    fetchItem: (ledgerId, itemId) => rawStore.fetchItem(ledgerId, itemId),
    fetchMilestone: (milestoneId) => rawStore.fetchMilestone(milestoneId),
    search: (ledgerId, query) => rawStore.search(ledgerId, query),
    ftsSearch: (query, opts) => rawStore.ftsSearch(query, opts),
    listMilestoneItems: (milestoneId) => rawStore.listMilestoneItems(milestoneId),
    snapshot: () => rawStore.snapshot(),
    invalidate: (ledgerId) => rawStore.invalidate(ledgerId),
    recordMcpUsage: (endpoint, bytesIn, bytesOut) =>
      rawStore.recordMcpUsage(endpoint, bytesIn, bytesOut),
    fetchMcpUsageStats: () => rawStore.fetchMcpUsageStats(),
    dispose: () => rawStore.dispose(),
    mutations,
    setRoots: (roots) => invocationAuthority.set(() => worksetStore.setRoots(roots)),
    snapshotRoots: () => worksetStore.snapshot(),
    activeAdmissionCount: () => worksetStore.activeAdmissionCount(),
  };

  assertNoPublicRawWriteEscape(surface);
  return surface;
}

/** Construct the direct trusted-host management surface. */
export function createWorksetManagementLedger(
  host: Omit<WorksetGenericMutationGatewayHost, "invocationAuthority">,
): WorksetGuardedLedger {
  return createWorksetGuardedLedger({
    ...host,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
  });
}

// ---------------------------------------------------------------------------
// Closed-graph target admission (shared by in-memory + filesystem factories)
// ---------------------------------------------------------------------------

/**
 * Build the coordinator `isTargetAdmitted` probe used by guarded factories:
 * empty roots admit everything; otherwise require closed-graph membership or
 * exact inactive-root equality against the live raw store.
 */
// ---------------------------------------------------------------------------
// In-memory Behavioral-Active dummy
// ---------------------------------------------------------------------------

export interface CreateInMemoryWorksetGuardedLedgerOptions {
  readonly now?: () => string;
  readonly seed?: Array<{ name: string; schema: LedgerSchema }>;
  readonly hooks?: WorksetAdmissionCoordinatorHooks;
  readonly afterGenericAdmit?: () => Promise<void> | void;
  readonly invocationAuthority?: WorksetInvocationAuthority;
}

/**
 * Strict hand-written in-memory dummy: {@link InMemoryLedgerStore} for
 * persistence + in-memory {@link WorksetStore} for roots/admission, exposed
 * only through {@link WorksetGuardedLedger}.
 *
 * Target admission uses closed-graph membership (plus exact inactive roots)
 * so ledger-mutation admits align with gateway validation.
 */
export function createInMemoryWorksetGuardedLedger(
  options: CreateInMemoryWorksetGuardedLedgerOptions = {},
): WorksetGuardedLedger {
  const rawStore = new InMemoryLedgerStore({
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  });

  // Shared probe consulted by the admission coordinator. Updated under the
  // same call stack as admit+validate; concurrent admits each rebuild from
  // the live store so membership stays coherent with the admitted epoch.
  const worksetStore = createInMemoryWorksetStore({
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    isTargetAdmitted: closedGraphIsTargetAdmitted(rawStore),
  });

  return createWorksetGuardedLedger({
    rawStore,
    worksetStore,
    runGenericTransaction: (mutate) =>
      rawStore.runAtomicGenericMutation(mutate, () => readWorksetRootsEpoch(worksetStore)),
    ...(options.invocationAuthority !== undefined
      ? { invocationAuthority: options.invocationAuthority }
      : {}),
    ...(options.afterGenericAdmit !== undefined
      ? { afterGenericAdmit: options.afterGenericAdmit }
      : {}),
  });
}

/** In-memory trusted-host management surface for direct administration and contracts. */
export function createInMemoryWorksetManagementLedger(
  options: Omit<CreateInMemoryWorksetGuardedLedgerOptions, "invocationAuthority"> = {},
): WorksetGuardedLedger {
  return createInMemoryWorksetGuardedLedger({
    ...options,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
  });
}

/**
 * Test helper: reject caller-minted admission lookalikes at the generic
 * mutation boundary (mirrors t3 {@link assertCallerCannotMintAdmission}).
 */
export function assertGenericMutationAdmissionNotCallerMinted(value: unknown): void {
  if (isLiveWorksetAdmission(value)) {
    throw new WorksetGenericMutationError(
      "caller-minted-admission",
      "live workset admissions are non-transferable and must not be re-supplied by callers",
    );
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "form" in value &&
    (value as { form: unknown }).form === "ledger-mutation"
  ) {
    throw new WorksetGenericMutationError(
      "caller-minted-admission",
      "caller-minted generic-mutation admission lookalikes are rejected",
    );
  }
}

/** Exhaustiveness helper used by the inventory test. */
export function inventoriedLedgerStoreMutationMethods(): readonly (keyof LedgerStore)[] {
  return WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS;
}

/** Sealed ownership field names covered by the inventory. */
export function inventoriedSealedOwnershipFields(): readonly string[] {
  return [...WORKSET_OWNED_FIELD_NAMES];
}

/** Canonical ledger count (for inventory stability checks). */
export function canonicalLedgerCount(): number {
  return CANONICAL_LEDGERS.length;
}
