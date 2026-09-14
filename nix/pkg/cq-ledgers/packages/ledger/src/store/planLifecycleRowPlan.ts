import {
  DECISIONS_LEDGER, DEFECTS_LEDGER, GOALS_LEDGER, MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_LEDGER, QUESTIONS_LEDGER, RESEARCHES_LEDGER, REVIEWS_LEDGER, TASKS_LEDGER,
} from "../constants.js";
import {
  PLAN_GENERATION_FIELD, PLAN_WAITING_RESEARCHES_FIELD, PLAN_WAITING_TASKS_FIELD,
  PlanClaimInputSchema, PlanFinalizeInputSchema, PlanPublishDraftInputSchema, PlanReleaseInputSchema,
  type PlanClaimInput, type PlanFinalizeInput, type PlanPrivateClaimRecord,
  type PlanPublishDraftInput, type PlanPublishedManifest, type PlanReleaseInput,
} from "../planLifecycle.js";
import { buildPrefixRegistry, canonicalizeRef, RefParseError } from "../refs.js";
import { LedgerError, type Item, type Ledger } from "../types.js";
import {
  abandonConflict, coordinationMilestoneConflict, currentDraft, finalizedDraft, ownerConflict,
  preflightManifestReferences, sameDraft,
  type InMemoryPlanLifecycleState, type InMemoryPlanOperationRecord,
} from "./inMemoryPlanLifecycle.js";
import type { LifecyclePrivateRecordChanges, LifecycleRowRepository } from "./lifecycleRowRepository.js";
import { claimScopeKey, operationScopeKey } from "./planLifecycleDump.js";
import type { AsyncLifecycleRowRepository } from "./asyncRowRepository.js";
import { createLifecycleReadRequests, runLifecycleReads, runAsyncLifecycleReads, type LifecycleReadProgram } from "./lifecycleReadProgram.js";

export type PlanLifecycleRowRequest =
  | { readonly operation: "claim"; readonly input: PlanClaimInput }
  | { readonly operation: "publish-draft"; readonly input: PlanPublishDraftInput }
  | { readonly operation: "release"; readonly input: PlanReleaseInput }
  | { readonly operation: "finalize"; readonly input: PlanFinalizeInput };

export interface PlanLifecycleRowPlan {
  readonly state: InMemoryPlanLifecycleState;
  readonly beforeLedgers: Map<string, Ledger>;
  privateChanges(): LifecyclePrivateRecordChanges;
}

function parseRequest(request: PlanLifecycleRowRequest): PlanLifecycleRowRequest {
  switch (request.operation) {
    case "claim": return { operation: request.operation, input: PlanClaimInputSchema.parse(request.input) };
    case "publish-draft": return { operation: request.operation, input: PlanPublishDraftInputSchema.parse(request.input) };
    case "release": return { operation: request.operation, input: PlanReleaseInputSchema.parse(request.input) };
    case "finalize": return { operation: request.operation, input: PlanFinalizeInputSchema.parse(request.input) };
  }
}

function fieldRefs(item: Item, name: string): readonly string[] {
  const value = item.fields[name];
  return Array.isArray(value) ? value : [];
}

export function loadPlanLifecycleRowPlan(
  rows: LifecycleRowRepository,
  rawRequest: PlanLifecycleRowRequest,
  now: () => string,
): PlanLifecycleRowPlan {
  return runLifecycleReads(rows, planLifecycleReads(rawRequest, now));
}

export function loadAsyncPlanLifecycleRowPlan(
  rows: AsyncLifecycleRowRepository,
  request: PlanLifecycleRowRequest,
  now: () => string,
): Promise<PlanLifecycleRowPlan> {
  return runAsyncLifecycleReads(rows, planLifecycleReads(request, now));
}

