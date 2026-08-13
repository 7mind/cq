/**
 * T1967 — workset-guarded planning lifecycle.
 *
 * Each operation acquires one t3 ledger-mutation admission for its goal, then
 * validates every pre-existing item the operation can replace or update from a
 * fresh all-ledger snapshot inside the persistence transaction. Newly created
 * planning effects must carry the canonical t1 goal-owner edge before commit.
 */

import {
  DEFECTS_LEDGER,
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_LEDGER,
  QUESTIONS_LEDGER,
  RESEARCHES_LEDGER,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
} from "./constants.js";
import {
  PLAN_CURRENT_DRAFT_FIELD,
  PLAN_FINALIZED_MANIFEST_FIELD,
  PlanClaimResultSchema,
  PlanFinalizeResultSchema,
  PlanPublishDraftResultSchema,
  PlanPublishedManifestSchema,
  PlanReleaseResultSchema,
  normalizeTaskRef,
  type PlanClaimInput,
  type PlanClaimResult,
  type PlanFinalizeInput,
  type PlanFinalizeResult,
  type PlanLifecycleStore,
  type PlanPublishDraftInput,
  type PlanPublishDraftResult,
  type PlanPublishedManifest,
  type PlanReleaseInput,
  type PlanReleaseResult,
} from "./planLifecycle.js";
import {
  buildActiveStateFromLedgerStore,
  type CreateInMemoryWorksetGuardedLedgerOptions,
} from "./worksetGenericMutation.js";
import {
  createWorksetOwnedGuardedLedger,
  type CreateInMemoryWorksetOwnedGuardedLedgerOptions,
  type WorksetOwnedGuardedLedger,
  type WorksetOwnedWriteHost,
} from "./worksetOwnedLifecycle.js";
import {
  closeWorkset,
  type WorksetActiveState,
} from "./worksetGraph.js";
import { readCanonicalOwnership, type WorksetOwnerEdgeKind } from "./worksetOwnerEdges.js";
import {
  isLiveWorksetAdmission,
  WorksetAdmissionError,
  type WorksetLedgerMutationAdmission,
  type WorksetPlanLifecycleMutationKind,
} from "./worksetEffectAdmission.js";
import {
  createInMemoryWorksetStore,
  readWorksetRootsEpoch,
} from "./worksetStore.js";
import {
  InMemoryLedgerStore,
  type InMemoryOwnedWriteTx,
  type InMemoryWorksetPlanLifecycleTx,
} from "./store/InMemoryLedgerStore.js";
import type { Item } from "./types.js";

type WorksetPlanLifecycleOperation =
  | { readonly kind: "claim-plan"; readonly input: PlanClaimInput }
  | { readonly kind: "publish-plan-draft"; readonly input: PlanPublishDraftInput }
  | { readonly kind: "release-plan-claim"; readonly input: PlanReleaseInput }
  | { readonly kind: "finalize-plan"; readonly input: PlanFinalizeInput };

export type WorksetPlanLifecycleErrorCode =
  | "goal-excluded"
  | "affected-item-excluded"
  | "stale-epoch"
  | "caller-minted-admission"
  | "canonical-ownership-missing";

export class WorksetPlanLifecycleError extends Error {
  readonly code: WorksetPlanLifecycleErrorCode;
  readonly refs: readonly string[];
  constructor(
    code: WorksetPlanLifecycleErrorCode,
    message: string,
    refs: readonly string[] = [],
  ) {
    super(message);
    this.name = "WorksetPlanLifecycleError";
    this.code = code;
    this.refs = [...new Set(refs)].sort();
  }
}

export interface WorksetPlanLifecycleTx {
  activeState(): WorksetActiveState;
  claimPlan(input: PlanClaimInput): PlanClaimResult;
  publishPlanDraft(input: PlanPublishDraftInput): PlanPublishDraftResult;
  releasePlanClaim(input: PlanReleaseInput): PlanReleaseResult;
  finalizePlan(input: PlanFinalizeInput): PlanFinalizeResult;
}

export interface WorksetPlanLifecycleHost extends WorksetOwnedWriteHost {
  runPlanLifecycleTransaction<T>(
    mutate: (tx: WorksetPlanLifecycleTx) => T,
  ): Promise<T>;
  readonly afterPlanAdmit?: () => Promise<void> | void;
}

export interface WorksetGuardedPlanLifecycleStore
  extends WorksetOwnedGuardedLedger,
    PlanLifecycleStore {}

function itemRef(ledgerId: string, itemId: string): string {
  return `${ledgerId}:${itemId}`;
}

function fieldStrings(item: Item, field: string): readonly string[] {
  const value = item.fields[field];
  return Array.isArray(value) && value.every((part) => typeof part === "string")
    ? value
    : [];
}

