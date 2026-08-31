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
 * Under non-empty (restrictive) roots:
 *  - generic creation (`createItem` / `createMilestone`) is denied
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
  MILESTONES_LEDGER,
} from "./constants.js";
import {
  closeWorkset,
  defaultWorksetPrefixRegistry,
  type WorksetGraph,
} from "./worksetGraph.js";
import {
  assertWorksetOwnershipFieldsAbsent,
  WorksetOwnershipFieldError,
} from "./worksetOwnerEdges.js";
import type { FinalizeBatchOperation } from "./finalize.js";
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
  CreateItemInit,
  CreateMilestoneItemInit,
  FetchedMilestoneItem,
  FtsSearchHit,
  FtsSearchOpts,
  LedgerStore,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "./store/LedgerStore.js";
import type {
  ArchivePointer,
  FetchedLedger,
  FieldValue,
  Item,
  LedgerSchema,
} from "./types.js";
import { LedgerError } from "./types.js";
import type { LedgerSnapshot } from "./snapshot.js";
import type { UsageStatsSnapshot } from "./usageStats.js";
import type {
  ArchiveTerminalItemsGatePolicy,
  ArchiveTerminalItemsResult,
  WorksetGenericMutationTx,
} from "./store/genericMutationTransaction.js";
import { CANONICAL_LEDGERS } from "./constants.js";

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
 * - `require-sweep-in-graph` — every archive sweep member must be in the graph
 */
export type WorksetGenericMutationRestrictivePolicy =
  | "deny"
  | "require-target-in-graph"
  | "require-exact-inactive-root"
  | "require-sweep-in-graph";

export interface WorksetGenericMutationOperationClause {
  readonly kind: WorksetGenericMutationOperationKind;
  /** LedgerStore method name this clause covers. */
  readonly method: keyof LedgerStore;
  readonly restrictive: WorksetGenericMutationRestrictivePolicy;
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
      unrestricted: "allow",
    },
    {
      kind: "create-milestone",
      method: "createMilestone",
      restrictive: "deny",
      unrestricted: "allow",
    },
    {
      kind: "create-item",
      method: "createItem",
      restrictive: "deny",
      unrestricted: "allow",
    },
    {
      kind: "update-milestone",
      method: "updateMilestone",
      restrictive: "require-target-in-graph",
      unrestricted: "allow",
    },
    {
      kind: "update-item",
      method: "updateItem",
      restrictive: "require-target-in-graph",
      unrestricted: "allow",
    },
    {
      kind: "reopen-item",
      method: "reopenItem",
      restrictive: "require-target-in-graph",
      unrestricted: "allow",
    },
    {
      kind: "unarchive-item",
      method: "unarchiveItem",
      restrictive: "require-exact-inactive-root",
      unrestricted: "allow",
    },
    {
      kind: "archive-milestone",
      method: "archiveMilestone",
      restrictive: "require-sweep-in-graph",
      unrestricted: "allow",
    },
  ] as const;

/** Field classification for generic create/update payloads. */
export type WorksetGenericMutationFieldKind =
  | "eligibility"
  | "closure-forming"
  | "advisory"
  | "sealed-ownership"
  | "ordinary";

export type WorksetGenericMutationFieldRestrictivePolicy =
  | "require-target-in-graph"
  | "require-introduced-refs-in-graph"
  | "allow"
  | "reject";

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
  ): Promise<Item>;
  updateItem(ledgerId: string, itemId: string, patch: UpdateItemPatch): Promise<Item>;
  createItem(
    ledgerId: string,
    milestoneId: string,
    init: CreateItemInit,
  ): Promise<Item>;
  createMilestone(init: CreateMilestoneItemInit): Promise<Item>;
  createLedger(name: string, schema: LedgerSchema): Promise<FetchedLedger>;
  reopenItem(ledgerId: string, itemId: string, toStatus: string): Promise<Item>;
  unarchiveItem(
    ledgerId: string,
    milestoneId: string,
    itemId: string,
  ): Promise<Item>;
  archiveTerminalItems(
    ledgerIds: readonly string[],
    summary: string,
    gatePolicy: ArchiveTerminalItemsGatePolicy,
  ): Promise<ArchiveTerminalItemsResult>;
  executeFinalize(operations: readonly FinalizeBatchOperation[]): Promise<{ applied: number }>;
  archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer>;
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

