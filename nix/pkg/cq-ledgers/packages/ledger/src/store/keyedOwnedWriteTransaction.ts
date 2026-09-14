import { DECISIONS_LEDGER, GOALS_LEDGER, MILESTONES_ACTIVE_GROUP_ID, MILESTONES_LEDGER, QUESTIONS_LEDGER, TASKS_LEDGER } from "../constants.js";
import { buildPrefixRegistry, canonicalizeRef, RefParseError } from "../refs.js";
import { LedgerError, LedgerNotFoundError, type FieldValue, type Item, type Ledger } from "../types.js";
import type { WorksetActiveState } from "../worksetGraph.js";
import type { WorksetOwnedWriteTx } from "../worksetOwnedLifecycle.js";
import type { CreateItemInit, CreateMilestoneItemInit } from "./LedgerStore.js";
import type { LifecycleRowRepository } from "./lifecycleRowRepository.js";
import { applyOperatorActionLifecycleRows } from "./operatorActionLifecycle.js";
import { createOwnedWriteTransaction } from "./ownedWriteTransaction.js";

export interface KeyedOwnedWriteTransaction {
  readonly tx: WorksetOwnedWriteTx;
  readonly ledgers: Map<string, Ledger>;
  readonly beforeLedgers: Map<string, Ledger>;
  readonly dirtyLedgers: ReadonlySet<string>;
}

