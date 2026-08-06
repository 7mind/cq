import { createHash } from "node:crypto";

import {
  DECISIONS_LEDGER,
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
  PLAN_REVIEW_DRAFT_FIELD,
  QUESTIONS_LEDGER,
  RESEARCHES_LEDGER,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
} from "../constants.js";
import {
  PLAN_ACTIVE_CLAIM_FIELD,
  PLAN_CURRENT_DRAFT_FIELD,
  PLAN_FINALIZED_DRAFT_FIELD,
  PLAN_FINALIZED_MANIFEST_FIELD,
  PLAN_GENERATION_FIELD,
  PLAN_WAITING_RESEARCHES_FIELD,
  PLAN_WAITING_TASKS_FIELD,
  PlanClaimInputSchema,
  PlanClaimResultSchema,
  PlanDraftIdentitySchema,
  PlanFinalizeInputSchema,
  PlanFinalizeResultSchema,
  PlanPrivateClaimRecordSchema,
  PlanPublicClaimSchema,
  PlanPublishDraftInputSchema,
  PlanPublishDraftResultSchema,
  PlanPublishedManifestSchema,
  PlanReleaseInputSchema,
  PlanReleaseResultSchema,
  replayPlanClaim,
  resolvePlanClaimPhase,
  resolvePlanFinalizeDraftBinding,
  resolvePlanOperationReplay,
  type PlanClaimInput,
  type PlanClaimResult,
  type PlanConflict,
  type PlanDraftIdentity,
  type PlanDraftReference,
  type PlanFinalizeInput,
  type PlanFinalizeResult,
  type PlanIdAllocation,
  type PlanOperationReplayRecord,
  type PlanPrivateClaimRecord,
  type PlanPublishDraftInput,
  type PlanPublishDraftResult,
  type PlanPublishedManifest,
  type PlanReleaseInput,
  type PlanReleaseResult,
  type PlanReviewDefectBatch,
  type PlanWriteProvenance,
} from "../planLifecycle.js";
import type { FieldValue, Item, Ledger, Milestone } from "../types.js";
import { LedgerError } from "../types.js";
import { buildPrefixRegistry, canonicalizeRef, parseRef, RefParseError } from "../refs.js";
import {
  normalizeRefFields,
  type RefValidationContext,
} from "./core.js";
import { activePlanResearchWaits, activePlanTaskWaits } from "./predicates.js";

interface StoredDraft {
  readonly identity: PlanDraftIdentity;
  readonly manifest: PlanPublishedManifest;
}

export interface InMemoryPlanOperationRecord {
  readonly replay: PlanOperationReplayRecord;
  readonly acknowledgement: unknown;
}

export interface InMemoryPlanLifecycleState {
  readonly ledgers: Map<string, Ledger>;
  readonly claims: Map<string, PlanPrivateClaimRecord>;
  readonly operations: Map<string, InMemoryPlanOperationRecord>;
  readonly now: () => string;
}

export interface InMemoryPlanMutation<T> {
  readonly result: T;
  readonly dirtyLedgers: readonly string[];
}

