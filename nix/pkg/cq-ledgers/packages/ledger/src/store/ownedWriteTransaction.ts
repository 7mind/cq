import {
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_LEDGER,
  QUESTIONS_ANSWER_FIELD,
  QUESTIONS_LEDGER,
} from "../constants.js";
import { buildPrefixRegistry } from "../refs.js";
import type { FieldValue, Item, Ledger } from "../types.js";
import { BootstrapViolationError, LedgerNotFoundError } from "../types.js";
import { buildWorksetActiveState } from "../worksetGraph.js";
import type { WorksetOwnedWriteTx } from "../worksetOwnedLifecycle.js";
import {
  applyCreateItem,
  applyCreateMilestoneItem,
  applyUpdateItem,
  applyUpdateMilestoneItem,
  assertGoalPhasePreconditions,
  collectNonTerminalOwnedChildren,
  assertMilestoneActive,
  assertQuestionAnswerPrecondition,
  findItem,
  validateMilestoneItemPatch,
  type RefValidationContext,
  type StatusChangePrecondition,
} from "./core.js";
import {
  assertRawPlanCreateAllowed,
  assertRawPlanUpdateAllowed,
} from "./planLifecycleGuards.js";

export interface OwnedWriteTransaction {
  readonly tx: WorksetOwnedWriteTx;
  readonly dirtyLedgers: ReadonlySet<string>;
}

export interface CreateOwnedWriteTransactionOptions {
  readonly ledgers: Map<string, Ledger>;
  readonly now: () => string;
  readonly archivedRefExists?: (ledgerId: string, itemId: string) => boolean;
}

function requireLedger(ledgers: ReadonlyMap<string, Ledger>, ledgerId: string): Ledger {
  const ledger = ledgers.get(ledgerId);
  if (ledger === undefined) throw new LedgerNotFoundError(ledgerId);
  return ledger;
}

function cloneItem(item: Item): Item {
  return structuredClone(item);
}

function buildRefValidationContext(
  ledgers: ReadonlyMap<string, Ledger>,
  archivedRefExists: ((ledgerId: string, itemId: string) => boolean) | undefined,
): RefValidationContext {
  return {
    registry: buildPrefixRegistry(
      [...ledgers].map(([name, ledger]) => ({ name, schema: ledger.schema })),
    ),
    refExists: (ledgerId, itemId) => {
      const ledger = ledgers.get(ledgerId);
      if (ledger !== undefined) {
        for (const milestone of ledger.milestones) {
          if (milestone.items.some((item) => item.id === itemId)) return true;
        }
      }
      return archivedRefExists?.(ledgerId, itemId) ?? false;
    },
  };
}

function statusChangePrecondition(
  ledgers: ReadonlyMap<string, Ledger>,
  ledgerId: string,
  ledger: Ledger,
  itemId: string,
  patch: { readonly fields?: Record<string, FieldValue | undefined> },
): StatusChangePrecondition | undefined {
  if (ledgerId === GOALS_LEDGER) {
    return (from, to) =>
      assertGoalPhasePreconditions(
        itemId,
        from,
        to,
        ledgers.get(QUESTIONS_LEDGER),
        ledgers.get(DECISIONS_LEDGER),
        collectNonTerminalOwnedChildren(ledgers, `${GOALS_LEDGER}:${itemId}`),
      );
  }
  if (ledgerId === QUESTIONS_LEDGER) {
    return (from, to) => {
      const { item } = findItem(ledger, itemId);
      const effectiveAnswer =
        patch.fields?.[QUESTIONS_ANSWER_FIELD] ?? item.fields[QUESTIONS_ANSWER_FIELD];
      assertQuestionAnswerPrecondition(itemId, from, to, effectiveAnswer);
    };
  }
  return undefined;
}

/**
 * Build the synchronous domain transaction shared by durable owned-write
 * adapters. The caller supplies a backend-private ledger map materialized and
 * locked inside its native atomic boundary, then persists exactly the returned
 * dirty ledgers before that boundary commits.
 */
export function createOwnedWriteTransaction(
  options: CreateOwnedWriteTransactionOptions,
): OwnedWriteTransaction {
  const { ledgers, now, archivedRefExists } = options;
  const dirtyLedgers = new Set<string>();
  const refs = buildRefValidationContext(ledgers, archivedRefExists);
  const getLedger = (ledgerId: string): Ledger => requireLedger(ledgers, ledgerId);

  const tx: WorksetOwnedWriteTx = {
    activeState: () =>
      buildWorksetActiveState(
        [...ledgers].map(([ledger, value]) => ({
          ledger,
          items: value.milestones.flatMap((group) => group.items),
        })),
        refs.registry,
      ),
    fetchItem: (ledgerId, itemId) => cloneItem(findItem(getLedger(ledgerId), itemId).item),
    createItemWithSealedOwnership: (ledgerId, milestoneId, init, ownership) => {
      if (ledgerId === MILESTONES_LEDGER) {
        throw new BootstrapViolationError(
          `use createMilestoneWithSealedOwnership to add an item to the ${MILESTONES_LEDGER} ledger`,
        );
      }
      assertMilestoneActive(getLedger(MILESTONES_LEDGER), milestoneId);
      assertRawPlanCreateAllowed(getLedger, ledgerId, init.fields);
      const item = applyCreateItem(
        getLedger(ledgerId),
        milestoneId,
        init,
        now(),
        refs,
        ownership,
      );
      dirtyLedgers.add(ledgerId);
      return cloneItem(item);
    },
    createMilestoneWithSealedOwnership: (init, ownership) => {
      const item = applyCreateMilestoneItem(
        getLedger(MILESTONES_LEDGER),
        init,
        now(),
        refs,
        ownership,
      );
      dirtyLedgers.add(MILESTONES_LEDGER);
      return cloneItem(item);
    },
    createItemOwnerless: (ledgerId, milestoneId, init) => {
      if (ledgerId === MILESTONES_LEDGER) {
        throw new BootstrapViolationError(
          `use createMilestoneOwnerless to add an item to the ${MILESTONES_LEDGER} ledger`,
        );
      }
      assertMilestoneActive(getLedger(MILESTONES_LEDGER), milestoneId);
      assertRawPlanCreateAllowed(getLedger, ledgerId, init.fields);
      const item = applyCreateItem(getLedger(ledgerId), milestoneId, init, now(), refs);
      dirtyLedgers.add(ledgerId);
      return cloneItem(item);
    },
    createMilestoneOwnerless: (init) => {
      const item = applyCreateMilestoneItem(
        getLedger(MILESTONES_LEDGER),
        init,
        now(),
        refs,
      );
      dirtyLedgers.add(MILESTONES_LEDGER);
      return cloneItem(item);
    },
    updateItem: (ledgerId, itemId, patch) => {
      if (ledgerId === MILESTONES_LEDGER) {
        const item = applyUpdateMilestoneItem(
          getLedger(MILESTONES_LEDGER),
          itemId,
          validateMilestoneItemPatch(patch),
          now(),
          refs,
        );
        dirtyLedgers.add(MILESTONES_LEDGER);
        return cloneItem(item);
      }
      const ledger = getLedger(ledgerId);
      assertRawPlanUpdateAllowed(getLedger, ledgerId, ledger, itemId, patch);
      const item = applyUpdateItem(
        ledger,
        itemId,
        patch,
        now(),
        statusChangePrecondition(ledgers, ledgerId, ledger, itemId, patch),
        refs,
      );
      dirtyLedgers.add(ledgerId);
      return cloneItem(item);
    },
  };

  return { tx, dirtyLedgers };
}
