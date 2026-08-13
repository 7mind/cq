/**
 * T1962 — owner-scoped lifecycle writes and coordination bundles (in-memory).
 *
 * Typed lifecycle capabilities that seal canonical ownership via the T1951
 * owner-edge matrix. Complements T1961's generic-mutation gateway:
 *  - generic mutations reject sealed ownership fields and deny creation under
 *    non-empty roots;
 *  - owned writes admit under t3 `owned-write`, validate owner membership +
 *    policy in the same critical section, derive sealed ownership, and commit
 *    either every requested item/link or none.
 *
 * Ownerless intake remains legal only when persisted roots are exactly empty.
 *
 * Coordination bundles cover multi-item atomic bootstraps (idea→goal,
 * defect→fix-goal, goal draft/manifest milestone+tasks).
 *
 * Backend legs (T1963+) implement the same public gateways over durable
 * adapters; the in-memory dummy below is the Behavioral-Active Blackbox
 * reference. Adapter failure injection stays out of the shared contract.
 */

import {
  DECISIONS_LEDGER,
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  HANDOFFS_LEDGER,
  HYPOTHESIS_LEDGER,
  IDEAS_LEDGER,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  QUESTIONS_LEDGER,
  RESEARCHES_LEDGER,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
} from "./constants.js";
import {
  buildActiveStateFromLedgerStore,
  createWorksetGuardedLedger,
  worksetMemberRefSet,
  type WorksetGenericMutationGatewayHost,
  type WorksetGuardedLedger,
  type WorksetLedgerReadSurface,
  type CreateInMemoryWorksetGuardedLedgerOptions,
} from "./worksetGenericMutation.js";
import {
  closeWorkset,
  type WorksetActiveState,
  type WorksetGraph,
} from "./worksetGraph.js";
import {
  deriveCanonicalOwnership,
  resolveOwnerEdgePolicy,
  type CanonicalOwnership,
  type LifecycleCreationKind,
} from "./worksetOwnerEdges.js";
import {
  isLiveWorksetAdmission,
  WorksetAdmissionError,
  type WorksetLedgerMutationAdmission,
  type WorksetRootsEpoch,
} from "./worksetEffectAdmission.js";
import {
  createInMemoryWorksetStore,
  readWorksetRootsEpoch,
} from "./worksetStore.js";
import {
  InMemoryLedgerStore,
  type InMemoryOwnedWriteTx,
} from "./store/InMemoryLedgerStore.js";
import type {
  CreateItemInit,
  CreateMilestoneItemInit,
  UpdateItemPatch,
} from "./store/LedgerStore.js";
import type { FieldValue, Item, LedgerSchema } from "./types.js";
import { LedgerError } from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type WorksetOwnedLifecycleErrorCode =
  | "owner-excluded"
  | "owner-policy-denied"
  | "ownerless-denied"
  | "forged-ownership"
  | "child-ledger-mismatch"
  | "bundle-incomplete"
  | "stale-epoch"
  | "caller-minted-admission"
  | "raw-write-escape"
  | "owner-not-found";