const STORED_DRAFT_FIELDS = new Set([
  PLAN_CURRENT_DRAFT_FIELD,
  PLAN_FINALIZED_DRAFT_FIELD,
  PLAN_FINALIZED_MANIFEST_FIELD,
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function verifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function payloadVerifier(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function claimScope(goalId: string, claimRequestId: string): string {
  return `${goalId}\u0000${claimRequestId}`;
}

function operationScope(
  goalId: string,
  claimId: string,
  generation: number,
  operation: "publish-draft" | "release" | "finalize",
  operationId: string,
): string {
  return [goalId, claimId, generation, operation, operationId].join("\u0000");
}

function ledger(state: InMemoryPlanLifecycleState, id: string): Ledger {
  const value = state.ledgers.get(id);
  if (value === undefined) throw new LedgerError(`ledger not found: ${id}`);
  return value;
}

function findActiveItem(source: Ledger, id: string): Item | undefined {
  for (const milestone of source.milestones) {
    const item = milestone.items.find((candidate) => candidate.id === id);
    if (item !== undefined) return item;
  }
  return undefined;
}

function goalItem(state: InMemoryPlanLifecycleState, goalId: string): Item | undefined {
  return findActiveItem(ledger(state, GOALS_LEDGER), goalId);
}

/**
 * D267/T1855: the goal's coordination milestone must resolve as a live parent
 * from the same authoritative state the mutation uses, BEFORE any state or id
 * allocation. An absent (archived or dangling) or terminal parent rejects the
 * operation with deterministic public conflict metadata.
 */
function coordinationMilestoneConflict(
  state: InMemoryPlanLifecycleState,
  goal: Item,
): PlanConflict | null {
  const milestoneId = goal.milestoneId;
  const parent = findActiveItem(ledger(state, MILESTONES_LEDGER), milestoneId);
  if (parent === undefined) {
    return { code: "parent-milestone-absent", goalId: goal.id, milestoneId };
  }
  const terminal = new Set(MILESTONES_SCHEMA.terminalStatuses);
  if (terminal.has(parent.status)) {
    return {
      code: "parent-milestone-terminal",
      goalId: goal.id,
      milestoneId,
      status: parent.status,
    };
  }
  return null;
}

function requireGoal(state: InMemoryPlanLifecycleState, goalId: string): Item {
  const goal = goalItem(state, goalId);
  if (goal === undefined) throw new LedgerError(`goal not found: ${goalId}`);
  return goal;
}

function fieldString(item: Item, name: string): string | undefined {
  const value = item.fields[name];
  return typeof value === "string" ? value : undefined;
}

function fieldStrings(item: Item, name: string): string[] {
  const value = item.fields[name];
  return Array.isArray(value) ? [...value] : [];
}

function generation(goal: Item): number | null {
  const raw = fieldString(goal, PLAN_GENERATION_FIELD);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new LedgerError(`goal ${goal.id} has invalid ${PLAN_GENERATION_FIELD}`);
  }
  return parsed;
}

function parseJsonField<T>(
  item: Item,
  name: string,
  parse: (value: unknown) => T,
): T | null {
  const raw = fieldString(item, name);
  if (raw === undefined) return null;
  try {
    return parse(JSON.parse(raw));
  } catch (error) {
    throw new LedgerError(
      `goal ${item.id} has invalid ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function currentDraft(goal: Item): StoredDraft | null {
  return parseJsonField(goal, PLAN_CURRENT_DRAFT_FIELD, (value) => {
    if (typeof value !== "object" || value === null) throw new Error("expected object");
    const candidate = value as Record<string, unknown>;
    return {
      identity: PlanDraftIdentitySchema.parse(candidate["identity"]),
      manifest: PlanPublishedManifestSchema.parse(candidate["manifest"]),
    };
  });
}

function finalizedDraft(goal: Item): PlanDraftIdentity | null {
  return parseJsonField(goal, PLAN_FINALIZED_DRAFT_FIELD, (value) =>
    PlanDraftIdentitySchema.parse(value),
  );
}

function finalizedManifest(goal: Item): PlanPublishedManifest | null {
  return parseJsonField(goal, PLAN_FINALIZED_MANIFEST_FIELD, (value) =>
    PlanPublishedManifestSchema.parse(value),
  );
}

function publicClaim(goal: Item): {
  goalId: string;
  claimId: string;
  generation: number;
  purpose: "initial" | "follow-up";
} | null {
  return parseJsonField(goal, PLAN_ACTIVE_CLAIM_FIELD, (value) =>
    PlanPublicClaimSchema.parse(value),
  );
}

function setField(item: Item, name: string, value: FieldValue | undefined): void {
  if (value === undefined) delete item.fields[name];
  else item.fields[name] = value;
}

function setJsonField(item: Item, name: string, value: unknown | null): void {
  setField(item, name, value === null ? undefined : JSON.stringify(value));
}

function touch(item: Item, provenance: PlanWriteProvenance, now: string): void {
  item.updatedAt = now;
  item.author = provenance.author;
  if (provenance.session === undefined) delete item.session;
  else item.session = provenance.session;
}

function effectivePrefix(source: Ledger): string {
  return source.schema.idPrefix ?? source.id.slice(0, 1).toUpperCase();
}

function allocateId(source: Ledger): string {
  const prefix = effectivePrefix(source);
  let id: string;
  do {
    source.counters.item += 1;
    id = `${prefix}${source.counters.item}`;
  } while (findActiveItem(source, id) !== undefined);
  return id;
}

function group(source: Ledger, milestoneId: string): Milestone {
  let value = source.milestones.find((candidate) => candidate.id === milestoneId);
  if (value === undefined) {
    value = { id: milestoneId, title: "", description: "", items: [] };
    source.milestones.push(value);
    source.counters.milestone += 1;
  }
  return value;
}

function makeItem(
  id: string,
  milestoneId: string,
  status: string,
  fields: Record<string, FieldValue>,
  provenance: PlanWriteProvenance,
  now: string,
): Item {
  return {
    id,
    milestoneId,
    status,
    fields,
    createdAt: now,
    updatedAt: now,
    author: provenance.author,
    ...(provenance.session === undefined ? {} : { session: provenance.session }),
  };
}

function addItem(
  state: InMemoryPlanLifecycleState,
  ledgerId: string,
  milestoneId: string,
  status: string,
  fields: Record<string, FieldValue>,
  provenance: PlanWriteProvenance,
): Item {
  const source = ledger(state, ledgerId);
  const id = allocateId(source);
  const item = makeItem(id, milestoneId, status, fields, provenance, state.now());
  group(source, milestoneId).items.push(item);
  return item;
}

/**
 * Rewrite a ledger-kind ref of the form `tasks:<draft-key>` /
 * `milestones:<draft-key>` onto the id allocated for that draft key in the
 * current publish (D204). Non-matching refs pass through for the subsequent
 * G80 dangling gate.
 */
function rewriteDraftKeyLedgerRef(
  ref: string,
  milestoneAllocations: ReadonlyMap<string, string>,
  taskAllocations: ReadonlyMap<string, string>,
): string {
  const colon = ref.indexOf(":");
  if (colon <= 0) return ref;
  const ledger = ref.slice(0, colon);
  const key = ref.slice(colon + 1);
  if (ledger === TASKS_LEDGER) {
    const id = taskAllocations.get(key);
    if (id !== undefined) return `${TASKS_LEDGER}:${id}`;
  } else if (ledger === MILESTONES_LEDGER) {
    const id = milestoneAllocations.get(key);
    if (id !== undefined) return `${MILESTONES_LEDGER}:${id}`;
  }
  return ref;
}

function materializeReferences(
  references: readonly PlanDraftReference[] | undefined,
  milestoneAllocations: ReadonlyMap<string, string>,
  taskAllocations: ReadonlyMap<string, string>,
): string[] {
  return (references ?? []).map((reference) => {
    if (reference.kind === "ledger") {
      // D204: a ledger-kind courier may carry a draft key (e.g. tasks:contract)
      // instead of the typed draft-task/draft-milestone kind. Rewrite when the
      // key is in the current allocation maps; leftovers face the G80 gate.
      return rewriteDraftKeyLedgerRef(
        reference.ref,
        milestoneAllocations,
        taskAllocations,
      );
    }
    const id =
      reference.kind === "draft-milestone"
        ? milestoneAllocations.get(reference.key)
        : taskAllocations.get(reference.key);
    if (id === undefined) throw new LedgerError(`missing draft allocation ${reference.key}`);
    return reference.kind === "draft-milestone"
      ? `${MILESTONES_LEDGER}:${id}`
      : `${TASKS_LEDGER}:${id}`;
  });
}

/**
 * G80 write-gate context for plan-draft materialization. Active items from the
 * lifecycle state plus the ids allocated in THIS publish (not yet inserted when
 * earlier siblings are validated). Same dangling rejection as applyCreateItem.
 */
function buildPlanPublishRefContext(
  state: InMemoryPlanLifecycleState,
  milestoneAllocations: ReadonlyMap<string, string>,
  taskAllocations: ReadonlyMap<string, string>,
): RefValidationContext {
  const registry = buildPrefixRegistry(
    [...state.ledgers].map(([name, l]) => ({ name, schema: l.schema })),
  );
  const pendingByLedger = new Map<string, Set<string>>([
    [MILESTONES_LEDGER, new Set(milestoneAllocations.values())],
    [TASKS_LEDGER, new Set(taskAllocations.values())],
  ]);
  return {
    registry,
    refExists: (ledger: string, id: string): boolean => {
      if (pendingByLedger.get(ledger)?.has(id) === true) return true;
      const source = state.ledgers.get(ledger);
      if (source === undefined) return false;
      for (const milestone of source.milestones) {
        for (const item of milestone.items) {
          if (item.id === id) return true;
        }
      }
      return false;
    },
  };
}

/** Apply G80 canonicalize + dangling rejection to dependsOn/blockedBy fields. */
function gateMaterializedRefFields(
  fields: Record<string, FieldValue>,
  refCtx: RefValidationContext,
): void {
  normalizeRefFields(fields, {}, refCtx);
}

function sameDraft(left: PlanDraftIdentity | null, right: PlanDraftIdentity): boolean {
  return (
    left !== null &&
    left.goalId === right.goalId &&
    left.claimId === right.claimId &&
    left.generation === right.generation &&
    left.revision === right.revision
  );
}

function stripRefId(ref: string): string {
  return ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
}

/**
 * The goal's DECLARED manifest work: the tasks grouped under the milestones
 * `goals.milestones` names, in ledger order. Adoption, the follow-up
 * implementation-active check, and replacement cleanup all range over exactly
 * this set — a task that references the goal but sits outside the declared
 * milestones is an orphan the guard never scans, adopts, or abandons (T856).
 */
function declaredManifestTasks(
  state: InMemoryPlanLifecycleState,
  goal: Item,
): Item[] {
  const declared = new Set(fieldStrings(goal, "milestones"));
  const out: Item[] = [];
  for (const milestone of ledger(state, TASKS_LEDGER).milestones) {
    if (!declared.has(milestone.id)) continue;
    out.push(...milestone.items);
  }
  return out;
}

function removeSupersededReferences(
  state: InMemoryPlanLifecycleState,
  supersededIds: ReadonlySet<string>,
): void {
  for (const ledgerId of [MILESTONES_LEDGER, TASKS_LEDGER]) {
    for (const milestone of ledger(state, ledgerId).milestones) {
      for (const item of milestone.items) {
        for (const field of ["dependsOn", "blockedBy"] as const) {
          const refs = fieldStrings(item, field);
          if (refs.length > 0) {
            item.fields[field] = refs.filter((ref) => {
              const id = stripRefId(ref);
              return !supersededIds.has(id);
            });
          }
        }
      }
    }
  }
}

function supersedeManifest(
  state: InMemoryPlanLifecycleState,
  manifest: PlanPublishedManifest,
): void {
  const ids = new Set([
    ...manifest.milestones.map(({ id }) => id),
    ...manifest.tasks.map(({ id }) => id),
  ]);
  for (const { id } of manifest.tasks) {
    const task = findActiveItem(ledger(state, TASKS_LEDGER), id);
    if (task?.status === "planned") task.status = "abandoned";
  }
  for (const { id } of manifest.milestones) {
    const milestone = findActiveItem(ledger(state, MILESTONES_LEDGER), id);
    if (milestone !== undefined && milestone.status !== "done") {
      milestone.status = "postponed";
    }
  }
  removeSupersededReferences(state, ids);
}

function applyFollowUpCleanup(state: InMemoryPlanLifecycleState, goal: Item): void {
  const milestoneIds = fieldStrings(goal, "milestones");
  const superseded = new Set(milestoneIds);
  for (const task of declaredManifestTasks(state, goal)) {
    if (task.status === "planned") {
      task.status = "abandoned";
      superseded.add(task.id);
    }
  }
  for (const id of milestoneIds) {
    const milestone = findActiveItem(ledger(state, MILESTONES_LEDGER), id);
    if (milestone !== undefined && milestone.status !== "done") {
      milestone.status = "postponed";
    }
  }
  const goalRef = `${GOALS_LEDGER}:${goal.id}`;
  for (const milestone of ledger(state, QUESTIONS_LEDGER).milestones) {
    for (const question of milestone.items) {
      if (question.status !== "open") continue;
      const refs = fieldStrings(question, "ledgerRefs");
      if (refs.length === 0) continue;
      if (refs.every((ref) => ref === goalRef || superseded.has(stripRefId(ref)))) {
        // Owned solely by the superseded work: the question asked about a plan
        // that no longer exists, so it is withdrawn with it.
        question.status = "withdrawn";
      } else {
        // Shared ownership: the question survives, but its backlinks into the
        // superseded manifest dangle and are reconciled away.
        const retained = refs.filter((ref) => !superseded.has(stripRefId(ref)));
        if (retained.length !== refs.length) setField(question, "ledgerRefs", retained);
      }
    }
  }
  removeSupersededReferences(state, superseded);
  setField(goal, "milestones", []);
  for (const name of STORED_DRAFT_FIELDS) setField(goal, name, undefined);
}

function adoptedManifest(
  state: InMemoryPlanLifecycleState,
  goal: Item,
): { milestoneIds: string[]; taskIds: string[] } {
  if (fieldString(goal, PLAN_GENERATION_FIELD) !== undefined) {
    return { milestoneIds: [], taskIds: [] };
  }
  const milestoneIds = fieldStrings(goal, "milestones");
  const taskIds = declaredManifestTasks(state, goal).map(({ id }) => id);
  return { milestoneIds, taskIds };
}

function seededManifest(
  adopted: { milestoneIds: string[]; taskIds: string[] },
): PlanPublishedManifest {
  return {
    revision: 1,
    milestones: adopted.milestoneIds.map((id, index) => ({
      key: `seeded_milestone${index === 0 ? "" : `_${index + 1}`}`,
      id,
    })),
    tasks: adopted.taskIds.map((id, index) => ({
      key: `seeded_task_${index + 1}`,
      id,
    })),
  };
}

function materializeManifest(
  state: InMemoryPlanLifecycleState,
  input: PlanPublishDraftInput,
  revision: number,
): PlanPublishedManifest {
  const milestoneSource = ledger(state, MILESTONES_LEDGER);
  const taskSource = ledger(state, TASKS_LEDGER);
  const milestoneAllocations = new Map<string, string>();
  const taskAllocations = new Map<string, string>();
  for (const draft of input.manifest.milestones) {
    milestoneAllocations.set(draft.key, allocateId(milestoneSource));
  }
  for (const draft of input.manifest.tasks) {
    taskAllocations.set(draft.key, allocateId(taskSource));
  }
  // D204: G80 dangling gate over the full allocation set so intra-manifest
  // refs (and rewritten draft-key ledger refs) resolve before insertion.
  const refCtx = buildPlanPublishRefContext(state, milestoneAllocations, taskAllocations);
  for (const draft of input.manifest.milestones) {
    const id = milestoneAllocations.get(draft.key);
    if (id === undefined) throw new LedgerError(`missing milestone allocation ${draft.key}`);
    const fields: Record<string, FieldValue> = { title: draft.title };
    if (draft.description !== undefined) fields["description"] = draft.description;
    const dependsOn = materializeReferences(
      draft.dependsOn,
      milestoneAllocations,
      taskAllocations,
    );
    const blockedBy = materializeReferences(
      draft.blockedBy,
      milestoneAllocations,
      taskAllocations,
    );
    if (dependsOn.length > 0) fields["dependsOn"] = dependsOn;
    if (blockedBy.length > 0) fields["blockedBy"] = blockedBy;
    gateMaterializedRefFields(fields, refCtx);
    group(milestoneSource, MILESTONES_ACTIVE_GROUP_ID).items.push(
      makeItem(
        id,
        MILESTONES_ACTIVE_GROUP_ID,
        "open",
        fields,
        input,
        state.now(),
      ),
    );
  }
  for (const draft of input.manifest.tasks) {
    const id = taskAllocations.get(draft.key);
    const milestoneId = milestoneAllocations.get(draft.milestoneKey);
    if (id === undefined || milestoneId === undefined) {
      throw new LedgerError(`missing task allocation ${draft.key}`);
    }
    const fields: Record<string, FieldValue> = {
      headline: draft.headline,
      ledgerRefs: [...new Set([`${GOALS_LEDGER}:${input.goalId}`, ...(draft.ledgerRefs ?? [])])],
    };
    if (draft.description !== undefined) fields["description"] = draft.description;
    if (draft.acceptance !== undefined) fields["acceptance"] = draft.acceptance;
    if (draft.suggestedModel !== undefined) fields["suggestedModel"] = draft.suggestedModel;
    if (draft.sourceRefs !== undefined) fields["sourceRefs"] = [...draft.sourceRefs];
    if (draft.tags !== undefined) fields["tags"] = [...draft.tags];
    const dependsOn = materializeReferences(
      draft.dependsOn,
      milestoneAllocations,
      taskAllocations,
    );
    const blockedBy = materializeReferences(
      draft.blockedBy,
      milestoneAllocations,
      taskAllocations,
    );
    if (dependsOn.length > 0) fields["dependsOn"] = dependsOn;
    if (blockedBy.length > 0) fields["blockedBy"] = blockedBy;
    gateMaterializedRefFields(fields, refCtx);
    group(taskSource, milestoneId).items.push(
      makeItem(id, milestoneId, "planned", fields, input, state.now()),
    );
  }
  return {
    revision,
    milestones: input.manifest.milestones.map(({ key }) => ({
      key,
      id: milestoneAllocations.get(key)!,
    })),
    tasks: input.manifest.tasks.map(({ key }) => ({
      key,
      id: taskAllocations.get(key)!,
    })),
  };
}

function addReviewDefects(
  state: InMemoryPlanLifecycleState,
  goalId: string,
  batch: PlanReviewDefectBatch | undefined,
  provenance: PlanWriteProvenance,
): PlanIdAllocation[] {
  if (batch === undefined) return [];
  const allocations = batch.defects.map((defect) => {
    const fields: Record<string, FieldValue> = {
      headline: defect.headline,
      severity: defect.severity,
      ledgerRefs: [`${GOALS_LEDGER}:${goalId}`, `${REVIEWS_LEDGER}:${batch.reviewId}`],
    };
    if (defect.description !== undefined) fields["description"] = defect.description;
    if (defect.rootCause !== undefined) fields["rootCause"] = defect.rootCause;
    if (defect.suggestedFix !== undefined) fields["suggestedFix"] = defect.suggestedFix;
    if (defect.sourceRefs !== undefined) fields["sourceRefs"] = [...defect.sourceRefs];
    if (defect.tags !== undefined) fields["tags"] = [...defect.tags];
    const item = addItem(
      state,
      DEFECTS_LEDGER,
      "M-AMBIENT",
      "open",
      fields,
      provenance,
    );
    return { key: defect.key, id: item.id };
  });
  const review = findActiveItem(ledger(state, REVIEWS_LEDGER), batch.reviewId);
  if (review !== undefined) {
    review.fields["defects"] = [
      ...fieldStrings(review, "defects"),
      ...allocations.map(({ id }) => id),
    ];
  }
  return allocations;
}

function activeClaim(
  state: InMemoryPlanLifecycleState,
  goal: Item,
): PlanPrivateClaimRecord | null {
  const active = publicClaim(goal);
  if (active === null) return null;
  return (
    [...state.claims.values()].find(
      (record) =>
        record.goalId === goal.id &&
        record.claimId === active.claimId &&
        record.generation === active.generation &&
        record.state === "active",
    ) ?? null
  );
}

function claimNotActive(
  goalId: string,
  claimId: string,
  generationValue: number,
): PlanConflict {
  return { code: "claim-not-active", goalId, claimId, generation: generationValue };
}

function ownerConflict(
  state: InMemoryPlanLifecycleState,
  input:
    | PlanPublishDraftInput
    | Extract<PlanReleaseInput, { kind: "pause" }>
    | PlanFinalizeInput,
): PlanConflict | null {
  const goal = goalItem(state, input.goalId);
  if (goal === undefined) return { code: "goal-not-found", goalId: input.goalId };
  const claim = activeClaim(state, goal);
  if (claim === null) {
    return claimNotActive(input.goalId, input.claimId, input.generation);
  }
  if (claim.claimId !== input.claimId) {
    return {
      code: "stale-claim",
      goalId: input.goalId,
      suppliedClaimId: input.claimId,
      currentClaimId: claim.claimId,
      currentGeneration: claim.generation,
    };
  }
  if (claim.generation !== input.generation) {
    return {
      code: "stale-generation",
      goalId: input.goalId,
      expectedGeneration: input.generation,
      currentGeneration: claim.generation,
    };
  }
  if (claim.ownerFenceTokenVerifier !== verifier(input.ownerFenceToken)) {
    return {
      code: "owner-fence-mismatch",
      goalId: input.goalId,
      claimId: input.claimId,
      generation: input.generation,
    };
  }
  return null;
}

function abandonConflict(
  state: InMemoryPlanLifecycleState,
  input: Extract<PlanReleaseInput, { kind: "abandon" }>,
): PlanConflict | null {
  const goal = goalItem(state, input.goalId);
  if (goal === undefined) return { code: "goal-not-found", goalId: input.goalId };
  const claim = activeClaim(state, goal);
  if (claim === null) {
    return claimNotActive(input.goalId, input.claimId, input.generation);
  }
  if (claim.claimId !== input.claimId) {
    return {
      code: "stale-claim",
      goalId: input.goalId,
      suppliedClaimId: input.claimId,
      currentClaimId: claim.claimId,
      currentGeneration: claim.generation,
    };
  }
  if (claim.generation !== input.generation) {
    return {
      code: "stale-generation",
      goalId: input.goalId,
      expectedGeneration: input.generation,
      currentGeneration: claim.generation,
    };
  }
  return null;
}

function replayOperation(
  state: InMemoryPlanLifecycleState,
  input: PlanPublishDraftInput | PlanReleaseInput | PlanFinalizeInput,
  operation: "publish-draft" | "release" | "finalize",
  requiresOwner: boolean,
):
  | { readonly ok: true; readonly replayed: true; readonly acknowledgement: unknown }
  | { readonly ok: false; readonly conflict: PlanConflict }
  | null {
  const stored = state.operations.get(
    operationScope(
      input.goalId,
      input.claimId,
      input.generation,
      operation,
      input.operationId,
    ),
  );
  if (stored === undefined) return null;
  if (requiresOwner) {
    const ownerInput = input as
      | PlanPublishDraftInput
      | Extract<PlanReleaseInput, { kind: "pause" }>
      | PlanFinalizeInput;
    const claim = [...state.claims.values()].find(
      (candidate) =>
        candidate.goalId === input.goalId &&
        candidate.claimId === input.claimId &&
        candidate.generation === input.generation,
    );
    if (
      claim === undefined ||
      claim.ownerFenceTokenVerifier !== verifier(ownerInput.ownerFenceToken)
    ) {
      return {
        ok: false,
        conflict: {
          code: "owner-fence-mismatch",
          goalId: input.goalId,
          claimId: input.claimId,
          generation: input.generation,
        },
      };
    }
  }
  const attempted: PlanOperationReplayRecord = {
    goalId: input.goalId,
    claimId: input.claimId,
    generation: input.generation,
    operationId: input.operationId,
    operation,
    requestPayloadVerifier: payloadVerifier(input),
  };
  const resolution = resolvePlanOperationReplay(stored.replay, attempted);
  if (resolution.kind === "conflict") return { ok: false, conflict: resolution.conflict };
  if (resolution.kind !== "exact-replay") {
    throw new LedgerError("operation replay lookup returned an independent scope");
  }
  return { ok: true, replayed: true, acknowledgement: clone(stored.acknowledgement) };
}

function recordOperation(
  state: InMemoryPlanLifecycleState,
  input: PlanPublishDraftInput | PlanReleaseInput | PlanFinalizeInput,
  operation: "publish-draft" | "release" | "finalize",
  acknowledgement: unknown,
): void {
  state.operations.set(
    operationScope(
      input.goalId,
      input.claimId,
      input.generation,
      operation,
      input.operationId,
    ),
    {
      replay: {
        goalId: input.goalId,
        claimId: input.claimId,
        generation: input.generation,
        operationId: input.operationId,
        operation,
        requestPayloadVerifier: payloadVerifier(input),
      },
      acknowledgement: clone(acknowledgement),
    },
  );
}

function releaseClaim(
  state: InMemoryPlanLifecycleState,
  goal: Item,
  claimId: string,
  claimState: "released" | "finalized",
): void {
  const entry = [...state.claims.entries()].find(
    ([, record]) =>
      record.goalId === goal.id &&
      record.claimId === claimId &&
      record.generation === generation(goal),
  );
  if (entry === undefined) throw new LedgerError("claim record missing during release");
  state.claims.set(entry[0], { ...entry[1], state: claimState });
  setField(goal, PLAN_ACTIVE_CLAIM_FIELD, undefined);
}

export function claimInMemoryPlan(
  state: InMemoryPlanLifecycleState,
  rawInput: PlanClaimInput,
): InMemoryPlanMutation<PlanClaimResult> {
  const input = PlanClaimInputSchema.parse(rawInput);
  const existing = state.claims.get(claimScope(input.goalId, input.claimRequestId));
  if (existing !== undefined) {
    return { result: replayPlanClaim(existing, input), dirtyLedgers: [] };
  }
  const goal = goalItem(state, input.goalId);
  if (goal === undefined) {
    return {
      result: PlanClaimResultSchema.parse({
        ok: false,
        conflict: { code: "goal-not-found", goalId: input.goalId },
      }),
      dirtyLedgers: [],
    };
  }
  const parentConflict = coordinationMilestoneConflict(state, goal);
  if (parentConflict !== null) {
    return {
      result: PlanClaimResultSchema.parse({ ok: false, conflict: parentConflict }),
      dirtyLedgers: [],
    };
  }
  const currentClaim = activeClaim(state, goal);
  if (currentClaim !== null) {
    return {
      result: PlanClaimResultSchema.parse({
        ok: false,
        conflict: {
          code: "claim-active",
          goalId: currentClaim.goalId,
          claimId: currentClaim.claimId,
          generation: currentClaim.generation,
        },
      }),
      dirtyLedgers: [],
    };
  }
  const phase = resolvePlanClaimPhase(input.goalId, input.purpose, goal.status);
  if (!phase.ok) {
    return {
      result: PlanClaimResultSchema.parse({ ok: false, conflict: phase.conflict }),
      dirtyLedgers: [],
    };
  }
  const currentGeneration = generation(goal);
  if (currentGeneration !== input.expectedGeneration) {
    return {
      result: PlanClaimResultSchema.parse({
        ok: false,
        conflict: {
          code: "stale-generation",
          goalId: input.goalId,
          expectedGeneration: input.expectedGeneration,
          currentGeneration,
        },
      }),
      dirtyLedgers: [],
    };
  }
  const waits = activePlanResearchWaits(
    goal,
    ledger(state, RESEARCHES_LEDGER).milestones.flatMap(({ items }) => items),
  );
  if (waits.length > 0) {
    return {
      result: PlanClaimResultSchema.parse({
        ok: false,
        conflict: {
          code: "research-wait-active",
          goalId: input.goalId,
          researchIds: waits,
        },
      }),
      dirtyLedgers: [],
    };
  }
  const taskWaits = activePlanTaskWaits(
    goal,
    ledger(state, TASKS_LEDGER).milestones.flatMap(({ items }) => items),
  );
  if (taskWaits.length > 0) {
    return {
      result: PlanClaimResultSchema.parse({
        ok: false,
        conflict: {
          code: "task-wait-active",
          goalId: input.goalId,
          taskIds: taskWaits,
        },
      }),
      dirtyLedgers: [],
    };
  }
  if (input.purpose === "follow-up") {
    const activeTasks = declaredManifestTasks(state, goal).filter(
      ({ status }) => status === "wip" || status === "blocked",
    );
    if (activeTasks.length > 0) {
      return {
        result: PlanClaimResultSchema.parse({
          ok: false,
          conflict: {
            code: "implementation-active",
            goalId: input.goalId,
            tasks: activeTasks.map(({ id, status }) => ({ taskId: id, status })),
          },
        }),
        dirtyLedgers: [],
      };
    }
  }

  const adopted = adoptedManifest(state, goal);
  if (input.purpose === "follow-up") applyFollowUpCleanup(state, goal);
  const nextGeneration = (currentGeneration ?? 0) + 1;
  const claimId = `claim_${input.goalId}_${nextGeneration}`;
  // An initial claim ADOPTS the legacy manifest as the executable baseline so
  // the old work keeps running under the guard; a follow-up SUPERSEDES it, so
  // the adopted record stays in the claim but no draft is installed.
  if (
    input.purpose === "initial" &&
    adopted.milestoneIds.length > 0 &&
    currentDraft(goal) === null
  ) {
    const manifest = seededManifest(adopted);
    const identity: PlanDraftIdentity = {
      goalId: input.goalId,
      claimId: `legacy_${input.goalId}`,
      generation: nextGeneration,
      revision: 1,
    };
    setJsonField(goal, PLAN_CURRENT_DRAFT_FIELD, { identity, manifest });
    setJsonField(goal, PLAN_FINALIZED_DRAFT_FIELD, identity);
    setJsonField(goal, PLAN_FINALIZED_MANIFEST_FIELD, manifest);
  }
  goal.status = phase.goalPhase;
  setField(goal, PLAN_GENERATION_FIELD, String(nextGeneration));
  setJsonField(goal, PLAN_ACTIVE_CLAIM_FIELD, {
    goalId: input.goalId,
    claimId,
    generation: nextGeneration,
    purpose: input.purpose,
  });
  setField(goal, PLAN_WAITING_RESEARCHES_FIELD, []);
  setField(goal, PLAN_WAITING_TASKS_FIELD, []);
  touch(goal, input, state.now());

  const record = PlanPrivateClaimRecordSchema.parse({
    goalId: input.goalId,
    claimId,
    generation: nextGeneration,
    purpose: input.purpose,
    claimRequestId: input.claimRequestId,
    ownerFenceTokenVerifier: verifier(input.ownerFenceToken),
    expectedGeneration: input.expectedGeneration,
    priorGeneration: currentGeneration,
    previousGoalPhase: phase.previousGoalPhase,
    goalPhase: phase.goalPhase,
    legacyAdopted: adopted.milestoneIds.length > 0,
    adoptedManifest: adopted,
    waitingResearches: [],
    waitingTasks: [],
    author: input.author,
    session: input.session,
    state: "active",
  });
  state.claims.set(claimScope(input.goalId, input.claimRequestId), record);
  return {
    result: PlanClaimResultSchema.parse({
      ok: true,
      replayed: false,
      acknowledgement: {
        goalId: input.goalId,
        claimId,
        generation: nextGeneration,
        purpose: input.purpose,
        claimRequestId: input.claimRequestId,
        ownerFenceToken: input.ownerFenceToken,
        previousGoalPhase: phase.previousGoalPhase,
        goalPhase: phase.goalPhase,
        legacyAdopted: adopted.milestoneIds.length > 0,
        adoptedManifest: adopted,
        waitingResearches: [],
        waitingTasks: [],
      },
    }),
    dirtyLedgers: [
      GOALS_LEDGER,
      ...(input.purpose === "follow-up"
        ? [MILESTONES_LEDGER, TASKS_LEDGER, QUESTIONS_LEDGER]
        : []),
    ],
  };
}

export function publishInMemoryPlanDraft(
  state: InMemoryPlanLifecycleState,
  rawInput: PlanPublishDraftInput,
): InMemoryPlanMutation<PlanPublishDraftResult> {
  const input = PlanPublishDraftInputSchema.parse(rawInput);
  const replay = replayOperation(state, input, "publish-draft", true);
  if (replay !== null) {
    return {
      result: PlanPublishDraftResultSchema.parse(replay),
      dirtyLedgers: [],
    };
  }
  const conflict = ownerConflict(state, input);
  if (conflict !== null) {
    return {
      result: PlanPublishDraftResultSchema.parse({ ok: false, conflict }),
      dirtyLedgers: [],
    };
  }
  const goal = requireGoal(state, input.goalId);
  const parentConflict = coordinationMilestoneConflict(state, goal);
  if (parentConflict !== null) {
    return {
      result: PlanPublishDraftResultSchema.parse({ ok: false, conflict: parentConflict }),
      dirtyLedgers: [],
    };
  }
  if (goal.status !== "planning") {
    return {
      result: PlanPublishDraftResultSchema.parse({
        ok: false,
        conflict: {
          code: "goal-phase-conflict",
          goalId: input.goalId,
          status: goal.status,
          allowed: ["planning"],
        },
      }),
      dirtyLedgers: [],
    };
  }
  const prior = currentDraft(goal);
  const replacedManifest = prior?.manifest ?? null;
  if (prior !== null && !sameDraft(finalizedDraft(goal), prior.identity)) {
    supersedeManifest(state, prior.manifest);
  }
  const revision = (prior?.identity.revision ?? 0) + 1;
  const manifest = materializeManifest(state, input, revision);
  const identity: PlanDraftIdentity = {
    goalId: input.goalId,
    claimId: input.claimId,
    generation: input.generation,
    revision,
  };
  setJsonField(goal, PLAN_CURRENT_DRAFT_FIELD, { identity, manifest });
  touch(goal, input, state.now());
  const defects = addReviewDefects(state, input.goalId, input.reviewDefects, input);
  const acknowledgement = {
    goalId: input.goalId,
    claimId: input.claimId,
    generation: input.generation,
    operationId: input.operationId,
    manifest,
    replacedManifest,
    reviewDefects: defects,
  };
  recordOperation(state, input, "publish-draft", acknowledgement);
  return {
    result: PlanPublishDraftResultSchema.parse({
      ok: true,
      replayed: false,
      acknowledgement,
    }),
    dirtyLedgers: [
      GOALS_LEDGER,
      MILESTONES_LEDGER,
      TASKS_LEDGER,
      ...(defects.length > 0 ? [DEFECTS_LEDGER, REVIEWS_LEDGER] : []),
    ],
  };
}

/**
 * Resolve a tasks-pause effect against live state. Fail-closed BEFORE any
 * mutation: every ref must canonicalize to the tasks ledger with a bare
 * task id that exists as an active item, and the supplied set must not be
 * entirely terminal (done/abandoned). Returns bare task ids in input order.
 */
function resolveTaskWaitIds(
  state: InMemoryPlanLifecycleState,
  refs: readonly string[],
): string[] {
  const registry = buildPrefixRegistry(
    [...state.ledgers].map(([name, l]) => ({ name, schema: l.schema })),
  );
  const tasksLedger = ledger(state, TASKS_LEDGER);
  const resolved: string[] = [];
  for (const ref of refs) {
    let canonical: string;
    try {
      canonical = canonicalizeRef(ref, registry);
    } catch (error) {
      if (error instanceof RefParseError) {
        throw new LedgerError(`invalid task wait ref "${ref}": ${error.message}`);
      }
      throw error;
    }
    const parsed = parseRef(canonical);
    if (parsed.kind !== "prefixed" || parsed.ledger !== TASKS_LEDGER) {
      throw new LedgerError(
        `invalid task wait ref "${ref}": must name the tasks ledger`,
      );
    }
    const bareId = parsed.id;
    if (!/^T\d+$/.test(bareId)) {
      throw new LedgerError(
        `invalid task wait ref "${ref}": id must match T<n>`,
      );
    }
    const item = findActiveItem(tasksLedger, bareId);
    if (item === undefined) {
      throw new LedgerError(
        `invalid task wait ref "${ref}": task ${bareId} is absent`,
      );
    }
    resolved.push(bareId);
  }
  const allTerminal = resolved.every((id) => {
    const item = findActiveItem(tasksLedger, id);
    return item !== undefined && (item.status === "done" || item.status === "abandoned");
  });
  if (allTerminal) {
    throw new LedgerError(
      "invalid task wait: every supplied task is already terminal (done/abandoned)",
    );
  }
  return resolved;
}

export function releaseInMemoryPlanClaim(
  state: InMemoryPlanLifecycleState,
  rawInput: PlanReleaseInput,
): InMemoryPlanMutation<PlanReleaseResult> {
  const input = PlanReleaseInputSchema.parse(rawInput);
  const replay = replayOperation(state, input, "release", input.kind === "pause");
  if (replay !== null) {
    return { result: PlanReleaseResultSchema.parse(replay), dirtyLedgers: [] };
  }
  const conflict =
    input.kind === "pause"
      ? ownerConflict(state, input)
      : abandonConflict(state, input);
  if (conflict !== null) {
    return {
      result: PlanReleaseResultSchema.parse({ ok: false, conflict }),
      dirtyLedgers: [],
    };
  }
  const goal = requireGoal(state, input.goalId);
  if (input.kind === "pause" && goal.status !== "planning") {
    return {
      result: PlanReleaseResultSchema.parse({
        ok: false,
        conflict: {
          code: "goal-phase-conflict",
          goalId: input.goalId,
          status: goal.status,
          allowed: ["planning"],
        },
      }),
      dirtyLedgers: [],
    };
  }
  // Resolve tasks-pause refs before any mutation so a bad set never releases
  // the claim or falls through to researches/abandon.
  const resolvedTaskWaits =
    input.kind === "pause" && input.effect.kind === "tasks"
      ? resolveTaskWaitIds(state, input.effect.tasks)
      : null;
  const defects = addReviewDefects(state, input.goalId, input.reviewDefects, input);
  let acknowledgement;
  const dirty = new Set<string>([GOALS_LEDGER]);
  if (defects.length > 0) {
    dirty.add(DEFECTS_LEDGER);
    dirty.add(REVIEWS_LEDGER);
  }
  if (input.kind === "pause" && input.effect.kind === "questions") {
    const questions = input.effect.questions.map((question) => {
      const fields: Record<string, FieldValue> = {
        question: question.question,
        ledgerRefs: [`${GOALS_LEDGER}:${input.goalId}`],
      };
      if (question.context !== undefined) fields["context"] = question.context;
      if (question.suggestions !== undefined) fields["suggestions"] = [...question.suggestions];
      if (question.recommendation !== undefined) {
        fields["recommendation"] = question.recommendation;
      }
      const item = addItem(
        state,
        QUESTIONS_LEDGER,
        "M-AMBIENT",
        "open",
        fields,
        input,
      );
      return { key: question.key, id: item.id };
    });
    goal.status = "clarifying";
    setField(goal, PLAN_WAITING_RESEARCHES_FIELD, []);
    setField(goal, PLAN_WAITING_TASKS_FIELD, []);
    dirty.add(QUESTIONS_LEDGER);
    acknowledgement = {
      kind: "questions",
      goalId: input.goalId,
      claimId: input.claimId,
      generation: input.generation,
      operationId: input.operationId,
      reviewDefects: defects,
      questions,
      researches: [],
      waitingResearches: [],
      tasks: [],
      waitingTasks: [],
      goalPhase: "clarifying",
    } as const;
  } else if (input.kind === "pause" && input.effect.kind === "researches") {
    const researches = input.effect.researches.map((research) => {
      const fields: Record<string, FieldValue> = {
        question: research.question,
        ledgerRefs: [`${GOALS_LEDGER}:${input.goalId}`],
      };
      if (research.scope !== undefined) fields["scope"] = research.scope;
      const item = addItem(
        state,
        RESEARCHES_LEDGER,
        "M-AMBIENT",
        "open",
        fields,
        input,
      );
      return { key: research.key, id: item.id };
    });
    goal.status = "planning";
    const waiting = researches.map(({ id }) => id);
    setField(goal, PLAN_WAITING_RESEARCHES_FIELD, waiting);
    setField(goal, PLAN_WAITING_TASKS_FIELD, []);
    dirty.add(RESEARCHES_LEDGER);
    acknowledgement = {
      kind: "researches",
      goalId: input.goalId,
      claimId: input.claimId,
      generation: input.generation,
      operationId: input.operationId,
      reviewDefects: defects,
      questions: [],
      researches,
      waitingResearches: waiting,
      tasks: [],
      waitingTasks: [],
      goalPhase: "planning",
    } as const;
  } else if (input.kind === "pause" && input.effect.kind === "tasks") {
    if (resolvedTaskWaits === null) {
      throw new LedgerError("tasks pause missing resolved wait set");
    }
    // Reference existing tasks only — never allocate, never route to research.
    goal.status = "planning";
    setField(goal, PLAN_WAITING_RESEARCHES_FIELD, []);
    setField(goal, PLAN_WAITING_TASKS_FIELD, resolvedTaskWaits);
    acknowledgement = {
      kind: "tasks",
      goalId: input.goalId,
      claimId: input.claimId,
      generation: input.generation,
      operationId: input.operationId,
      reviewDefects: defects,
      questions: [],
      researches: [],
      waitingResearches: [],
      tasks: resolvedTaskWaits,
      waitingTasks: resolvedTaskWaits,
      goalPhase: "planning",
    } as const;
  } else if (input.kind === "abandon") {
    goal.status = "planning";
    setField(goal, PLAN_WAITING_RESEARCHES_FIELD, []);
    setField(goal, PLAN_WAITING_TASKS_FIELD, []);
    acknowledgement = {
      kind: "abandon",
      goalId: input.goalId,
      claimId: input.claimId,
      generation: input.generation,
      operationId: input.operationId,
      reviewDefects: defects,
      questions: [],
      researches: [],
      waitingResearches: [],
      tasks: [],
      waitingTasks: [],
      goalPhase: "planning",
    } as const;
  } else {
    // Fail closed: an unknown pause kind must never fall through to abandon.
    throw new LedgerError(
      `unsupported plan pause effect kind: ${(input as { effect?: { kind?: string } }).effect?.kind ?? "unknown"}`,
    );
  }
  touch(goal, input, state.now());
  releaseClaim(state, goal, input.claimId, "released");
  recordOperation(state, input, "release", acknowledgement);
  return {
    result: PlanReleaseResultSchema.parse({
      ok: true,
      replayed: false,
      acknowledgement,
    }),
    dirtyLedgers: [...dirty],
  };
}

export function finalizeInMemoryPlan(
  state: InMemoryPlanLifecycleState,
  rawInput: PlanFinalizeInput,
): InMemoryPlanMutation<PlanFinalizeResult> {
  const input = PlanFinalizeInputSchema.parse(rawInput);
  const replay = replayOperation(state, input, "finalize", true);
  if (replay !== null) {
    return { result: PlanFinalizeResultSchema.parse(replay), dirtyLedgers: [] };
  }
  const conflict = ownerConflict(state, input);
  if (conflict !== null) {
    return {
      result: PlanFinalizeResultSchema.parse({ ok: false, conflict }),
      dirtyLedgers: [],
    };
  }
  const goal = requireGoal(state, input.goalId);
  const draft = currentDraft(goal);
  if (draft === null) {
    return {
      result: PlanFinalizeResultSchema.parse({
        ok: false,
        conflict: {
          code: "draft-not-found",
          goalId: input.goalId,
          claimId: input.claimId,
          generation: input.generation,
        },
      }),
      dirtyLedgers: [],
    };
  }
  const review = findActiveItem(ledger(state, REVIEWS_LEDGER), input.reviewId);
  if (review === undefined) {
    return {
      result: PlanFinalizeResultSchema.parse({
        ok: false,
        conflict: {
          code: "review-not-found",
          goalId: input.goalId,
          claimId: input.claimId,
          generation: input.generation,
          reviewId: input.reviewId,
        },
      }),
      dirtyLedgers: [],
    };
  }
  if (review.status !== "go-ahead") {
    return {
      result: PlanFinalizeResultSchema.parse({
        ok: false,
        conflict: {
          code: "review-not-approved",
          goalId: input.goalId,
          claimId: input.claimId,
          generation: input.generation,
          reviewId: input.reviewId,
          status: "revise",
        },
      }),
      dirtyLedgers: [],
    };
  }
  const reviewDraft = parseJsonField(review, PLAN_REVIEW_DRAFT_FIELD, (value) =>
    PlanDraftIdentitySchema.parse(value),
  );
  const binding = resolvePlanFinalizeDraftBinding(
    input,
    draft.identity,
    reviewDraft === null ? null : { reviewId: review.id, draft: reviewDraft },
  );
  if (!binding.ok) {
    return {
      result: PlanFinalizeResultSchema.parse({ ok: false, conflict: binding.conflict }),
      dirtyLedgers: [],
    };
  }

  // The decision is allocated before the finalized marker becomes visible.
  const decisionFields: Record<string, FieldValue> = {
    headline: input.decision.headline,
    ledgerRefs: [`${GOALS_LEDGER}:${input.goalId}`, `${REVIEWS_LEDGER}:${input.reviewId}`],
  };
  if (input.decision.rationale !== undefined) {
    decisionFields["rationale"] = input.decision.rationale;
  }
  if (input.decision.alternatives !== undefined) {
    decisionFields["alternatives"] = input.decision.alternatives;
  }
  const decision = addItem(
    state,
    DECISIONS_LEDGER,
    "M-AMBIENT",
    "locked",
    decisionFields,
    input,
  );
  const defects = addReviewDefects(state, input.goalId, input.reviewDefects, input);
  goal.status = "planned";
  setField(goal, "milestones", draft.manifest.milestones.map(({ id }) => id));
  setJsonField(goal, PLAN_FINALIZED_DRAFT_FIELD, draft.identity);
  setJsonField(goal, PLAN_FINALIZED_MANIFEST_FIELD, draft.manifest);
  setField(goal, PLAN_WAITING_RESEARCHES_FIELD, []);
  setField(goal, PLAN_WAITING_TASKS_FIELD, []);
  touch(goal, input, state.now());
  const acknowledgement = {
    goalId: input.goalId,
    claimId: input.claimId,
    generation: input.generation,
    operationId: input.operationId,
    reviewId: input.reviewId,
    draft: binding.draft,
    decisionId: decision.id,
    manifest: draft.manifest,
    reviewDefects: defects,
    goalPhase: "planned",
  } as const;
  releaseClaim(state, goal, input.claimId, "finalized");
  recordOperation(state, input, "finalize", acknowledgement);
  return {
    result: PlanFinalizeResultSchema.parse({
      ok: true,
      replayed: false,
      acknowledgement,
    }),
    dirtyLedgers: [
      GOALS_LEDGER,
      DECISIONS_LEDGER,
      TASKS_LEDGER,
      ...(defects.length > 0 ? [DEFECTS_LEDGER, REVIEWS_LEDGER] : []),
    ],
  };
}

export function readInMemoryPlanState(goal: Item): {
  generation: number | null;
  activeClaim: ReturnType<typeof publicClaim>;
  currentDraft: StoredDraft | null;
  finalizedDraft: PlanDraftIdentity | null;
  finalizedManifest: PlanPublishedManifest | null;
  waitingResearches: string[];
  waitingTasks: string[];
} {
  return {
    generation: generation(goal),
    activeClaim: publicClaim(goal),
    currentDraft: currentDraft(goal),
    finalizedDraft: finalizedDraft(goal),
    finalizedManifest: finalizedManifest(goal),
    waitingResearches: fieldStrings(goal, PLAN_WAITING_RESEARCHES_FIELD),
    waitingTasks: fieldStrings(goal, PLAN_WAITING_TASKS_FIELD),
  };
}
