import { DECISIONS_LEDGER, GOALS_LEDGER, IDEAS_LEDGER, MILESTONES_ACTIVE_GROUP_ID, MILESTONES_AMBIENT_ID, MILESTONES_LEDGER, QUESTIONS_LEDGER, TASKS_LEDGER } from "../constants.js";
import { buildPrefixRegistry, canonicalizeRef, RefParseError } from "../refs.js";
import { LedgerError, LedgerNotFoundError, type FieldValue, type Item, type Ledger } from "../types.js";
import type { WorksetActiveState } from "../worksetGraph.js";
import type { OwnedMutationOperation, WorksetOwnedWriteTx } from "../worksetOwnedLifecycle.js";
import { readCanonicalOwnership } from "../worksetOwnerEdges.js";
import type { CreateItemInit, CreateMilestoneItemInit } from "./LedgerStore.js";
import type { LifecycleRowRepository } from "./lifecycleRowRepository.js";
import { applyOperatorActionLifecycleRows } from "./operatorActionLifecycle.js";
import { createOwnedWriteTransaction } from "./ownedWriteTransaction.js";
import type { AsyncLifecycleRowRepository } from "./asyncRowRepository.js";
import type { GenericMutationLedgerMetadata } from "./genericMutationDataSource.js";
import { repositoryRead, runRepositoryReads, runAsyncRepositoryReads, type RepositoryReadProgram } from "./readProgram.js";

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
  return plan.transaction((program) => {
    const step = program.next();
    if (!step.done) throw new LedgerError("owned transaction requested an unprepared row outside its declared operation");
    return step.value;
  }, admittedState, now);
}

type OwnedReadSource = LifecycleRowRepository | AsyncLifecycleRowRepository;
type OwnedReads<T> = RepositoryReadProgram<OwnedReadSource, T>;

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
  function* prepareCreate(ledgerId: string, milestoneId: string, init: CreateItemInit): OwnedReads<void> {
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
    yield* prepareCreate(GOALS_LEDGER, MILESTONES_AMBIENT_ID, { status: goal.status ?? "clarifying",
      fields: { title: goal.title, description: goal.description, ...goal.fields } });
    if (operation.kind === "idea-to-goal" && operation.input.consumeIdea === true) {
      const idea = yield* loadItem(IDEAS_LEDGER, operation.input.ideaId);
      if (idea !== undefined && idea.status !== "planned" && idea.status !== "discarded") yield* prepareFields(IDEAS_LEDGER, idea.fields);
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
          const item = run(loadItem(ledgerId, itemId));
          if (item !== undefined) run(prepareFields(ledgerId, item.fields));
          if (patch.fields !== undefined) run(prepareFields(ledgerId, patch.fields));
          if (ledgerId === GOALS_LEDGER && patch.status !== undefined) {
            const ref = `${ledgerId}:${itemId}`;
            for (const source of run(rows.referenceSources(ref, ["worksetOwnerRef"]))) run(loadRef(source, false));
            for (const source of run(rows.referenceSources(ref, ["ledgerRefs"]))) {
              if (source.startsWith(`${QUESTIONS_LEDGER}:`) || source.startsWith(`${DECISIONS_LEDGER}:`)) run(loadRef(source, false));
            }
          }
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
  return { includeState, prepareOperation, transaction };
}