function parseStoredManifest(value: unknown): PlanPublishedManifest | null {
  if (typeof value !== "string") return null;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed === "object" && parsed !== null && "manifest" in parsed) {
    return PlanPublishedManifestSchema.parse(
      (parsed as { readonly manifest: unknown }).manifest,
    );
  }
  return PlanPublishedManifestSchema.parse(parsed);
}

function addManifestRefs(refs: Set<string>, manifest: PlanPublishedManifest | null): void {
  if (manifest === null) return;
  for (const { id } of manifest.milestones) refs.add(itemRef(MILESTONES_LEDGER, id));
  for (const { id } of manifest.tasks) refs.add(itemRef(TASKS_LEDGER, id));
}

function affectedRefs(
  state: WorksetActiveState,
  operation: WorksetPlanLifecycleOperation,
): ReadonlySet<string> {
  const goalRef = itemRef(GOALS_LEDGER, operation.input.goalId);
  const refs = new Set<string>([goalRef]);
  const goal = state.byRef.get(goalRef);
  if (goal === undefined) return refs;

  addManifestRefs(refs, parseStoredManifest(goal.fields[PLAN_CURRENT_DRAFT_FIELD]));
  addManifestRefs(refs, parseStoredManifest(goal.fields[PLAN_FINALIZED_MANIFEST_FIELD]));

  const declaredMilestones = new Set(fieldStrings(goal, "milestones"));
  for (const milestoneId of declaredMilestones) {
    refs.add(itemRef(MILESTONES_LEDGER, milestoneId));
  }
  for (const [ref, item] of state.byRef) {
    if (ref.startsWith(`${TASKS_LEDGER}:`) && declaredMilestones.has(item.milestoneId)) {
      refs.add(ref);
    }
  }

  if (operation.kind === "release-plan-claim" && operation.input.kind === "pause") {
    if (operation.input.effect.kind === "tasks") {
      for (const ref of operation.input.effect.tasks) {
        refs.add(itemRef(TASKS_LEDGER, normalizeTaskRef(ref)));
      }
    }
  }
  let reviewId: string | undefined;
  if (operation.kind === "finalize-plan") reviewId = operation.input.reviewId;
  else if (operation.kind !== "claim-plan") {
    reviewId = operation.input.reviewDefects?.reviewId;
  }
  if (reviewId !== undefined) {
    const reviewRef = itemRef(REVIEWS_LEDGER, reviewId);
    if (operation.kind === "finalize-plan" || state.byRef.has(reviewRef)) refs.add(reviewRef);
  }
  return refs;
}

function selectedMembersForOperation(
  state: WorksetActiveState,
  roots: readonly string[],
  refs: ReadonlySet<string>,
): ReadonlySet<string> | null {
  if (roots.length === 0) return null;
  const graph = closeWorkset(roots, state);
  const members = new Set(graph.nodes.map(({ ref }) => ref));
  const goalRef = [...refs][0];
  if (goalRef !== undefined && !members.has(goalRef)) {
    throw new WorksetPlanLifecycleError(
      "goal-excluded",
      `plan lifecycle goal "${goalRef}" is outside the admitted workset`,
      [goalRef],
    );
  }
  for (const ref of refs) {
    if (!members.has(ref)) {
      throw new WorksetPlanLifecycleError(
        "affected-item-excluded",
        `plan lifecycle item "${ref}" is outside the admitted workset`,
        [ref],
      );
    }
  }
  return members;
}

function itemBytesByRef(state: WorksetActiveState): ReadonlyMap<string, string> {
  return new Map(
    [...state.byRef].map(([ref, item]) => [ref, JSON.stringify(item)] as const),
  );
}

function assertChangedExistingItemsSelected(
  before: ReadonlyMap<string, string>,
  after: WorksetActiveState,
  selectedMembers: ReadonlySet<string> | null,
): void {
  if (selectedMembers === null) return;
  for (const [ref, bytes] of before) {
    const current = after.byRef.get(ref);
    if (current !== undefined && JSON.stringify(current) === bytes) continue;
    if (!selectedMembers.has(ref)) {
      throw new WorksetPlanLifecycleError(
        "affected-item-excluded",
        `plan lifecycle changed item "${ref}" outside the admitted workset`,
        [ref],
      );
    }
  }
}