export function createKeyedOwnedWriteTransaction(
  rows: LifecycleRowRepository,
  admittedState: WorksetActiveState | null,
  now: () => string,
): KeyedOwnedWriteTransaction {
  const metadata = rows.publicRows.listLedgers();
  const ledgers = new Map<string, Ledger>(metadata.map(({ id, schema, counters }) => [id, {
    id, schema: structuredClone(schema), counters: { ...counters }, milestones: [], archivePointers: [],
  }]));
  const beforeLedgers = structuredClone(ledgers);
  const registry = buildPrefixRegistry(metadata.map(({ id, schema }) => ({ name: id, schema })));
  const loaded = new Set<string>();
  const loadedGroups = new Set<string>();
  const archived = new Map<string, boolean>();
  const operatorDirty = new Set<string>();
  const requireLedger = (source: ReadonlyMap<string, Ledger>, id: string): Ledger => {
    const ledger = source.get(id);
    if (ledger === undefined) throw new LedgerNotFoundError(id);
    return ledger;
  };
  const loadGroup = (ledgerId: string, id: string): void => {
    const key = `${ledgerId}:${id}`;
    if (loadedGroups.has(key)) return;
    loadedGroups.add(key);
    const group = rows.fetchGroup(ledgerId, id);
    if (group === undefined) return;
    for (const map of [beforeLedgers, ledgers]) {
      const ledger = requireLedger(map, ledgerId);
      if (!ledger.milestones.some((candidate) => candidate.id === id)) ledger.milestones.push({ ...group, items: [] });
    }
  };
  const includeItem = (ledgerId: string, item: Item): Item => {
    loadGroup(ledgerId, item.milestoneId);
    for (const map of [beforeLedgers, ledgers]) {
      const group = requireLedger(map, ledgerId).milestones.find(({ id }) => id === item.milestoneId);
      if (group === undefined) throw new LedgerError(`ledger ${ledgerId}: item ${item.id} references a milestone-group with no groups row`);
      group.items.push(map === ledgers ? item : structuredClone(item));
    }
    loaded.add(`${ledgerId}:${item.id}`);
    return item;
  };
  const loadItem = (ledgerId: string, itemId: string): Item | undefined => {
    const ledger = requireLedger(ledgers, ledgerId);
    for (const group of ledger.milestones) {
      const item = group.items.find(({ id }) => id === itemId);
      if (item !== undefined) return item;
    }
    const ref = `${ledgerId}:${itemId}`;
    if (loaded.has(ref)) return undefined;
    loaded.add(ref);
    const item = rows.publicRows.fetchActiveItem(ref);
    return item === undefined ? undefined : includeItem(ledgerId, item);
  };
  const loadRef = (raw: string, allowArchived: boolean): void => {
    let ref: string;
    try { ref = canonicalizeRef(raw, registry); } catch (error) {
      if (error instanceof RefParseError) return;
      throw error;
    }
    const colon = ref.indexOf(":");
    if (loadItem(ref.slice(0, colon), ref.slice(colon + 1)) !== undefined || !allowArchived || archived.has(ref)) return;
    archived.set(ref, rows.publicRows.fetchArchivedItem(ref) !== undefined);
  };
  const prepareFields = (ledgerId: string, fields: Readonly<Record<string, FieldValue | undefined>>): void => {
    for (const name of ["dependsOn", "blockedBy"]) {
      const refs = fields[name];
      if (Array.isArray(refs)) for (const ref of refs) loadRef(ref, true);
    }
    if (ledgerId === TASKS_LEDGER) {
      const refs = fields.ledgerRefs;
      if (Array.isArray(refs)) for (const ref of refs) if (ref.startsWith(`${GOALS_LEDGER}:`)) loadRef(ref, false);
    }
  };
  const prepareAllocation = (ledgerId: string, explicitId: string | undefined): void => {
    if (explicitId !== undefined) { loadItem(ledgerId, explicitId); return; }
    const ledger = requireLedger(ledgers, ledgerId);
    const prefix = ledger.schema.idPrefix ?? ledgerId.slice(0, 1).toUpperCase();
    let counter = ledger.counters.item;
    while (loadItem(ledgerId, `${prefix}${counter + 1}`) !== undefined) counter += 1;
  };
  const prepareCreate = (ledgerId: string, milestoneId: string, init: CreateItemInit): void => {
    loadItem(MILESTONES_LEDGER, milestoneId);
    loadGroup(ledgerId, milestoneId);
    prepareFields(ledgerId, init.fields);
    prepareAllocation(ledgerId, init.id);
  };
  const prepareMilestone = (init: CreateMilestoneItemInit): void => {
    loadGroup(MILESTONES_LEDGER, MILESTONES_ACTIVE_GROUP_ID);
    prepareFields(MILESTONES_LEDGER, { dependsOn: init.dependsOn, blockedBy: init.blockedBy });
    prepareAllocation(MILESTONES_LEDGER, init.id);
  };
  if (admittedState !== null) {
    for (const [ref, item] of admittedState.byRef) includeItem(ref.slice(0, ref.indexOf(":")), structuredClone(item));
  }
  const owned = createOwnedWriteTransaction({
    ledgers, now,
    archivedRefExists: (ledgerId, itemId) => archived.get(`${ledgerId}:${itemId}`) === true,
  });
  return {
    ledgers, beforeLedgers,
    get dirtyLedgers() { return new Set([...owned.dirtyLedgers, ...operatorDirty]); },
    tx: {
      ...owned.tx,
      activeState: () => {
        if (admittedState === null) throw new LedgerError("direct keyed owned transactions cannot enumerate active state");
        return owned.tx.activeState();
      },
      fetchItem: (ledgerId, itemId) => { loadItem(ledgerId, itemId); return owned.tx.fetchItem(ledgerId, itemId); },
      createItemWithSealedOwnership: (ledgerId, milestoneId, init, ownership) => {
        prepareCreate(ledgerId, milestoneId, init);
        return owned.tx.createItemWithSealedOwnership(ledgerId, milestoneId, init, ownership);
      },
      createItemOwnerless: (ledgerId, milestoneId, init) => {
        prepareCreate(ledgerId, milestoneId, init);
        return owned.tx.createItemOwnerless(ledgerId, milestoneId, init);
      },
      createMilestoneWithSealedOwnership: (init, ownership) => {
        prepareMilestone(init); return owned.tx.createMilestoneWithSealedOwnership(init, ownership);
      },
      createMilestoneOwnerless: (init) => { prepareMilestone(init); return owned.tx.createMilestoneOwnerless(init); },
      updateItem: (ledgerId, itemId, patch) => {
        const item = loadItem(ledgerId, itemId);
        if (item !== undefined) prepareFields(ledgerId, item.fields);
        if (patch.fields !== undefined) prepareFields(ledgerId, patch.fields);
        if (ledgerId === GOALS_LEDGER && patch.status !== undefined) {
          const ref = `${ledgerId}:${itemId}`;
          for (const source of rows.publicRows.referenceSources(ref, ["worksetOwnerRef"])) loadRef(source, false);
          for (const source of rows.publicRows.referenceSources(ref, ["ledgerRefs"])) {
            if (source.startsWith(`${QUESTIONS_LEDGER}:`) || source.startsWith(`${DECISIONS_LEDGER}:`)) loadRef(source, false);
          }
        }
        return owned.tx.updateItem(ledgerId, itemId, patch);
      },
      mutateOperatorAction: (mutation) => {
        const outcome = applyOperatorActionLifecycleRows({ fetchItem: loadItem }, mutation, now);
        for (const ledgerId of outcome.dirtyLedgers) operatorDirty.add(ledgerId);
        return outcome.result;
      },
    },
  };
}
