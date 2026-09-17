import { DECISIONS_LEDGER, DEFECTS_LEDGER, GOALS_LEDGER, HANDOFFS_LEDGER, IDEAS_LEDGER, IMPLEMENTATION_COMPLETION_REVIEW_FIELD, MILESTONES_ACTIVE_GROUP_ID, MILESTONES_AMBIENT_ID, MILESTONES_LEDGER, OPERATOR_ACTIONS_LEDGER, QUESTIONS_LEDGER, REVIEWS_LEDGER, TASKS_LEDGER } from "../constants.js";
import { buildPrefixRegistry, canonicalizeRef, RefParseError } from "../refs.js";
import { LedgerError, LedgerNotFoundError, type FieldValue, type Item, type Ledger } from "../types.js";
import type { WorksetActiveState } from "../worksetGraph.js";
import type { OwnedMutationOperation, WorksetOwnedWriteTx } from "../worksetOwnedLifecycle.js";
import { readCanonicalOwnership } from "../worksetOwnerEdges.js";
import type { CreateItemInit, CreateMilestoneItemInit, UpdateItemPatch } from "./LedgerStore.js";
import type { LifecycleRowRepository } from "./lifecycleRowRepository.js";
import { applyOperatorActionLifecycleRows, operatorActionReads } from "./operatorActionLifecycle.js";
import { createOwnedWriteTransaction } from "./ownedWriteTransaction.js";
import type { AsyncLifecycleRowRepository } from "./asyncRowRepository.js";
import type { GenericMutationLedgerMetadata } from "./genericMutationDataSource.js";
import { repositoryRead, runRepositoryReads, runAsyncRepositoryReads, type RepositoryReadProgram } from "./readProgram.js";
import type { DirectOwnedOperation } from "./directOwnedMutation.js";
import { actionIdForTask, handoffIdForTask, taskIdForAction } from "../operatorActions.js";

export interface KeyedOwnedWriteTransaction {
  readonly tx: WorksetOwnedWriteTx;
  readonly ledgers: Map<string, Ledger>;
  readonly beforeLedgers: Map<string, Ledger>;
  readonly dirtyLedgers: ReadonlySet<string>;
  readonly allocationLedgers: ReadonlySet<string>;
}

export function createKeyedOwnedWriteTransaction(
  rows: LifecycleRowRepository,
  admittedState: WorksetActiveState | null,
  now: () => string,
): KeyedOwnedWriteTransaction {
  const plan = prepareOwnedRows(rows.publicRows.listLedgers());
  runRepositoryReads(rows, plan.includeState(admittedState));
  return plan.transaction((program) => runRepositoryReads(rows, program), admittedState, now);
}

export async function createAsyncKeyedOwnedWriteTransaction(rows: AsyncLifecycleRowRepository,
  admittedState: WorksetActiveState, operation: OwnedMutationOperation, now: () => string): Promise<KeyedOwnedWriteTransaction> {
  const plan = prepareOwnedRows(await rows.publicRows.listLedgers());
  await runAsyncRepositoryReads(rows, plan.includeState(admittedState));
  await runAsyncRepositoryReads(rows, plan.prepareOperation(operation, admittedState));
  return plan.transaction(requirePreparedRows, admittedState, now);
}

export async function createAsyncDirectOwnedWriteTransaction(rows: AsyncLifecycleRowRepository,
  operation: DirectOwnedOperation, now: () => string): Promise<KeyedOwnedWriteTransaction> {
  const plan = prepareOwnedRows(await rows.publicRows.listLedgers());
  await runAsyncRepositoryReads(rows, plan.prepareDirectOperation(operation, now));
  return plan.transaction(requirePreparedRows, null, now);
}

type OwnedReadSource = LifecycleRowRepository | AsyncLifecycleRowRepository;
type OwnedReads<T> = RepositoryReadProgram<OwnedReadSource, T>;

function requirePreparedRows<T>(program: OwnedReads<T>): T {
  const step = program.next();
  if (!step.done) throw new LedgerError("owned transaction requested an unprepared row outside its declared operation");
  return step.value;
}