function assertCanonicalOwnership(
  state: WorksetActiveState,
  ledgerId: string,
  itemId: string,
  goalId: string,
  edgeKind: WorksetOwnerEdgeKind,
): void {
  const ref = itemRef(ledgerId, itemId);
  const item = state.byRef.get(ref);
  const ownership = item === undefined ? null : readCanonicalOwnership(item);
  if (ownership?.ownerRef !== itemRef(GOALS_LEDGER, goalId) || ownership.edgeKind !== edgeKind) {
    throw new WorksetPlanLifecycleError(
      "canonical-ownership-missing",
      `plan lifecycle item "${ref}" lacks canonical ${edgeKind} ownership`,
      [ref],
    );
  }
}

function assertCreatedOwnership(
  tx: WorksetPlanLifecycleTx,
  kind: WorksetPlanLifecycleMutationKind,
  goalId: string,
  result: PlanClaimResult | PlanPublishDraftResult | PlanReleaseResult | PlanFinalizeResult,
): void {
  if (!result.ok || result.replayed || kind === "claim-plan") return;
  const state = tx.activeState();
  if (kind === "publish-plan-draft") {
    const acknowledgement = (result as PlanPublishDraftResult & { readonly ok: true }).acknowledgement;
    for (const { id } of acknowledgement.manifest.milestones) {
      assertCanonicalOwnership(state, MILESTONES_LEDGER, id, goalId, "active-current-draft");
    }
    for (const { id } of acknowledgement.manifest.tasks) {
      assertCanonicalOwnership(state, TASKS_LEDGER, id, goalId, "active-current-draft");
    }
    for (const { id } of acknowledgement.reviewDefects) {
      assertCanonicalOwnership(state, DEFECTS_LEDGER, id, goalId, "review-filed-defect");
    }
    return;
  }
  if (kind === "release-plan-claim") {
    const acknowledgement = (result as PlanReleaseResult & { readonly ok: true }).acknowledgement;
    for (const { id } of acknowledgement.questions) {
      assertCanonicalOwnership(state, QUESTIONS_LEDGER, id, goalId, "exact-gate-question");
    }
    for (const { id } of acknowledgement.researches) {
      assertCanonicalOwnership(state, RESEARCHES_LEDGER, id, goalId, "research");
    }
    for (const { id } of acknowledgement.reviewDefects) {
      assertCanonicalOwnership(state, DEFECTS_LEDGER, id, goalId, "review-filed-defect");
    }
    return;
  }
  const acknowledgement = (result as PlanFinalizeResult & { readonly ok: true }).acknowledgement;
  assertCanonicalOwnership(state, DECISIONS_LEDGER, acknowledgement.decisionId, goalId, "decision");
  for (const { id } of acknowledgement.manifest.milestones) {
    assertCanonicalOwnership(state, MILESTONES_LEDGER, id, goalId, "finalized-manifest");
  }
  for (const { id } of acknowledgement.manifest.tasks) {
    assertCanonicalOwnership(state, TASKS_LEDGER, id, goalId, "finalized-manifest");
  }
  for (const { id } of acknowledgement.reviewDefects) {
    assertCanonicalOwnership(state, DEFECTS_LEDGER, id, goalId, "review-filed-defect");
  }
}

