import {
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
} from "../constants.js";
import { buildPrefixRegistry } from "../refs.js";
import { buildWorksetActiveState, type WorksetActiveState } from "../worksetGraph.js";
import type {
  ArchivePointer,
  FetchedLedger,
  Item,
  Ledger,
  LedgerSchema,
} from "../types.js";
import {
  BootstrapViolationError,
  DuplicateIdError,
  LedgerError,
  LedgerNotFoundError,
} from "../types.js";
import type {
  CreateItemInit,
  CreateMilestoneItemInit,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "./LedgerStore.js";
import {
  applyCreateItem,
  applyCreateMilestoneItem,
  applyDetachMilestoneGroup,
  applyDetachMilestoneItem,
  applyReattachItem,
  applyReopenItem,
  assertArchiveDoesNotDropUnsatisfyingGates,
  assertArchiveItemsDoNotDropUnsatisfyingGates,
  collectUnsatisfiedDependencyArchiveBlockers,
  applyUpdateItem,
  statusSatisfiesDependency,
  applyUpdateMilestoneItem,
  assertGoalPhasePreconditions,
  assertMilestoneActive,
  assertPrefixUnique,
  assertQuestionAnswerPrecondition,
  collectNonTerminalChildren,
  findItem,
  validateSchema,
  type RefValidationContext,
  type StatusChangePrecondition,
} from "./core.js";
import {
  assertManagedGoalTransitionAllowed,
  assertManagedTaskTransitionAllowed,
  assertRawPlanCreateAllowed,
  assertRawPlanUpdateAllowed,
} from "./planLifecycleGuards.js";
import {
  GOALS_LEDGER,
  QUESTIONS_ANSWER_FIELD,
  QUESTIONS_LEDGER,
  TASKS_LEDGER,
  DECISIONS_LEDGER,
} from "../constants.js";

export interface GenericArchiveEntry {
  readonly ledgerId: string;
  readonly pointerId: string;
  readonly title: string;
  readonly description: string;
  readonly items: Item[];
}

export interface GenericMutationTransactionState {
  readonly ledgers: Map<string, Ledger>;
  readonly archives: Map<string, GenericArchiveEntry>;
  readonly now: () => string;
}

export interface ArchiveTerminalItemsResult {
  readonly archivedItems: number;
  readonly archiveGroups: number;
  readonly byLedger: Readonly<Record<string, number>>;
  readonly retainedActiveGates: readonly string[];
}

export type ArchiveTerminalItemsGatePolicy =
  | "fail-on-active-gate"
  | "retain-active-gates";

export interface WorksetGenericMutationTx {
  activeState(): WorksetActiveState;
  fetchItem(ledgerId: string, itemId: string): Item;
  updateMilestone(milestoneId: string, patch: UpdateMilestoneItemPatch): Item;
  updateItem(ledgerId: string, itemId: string, patch: UpdateItemPatch): Item;
  createItem(ledgerId: string, milestoneId: string, init: CreateItemInit): Item;
  createMilestone(init: CreateMilestoneItemInit): Item;
  createLedger(name: string, schema: LedgerSchema): FetchedLedger;
  reopenItem(ledgerId: string, itemId: string, toStatus: string): Item;
  unarchiveItem(ledgerId: string, milestoneId: string, itemId: string): Item;
  archiveTerminalItems(
    ledgerIds: readonly string[],
    summary: string,
    gatePolicy: ArchiveTerminalItemsGatePolicy,
  ): ArchiveTerminalItemsResult;
  collectArchiveSweepRefs(milestoneId: string): readonly string[];
  archiveMilestone(milestoneId: string, summary: string): ArchivePointer;
}

export interface GenericMutationTransaction {
  readonly tx: WorksetGenericMutationTx;
  readonly dirtyLedgers: ReadonlySet<string>;
  readonly dirtyArchives: ReadonlySet<string>;
  readonly registryChanged: () => boolean;
}

export function genericArchiveKey(ledgerId: string, pointerId: string): string {
  return `${ledgerId}/${pointerId}`;
}

function cloneItem(item: Item): Item {
  return structuredClone(item);
}

function requireLedger(ledgers: ReadonlyMap<string, Ledger>, ledgerId: string): Ledger {
  const ledger = ledgers.get(ledgerId);
  if (ledger === undefined) throw new LedgerNotFoundError(ledgerId);
  return ledger;
}

function refsFor(state: GenericMutationTransactionState): RefValidationContext {
  return {
    registry: buildPrefixRegistry(
      [...state.ledgers].map(([name, ledger]) => ({ name, schema: ledger.schema })),
    ),
    refExists: (ledgerId, itemId) => {
      const ledger = state.ledgers.get(ledgerId);
      if (
        ledger?.milestones.some((group) => group.items.some((item) => item.id === itemId)) ===
        true
      ) {
        return true;
      }
      for (const entry of state.archives.values()) {
        if (entry.ledgerId === ledgerId && entry.items.some((item) => item.id === itemId)) {
          return true;
        }
      }
      return false;
    },
    archivedUnsatisfying: (ledgerId, itemId) => {
      const ledger = state.ledgers.get(ledgerId);
      if (ledger?.milestones.some((group) => group.items.some((item) => item.id === itemId)) === true) {
        return false;
      }
      if (ledger === undefined) return false;
      for (const entry of state.archives.values()) {
        if (entry.ledgerId !== ledgerId) continue;
        const archived = entry.items.find((item) => item.id === itemId);
        if (archived !== undefined) {
          return !statusSatisfiesDependency(ledger.schema, archived.status);
        }
      }
      return false;
    },
  };
}

function statusPrecondition(
  ledgers: ReadonlyMap<string, Ledger>,
  ledgerId: string,
  ledger: Ledger,
  itemId: string,
  patch: UpdateItemPatch,
): StatusChangePrecondition | undefined {
  if (ledgerId === GOALS_LEDGER) {
    return (from, to) =>
      assertGoalPhasePreconditions(
        itemId,
        from,
        to,
        ledgers.get(QUESTIONS_LEDGER),
        ledgers.get(DECISIONS_LEDGER),
      );
  }
  if (ledgerId === QUESTIONS_LEDGER) {
    return (from, to) => {
      const current = findItem(ledger, itemId).item;
      const answer = patch.fields?.[QUESTIONS_ANSWER_FIELD] ?? current.fields[QUESTIONS_ANSWER_FIELD];
      assertQuestionAnswerPrecondition(itemId, from, to, answer);
    };
  }
  return undefined;
}

export function createGenericMutationTransaction(
  state: GenericMutationTransactionState,
): GenericMutationTransaction {
  const dirtyLedgers = new Set<string>();
  const dirtyArchives = new Set<string>();
  let changedRegistry = false;
  const getLedger = (ledgerId: string): Ledger => requireLedger(state.ledgers, ledgerId);

  const tx: WorksetGenericMutationTx = {
    activeState: () =>
      buildWorksetActiveState(
        [...state.ledgers].map(([ledger, value]) => ({
          ledger,
          items: value.milestones.flatMap((group) => group.items),
        })),
        refsFor(state).registry,
      ),
    fetchItem: (ledgerId, itemId) => cloneItem(findItem(getLedger(ledgerId), itemId).item),
    updateMilestone: (milestoneId, patch) => {
      const item = applyUpdateMilestoneItem(
        getLedger(MILESTONES_LEDGER),
        milestoneId,
        patch,
        state.now(),
        refsFor(state),
        collectNonTerminalChildren(state.ledgers, milestoneId),
      );
      dirtyLedgers.add(MILESTONES_LEDGER);
      return cloneItem(item);
    },
    updateItem: (ledgerId, itemId, patch) => {
      if (ledgerId === MILESTONES_LEDGER) return tx.updateMilestone(itemId, patch);
      const ledger = getLedger(ledgerId);
      assertRawPlanUpdateAllowed(getLedger, ledgerId, ledger, itemId, patch);
      const item = applyUpdateItem(
        ledger,
        itemId,
        patch,
        state.now(),
        statusPrecondition(state.ledgers, ledgerId, ledger, itemId, patch),
        refsFor(state),
      );
      dirtyLedgers.add(ledgerId);
      return cloneItem(item);
    },
    createItem: (ledgerId, milestoneId, init) => {
      if (ledgerId === MILESTONES_LEDGER) {
        throw new BootstrapViolationError(
          `use createMilestone to add an item to the ${MILESTONES_LEDGER} ledger`,
        );
      }
      assertMilestoneActive(getLedger(MILESTONES_LEDGER), milestoneId);
      assertRawPlanCreateAllowed(getLedger, ledgerId, init.fields);
      const item = applyCreateItem(
        getLedger(ledgerId),
        milestoneId,
        init,
        state.now(),
        refsFor(state),
      );
      dirtyLedgers.add(ledgerId);
      return cloneItem(item);
    },
    createMilestone: (init) => {
      const item = applyCreateMilestoneItem(
        getLedger(MILESTONES_LEDGER),
        init,
        state.now(),
        refsFor(state),
      );
      dirtyLedgers.add(MILESTONES_LEDGER);
      return cloneItem(item);
    },
    createLedger: (name, schema) => {
      if (name === MILESTONES_LEDGER) {
        throw new BootstrapViolationError(`ledger name "${MILESTONES_LEDGER}" is reserved`);
      }
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new LedgerError(`invalid ledger name "${name}": only A-Za-z0-9_- are allowed`);
      }
      validateSchema(schema);
      if (state.ledgers.has(name)) throw new DuplicateIdError("ledger", name);
      assertPrefixUnique(
        name,
        schema,
        [...state.ledgers].map(([ledgerName, ledger]) => ({
          name: ledgerName,
          schema: ledger.schema,
        })),
      );
      const ledger: Ledger = {
        id: name,
        schema,
        counters: { milestone: 0, item: 0 },
        milestones: [],
        archivePointers: [],
      };
      state.ledgers.set(name, ledger);
      dirtyLedgers.add(name);
      changedRegistry = true;
      return {
        id: ledger.id,
        schema: structuredClone(ledger.schema),
        counters: { ...ledger.counters },
        milestones: [],
        archivePointers: [],
      };
    },
    reopenItem: (ledgerId, itemId, toStatus) => {
      const ledger = getLedger(ledgerId);
      const source = findItem(ledger, itemId).item;
      if (ledgerId === GOALS_LEDGER) assertManagedGoalTransitionAllowed(source, toStatus);
      if (ledgerId === TASKS_LEDGER) {
        assertManagedTaskTransitionAllowed(getLedger, source, toStatus);
      }
      assertMilestoneActive(getLedger(MILESTONES_LEDGER), source.milestoneId);
      const item = applyReopenItem(ledger, itemId, toStatus, state.now(), refsFor(state));
      dirtyLedgers.add(ledgerId);
      return cloneItem(item);
    },
    unarchiveItem: (ledgerId, milestoneId, itemId) => {
      const ledger = getLedger(ledgerId);
      const key = genericArchiveKey(ledgerId, milestoneId);
      const entry = state.archives.get(key);
      if (entry === undefined) {
        throw new LedgerError(`no archived item ${itemId} under ${ledgerId}:${milestoneId}`);
      }
      const index = entry.items.findIndex((item) => item.id === itemId);
      const archived = entry.items[index];
      if (archived === undefined) {
        throw new LedgerError(`archive ${ledgerId}:${milestoneId} has no item ${itemId}`);
      }
      if (!new Set(ledger.schema.terminalStatuses).has(archived.status)) {
        assertMilestoneActive(getLedger(MILESTONES_LEDGER), archived.milestoneId);
      }
      const item = applyReattachItem(
        ledger,
        ledgerId === MILESTONES_LEDGER ? archived.milestoneId : milestoneId,
        archived,
        state.now(),
      );
      entry.items.splice(index, 1);
      if (entry.items.length === 0) {
        state.archives.delete(key);
        const pointer = ledger.archivePointers.findIndex((candidate) => candidate.id === milestoneId);
        if (pointer >= 0) ledger.archivePointers.splice(pointer, 1);
      }
      dirtyArchives.add(key);
      dirtyLedgers.add(ledgerId);
      return cloneItem(item);
    },
    archiveTerminalItems: (ledgerIds, summary, gatePolicy) => {
      if (gatePolicy !== "fail-on-active-gate" && gatePolicy !== "retain-active-gates") {
        throw new LedgerError(`unknown terminal-item archive gate policy "${gatePolicy}"`);
      }
      const selectedLedgerIds = [...new Set(ledgerIds)].sort();
      if (selectedLedgerIds.includes(MILESTONES_LEDGER)) {
        throw new BootstrapViolationError(
          `${MILESTONES_LEDGER} items are archived only through archiveMilestone`,
        );
      }
      for (const ledgerId of selectedLedgerIds) getLedger(ledgerId);

      const leavingUnsatisfied = new Map<string, string>();
      for (const ledgerId of selectedLedgerIds) {
        const ledger = getLedger(ledgerId);
        const terminal = new Set(ledger.schema.terminalStatuses);
        for (const group of ledger.milestones) {
          for (const item of group.items) {
            if (
              terminal.has(item.status) &&
              !statusSatisfiesDependency(ledger.schema, item.status)
            ) {
              leavingUnsatisfied.set(`${ledgerId}:${item.id}`, group.id);
            }
          }
        }
      }
      const blockers = collectUnsatisfiedDependencyArchiveBlockers(
        state.ledgers,
        leavingUnsatisfied,
      );
      if (gatePolicy === "fail-on-active-gate") {
        assertArchiveItemsDoNotDropUnsatisfyingGates(state.ledgers, leavingUnsatisfied);
      }
      const retainedActiveGates = [
        ...new Set(blockers.map((blocker) => blocker.targetRef)),
      ].sort();
      const retained = new Set(retainedActiveGates);

      const milestones = getLedger(MILESTONES_LEDGER);
      const byLedger: Record<string, number> = {};
      let archivedItems = 0;
      let archiveGroups = 0;
      for (const ledgerId of selectedLedgerIds) {
        const ledger = getLedger(ledgerId);
        const terminal = new Set(ledger.schema.terminalStatuses);
        for (const group of [...ledger.milestones]) {
          const leaving = group.items.filter(
            (item) =>
              terminal.has(item.status) && !retained.has(`${ledgerId}:${item.id}`),
          );
          if (leaving.length === 0) continue;
          const leavingIds = new Set(leaving.map((item) => item.id));
          const staying = group.items.filter((item) => !leavingIds.has(item.id));
          const milestone = findItem(milestones, group.id).item;
          const title = typeof milestone.fields.title === "string" ? milestone.fields.title : "";
          const description =
            typeof milestone.fields.description === "string"
              ? milestone.fields.description
              : "";
          const path = `./archive/${ledgerId}/${group.id}.md`;
          const key = genericArchiveKey(ledgerId, group.id);
          const existing = state.archives.get(key);
          const pointer = ledger.archivePointers.find((candidate) => candidate.id === group.id);
          if ((existing === undefined) !== (pointer === undefined)) {
            throw new LedgerError(`archive pointer/content mismatch for ${key}`);
          }
          if (pointer === undefined) {
            ledger.archivePointers.push({
              id: group.id,
              path,
              summary,
              title,
              status: milestone.status,
            });
          } else {
            pointer.summary = summary;
            pointer.title = title;
            pointer.status = milestone.status;
          }
          const archived: GenericArchiveEntry = {
            ledgerId,
            pointerId: group.id,
            title,
            description,
            items: existing?.items ?? [],
          };
          archived.items.push(...leaving.map(cloneItem));
          state.archives.set(key, archived);

          const groupIndex = ledger.milestones.indexOf(group);
          if (staying.length === 0) {
            ledger.milestones.splice(groupIndex, 1);
          } else {
            group.items = staying;
          }
          dirtyArchives.add(key);
          dirtyLedgers.add(ledgerId);
          archivedItems += leaving.length;
          archiveGroups += 1;
          byLedger[ledgerId] = (byLedger[ledgerId] ?? 0) + leaving.length;
        }
      }
      return { archivedItems, archiveGroups, byLedger, retainedActiveGates };
    },
    collectArchiveSweepRefs: (milestoneId) => {
      const refs: string[] = [];
      for (const [ledgerId, ledger] of state.ledgers) {
        if (ledgerId === MILESTONES_LEDGER) {
          try {
            refs.push(`${ledgerId}:${findItem(ledger, milestoneId).item.id}`);
          } catch {
            // Absent milestone validation belongs to archiveMilestone.
          }
          continue;
        }
        const group = ledger.milestones.find((candidate) => candidate.id === milestoneId);
        if (group !== undefined) refs.push(...group.items.map((item) => `${ledgerId}:${item.id}`));
      }
      return refs.sort();
    },
    archiveMilestone: (milestoneId, summary) => {
      if (milestoneId === MILESTONES_ACTIVE_GROUP_ID) {
        throw new BootstrapViolationError(
          `the bootstrap group ${MILESTONES_ACTIVE_GROUP_ID} cannot be archived`,
        );
      }
      if (milestoneId === MILESTONES_AMBIENT_ID) {
        throw new BootstrapViolationError(
          `${MILESTONES_AMBIENT_ID} is immortal and cannot be archived`,
        );
      }
      assertArchiveDoesNotDropUnsatisfyingGates(state.ledgers, milestoneId);
      const milestones = getLedger(MILESTONES_LEDGER);
      const milestone = findItem(milestones, milestoneId).item;
      const title = typeof milestone.fields.title === "string" ? milestone.fields.title : "";
      const status = milestone.status;
      for (const [ledgerId, ledger] of state.ledgers) {
        if (ledgerId === MILESTONES_LEDGER) continue;
        const key = genericArchiveKey(ledgerId, milestoneId);
        const existing = state.archives.get(key);
        const hasActiveGroup = ledger.milestones.some((group) => group.id === milestoneId);
        if (!hasActiveGroup && existing === undefined) continue;
        const path = `./archive/${ledgerId}/${milestoneId}.md`;
        if (!hasActiveGroup) {
          const pointer = ledger.archivePointers.find((candidate) => candidate.id === milestoneId);
          if (pointer === undefined || existing === undefined) {
            throw new LedgerError(`archive pointer/content mismatch for ${key}`);
          }
          pointer.summary = summary;
          pointer.title = title;
          pointer.status = status;
          state.archives.set(key, { ...existing, title });
          dirtyArchives.add(key);
          dirtyLedgers.add(ledgerId);
          continue;
        }
        if (existing !== undefined) {
          const pointerIndex = ledger.archivePointers.findIndex(
            (candidate) => candidate.id === milestoneId,
          );
          if (pointerIndex < 0) {
            throw new LedgerError(`archive pointer/content mismatch for ${key}`);
          }
          ledger.archivePointers.splice(pointerIndex, 1);
        }
        const detached = applyDetachMilestoneGroup(
          ledger,
          milestoneId,
          summary,
          path,
          title,
          status,
        );
        state.archives.set(key, {
          ledgerId,
          pointerId: milestoneId,
          title: detached.milestone.title,
          description: detached.milestone.description,
          items: [
            ...(existing?.items.map(cloneItem) ?? []),
            ...detached.milestone.items.map(cloneItem),
          ],
        });
        dirtyArchives.add(key);
        dirtyLedgers.add(ledgerId);
      }
      const path = `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`;
      const detached = applyDetachMilestoneItem(
        milestones,
        milestoneId,
        summary,
        path,
        title,
        status,
      );
      const key = genericArchiveKey(MILESTONES_LEDGER, milestoneId);
      state.archives.set(key, {
        ledgerId: MILESTONES_LEDGER,
        pointerId: milestoneId,
        title,
        description:
          typeof detached.item.fields.description === "string"
            ? detached.item.fields.description
            : "",
        items: [cloneItem(detached.item)],
      });
      dirtyArchives.add(key);
      dirtyLedgers.add(MILESTONES_LEDGER);
      return { ...detached.pointer };
    },
  };

  return {
    tx,
    dirtyLedgers,
    dirtyArchives,
    registryChanged: () => changedRegistry,
  };
}
