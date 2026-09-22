import { DECISIONS_LEDGER, DEFECTS_LEDGER, GOALS_LEDGER, HANDOFFS_LEDGER, IDEAS_LEDGER, MILESTONES_ACTIVE_GROUP_ID, MILESTONES_AMBIENT_ID, MILESTONES_LEDGER, OPERATOR_ACTIONS_LEDGER, QUESTIONS_LEDGER, REVIEWS_LEDGER, TASKS_LEDGER } from "../constants.js";
import { buildPrefixRegistry, canonicalizeRef, RefParseError } from "../refs.js";
import { LedgerError, LedgerNotFoundError, type FieldValue, type Item, type Ledger } from "../types.js";
import type { WorksetActiveState } from "../worksetGraph.js";
import type { OwnedMutationOperation } from "../worksetOwnedLifecycle.js";
import { readCanonicalOwnership } from "../worksetOwnerEdges.js";
import type { CreateItemInit, CreateMilestoneItemInit, UpdateItemPatch } from "./LedgerStore.js";
import type { ImplementationCompletionBindingRecord, LifecycleRowRepository } from "./lifecycleRowRepository.js";
import { applyOperatorActionLifecycleRows, operatorActionReads } from "./operatorActionLifecycle.js";
import { createOwnedWriteTransaction } from "./ownedWriteTransaction.js";
import type { AsyncLifecycleRowRepository } from "./asyncRowRepository.js";
import type { GenericMutationLedgerMetadata } from "./genericMutationDataSource.js";
import { repositoryRead, runRepositoryReads, runAsyncRepositoryReads, type RepositoryReadProgram } from "./readProgram.js";
import type { DirectOwnedOperation, DirectOwnedWriteTx } from "./directOwnedMutation.js";
import { directCompletionTaskIds } from "./directOwnedMutation.js";
import { actionIdForTask, handoffIdForTask, taskIdForAction, findCohortOperatorActionInItems } from "../operatorActions.js";
import { defectFixTaskIds } from "../relationships.js";
import { parseGoalFinalizedManifest } from "../worksetGraph.js";
import { createGenericMutationTransaction, genericArchiveKey, type GenericArchiveEntry } from "./genericMutationTransaction.js";

export interface KeyedOwnedWriteTransaction {
  readonly tx: DirectOwnedWriteTx;
  readonly ledgers: Map<string, Ledger>;
  readonly beforeLedgers: Map<string, Ledger>;
  readonly archives: Map<string, GenericArchiveEntry>;
  readonly beforeArchives: Map<string, GenericArchiveEntry>;
  readonly unloadedArchiveKeys: ReadonlySet<string>;
  readonly dirtyArchives: ReadonlySet<string>;
  readonly dirtyLedgers: ReadonlySet<string>;
  readonly allocationLedgers: ReadonlySet<string>;
  readonly implementationCompletionBindingChanges: readonly ImplementationCompletionBindingRecord[];
}

export function createKeyedOwnedWriteTransaction(
  rows: LifecycleRowRepository,
  admittedState: WorksetActiveState | null,
  directOperation: DirectOwnedOperation | null,
  now: () => string,
): KeyedOwnedWriteTransaction {
  const plan = prepareOwnedRows(rows.publicRows.listLedgers());
  runRepositoryReads(rows, plan.includeState(admittedState));
  if (directOperation !== null) runRepositoryReads(rows, plan.prepareDirectOperation(directOperation, now));
  return plan.transaction((program) => runRepositoryReads(rows, program), admittedState, directOperation, now);
}

export async function createAsyncKeyedOwnedWriteTransaction(rows: AsyncLifecycleRowRepository,
  admittedState: WorksetActiveState, operation: OwnedMutationOperation, now: () => string): Promise<KeyedOwnedWriteTransaction> {
  const plan = prepareOwnedRows(await rows.publicRows.listLedgers());
  await runAsyncRepositoryReads(rows, plan.includeState(admittedState));
  await runAsyncRepositoryReads(rows, plan.prepareOperation(operation, admittedState));
  return plan.transaction(requirePreparedRows, admittedState, null, now);
}