export function createWorksetGuardedPlanLifecycleStore(
  host: WorksetPlanLifecycleHost,
): WorksetGuardedPlanLifecycleStore {
  const base = createWorksetOwnedGuardedLedger(host);

  function conflictResult<T>(
    kind: WorksetPlanLifecycleMutationKind,
    input: PlanClaimInput | PlanPublishDraftInput | PlanReleaseInput | PlanFinalizeInput,
    reason: "target-excluded" | "stale-epoch" | "revoked",
    refs: readonly string[],
    epoch: number,
  ): T {
    const value = {
      ok: false,
      conflict: {
        code: "workset-conflict",
        operation: kind,
        reason,
        goalId: input.goalId,
        refs: [...new Set(refs)].sort(),
        epoch,
      },
    };
    if (kind === "claim-plan") return PlanClaimResultSchema.parse(value) as T;
    if (kind === "publish-plan-draft") {
      return PlanPublishDraftResultSchema.parse(value) as T;
    }
    if (kind === "release-plan-claim") return PlanReleaseResultSchema.parse(value) as T;
    return PlanFinalizeResultSchema.parse(value) as T;
  }

  function errorReason(
    error: WorksetPlanLifecycleError,
  ): "target-excluded" | "stale-epoch" | null {
    if (error.code === "goal-excluded" || error.code === "affected-item-excluded") {
      return "target-excluded";
    }
    if (error.code === "stale-epoch") return "stale-epoch";
    return null;
  }

  async function run<T extends PlanClaimResult | PlanPublishDraftResult | PlanReleaseResult | PlanFinalizeResult>(
    kind: WorksetPlanLifecycleMutationKind,
    input: PlanClaimInput | PlanPublishDraftInput | PlanReleaseInput | PlanFinalizeInput,
    mutate: (tx: WorksetPlanLifecycleTx) => T,
  ): Promise<T> {
    let admission: WorksetLedgerMutationAdmission;
    try {
      admission = await host.worksetStore.admitLedgerMutation({
        kind,
        targets: [itemRef(GOALS_LEDGER, input.goalId)],
      });
    } catch (error) {
      if (
        error instanceof WorksetAdmissionError &&
        (error.code === "target-excluded" ||
          error.code === "stale-epoch" ||
          error.code === "revoked")
      ) {
        const snapshot = await readWorksetRootsEpoch(host.worksetStore);
        return conflictResult<T>(
          kind,
          input,
          error.code === "target-excluded"
            ? "target-excluded"
            : error.code === "revoked"
              ? "revoked"
              : "stale-epoch",
          [itemRef(GOALS_LEDGER, input.goalId)],
          snapshot.epoch,
        );
      }
      throw error;
    }
    if (!isLiveWorksetAdmission(admission)) {
      throw new WorksetPlanLifecycleError(
        "caller-minted-admission",
        "plan lifecycle requires a coordinator-granted live admission",
      );
    }
    try {
      if (host.afterPlanAdmit !== undefined) await host.afterPlanAdmit();
      const snapshot = await readWorksetRootsEpoch(host.worksetStore);
      if (snapshot.epoch !== admission.epoch) {
        return conflictResult<T>(
          kind,
          input,
          "stale-epoch",
          [itemRef(GOALS_LEDGER, input.goalId)],
          snapshot.epoch,
        );
      }
      try {
        return await host.runPlanLifecycleTransaction((tx) => {
          const beforeState = tx.activeState();
          const selectedMembers = selectedMembersForOperation(
            beforeState,
            admission.roots,
            affectedRefs(beforeState, { kind, input } as WorksetPlanLifecycleOperation),
          );
          const beforeItems = itemBytesByRef(beforeState);
          const result = mutate(tx);
          const afterState = tx.activeState();
          assertChangedExistingItemsSelected(beforeItems, afterState, selectedMembers);
          assertCreatedOwnership(tx, kind, input.goalId, result);
          return result;
        });
      } catch (error) {
        if (error instanceof WorksetPlanLifecycleError) {
          const reason = errorReason(error);
          if (reason !== null) {
            return conflictResult<T>(kind, input, reason, error.refs, admission.epoch);
          }
        }
        throw error;
      }
    } finally {
      await admission.acknowledge();
    }
  }

  const surface: WorksetGuardedPlanLifecycleStore = {
    ...base,
    claimPlan: (input) => run("claim-plan", input, (tx) => tx.claimPlan(input)),
    publishPlanDraft: (input) =>
      run("publish-plan-draft", input, (tx) => tx.publishPlanDraft(input)),
    releasePlanClaim: (input) =>
      run("release-plan-claim", input, (tx) => tx.releasePlanClaim(input)),
    finalizePlan: (input) => run("finalize-plan", input, (tx) => tx.finalizePlan(input)),
  };
  return surface;
}

export interface CreateInMemoryWorksetGuardedPlanLifecycleOptions
  extends CreateInMemoryWorksetGuardedLedgerOptions,
    Pick<CreateInMemoryWorksetOwnedGuardedLedgerOptions, "afterOwnedAdmit"> {
  readonly afterPlanAdmit?: () => Promise<void> | void;
}

export function createInMemoryWorksetGuardedPlanLifecycleStore(
  options: CreateInMemoryWorksetGuardedPlanLifecycleOptions = {},
): WorksetGuardedPlanLifecycleStore {
  const rawStore = new InMemoryLedgerStore({
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  });
  const worksetStore = createInMemoryWorksetStore({
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    isTargetAdmitted: (target, roots) => {
      if (roots.length === 0) return true;
      try {
        const graph = closeWorkset(roots, buildActiveStateFromLedgerStore(rawStore));
        if (graph.nodes.some(({ ref }) => ref === target)) return true;
        return graph.inactiveRoots.includes(target);
      } catch {
        return false;
      }
    },
  });
  const host: WorksetPlanLifecycleHost = {
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
    ...(options.afterPlanAdmit !== undefined
      ? { afterPlanAdmit: options.afterPlanAdmit }
      : {}),
    runOwnedTransaction: (mutate) =>
      rawStore.runAtomicOwnedMutation((tx: InMemoryOwnedWriteTx) => mutate(tx)),
    runPlanLifecycleTransaction: (mutate) =>
      rawStore.runAtomicWorksetPlanLifecycleMutation(
        (tx: InMemoryWorksetPlanLifecycleTx) => mutate(tx),
      ),
  };
  return createWorksetGuardedPlanLifecycleStore(host);
}