export class WorksetOwnedLifecycleError extends Error {
  readonly code: WorksetOwnedLifecycleErrorCode;
  constructor(code: WorksetOwnedLifecycleErrorCode, message: string) {
    super(message);
    this.name = "WorksetOwnedLifecycleError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public input / result shapes
// ---------------------------------------------------------------------------

export interface OwnedOwnerRef {
  readonly ledgerId: string;
  readonly itemId: string;
}

/** Caller-supplied child payload — must not include sealed ownership fields. */
export interface OwnedChildInit {
  readonly ledgerId: string;
  readonly milestoneId?: string;
  readonly status: string;
  readonly fields: Record<string, FieldValue>;
  readonly author?: string;
  readonly session?: string;
  readonly id?: string;
}

export interface OwnedCreateInput {
  readonly owner: OwnedOwnerRef;
  readonly creationKind: LifecycleCreationKind;
  readonly child: OwnedChildInit;
}

export interface OwnedCreateResult {
  readonly child: Item;
  readonly ownership: CanonicalOwnership;
  readonly ownerRef: string;
}

export interface OwnerlessCreateInput {
  readonly ledgerId: string;
  readonly milestoneId?: string;
  readonly status: string;
  readonly fields: Record<string, FieldValue>;
  readonly author?: string;
  readonly session?: string;
  readonly id?: string;
}

export interface IdeaToGoalBundleInput {
  readonly ideaId: string;
  readonly goal: {
    readonly title: string;
    readonly description: string;
    readonly status?: string;
    readonly fields?: Record<string, FieldValue>;
    readonly author?: string;
    readonly session?: string;
  };
  /** When true, mark the idea `planned` after the goal seals. Defaults false. */
  readonly consumeIdea?: boolean;
}

export interface IdeaToGoalBundleResult {
  readonly idea: Item;
  readonly goal: Item;
  readonly ownership: CanonicalOwnership;
}

export interface DefectToFixGoalBundleInput {
  readonly defectId: string;
  readonly goal: {
    readonly title: string;
    readonly description: string;
    readonly status?: string;
    readonly fields?: Record<string, FieldValue>;
    readonly author?: string;
    readonly session?: string;
  };
}

export interface DefectToFixGoalBundleResult {
  readonly defect: Item;
  readonly goal: Item;
  readonly ownership: CanonicalOwnership;
}

export interface OwnedDraftTaskInit {
  readonly headline: string;
  readonly status?: string;
  readonly fields?: Record<string, FieldValue>;
  readonly author?: string;
  readonly session?: string;
}

export interface OwnedDraftBundleInput {
  readonly goalId: string;
  /**
   * Must match the goal phase: `active-current-draft` in clarifying/planning,
   * `finalized-manifest` in planned/building.
   */
  readonly creationKind: "active-current-draft" | "finalized-manifest";
  readonly milestone: {
    readonly title: string;
    readonly description?: string;
    readonly author?: string;
    readonly session?: string;
  };
  readonly tasks: readonly OwnedDraftTaskInit[];
}

export interface OwnedDraftBundleResult {
  readonly goal: Item;
  readonly milestone: Item;
  readonly tasks: readonly Item[];
  readonly ownership: CanonicalOwnership;
}

// ---------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------

/**
 * Owner-scoped single-child lifecycle writes. Creation under a selected owner
 * derives and seals canonical ownership; ownerless intake is empty-roots only.
 */
export interface WorksetOwnedWriteGateway {
  readonly form: "workset-owned-write-gateway";
  createOwned(input: OwnedCreateInput): Promise<OwnedCreateResult>;
  createOwnerless(input: OwnerlessCreateInput): Promise<Item>;
}

/**
 * Multi-item atomic coordination bundles. Every requested item/link commits
 * together or the pre-operation state is restored.
 */
export interface WorksetCoordinationBundleGateway {
  readonly form: "workset-coordination-bundle-gateway";
  bootstrapIdeaToGoal(input: IdeaToGoalBundleInput): Promise<IdeaToGoalBundleResult>;
  bootstrapDefectToFixGoal(
    input: DefectToFixGoalBundleInput,
  ): Promise<DefectToFixGoalBundleResult>;
  publishOwnedDraft(input: OwnedDraftBundleInput): Promise<OwnedDraftBundleResult>;
}

/**
 * Full public guarded ledger: reads + generic mutations + owned writes +
 * coordination bundles. Raw {@link LedgerStore} write methods are not part of
 * this surface.
 */
export interface WorksetOwnedGuardedLedger extends WorksetGuardedLedger {
  readonly owned: WorksetOwnedWriteGateway;
  readonly bundles: WorksetCoordinationBundleGateway;
}

// ---------------------------------------------------------------------------
// Host / transaction abstraction
// ---------------------------------------------------------------------------

/**
 * Persistence host for owned writes. In-memory supplies an atomic multi-ledger
 * transaction; durable adapters will bind the same surface to real TX/CAS.
 */
export interface WorksetOwnedWriteHost extends WorksetGenericMutationGatewayHost {
  runOwnedTransaction<T>(mutate: (tx: WorksetOwnedWriteTx) => T | Promise<T>): Promise<T>;
  readonly afterOwnedAdmit?: () => Promise<void> | void;
}

export interface WorksetOwnedWriteTx {
  /** Fresh active state read under the same atomic boundary as the write. */
  activeState(): WorksetActiveState;
  fetchItem(ledgerId: string, itemId: string): Item;
  createItemWithSealedOwnership(
    ledgerId: string,
    milestoneId: string,
    init: CreateItemInit,
    sealedOwnership: CanonicalOwnership,
  ): Item;
  createMilestoneWithSealedOwnership(
    init: CreateMilestoneItemInit,
    sealedOwnership: CanonicalOwnership,
  ): Item;
  /** Empty-roots ownerless intake — no sealed ownership written. */
  createItemOwnerless(
    ledgerId: string,
    milestoneId: string,
    init: CreateItemInit,
  ): Item;
  createMilestoneOwnerless(init: CreateMilestoneItemInit): Item;
  updateItem(ledgerId: string, itemId: string, patch: UpdateItemPatch): Item;
  /**
   * Write plan draft/manifest bindings on a goal. Bypasses the raw-plan
   * managed-field fence because owned draft bundles are a typed lifecycle path
   * (parallel to PlanLifecycleStore publish).
   */
  writeGoalPhaseManifest(
    goalId: string,
    kind: "active-current-draft" | "finalized-manifest",
    manifestJson: string,
    draftEnvelopeJson?: string,
  ): Item;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function itemRef(ledgerId: string, itemId: string): string {
  return `${ledgerId}:${itemId}`;
}

function assertNoForgedOwnership(fields: Record<string, FieldValue> | undefined): void {
  if (fields === undefined) return;
  if (Object.prototype.hasOwnProperty.call(fields, WORKSET_OWNER_REF_FIELD)) {
    throw new WorksetOwnedLifecycleError(
      "forged-ownership",
      `caller must not supply sealed ownership field "${WORKSET_OWNER_REF_FIELD}"`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(fields, WORKSET_OWNER_EDGE_KIND_FIELD)) {
    throw new WorksetOwnedLifecycleError(
      "forged-ownership",
      `caller must not supply sealed ownership field "${WORKSET_OWNER_EDGE_KIND_FIELD}"`,
    );
  }
}

function buildOwnedValidationContext(
  state: WorksetActiveState,
  rootsEpoch: WorksetRootsEpoch,
): {
  readonly restrictive: boolean;
  readonly roots: readonly string[];
  readonly graph: WorksetGraph;
  readonly members: ReadonlySet<string>;
} {
  const graph = closeWorkset(rootsEpoch.roots, state);
  return {
    restrictive: graph.restrictive,
    roots: graph.roots,
    graph,
    members: worksetMemberRefSet(graph),
  };
}

function resolveAllowedOwnership(
  owner: Item,
  ownerLedger: string,
  creationKind: LifecycleCreationKind,
): CanonicalOwnership {
  const resolution = resolveOwnerEdgePolicy({
    ownerLedger,
    ownerStatus: owner.status,
    creationKind,
  });
  if (resolution.decision === "deny") {
    throw new WorksetOwnedLifecycleError(
      "owner-policy-denied",
      resolution.reason,
    );
  }
  return deriveCanonicalOwnership(ownerLedger, owner.id, resolution);
}

function assertChildLedgerAllowed(
  ownership: CanonicalOwnership,
  childLedger: string,
  creationKind: LifecycleCreationKind,
  ownerLedger: string,
  ownerStatus: string,
): void {
  const resolution = resolveOwnerEdgePolicy({
    ownerLedger,
    ownerStatus,
    creationKind,
  });
  if (resolution.decision === "deny") {
    throw new WorksetOwnedLifecycleError("owner-policy-denied", resolution.reason);
  }
  if (!resolution.childLedgers.includes(childLedger)) {
    throw new WorksetOwnedLifecycleError(
      "child-ledger-mismatch",
      `${creationKind} under ${ownerLedger} does not authorise child ledger ${childLedger}; allowed: ${resolution.childLedgers.join(", ")}`,
    );
  }
  // ownership.edgeKind already equals creationKind for allow rows.
  void ownership;
}

// ---------------------------------------------------------------------------
// Gateway implementation
// ---------------------------------------------------------------------------

export function createWorksetOwnedWriteGateway(
  host: WorksetOwnedWriteHost,
): WorksetOwnedWriteGateway {
  const { worksetStore, afterOwnedAdmit } = host;

  async function withOwnedAdmission<T>(
    targets: readonly string[],
    validateAndRun: (admission: WorksetLedgerMutationAdmission) => Promise<T>,
  ): Promise<T> {
    let admission: WorksetLedgerMutationAdmission;
    try {
      admission = await worksetStore.admitLedgerMutation({
        kind: "owned-write",
        targets: [...targets],
      });
    } catch (error) {
      if (error instanceof WorksetAdmissionError && error.code === "target-excluded") {
        throw new WorksetOwnedLifecycleError(
          "owner-excluded",
          error.message,
        );
      }
      throw error;
    }
    if (!isLiveWorksetAdmission(admission)) {
      throw new WorksetOwnedLifecycleError(
        "caller-minted-admission",
        "owned write requires a coordinator-granted live admission",
      );
    }
    try {
      if (afterOwnedAdmit !== undefined) {
        await afterOwnedAdmit();
      }
      const snap = await readWorksetRootsEpoch(worksetStore);
      if (snap.epoch !== admission.epoch) {
        throw new WorksetOwnedLifecycleError(
          "stale-epoch",
          "workset epoch advanced before owned-write critical section",
        );
      }
      return await validateAndRun(admission);
    } finally {
      await admission.acknowledge();
    }
  }

  const gateway: WorksetOwnedWriteGateway = {
    form: "workset-owned-write-gateway",

    async createOwned(input) {
      assertNoForgedOwnership(input.child.fields);
      if (
        input.creationKind === "active-current-draft" ||
        input.creationKind === "finalized-manifest"
      ) {
        throw new WorksetOwnedLifecycleError(
          "bundle-incomplete",
          `${input.creationKind} requires publishOwnedDraft so milestone, tasks, and manifest commit atomically`,
        );
      }
      const ownerRef = itemRef(input.owner.ledgerId, input.owner.itemId);
      return withOwnedAdmission([ownerRef], async (admission) => {
        return host.runOwnedTransaction((tx) => {
          const ctx = buildOwnedValidationContext(tx.activeState(), {
            roots: admission.roots,
            epoch: admission.epoch,
          });
          if (ctx.restrictive && !ctx.members.has(ownerRef)) {
            throw new WorksetOwnedLifecycleError(
              "owner-excluded",
              `owner "${ownerRef}" is outside the admitted workset`,
            );
          }
          let owner: Item;
          try {
            owner = tx.fetchItem(input.owner.ledgerId, input.owner.itemId);
          } catch {
            throw new WorksetOwnedLifecycleError(
              "owner-not-found",
              `owner "${ownerRef}" does not exist`,
            );
          }
          const ownership = resolveAllowedOwnership(
            owner,
            input.owner.ledgerId,
            input.creationKind,
          );
          assertChildLedgerAllowed(
            ownership,
            input.child.ledgerId,
            input.creationKind,
            input.owner.ledgerId,
            owner.status,
          );
          const milestoneId = input.child.milestoneId ?? MILESTONES_AMBIENT_ID;
          const init: CreateItemInit = {
            status: input.child.status,
            fields: { ...input.child.fields },
          };
          if (input.child.id !== undefined) init.id = input.child.id;
          if (input.child.author !== undefined) init.author = input.child.author;
          if (input.child.session !== undefined) init.session = input.child.session;

          let child: Item;
          if (input.child.ledgerId === MILESTONES_LEDGER) {
            const title = init.fields.title;
            if (typeof title !== "string") {
              throw new WorksetOwnedLifecycleError(
                "bundle-incomplete",
                "milestone child requires string title field",
              );
            }
            const mInit: CreateMilestoneItemInit = { title };
            if (typeof init.fields.description === "string") {
              mInit.description = init.fields.description;
            }
            if (init.id !== undefined) mInit.id = init.id;
            if (init.author !== undefined) mInit.author = init.author;
            if (init.session !== undefined) mInit.session = init.session;
            child = tx.createMilestoneWithSealedOwnership(mInit, ownership);
          } else {
            child = tx.createItemWithSealedOwnership(
              input.child.ledgerId,
              milestoneId,
              init,
              ownership,
            );
          }
          return { child, ownership, ownerRef };
        });
      });
    },

    async createOwnerless(input) {
      assertNoForgedOwnership(input.fields);
      return withOwnedAdmission([], async (adm) => {
        if (adm.roots.length > 0) {
          throw new WorksetOwnedLifecycleError(
            "ownerless-denied",
            "ownerless intake is legal only when persisted workset roots are exactly empty",
          );
        }
        return host.runOwnedTransaction((tx) => {
          const milestoneId = input.milestoneId ?? MILESTONES_AMBIENT_ID;
          const init: CreateItemInit = {
            status: input.status,
            fields: { ...input.fields },
          };
          if (input.id !== undefined) init.id = input.id;
          if (input.author !== undefined) init.author = input.author;
          if (input.session !== undefined) init.session = input.session;
          if (input.ledgerId === MILESTONES_LEDGER) {
            const title = init.fields.title;
            if (typeof title !== "string") {
              throw new LedgerError("ownerless milestone requires string title");
            }
            const mInit: CreateMilestoneItemInit = { title };
            if (typeof init.fields.description === "string") {
              mInit.description = init.fields.description;
            }
            if (init.id !== undefined) mInit.id = init.id;
            if (init.author !== undefined) mInit.author = init.author;
            if (init.session !== undefined) mInit.session = init.session;
            return tx.createMilestoneOwnerless(mInit);
          }
          return tx.createItemOwnerless(input.ledgerId, milestoneId, init);
        });
      });
    },
  };

  Object.freeze(gateway);
  return gateway;
}

export function createWorksetCoordinationBundleGateway(
  host: WorksetOwnedWriteHost,
): WorksetCoordinationBundleGateway {
  const { worksetStore, afterOwnedAdmit } = host;

  async function withOwnedAdmission<T>(
    targets: readonly string[],
    validateAndRun: (admission: WorksetLedgerMutationAdmission) => Promise<T>,
  ): Promise<T> {
    let admission: WorksetLedgerMutationAdmission;
    try {
      admission = await worksetStore.admitLedgerMutation({
        kind: "owned-write",
        targets: [...targets],
      });
    } catch (error) {
      if (error instanceof WorksetAdmissionError && error.code === "target-excluded") {
        throw new WorksetOwnedLifecycleError("owner-excluded", error.message);
      }
      throw error;
    }
    if (!isLiveWorksetAdmission(admission)) {
      throw new WorksetOwnedLifecycleError(
        "caller-minted-admission",
        "coordination bundle requires a coordinator-granted live admission",
      );
    }
    try {
      if (afterOwnedAdmit !== undefined) {
        await afterOwnedAdmit();
      }
      const snap = await readWorksetRootsEpoch(worksetStore);
      if (snap.epoch !== admission.epoch) {
        throw new WorksetOwnedLifecycleError(
          "stale-epoch",
          "workset epoch advanced before coordination-bundle critical section",
        );
      }
      return await validateAndRun(admission);
    } finally {
      await admission.acknowledge();
    }
  }

  const gateway: WorksetCoordinationBundleGateway = {
    form: "workset-coordination-bundle-gateway",

    async bootstrapIdeaToGoal(input) {
      assertNoForgedOwnership(input.goal.fields);
      const ownerRef = itemRef(IDEAS_LEDGER, input.ideaId);
      return withOwnedAdmission([ownerRef], async (admission) => {
        return host.runOwnedTransaction((tx) => {
          const ctx = buildOwnedValidationContext(tx.activeState(), {
            roots: admission.roots,
            epoch: admission.epoch,
          });
          if (ctx.restrictive && !ctx.members.has(ownerRef)) {
            throw new WorksetOwnedLifecycleError(
              "owner-excluded",
              `owner "${ownerRef}" is outside the admitted workset`,
            );
          }
          let idea: Item;
          try {
            idea = tx.fetchItem(IDEAS_LEDGER, input.ideaId);
          } catch {
            throw new WorksetOwnedLifecycleError(
              "owner-not-found",
              `idea "${ownerRef}" does not exist`,
            );
          }
          const ownership = resolveAllowedOwnership(idea, IDEAS_LEDGER, "idea-to-goal");
          const goalFields: Record<string, FieldValue> = {
            title: input.goal.title,
            description: input.goal.description,
            ...(input.goal.fields ?? {}),
          };
          assertNoForgedOwnership(goalFields);
          const goalInit: CreateItemInit = {
            status: input.goal.status ?? "clarifying",
            fields: goalFields,
          };
          if (input.goal.author !== undefined) goalInit.author = input.goal.author;
          if (input.goal.session !== undefined) goalInit.session = input.goal.session;
          const goal = tx.createItemWithSealedOwnership(
            GOALS_LEDGER,
            MILESTONES_AMBIENT_ID,
            goalInit,
            ownership,
          );
          let finalIdea = idea;
          const consume = input.consumeIdea === true;
          if (consume && idea.status !== "planned" && idea.status !== "discarded") {
            finalIdea = tx.updateItem(IDEAS_LEDGER, idea.id, { status: "planned" });
          }
          return { idea: finalIdea, goal, ownership };
        });
      });
    },

    async bootstrapDefectToFixGoal(input) {
      assertNoForgedOwnership(input.goal.fields);
      const ownerRef = itemRef(DEFECTS_LEDGER, input.defectId);
      return withOwnedAdmission([ownerRef], async (admission) => {
        return host.runOwnedTransaction((tx) => {
          const ctx = buildOwnedValidationContext(tx.activeState(), {
            roots: admission.roots,
            epoch: admission.epoch,
          });
          if (ctx.restrictive && !ctx.members.has(ownerRef)) {
            throw new WorksetOwnedLifecycleError(
              "owner-excluded",
              `owner "${ownerRef}" is outside the admitted workset`,
            );
          }
          let defect: Item;
          try {
            defect = tx.fetchItem(DEFECTS_LEDGER, input.defectId);
          } catch {
            throw new WorksetOwnedLifecycleError(
              "owner-not-found",
              `defect "${ownerRef}" does not exist`,
            );
          }
          const ownership = resolveAllowedOwnership(defect, DEFECTS_LEDGER, "fix-goal");
          const goalFields: Record<string, FieldValue> = {
            title: input.goal.title,
            description: input.goal.description,
            ...(input.goal.fields ?? {}),
          };
          assertNoForgedOwnership(goalFields);
          const goalInit: CreateItemInit = {
            status: input.goal.status ?? "clarifying",
            fields: goalFields,
          };
          if (input.goal.author !== undefined) goalInit.author = input.goal.author;
          if (input.goal.session !== undefined) goalInit.session = input.goal.session;
          const goal = tx.createItemWithSealedOwnership(
            GOALS_LEDGER,
            MILESTONES_AMBIENT_ID,
            goalInit,
            ownership,
          );
          return { defect, goal, ownership };
        });
      });
    },

    async publishOwnedDraft(input) {
      if (input.tasks.length === 0) {
        throw new WorksetOwnedLifecycleError(
          "bundle-incomplete",
          "owned draft bundle requires at least one task",
        );
      }
      const ownerRef = itemRef(GOALS_LEDGER, input.goalId);
      return withOwnedAdmission([ownerRef], async (admission) => {
        return host.runOwnedTransaction((tx) => {
          const ctx = buildOwnedValidationContext(tx.activeState(), {
            roots: admission.roots,
            epoch: admission.epoch,
          });
          if (ctx.restrictive && !ctx.members.has(ownerRef)) {
            throw new WorksetOwnedLifecycleError(
              "owner-excluded",
              `owner "${ownerRef}" is outside the admitted workset`,
            );
          }
          let goal: Item;
          try {
            goal = tx.fetchItem(GOALS_LEDGER, input.goalId);
          } catch {
            throw new WorksetOwnedLifecycleError(
              "owner-not-found",
              `goal "${ownerRef}" does not exist`,
            );
          }
          const ownership = resolveAllowedOwnership(
            goal,
            GOALS_LEDGER,
            input.creationKind,
          );
          const mInit: CreateMilestoneItemInit = { title: input.milestone.title };
          if (input.milestone.description !== undefined) {
            mInit.description = input.milestone.description;
          }
          if (input.milestone.author !== undefined) mInit.author = input.milestone.author;
          if (input.milestone.session !== undefined) mInit.session = input.milestone.session;
          const milestone = tx.createMilestoneWithSealedOwnership(mInit, ownership);
          const tasks: Item[] = [];
          for (const taskInit of input.tasks) {
            const fields: Record<string, FieldValue> = {
              headline: taskInit.headline,
              ...(taskInit.fields ?? {}),
            };
            assertNoForgedOwnership(fields);
            const init: CreateItemInit = {
              status: taskInit.status ?? "planned",
              fields,
            };
            if (taskInit.author !== undefined) init.author = taskInit.author;
            if (taskInit.session !== undefined) init.session = taskInit.session;
            tasks.push(
              tx.createItemWithSealedOwnership(
                TASKS_LEDGER,
                milestone.id,
                init,
                ownership,
              ),
            );
          }
          // Bind the phase manifest so T1952 closure admits sealed draft members.
          const revision = 1;
          const manifest = {
            revision,
            milestones: [{ key: `ms${milestone.id}`, id: milestone.id }],
            tasks: tasks.map((t, i) => ({ key: `task${i}`, id: t.id })),
          };
          const manifestJson = JSON.stringify(manifest);
          if (input.creationKind === "active-current-draft") {
            const identity = {
              goalId: goal.id,
              claimId: `owned-draft-${goal.id}`,
              generation: 1,
              revision,
            };
            goal = tx.writeGoalPhaseManifest(
              goal.id,
              "active-current-draft",
              manifestJson,
              JSON.stringify({ identity, manifest }),
            );
          } else {
            goal = tx.writeGoalPhaseManifest(
              goal.id,
              "finalized-manifest",
              manifestJson,
            );
          }
          return { goal, milestone, tasks, ownership };
        });
      });
    },
  };

  Object.freeze(gateway);
  return gateway;
}

// ---------------------------------------------------------------------------
// Public surface assembly
// ---------------------------------------------------------------------------

export function createWorksetOwnedGuardedLedger(
  host: WorksetOwnedWriteHost,
): WorksetOwnedGuardedLedger {
  const base = createWorksetGuardedLedger(host);
  const owned = createWorksetOwnedWriteGateway(host);
  const bundles = createWorksetCoordinationBundleGateway(host);

  const surface: WorksetOwnedGuardedLedger = {
    ...base,
    owned,
    bundles,
  };
  // Re-assert: spreading must not have reintroduced raw writes.
  for (const method of [
    "updateMilestone",
    "updateItem",
    "createItem",
    "createMilestone",
    "createLedger",
    "reopenItem",
    "unarchiveItem",
    "archiveMilestone",
  ] as const) {
    if (typeof (surface as unknown as Record<string, unknown>)[method] === "function") {
      throw new WorksetOwnedLifecycleError(
        "raw-write-escape",
        `public owned guarded ledger must not expose raw write method "${method}"`,
      );
    }
  }
  return surface;
}

// ---------------------------------------------------------------------------
// In-memory dummy
// ---------------------------------------------------------------------------

export interface CreateInMemoryWorksetOwnedGuardedLedgerOptions
  extends CreateInMemoryWorksetGuardedLedgerOptions {
  readonly afterOwnedAdmit?: () => Promise<void> | void;
}

/**
 * Strict hand-written in-memory dummy for owned writes + coordination bundles.
 * Shares one {@link InMemoryLedgerStore} + {@link WorksetStore} across the
 * generic-mutation gateway and the owned/bundle gateways.
 */
export function createInMemoryWorksetOwnedGuardedLedger(
  options: CreateInMemoryWorksetOwnedGuardedLedgerOptions = {},
): WorksetOwnedGuardedLedger {
  const rawStore = new InMemoryLedgerStore({
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  });

  const worksetStore = createInMemoryWorksetStore({
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    isTargetAdmitted: (target, roots) => {
      if (roots.length === 0) return true;
      try {
        const state = buildActiveStateFromLedgerStore(rawStore);
        const graph = closeWorkset(roots, state);
        if (worksetMemberRefSet(graph).has(target)) return true;
        if (graph.inactiveRoots.includes(target)) return true;
        return false;
      } catch {
        return false;
      }
    },
  });

  const host: WorksetOwnedWriteHost = {
    rawStore,
    worksetStore,
    ...(options.invocationAuthority !== undefined
      ? { invocationAuthority: options.invocationAuthority }
      : {}),
    ...(options.afterGenericAdmit !== undefined
      ? { afterGenericAdmit: options.afterGenericAdmit }
      : {}),
    ...(options.afterOwnedAdmit !== undefined
      ? { afterOwnedAdmit: options.afterOwnedAdmit }
      : {}),
    runOwnedTransaction: async (mutate) =>
      rawStore.runAtomicOwnedMutation((baseTx: InMemoryOwnedWriteTx) => mutate(baseTx)),
  };

  return createWorksetOwnedGuardedLedger(host);
}

/** Test helper: reject caller-minted owned-write admission lookalikes. */
export function assertOwnedWriteAdmissionNotCallerMinted(value: unknown): void {
  if (isLiveWorksetAdmission(value)) {
    throw new WorksetOwnedLifecycleError(
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
    throw new WorksetOwnedLifecycleError(
      "caller-minted-admission",
      "caller-minted owned-write admission lookalikes are rejected",
    );
  }
}

/** Creation kinds the owned-write gateway must cover (union of both inventories). */
export const WORKSET_OWNED_WRITE_CREATION_KINDS = [
  "idea-to-goal",
  "active-current-draft",
  "finalized-manifest",
  "exact-gate-question",
  "review",
  "review-filed-defect",
  "implementation-defect",
  "research",
  "hypothesis",
  "decision",
  "fix-goal",
  "handoff",
] as const satisfies readonly LifecycleCreationKind[];

export type WorksetOwnedWriteCreationKind =
  (typeof WORKSET_OWNED_WRITE_CREATION_KINDS)[number];

/** Default child ledger for single-child kinds (not multi-ledger draft kinds). */
export function defaultChildLedgerForCreationKind(
  kind: LifecycleCreationKind,
): string | readonly string[] {
  switch (kind) {
    case "idea-to-goal":
    case "fix-goal":
      return GOALS_LEDGER;
    case "active-current-draft":
    case "finalized-manifest":
      return [MILESTONES_LEDGER, TASKS_LEDGER];
    case "exact-gate-question":
      return QUESTIONS_LEDGER;
    case "review":
      return REVIEWS_LEDGER;
    case "review-filed-defect":
    case "implementation-defect":
      return DEFECTS_LEDGER;
    case "research":
      return RESEARCHES_LEDGER;
    case "hypothesis":
      return HYPOTHESIS_LEDGER;
    case "decision":
      return DECISIONS_LEDGER;
    case "handoff":
      return HANDOFFS_LEDGER;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

// Silence unused type import for LedgerSchema in options re-export path.
export type { LedgerSchema, WorksetLedgerReadSurface };