export async function createAsyncDirectOwnedWriteTransaction(rows: AsyncLifecycleRowRepository,
  operation: DirectOwnedOperation, now: () => string): Promise<KeyedOwnedWriteTransaction> {
  const plan = prepareOwnedRows(await rows.publicRows.listLedgers());
  await runAsyncRepositoryReads(rows, plan.prepareDirectOperation(operation, now));
  return plan.transaction(requirePreparedRows, null, operation, now);
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
  const archivedItems = new Map<string, Item>();
  const archives = new Map<string, GenericArchiveEntry>();
  const beforeArchives = new Map<string, GenericArchiveEntry>();
  const unloadedArchiveKeys = new Set<string>();
  const loadedArchives = new Set<string>();
  const allocationLedgers = new Set<string>();
  const completionBindings = new Map<string, string | undefined>();
  const completionBindingChanges = new Map<string, string>();
  const completionDefectTaskRefs = new Map<string, readonly string[]>();
  let cohortTaskIds: ReadonlySet<string> | null = null;
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
  function* loadImplementationCompletionBinding(taskId: string): OwnedReads<string | undefined> {
    if (completionBindings.has(taskId)) return completionBindings.get(taskId);
    const binding = yield* repositoryRead((source: OwnedReadSource) =>
      source.fetchImplementationCompletionBinding(taskId));
    const reviewRef = binding?.reviewRef;
    completionBindings.set(taskId, reviewRef);
    return reviewRef;
  }
  function* loadCompletionItem(ledgerId: string, itemId: string): OwnedReads<Item | undefined> {
    const active = yield* loadItem(ledgerId, itemId);
    if (active !== undefined) return active;
    if (cohortTaskIds === null || (ledgerId === TASKS_LEDGER && !cohortTaskIds.has(itemId))) return undefined;
    const ref = `${ledgerId}:${itemId}`;
    if (!archived.has(ref)) {
      const value = yield* rows.fetchArchivedItem(ref);
      archived.set(ref, value !== undefined);
      if (value !== undefined) archivedItems.set(ref, value.item);
    }
    return archivedItems.get(ref);
  }
  function* loadArchive(ledgerId: string, pointerId: string): OwnedReads<void> {
    const key = genericArchiveKey(ledgerId, pointerId);
    if (loadedArchives.has(key)) return;
    loadedArchives.add(key);
    const pointer = yield* repositoryRead((source: OwnedReadSource) => source.fetchArchivePointer(ledgerId, pointerId));
    if (pointer === undefined) return;
    for (const map of [beforeLedgers, ledgers]) requireLedger(map, ledgerId).archivePointers.push(structuredClone(pointer));
    const entry = { ledgerId, pointerId, title: pointer.title, description: "", items: [] };
    archives.set(key, entry);
    beforeArchives.set(key, structuredClone(entry));
    unloadedArchiveKeys.add(key);
  }
  function* loadRef(raw: string, allowArchived: boolean): OwnedReads<void> {
    let ref: string;
    try { ref = canonicalizeRef(raw, registry); } catch (error) {
      if (error instanceof RefParseError) return;
      throw error;
    }
    const colon = ref.indexOf(":");
    if ((yield* loadItem(ref.slice(0, colon), ref.slice(colon + 1))) !== undefined || !allowArchived || archived.has(ref)) return;
    const value = yield* rows.fetchArchivedItem(ref);
    archived.set(ref, value !== undefined);
    if (value !== undefined) archivedItems.set(ref, value.item);
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
    if (operation.kind === "materialize-cohort-operator") {
      for (const member of operation.batch.members) {
        yield* loadRef(member.taskRef, false);
        for (const ref of yield* rows.referenceSources(member.taskRef, ["ledgerRefs"])) {
          if (!ref.startsWith(`${OPERATOR_ACTIONS_LEDGER}:`)) continue;
          yield* loadItem(OPERATOR_ACTIONS_LEDGER, ref.slice(OPERATOR_ACTIONS_LEDGER.length + 1));
          for (const handoff of yield* rows.referenceSources(ref, ["ledgerRefs"])) {
            if (handoff.startsWith(`${HANDOFFS_LEDGER}:`)) yield* loadRef(handoff, false);
          }
        }
      }
      yield* prepareCreate(OPERATOR_ACTIONS_LEDGER, MILESTONES_AMBIENT_ID, { fields: {
        ledgerRefs: operation.batch.envelope.memberAuthorities.flatMap(({ taskRef, goalRef }) => [taskRef, goalRef]) } });
      yield* prepareCreate(HANDOFFS_LEDGER, MILESTONES_AMBIENT_ID, { fields: {} });
      return;
    }
    if (operation.kind === "cohort-completion") {
      cohortTaskIds = directCompletionTaskIds(operation);
      for (const member of operation.members) {
        const goal = yield* loadItem(GOALS_LEDGER, member.ownerGoalId);
        if (goal !== undefined) for (const task of parseGoalFinalizedManifest(goal)?.tasks ?? []) {
          yield* loadCompletionItem(TASKS_LEDGER, task.id);
        }
        yield* loadCompletionItem(TASKS_LEDGER, member.taskId);
        yield* prepareDirectOperation(member, now);
      }
      const reviews = requireLedger(ledgers, REVIEWS_LEDGER);
      let next = reviews.counters.item;
      for (const member of operation.members) {
        if (completionBindings.get(member.taskId) !== undefined) continue;
        while ((yield* loadItem(REVIEWS_LEDGER, `${reviews.schema.idPrefix ?? "R"}${++next}`)) !== undefined) { /* reserve a free allocation */ }
      }
      const candidates = new Set(operation.sweep.terminalItems.map(({ targetId }) => targetId));
      if (operation.operatorSettlement !== null) {
        yield* loadItem(OPERATOR_ACTIONS_LEDGER, operation.operatorSettlement.actionId);
        candidates.add(`${HANDOFFS_LEDGER}:${operation.operatorSettlement.handoffId}`);
      }
      for (const defectId of completionDefectTaskRefs.keys()) candidates.add(`${DEFECTS_LEDGER}:${defectId}`);
      for (const selected of operation.sweep.milestones) {
        candidates.add(`${MILESTONES_LEDGER}:${selected.id}`);
        for (const ref of yield* repositoryRead((source: OwnedReadSource) => source.publicRows.itemRefsByMilestone(selected.id))) candidates.add(ref);
        for (const ledgerId of ledgers.keys()) yield* loadArchive(ledgerId, selected.id);
      }
      for (const member of operation.members) candidates.add(`${TASKS_LEDGER}:${member.taskId}`);
      for (const ref of candidates) {
        const colon = ref.indexOf(":");
        const ledgerId = ref.slice(0, colon);
        const item = yield* loadCompletionItem(ledgerId, ref.slice(colon + 1));
        if (item !== undefined) {
          yield* loadCompletionItem(MILESTONES_LEDGER, item.milestoneId);
          yield* loadArchive(ledgerId, item.milestoneId);
          if (ledgerId === TASKS_LEDGER) yield* loadArchive(REVIEWS_LEDGER, item.milestoneId);
        }
        for (const consumer of yield* rows.referenceSources(ref, ["worksetOwnerRef", "dependsOn", "blockedBy"])) {
          yield* loadRef(consumer, false);
        }
      }
      return;
    }
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
    const task = yield* loadCompletionItem(TASKS_LEDGER, operation.taskId);
    if (task === undefined) return;
    const reviewBinding = yield* loadImplementationCompletionBinding(task.id);
    if (reviewBinding !== undefined) {
      if (typeof reviewBinding === "string" && /^reviews:R[0-9]+$/u.test(reviewBinding)) {
        yield* loadCompletionItem(REVIEWS_LEDGER, reviewBinding.slice(`${REVIEWS_LEDGER}:`.length));
      }
    }
    const rawDefectRefs = task.fields.ledgerRefs;
    if (Array.isArray(rawDefectRefs)) {
      for (const rawRef of new Set(rawDefectRefs)) {
        if (typeof rawRef !== "string") continue;
        let defectRef: string;
        try { defectRef = canonicalizeRef(rawRef, registry); }
        catch (error) {
          if (error instanceof RefParseError) continue;
          throw error;
        }
        if (!defectRef.startsWith(`${DEFECTS_LEDGER}:`)) continue;
        const defectId = defectRef.slice(DEFECTS_LEDGER.length + 1);
        const defect = yield* loadCompletionItem(DEFECTS_LEDGER, defectId);
        if (defect === undefined) continue;
        const taskRefs = new Set(
          defectFixTaskIds(defect.id, [defect], []).map((id) => `${TASKS_LEDGER}:${id}`),
        );
        for (const source of yield* rows.referenceSources(defectRef, ["ledgerRefs"])) {
          if (source.startsWith(`${TASKS_LEDGER}:`)) taskRefs.add(source);
        }
        for (const ref of taskRefs) {
          yield* loadCompletionItem(TASKS_LEDGER, ref.slice(TASKS_LEDGER.length + 1));
        }
        completionDefectTaskRefs.set(defectId, [...taskRefs]);
      }
    }
    if (reviewBinding !== undefined || task.status === "done") return;
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
    directOperation: DirectOwnedOperation | null, now: () => string): KeyedOwnedWriteTransaction {
    const operatorDirty = new Set<string>();
    const owned = createOwnedWriteTransaction({
      ledgers, now,
      archivedRefExists: (ledgerId, itemId) => archived.get(`${ledgerId}:${itemId}`) === true,
    });
    const archiveTransaction = createGenericMutationTransaction({ ledgers, archives, unloadedArchiveKeys, now });
    const assertCompletionArchive = (): void => {
      if (directOperation === null || directOperation.kind !== "cohort-completion") throw new LedgerError("completion archive requires its exact cohort operation");
    };
    const completionTaskIds = directCompletionTaskIds(directOperation);
    const assertCompletionTask = (taskId: string): void => {
      if (!completionTaskIds.has(taskId)) {
        throw new LedgerError("implementation completion bindings require their exact protected operation");
      }
    };
    return {
      ledgers, beforeLedgers, archives, beforeArchives, unloadedArchiveKeys, allocationLedgers,
      get dirtyArchives() { return archiveTransaction.dirtyArchives; },
      get implementationCompletionBindingChanges() {
        return [...completionBindingChanges].map(([taskId, reviewRef]) => ({ taskId, reviewRef }));
      },
      get dirtyLedgers() { return new Set([...owned.dirtyLedgers, ...operatorDirty, ...archiveTransaction.dirtyLedgers]); },
      tx: {
        ...owned.tx,
        findCohortOperatorAction: (batchDigest) => {
          if (directOperation?.kind !== "materialize-cohort-operator" || directOperation.batch.batchDigest !== batchDigest) {
            throw new LedgerError("cohort operator lookup requires its exact materialization operation");
          }
          return findCohortOperatorActionInItems(requireLedger(ledgers, OPERATOR_ACTIONS_LEDGER).milestones.flatMap(({ items }) => items),
            requireLedger(ledgers, HANDOFFS_LEDGER).milestones.flatMap(({ items }) => items), batchDigest);
        },
        fetchImplementationCompletionItem: (ledgerId, itemId) => {
          const item = run(loadCompletionItem(ledgerId, itemId));
          return item === undefined ? owned.tx.fetchItem(ledgerId, itemId) : structuredClone(item);
        },
        completionArchive: {
          collectArchiveTerminalItemRefs: (...args) => { assertCompletionArchive(); return archiveTransaction.tx.collectArchiveTerminalItemRefs(...args); },
          archiveTerminalItems: (...args) => { assertCompletionArchive(); return archiveTransaction.tx.archiveTerminalItems(...args); },
          archiveMilestone: (...args) => { assertCompletionArchive(); return archiveTransaction.tx.archiveMilestone(...args); },
          updateMilestone: (...args) => { assertCompletionArchive(); return archiveTransaction.tx.updateMilestone(...args); },
          collectArchiveSweepRefs: (...args) => { assertCompletionArchive(); return archiveTransaction.tx.collectArchiveSweepRefs(...args); },
        },
        fetchImplementationCompletionBinding: (taskId) => {
          assertCompletionTask(taskId);
          return run(loadImplementationCompletionBinding(taskId));
        },
        bindImplementationCompletionReview: (taskId, reviewRef) => {
          assertCompletionTask(taskId);
          if (run(loadImplementationCompletionBinding(taskId)) !== undefined) {
            throw new LedgerError("terminal implementation review binding already exists");
          }
          completionBindings.set(taskId, reviewRef);
          completionBindingChanges.set(taskId, reviewRef);
        },
        implementationCompletionDefectFixes: (taskId) => {
          assertCompletionTask(taskId);
          const result: Array<{ defect: Item; fixTasks: Item[] }> = [];
          for (const [defectId, taskRefs] of completionDefectTaskRefs) {
            const defect = run(loadCompletionItem(DEFECTS_LEDGER, defectId));
            if (defect === undefined) continue;
            const fixTasks: Item[] = [];
            for (const ref of taskRefs) {
              const task = run(loadCompletionItem(TASKS_LEDGER, ref.slice(TASKS_LEDGER.length + 1)));
              if (task !== undefined) fixTasks.push(task);
            }
            result.push({ defect, fixTasks });
          }
          return result;
        },
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
