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
    const existing = rows.fetchClaimByRequest(request.input);
    includeClaim(existing);
    if (existing !== undefined) return finish();
  } else {
    const operation = rows.fetchOperation({ ...request.input, operation: request.operation });
    if (operation !== undefined) {
      includeClaim(rows.fetchClaimByIdentity(request.input));
      const key = operation.replay;
      operations.set(operationScopeKey(key.goalId, key.claimId, key.generation, key.operation, key.operationId), operation);
      return finish();
    }
  }

  const metadata = rows.publicRows.listLedgers();
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
  const includeGroup = (ledgerId: string, groupId: string): void => {
    const key = `${ledgerId}:${groupId}`;
    if (groups.has(key)) return;
    groups.add(key);
    const group = rows.fetchGroup(ledgerId, groupId);
    if (group !== undefined) requireLedger(ledgerId).milestones.push({ ...group, items: [] });
  };
  const includeActive = (ledgerId: string, id: string): Item | undefined => {
    const ref = `${ledgerId}:${id}`;
    if (items.has(ref)) return items.get(ref);
    const item = rows.publicRows.fetchActiveItem(ref);
    items.set(ref, item);
    if (item === undefined) return undefined;
    includeGroup(ledgerId, item.milestoneId);
    const ledger = requireLedger(ledgerId);
    const group = ledger.milestones.find(({ id }) => id === item.milestoneId);
    if (group === undefined) {
      throw new LedgerError(`ledger ${ledgerId}: item ${item.id} references a milestone-group with no groups row`);
    }
    group.items.push(item);
    return item;
  };
  const includeRef = (raw: string, archived: boolean): void => {
    let ref: string;
    try { ref = canonicalizeRef(raw, registry); } catch (error) {
      // Reference validation belongs to the operation, after its fencing checks.
      if (error instanceof RefParseError) return;
      throw error;
    }
    const colon = ref.indexOf(":");
    const ledgerId = ref.slice(0, colon);
    const id = ref.slice(colon + 1);
    if (includeActive(ledgerId, id) !== undefined || !archived) return;
    const target = rows.publicRows.fetchArchivedItem(ref);
    if (target === undefined) return;
    let ids = archivedIds.get(ledgerId);
    if (ids === undefined) { ids = new Set(); archivedIds.set(ledgerId, ids); }
    ids.add(id);
  };
  const includeIncident = (refs: readonly string[], fields: readonly string[], allowed: readonly string[]): void => {
    for (const ref of refs) {
      for (const source of rows.publicRows.referenceSources(ref, fields)) {
        if (allowed.includes(source.slice(0, source.indexOf(":")))) includeRef(source, false);
      }
    }
  };
  const includeManifest = (manifest: PlanPublishedManifest): string[] => {
    const refs = [
      ...manifest.milestones.map(({ id }) => `${MILESTONES_LEDGER}:${id}`),
      ...manifest.tasks.map(({ id }) => `${TASKS_LEDGER}:${id}`),
    ];
    for (const ref of refs) includeRef(ref, false);
    return refs;
  };
  const prepareAllocation = (ledgerId: string, count: number): string[] => {
    const ledger = requireLedger(ledgerId);
    const prefix = ledger.schema.idPrefix ?? ledgerId.slice(0, 1).toUpperCase();
    const ids: string[] = [];
    let counter = ledger.counters.item;
    while (ids.length < count) {
      const id = `${prefix}${++counter}`;
      if (includeActive(ledgerId, id) === undefined) ids.push(id);
    }
    return ids;
  };

  const goal = includeActive(GOALS_LEDGER, request.input.goalId);
  if (goal === undefined) return finish();
  includeClaim(rows.fetchActiveClaim(goal.id));
  if (request.operation === "claim" || request.operation === "publish-draft") {
    includeActive(MILESTONES_LEDGER, goal.milestoneId);
  }

  if (request.operation === "claim") {
    const milestoneIds = fieldRefs(goal, "milestones");
    if (request.input.purpose === "follow-up" || typeof goal.fields[PLAN_GENERATION_FIELD] !== "string") {
      for (const ref of rows.taskRefsByMilestones(milestoneIds)) includeRef(ref, false);
    }
    for (const ref of fieldRefs(goal, PLAN_WAITING_RESEARCHES_FIELD)) {
      includeActive(RESEARCHES_LEDGER, ref.replace(/^researches:/, ""));
    }
    for (const ref of fieldRefs(goal, PLAN_WAITING_TASKS_FIELD)) {
      includeActive(TASKS_LEDGER, ref.replace(/^tasks:/, ""));
    }
    if (request.input.purpose === "follow-up") {
      const superseded = milestoneIds.map((id) => `${MILESTONES_LEDGER}:${id}`);
      for (const id of milestoneIds) includeActive(MILESTONES_LEDGER, id);
      for (const group of requireLedger(TASKS_LEDGER).milestones) {
        if (!milestoneIds.includes(group.id)) continue;
        for (const task of group.items) if (task.status === "planned") superseded.push(`${TASKS_LEDGER}:${task.id}`);
      }
      includeIncident(superseded, ["dependsOn", "blockedBy"], [MILESTONES_LEDGER, TASKS_LEDGER]);
      includeIncident([`${GOALS_LEDGER}:${goal.id}`, ...superseded], ["ledgerRefs"], [QUESTIONS_LEDGER]);
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
    const milestoneIds = prepareAllocation(MILESTONES_LEDGER, request.input.manifest.milestones.length);
    prepareAllocation(TASKS_LEDGER, request.input.manifest.tasks.length);
    includeGroup(MILESTONES_LEDGER, MILESTONES_ACTIVE_GROUP_ID);
    for (const id of milestoneIds) includeGroup(TASKS_LEDGER, id);
    for (const draft of [...request.input.manifest.milestones, ...request.input.manifest.tasks]) {
      for (const ref of [...(draft.dependsOn ?? []), ...(draft.blockedBy ?? [])]) {
        if (ref.kind === "ledger") includeRef(ref.ref, true);
      }
    }
    preflightManifestReferences(state, request.input);
    const prior = currentDraft(goal);
    if (prior !== null && !sameDraft(finalizedDraft(goal), prior.identity)) {
      includeIncident(includeManifest(prior.manifest), ["dependsOn", "blockedBy"], [MILESTONES_LEDGER, TASKS_LEDGER]);
    }
  } else if (request.operation === "release") {
    if (request.input.kind === "pause") {
      if (goal.status !== "planning") return finish();
      const effect = request.input.effect;
      if (effect.kind === "tasks") {
        for (const ref of effect.tasks) includeRef(ref, false);
      } else {
        const ledgerId = effect.kind === "questions" ? QUESTIONS_LEDGER : RESEARCHES_LEDGER;
        const count = effect.kind === "questions" ? effect.questions.length : effect.researches.length;
        prepareAllocation(ledgerId, count);
        includeGroup(ledgerId, "M-AMBIENT");
      }
    }
  } else {
    const draft = currentDraft(goal);
    if (draft === null) return finish();
    includeManifest(draft.manifest);
    includeActive(REVIEWS_LEDGER, request.input.reviewId);
    prepareAllocation(DECISIONS_LEDGER, 1);
    includeGroup(DECISIONS_LEDGER, "M-AMBIENT");
  }
  const reviewDefects = request.input.reviewDefects;
  if (reviewDefects !== undefined) {
    includeActive(REVIEWS_LEDGER, reviewDefects.reviewId);
    prepareAllocation(DEFECTS_LEDGER, reviewDefects.defects.length);
    includeGroup(DEFECTS_LEDGER, "M-AMBIENT");
  }
  return finish();
}