function prepareOwnedRows(metadata: readonly GenericMutationLedgerMetadata[]) {
  const rows = {
    fetchGroup: (ledgerId: string, id: string) => repositoryRead((source: OwnedReadSource) => source.fetchGroup(ledgerId, id)),
    fetchActiveItem: (ref: string) => repositoryRead((source: OwnedReadSource) => source.publicRows.fetchActiveItem(ref)),
    fetchArchivedItem: (ref: string) => repositoryRead((source: OwnedReadSource) => source.publicRows.fetchArchivedItem(ref)),
    referenceSources: (ref: string, fields: readonly string[]) => repositoryRead((source: OwnedReadSource) => source.publicRows.referenceSources(ref, fields)),
  };
  const ledgers = new Map<string, Ledger>(metadata.map(({ id, schema, counters }) => [id, {
    id, schema: structuredClone(schema), counters: { ...counters }, milestones: [], archivePointers: [],
  }]));
  const beforeLedgers = structuredClone(ledgers);
  const registry = buildPrefixRegistry(metadata.map(({ id, schema }) => ({ name: id, schema })));
  const loaded = new Set<string>();
  const loadedGroups = new Set<string>();
  const archived = new Map<string, boolean>();
  const allocationLedgers = new Set<string>();
  const requireLedger = (source: ReadonlyMap<string, Ledger>, id: string): Ledger => {
    const ledger = source.get(id);
    if (ledger === undefined) throw new LedgerNotFoundError(id);
    return ledger;
  };
  function* loadGroup(ledgerId: string, id: string): OwnedReads<void> {
    const key = `${ledgerId}:${id}`;
    if (loadedGroups.has(key)) return;
    const group = yield* rows.fetchGroup(ledgerId, id);
    loadedGroups.add(key);
    if (group === undefined) return;
    for (const map of [beforeLedgers, ledgers]) {
      const ledger = requireLedger(map, ledgerId);
      if (!ledger.milestones.some((candidate) => candidate.id === id)) ledger.milestones.push({ ...group, items: [] });
    }
  }
  function* includeItem(ledgerId: string, item: Item): OwnedReads<Item> {
    yield* loadGroup(ledgerId, item.milestoneId);
    for (const map of [beforeLedgers, ledgers]) {
      const group = requireLedger(map, ledgerId).milestones.find(({ id }) => id === item.milestoneId);
      if (group === undefined) throw new LedgerError(`ledger ${ledgerId}: item ${item.id} references a milestone-group with no groups row`);
      group.items.push(map === ledgers ? item : structuredClone(item));
    }
    loaded.add(`${ledgerId}:${item.id}`);
    return item;
  }
  function* loadItem(ledgerId: string, itemId: string): OwnedReads<Item | undefined> {
    const ledger = requireLedger(ledgers, ledgerId);
    for (const group of ledger.milestones) {
      const item = group.items.find(({ id }) => id === itemId);
      if (item !== undefined) return item;
    }
    const ref = `${ledgerId}:${itemId}`;
    if (loaded.has(ref)) return undefined;
    const item = yield* rows.fetchActiveItem(ref);
    loaded.add(ref);
    return item === undefined ? undefined : yield* includeItem(ledgerId, item);
  }
  function* loadRef(raw: string, allowArchived: boolean): OwnedReads<void> {
    let ref: string;
    try { ref = canonicalizeRef(raw, registry); } catch (error) {
      if (error instanceof RefParseError) return;
      throw error;
    }
    const colon = ref.indexOf(":");
    if ((yield* loadItem(ref.slice(0, colon), ref.slice(colon + 1))) !== undefined || !allowArchived || archived.has(ref)) return;
    archived.set(ref, (yield* rows.fetchArchivedItem(ref)) !== undefined);
  }
  function* prepareFields(ledgerId: string, fields: Readonly<Record<string, FieldValue | undefined>>): OwnedReads<void> {
    for (const name of ["dependsOn", "blockedBy"]) {
      const refs = fields[name];
      if (Array.isArray(refs)) for (const ref of refs) yield* loadRef(ref, true);
    }
    if (ledgerId === TASKS_LEDGER) {
      const refs = fields.ledgerRefs;
      if (Array.isArray(refs)) for (const ref of refs) if (ref.startsWith(`${GOALS_LEDGER}:`)) yield* loadRef(ref, false);
    }
  }
  function* prepareAllocation(ledgerId: string, explicitId: string | undefined): OwnedReads<void> {
    allocationLedgers.add(ledgerId);
    if (explicitId !== undefined) { yield* loadItem(ledgerId, explicitId); return; }
    const ledger = requireLedger(ledgers, ledgerId);
    const prefix = ledger.schema.idPrefix ?? ledgerId.slice(0, 1).toUpperCase();
    let counter = ledger.counters.item;
    while ((yield* loadItem(ledgerId, `${prefix}${counter + 1}`)) !== undefined) counter += 1;
  }
  function* prepareCreate(ledgerId: string, milestoneId: string, init: Pick<CreateItemInit, "id" | "fields">): OwnedReads<void> {
    yield* loadItem(MILESTONES_LEDGER, milestoneId);
    yield* loadGroup(ledgerId, milestoneId);
    yield* prepareFields(ledgerId, init.fields);
    yield* prepareAllocation(ledgerId, init.id);
  }
  function* prepareMilestone(init: Pick<CreateMilestoneItemInit, "id" | "dependsOn" | "blockedBy">): OwnedReads<void> {
    yield* loadGroup(MILESTONES_LEDGER, MILESTONES_ACTIVE_GROUP_ID);
    yield* prepareFields(MILESTONES_LEDGER, { dependsOn: init.dependsOn, blockedBy: init.blockedBy });
    yield* prepareAllocation(MILESTONES_LEDGER, init.id);
  }
  function* includeState(admittedState: WorksetActiveState | null): OwnedReads<void> {
    if (admittedState !== null) {
      for (const [ref, item] of admittedState.byRef) yield* includeItem(ref.slice(0, ref.indexOf(":")), structuredClone(item));
    }
  }
  function* prepareOperation(operation: OwnedMutationOperation, admittedState: WorksetActiveState): OwnedReads<void> {
    if (operation.kind === "create-owned" || operation.kind === "create-ownerless") {
      const input = operation.kind === "create-owned" ? operation.input.child : operation.input;
      const init: CreateItemInit = { status: input.status, fields: input.fields };
      if (input.id !== undefined) init.id = input.id;
      if (input.ledgerId === MILESTONES_LEDGER) {
        const milestone: Pick<CreateMilestoneItemInit, "id"> = {};
        if (input.id !== undefined) milestone.id = input.id;
        yield* prepareMilestone(milestone);
      } else yield* prepareCreate(input.ledgerId, input.milestoneId ?? MILESTONES_AMBIENT_ID, init);
      return;
    }
    if (operation.kind === "defect-to-fix-goal") {
      const ownerRef = `defects:${operation.input.defectId}`;
      for (const [ref, item] of admittedState.byRef) {
        if (!ref.startsWith(`${GOALS_LEDGER}:`)) continue;
        const ownership = readCanonicalOwnership(item);
        if (ownership !== null && ownership.ownerRef === ownerRef && ownership.edgeKind === "fix-goal") return;
      }
    }
    const { goal } = operation.input;
    yield* prepareCreate(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      fields: { title: goal.title, description: goal.description, ...goal.fields } });
    if (operation.kind === "idea-to-goal" && operation.input.consumeIdea === true) {
      const idea = yield* loadItem(IDEAS_LEDGER, operation.input.ideaId);
      if (idea !== undefined && idea.status !== "planned" && idea.status !== "discarded") yield* prepareFields(IDEAS_LEDGER, idea.fields);
    }
  }
  function* prepareUpdate(ledgerId: string, itemId: string, patch: UpdateItemPatch): OwnedReads<void> {
    const item = yield* loadItem(ledgerId, itemId);
    if (item !== undefined) yield* prepareFields(ledgerId, item.fields);
    if (patch.fields !== undefined) yield* prepareFields(ledgerId, patch.fields);
    if (ledgerId === GOALS_LEDGER && patch.status !== undefined) {
      const ref = `${ledgerId}:${itemId}`;
      for (const source of yield* rows.referenceSources(ref, ["worksetOwnerRef"])) yield* loadRef(source, false);
      for (const source of yield* rows.referenceSources(ref, ["ledgerRefs"])) {
        if (source.startsWith(`${QUESTIONS_LEDGER}:`) || source.startsWith(`${DECISIONS_LEDGER}:`)) yield* loadRef(source, false);
      }
    }
  }
  function* prepareDirectOperation(operation: DirectOwnedOperation, now: () => string): OwnedReads<void> {
    if (operation.kind === "implementation-adoption") {
      yield* loadItem(GOALS_LEDGER, operation.ownerGoalId);
      yield* loadItem(QUESTIONS_LEDGER, operation.approvalQuestionId);
      yield* prepareUpdate(TASKS_LEDGER, operation.taskId, operation.taskPatch);
      return;
    }
    if (operation.kind === "materialize-operator") {
      const task = yield* loadItem(TASKS_LEDGER, operation.input.taskId);
      if (task === undefined || task.status !== "planned") return;
      const actionId = actionIdForTask(task.id);
      const handoffId = handoffIdForTask(task.id);
      const action = yield* loadItem(OPERATOR_ACTIONS_LEDGER, actionId);
      if (action === undefined) yield* prepareCreate(OPERATOR_ACTIONS_LEDGER, task.milestoneId, { id: actionId, fields: {} });
      const handoff = yield* loadItem(HANDOFFS_LEDGER, handoffId);
      if (handoff === undefined) yield* prepareCreate(HANDOFFS_LEDGER, task.milestoneId, { id: handoffId, fields: {} });
      return;
    }
    if (operation.kind === "supersede-operator") {
      const { input } = operation;
      const action = yield* loadItem(OPERATOR_ACTIONS_LEDGER, input.actionId);
      if (action !== undefined) {
        const program = operatorActionReads({ kind: "supersede", ...input, provenance: {
          author: input.author, ...(input.session === undefined ? {} : { session: input.session }),
        } }, now);
        let step = program.next();
        while (!step.done) step = program.next(yield* loadItem(step.value.ledgerId, step.value.itemId));
      } else {
        const task = yield* loadItem(TASKS_LEDGER, taskIdForAction(input.actionId));
        if (task !== undefined && task.status === "planned") yield* prepareFields(TASKS_LEDGER, task.fields);
      }
      return;
    }
    const task = yield* loadItem(TASKS_LEDGER, operation.taskId);
    if (task === undefined) return;
    const reviewBinding = task.fields[IMPLEMENTATION_COMPLETION_REVIEW_FIELD];
    if (reviewBinding !== undefined) {
      if (typeof reviewBinding === "string" && /^reviews:R[0-9]+$/u.test(reviewBinding)) {
        yield* loadItem(REVIEWS_LEDGER, reviewBinding.slice(`${REVIEWS_LEDGER}:`.length));
      }
      return;
    }
    if (task.status === "done") return;
    yield* prepareCreate(REVIEWS_LEDGER, task.milestoneId, operation.reviewInit);
    if (task.status !== "done") yield* prepareUpdate(TASKS_LEDGER, task.id, operation.taskPatch);
    const defectRefs = task.fields.ledgerRefs;
    if (Array.isArray(defectRefs)) for (const ref of new Set(defectRefs)) {
      if (!ref.startsWith(`${DEFECTS_LEDGER}:`)) continue;
      const defect = yield* loadItem(DEFECTS_LEDGER, ref.slice(DEFECTS_LEDGER.length + 1));
      if (defect !== undefined && defect.status === "root-caused") yield* prepareUpdate(DEFECTS_LEDGER, defect.id, operation.defectPatch);
    }
  }
  function transaction(run: <T>(program: OwnedReads<T>) => T, admittedState: WorksetActiveState | null,
    now: () => string): KeyedOwnedWriteTransaction {
    const operatorDirty = new Set<string>();
    const owned = createOwnedWriteTransaction({
      ledgers, now,
      archivedRefExists: (ledgerId, itemId) => archived.get(`${ledgerId}:${itemId}`) === true,
    });
    return {
      ledgers, beforeLedgers, allocationLedgers,
      get dirtyLedgers() { return new Set([...owned.dirtyLedgers, ...operatorDirty]); },
      tx: {
        ...owned.tx,
        activeState: () => {
          if (admittedState === null) throw new LedgerError("direct keyed owned transactions cannot enumerate active state");
          return owned.tx.activeState();
        },
        fetchItem: (ledgerId, itemId) => { run(loadItem(ledgerId, itemId)); return owned.tx.fetchItem(ledgerId, itemId); },
        createItemWithSealedOwnership: (ledgerId, milestoneId, init, ownership) => {
          run(prepareCreate(ledgerId, milestoneId, init));
          return owned.tx.createItemWithSealedOwnership(ledgerId, milestoneId, init, ownership);
        },
        createItemOwnerless: (ledgerId, milestoneId, init) => {
          run(prepareCreate(ledgerId, milestoneId, init));
          return owned.tx.createItemOwnerless(ledgerId, milestoneId, init);
        },
        createMilestoneWithSealedOwnership: (init, ownership) => {
          run(prepareMilestone(init)); return owned.tx.createMilestoneWithSealedOwnership(init, ownership);
        },
        createMilestoneOwnerless: (init) => { run(prepareMilestone(init)); return owned.tx.createMilestoneOwnerless(init); },
        updateItem: (ledgerId, itemId, patch) => {
          run(prepareUpdate(ledgerId, itemId, patch));
          return owned.tx.updateItem(ledgerId, itemId, patch);
        },
        mutateOperatorAction: (mutation) => {
          const outcome = applyOperatorActionLifecycleRows({ fetchItem: (ledgerId, itemId) => run(loadItem(ledgerId, itemId)) }, mutation, now);
          for (const ledgerId of outcome.dirtyLedgers) operatorDirty.add(ledgerId);
          return outcome.result;
        },
      },
    };
  }
  return { includeState, prepareOperation, prepareDirectOperation, transaction };
}