function* planLifecycleReads(rawRequest: PlanLifecycleRowRequest, now: () => string): LifecycleReadProgram<PlanLifecycleRowPlan> {
  const rows = createLifecycleReadRequests();
  const request = parseRequest(rawRequest);
  const ledgers = new Map<string, Ledger>();
  const claims = new Map<string, PlanPrivateClaimRecord>();
  const operations = new Map<string, InMemoryPlanOperationRecord>();
  const archivedIds = new Map<string, Set<string>>();
  const state: InMemoryPlanLifecycleState = { ledgers, claims, operations, archivedIds, now };
  const includeClaim = (claim: PlanPrivateClaimRecord | undefined): void => {
    if (claim !== undefined) claims.set(claimScopeKey(claim.goalId, claim.claimRequestId), claim);
  };
  const finish = (): PlanLifecycleRowPlan => {
    const beforeClaims = new Map([...claims].map(([key, value]) => [key, JSON.stringify(value)]));
    const beforeOperations = new Map([...operations].map(([key, value]) => [key, JSON.stringify(value)]));
    return {
      state, beforeLedgers: structuredClone(ledgers),
      privateChanges: () => ({
        claims: [...claims].filter(([key, value]) => beforeClaims.get(key) !== JSON.stringify(value)).map(([, value]) => value),
        operations: [...operations].filter(([key, value]) => beforeOperations.get(key) !== JSON.stringify(value)).map(([, value]) => value),
      }),
    };
  };

  // Replay precedes goal lookup, including after archival or a later generation.
  if (request.operation === "claim") {
    const existing = yield* rows.fetchClaimByRequest(request.input);
    includeClaim(existing);
    if (existing !== undefined) return finish();
  } else {
    const operation = yield* rows.fetchOperation({ ...request.input, operation: request.operation });
    if (operation !== undefined) {
      includeClaim(yield* rows.fetchClaimByIdentity(request.input));
      const key = operation.replay;
      operations.set(operationScopeKey(key.goalId, key.claimId, key.generation, key.operation, key.operationId), operation);
      return finish();
    }
  }

  const metadata = yield* rows.publicRows.listLedgers();
  for (const { id, schema, counters } of metadata) {
    ledgers.set(id, { id, schema: structuredClone(schema), counters: { ...counters }, milestones: [], archivePointers: [] });
  }
  const registry = buildPrefixRegistry(metadata.map(({ id, schema }) => ({ name: id, schema })));
  const items = new Map<string, Item | undefined>();
  const groups = new Set<string>();
  const requireLedger = (id: string): Ledger => {
    const ledger = ledgers.get(id);
    if (ledger === undefined) throw new LedgerError(`ledger not found: ${id}`);
    return ledger;
  };
  const includeGroup = function* (ledgerId: string, groupId: string): LifecycleReadProgram<void> {
    const key = `${ledgerId}:${groupId}`;
    if (groups.has(key)) return;
    groups.add(key);
    const group = yield* rows.fetchGroup(ledgerId, groupId);
    if (group !== undefined) requireLedger(ledgerId).milestones.push({ ...group, items: [] });
  };
  const includeActive = function* (ledgerId: string, id: string): LifecycleReadProgram<Item | undefined> {
    const ref = `${ledgerId}:${id}`;
    if (items.has(ref)) return items.get(ref);
    const item = yield* rows.publicRows.fetchActiveItem(ref);
    items.set(ref, item);
    if (item === undefined) return undefined;
    yield* includeGroup(ledgerId, item.milestoneId);
    const ledger = requireLedger(ledgerId);
    const group = ledger.milestones.find(({ id }) => id === item.milestoneId);
    if (group === undefined) {
      throw new LedgerError(`ledger ${ledgerId}: item ${item.id} references a milestone-group with no groups row`);
    }
    group.items.push(item);
    return item;
  };
  const includeRef = function* (raw: string, archived: boolean): LifecycleReadProgram<void> {
    let ref: string;
    try { ref = canonicalizeRef(raw, registry); } catch (error) {
      // Reference validation belongs to the operation, after its fencing checks.
      if (error instanceof RefParseError) return;
      throw error;
    }
    const colon = ref.indexOf(":");
    const ledgerId = ref.slice(0, colon);
    const id = ref.slice(colon + 1);
    if ((yield* includeActive(ledgerId, id)) !== undefined || !archived) return;
    const target = yield* rows.publicRows.fetchArchivedItem(ref);
    if (target === undefined) return;
    let ids = archivedIds.get(ledgerId);
    if (ids === undefined) { ids = new Set(); archivedIds.set(ledgerId, ids); }
    ids.add(id);
  };
  const includeIncident = function* (refs: readonly string[], fields: readonly string[], allowed: readonly string[]): LifecycleReadProgram<void> {
    for (const ref of refs) {
      for (const source of yield* rows.publicRows.referenceSources(ref, fields)) {
        if (allowed.includes(source.slice(0, source.indexOf(":")))) yield* includeRef(source, false);
      }
    }
  };
  const includeManifest = function* (manifest: PlanPublishedManifest): LifecycleReadProgram<string[]> {
    const refs = [
      ...manifest.milestones.map(({ id }) => `${MILESTONES_LEDGER}:${id}`),
      ...manifest.tasks.map(({ id }) => `${TASKS_LEDGER}:${id}`),
    ];
    for (const ref of refs) yield* includeRef(ref, false);
    return refs;
  };
  const prepareAllocation = function* (ledgerId: string, count: number): LifecycleReadProgram<string[]> {
    const ledger = requireLedger(ledgerId);
    const prefix = ledger.schema.idPrefix ?? ledgerId.slice(0, 1).toUpperCase();
    const ids: string[] = [];
    let counter = ledger.counters.item;
    while (ids.length < count) {
      const id = `${prefix}${++counter}`;
      if ((yield* includeActive(ledgerId, id)) === undefined) ids.push(id);
    }
    return ids;
  };

  const goal = yield* includeActive(GOALS_LEDGER, request.input.goalId);
  if (goal === undefined) return finish();
  includeClaim(yield* rows.fetchActiveClaim(goal.id));
  if (request.operation === "claim" || request.operation === "publish-draft") {
    yield* includeActive(MILESTONES_LEDGER, goal.milestoneId);
  }

  if (request.operation === "claim") {
    const milestoneIds = fieldRefs(goal, "milestones");
    if (request.input.purpose === "follow-up" || typeof goal.fields[PLAN_GENERATION_FIELD] !== "string") {
      for (const ref of yield* rows.taskRefsByMilestones(milestoneIds)) yield* includeRef(ref, false);
    }
    for (const ref of fieldRefs(goal, PLAN_WAITING_RESEARCHES_FIELD)) {
      yield* includeActive(RESEARCHES_LEDGER, ref.replace(/^researches:/, ""));
    }
    for (const ref of fieldRefs(goal, PLAN_WAITING_TASKS_FIELD)) {
      yield* includeActive(TASKS_LEDGER, ref.replace(/^tasks:/, ""));
    }
    if (request.input.purpose === "follow-up") {
      const superseded = milestoneIds.map((id) => `${MILESTONES_LEDGER}:${id}`);
      for (const id of milestoneIds) yield* includeActive(MILESTONES_LEDGER, id);
      for (const group of requireLedger(TASKS_LEDGER).milestones) {
        if (!milestoneIds.includes(group.id)) continue;
        for (const task of group.items) if (task.status === "planned") superseded.push(`${TASKS_LEDGER}:${task.id}`);
      }
      yield* includeIncident(superseded, ["dependsOn", "blockedBy"], [MILESTONES_LEDGER, TASKS_LEDGER]);
      yield* includeIncident([`${GOALS_LEDGER}:${goal.id}`, ...superseded], ["ledgerRefs"], [QUESTIONS_LEDGER]);
    }
    return finish();
  }

  const conflict = request.operation === "release"
    ? request.input.kind === "abandon"
      ? abandonConflict(state, request.input) : ownerConflict(state, request.input)
    : ownerConflict(state, request.input);
  if (conflict !== null) return finish();

  if (request.operation === "publish-draft") {
    if (coordinationMilestoneConflict(state, goal) !== null || goal.status !== "planning") return finish();
    const milestoneIds = yield* prepareAllocation(MILESTONES_LEDGER, request.input.manifest.milestones.length);
    yield* prepareAllocation(TASKS_LEDGER, request.input.manifest.tasks.length);
    yield* includeGroup(MILESTONES_LEDGER, MILESTONES_ACTIVE_GROUP_ID);
    for (const id of milestoneIds) yield* includeGroup(TASKS_LEDGER, id);
    for (const draft of [...request.input.manifest.milestones, ...request.input.manifest.tasks]) {
      for (const ref of [...(draft.dependsOn ?? []), ...(draft.blockedBy ?? [])]) {
        if (ref.kind === "ledger") yield* includeRef(ref.ref, true);
      }
    }
    preflightManifestReferences(state, request.input);
    const prior = currentDraft(goal);
    if (prior !== null && !sameDraft(finalizedDraft(goal), prior.identity)) {
      yield* includeIncident(yield* includeManifest(prior.manifest), ["dependsOn", "blockedBy"], [MILESTONES_LEDGER, TASKS_LEDGER]);
    }
  } else if (request.operation === "release") {
    if (request.input.kind === "pause") {
      if (goal.status !== "planning") return finish();
      const effect = request.input.effect;
      if (effect.kind === "tasks") {
        for (const ref of effect.tasks) yield* includeRef(ref, false);
      } else {
        const ledgerId = effect.kind === "questions" ? QUESTIONS_LEDGER : RESEARCHES_LEDGER;
        const count = effect.kind === "questions" ? effect.questions.length : effect.researches.length;
        yield* prepareAllocation(ledgerId, count);
        yield* includeGroup(ledgerId, "M-AMBIENT");
      }
    }
  } else {
    const draft = currentDraft(goal);
    if (draft === null) return finish();
    yield* includeManifest(draft.manifest);
    yield* includeActive(REVIEWS_LEDGER, request.input.reviewId);
    yield* prepareAllocation(DECISIONS_LEDGER, 1);
    yield* includeGroup(DECISIONS_LEDGER, "M-AMBIENT");
  }
  const reviewDefects = request.input.reviewDefects;
  if (reviewDefects !== undefined) {
    yield* includeActive(REVIEWS_LEDGER, reviewDefects.reviewId);
    yield* prepareAllocation(DEFECTS_LEDGER, reviewDefects.defects.length);
    yield* includeGroup(DEFECTS_LEDGER, "M-AMBIENT");
  }
  return finish();
}