function asStringArray(value: FieldValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
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

function assertIntroducedRefsInGraph(
  ctx: ValidationContext,
  introduced: readonly string[],
): void {
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
      throw new WorksetGenericMutationError(
        "sealed-ownership",
        error.message,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Gateway implementation over a raw LedgerStore + WorksetStore
// ---------------------------------------------------------------------------

export interface WorksetGenericMutationGatewayHost {
  /** Raw persistence adapter — never exposed on the public surface. */
  readonly rawStore: LedgerStore;
  /** Workset roots + t3 admission coordinator. */
  readonly worksetStore: WorksetStore;
  /** Runtime authority carried outside invocation arguments. */
  readonly invocationAuthority?: WorksetInvocationAuthority;
  readonly runGenericTransaction?: <T>(
    mutate: (tx: WorksetGenericMutationTx, roots: WorksetRootsEpoch) => T,
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
      readRoots?: () => Promise<WorksetRootsEpoch>,
    ): Promise<T>;
  };
  const runGenericTransaction =
    host.runGenericTransaction ??
    (<T>(mutate: (tx: WorksetGenericMutationTx, roots: WorksetRootsEpoch) => T) =>
      atomicStore.runAtomicGenericMutation(mutate, () => readWorksetRootsEpoch(worksetStore)));

  async function withGenericAdmission<T>(
    targets: readonly string[],
    validateAndRun: (
      tx: WorksetGenericMutationTx,
      admission: WorksetLedgerMutationAdmission,
      ctx: ValidationContext,
    ) => T,
    options: {
      /** Map coordinator target-excluded into a gateway-specific code. */
      readonly onTargetExcluded?: (
        cause: WorksetAdmissionError,
      ) => WorksetGenericMutationError;
    } = {},
  ): Promise<T> {
    let admission: WorksetLedgerMutationAdmission;
    try {
      admission = await worksetStore.admitLedgerMutation({
        kind: "generic-write",
        targets: [...targets],
      });
    } catch (error) {
      if (error instanceof WorksetAdmissionError && error.code === "target-excluded") {
        if (options.onTargetExcluded !== undefined) {
          throw options.onTargetExcluded(error);
        }
        throw new WorksetGenericMutationError("target-excluded", error.message);
      }
      throw error;
    }
    if (!isLiveWorksetAdmission(admission)) {
      throw new WorksetGenericMutationError(
        "caller-minted-admission",
        "generic mutation requires a coordinator-granted live admission",
      );
    }
    try {
      if (afterGenericAdmit !== undefined) {
        await afterGenericAdmit();
      }
      return await runGenericTransaction((tx, snap) => {
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
      });
    } finally {
      await admission.acknowledge();
    }
  }

  const gateway: WorksetGenericMutationGateway = {
    form: "workset-generic-mutation-gateway",

    async updateMilestone(milestoneId, patch) {
      const ref = itemRef(MILESTONES_LEDGER, milestoneId);
      const fieldBag: Record<string, FieldValue> = {};
      if (patch.title !== undefined) fieldBag.title = patch.title;
      if (patch.description !== undefined) fieldBag.description = patch.description;
      if (patch.blockedBy !== undefined) fieldBag.blockedBy = patch.blockedBy;
      if (patch.dependsOn !== undefined) fieldBag.dependsOn = patch.dependsOn;

      return withGenericAdmission([ref], (tx, _adm, ctx) => {
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
      });
    },

    async updateItem(ledgerId, itemId, patch) {
      const ref = itemRef(ledgerId, itemId);
      return withGenericAdmission([ref], (tx, _adm, ctx) => {
        assertTargetInGraph(ctx, ref);
        let existing: Item | undefined;
        try {
          existing = tx.fetchItem(ledgerId, itemId);
        } catch {
          existing = undefined;
        }
        assertSealedOwnershipAbsent(patch.fields, existing);
        const introduced = introducedClosureRefs(
          existing?.fields,
          patch.fields,
          ctx.prefixRegistry,
        );
        assertIntroducedRefsInGraph(ctx, introduced);
        // Include introduced refs in the atomic mixed-target check.
        if (ctx.restrictive) {
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
      });
    },

    async createItem(ledgerId, milestoneId, init) {
      // Restrictive denial uses admission.roots inside the held t3 section
      // (not a pre-admit read) so concurrent setRoots cannot TOCTOU create.
      // Sealed-ownership is checked after creation-denied so the deny code is
      // stable under restrictive roots.
      return withGenericAdmission([], (tx, adm) => {
        if (adm.roots.length > 0) {
          throw new WorksetGenericMutationError(
            "creation-denied",
            "generic createItem is denied under non-empty workset roots; use owner-scoped lifecycle writes",
          );
        }
        assertSealedOwnershipAbsent(init.fields);
        return tx.createItem(ledgerId, milestoneId, init);
      });
    },

    async createMilestone(init) {
      const fields: Record<string, FieldValue> = { title: init.title };
      if (init.description !== undefined) fields.description = init.description;
      if (init.blockedBy !== undefined) fields.blockedBy = init.blockedBy;
      if (init.dependsOn !== undefined) fields.dependsOn = init.dependsOn;
      return withGenericAdmission([], (tx, adm) => {
        if (adm.roots.length > 0) {
          throw new WorksetGenericMutationError(
            "creation-denied",
            "generic createMilestone is denied under non-empty workset roots; use owner-scoped lifecycle writes",
          );
        }
        assertSealedOwnershipAbsent(fields);
        return tx.createMilestone(init);
      });
    },

    async createLedger(name, schema) {
      return withGenericAdmission([], (tx, adm) => {
        if (adm.roots.length > 0) {
          throw new WorksetGenericMutationError(
            "create-ledger-denied",
            "createLedger is denied under non-empty workset roots",
          );
        }
        return tx.createLedger(name, schema);
      });
    },

    async reopenItem(ledgerId, itemId, toStatus) {
      const ref = itemRef(ledgerId, itemId);
      return withGenericAdmission([ref], (tx, _adm, ctx) => {
        assertTargetInGraph(ctx, ref);
        return tx.reopenItem(ledgerId, itemId, toStatus);
      });
    },

    async unarchiveItem(ledgerId, milestoneId, itemId) {
      const ref = itemRef(ledgerId, itemId);
      return withGenericAdmission(
        [ref],
        (tx, _adm, ctx) => {
          if (ctx.restrictive) {
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
          onTargetExcluded: (cause) =>
            new WorksetGenericMutationError(
              "unarchive-not-exact-inactive-root",
              `unarchiveItem is limited to an exact configured inactive root; "${ref}" is not one (${cause.message})`,
            ),
        },
      );
    },

    async archiveTerminalItems(ledgerIds, summary, gatePolicy) {
      return withGenericAdmission([], (tx, adm) => {
        if (adm.roots.length > 0) {
          throw new WorksetGenericMutationError(
            "archive-terminal-items-denied",
            "archiveTerminalItems is denied under non-empty workset roots",
          );
        }
        return tx.archiveTerminalItems(ledgerIds, summary, gatePolicy);
      });
    },

    async executeFinalize(operations) {
      const admissionTargets = operations.flatMap((operation) => {
        switch (operation.action) {
          case "close-milestone":
            return [itemRef(MILESTONES_LEDGER, operation.targetId)];
          case "close-goal":
            return [itemRef("goals", operation.targetId)];
          case "archive-milestone": {
            const sweep = collectArchiveSweepRefs(rawStore, operation.targetId);
            return sweep.length > 0
              ? sweep
              : [itemRef(MILESTONES_LEDGER, operation.targetId)];
          }
        }
      });
      return withGenericAdmission(admissionTargets, (tx, _adm, ctx) => {
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
            case "close-milestone":
              assertTargetInGraph(ctx, itemRef(MILESTONES_LEDGER, operation.targetId));
              if (operation.targetStatus === undefined) {
                throw new LedgerError(
                  `finalize operation ${operation.id} requires targetStatus`,
                );
              }
              tx.updateMilestone(operation.targetId, { status: operation.targetStatus });
              break;
            case "close-goal":
              assertTargetInGraph(ctx, itemRef("goals", operation.targetId));
              if (operation.targetStatus === undefined) {
                throw new LedgerError(
                  `finalize operation ${operation.id} requires targetStatus`,
                );
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
      });
    },

    async archiveMilestone(milestoneId, summary) {
      // Resolve the live sweep first so admission targets cover every member;
      // re-check inside the critical section for linearizability.
      const preSweep = collectArchiveSweepRefs(rawStore, milestoneId);
      const admitTargets =
        preSweep.length > 0
          ? preSweep
          : [itemRef(MILESTONES_LEDGER, milestoneId)];
      return withGenericAdmission(
        admitTargets,
        (tx, _adm, ctx) => {
          const sweep = tx.collectArchiveSweepRefs(milestoneId);
          if (ctx.restrictive) {
            const missing = sweep.filter((ref) => !ctx.members.has(ref));
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
      rawStore.runAtomicGenericMutation(
        mutate,
        () => readWorksetRootsEpoch(worksetStore),
      ),
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
  return WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES.map((c) => c.method);
}

/** Sealed ownership field names covered by the inventory. */
export function inventoriedSealedOwnershipFields(): readonly string[] {
  return [...WORKSET_OWNED_FIELD_NAMES];
}

/** Canonical ledger count (for inventory stability checks). */
export function canonicalLedgerCount(): number {
  return CANONICAL_LEDGERS.length;
}
