import {
  GOALS_LEDGER,
  TASKS_LEDGER,
} from "../constants.js";
import {
  PLAN_ACTIVE_CLAIM_FIELD,
  PLAN_GENERATION_FIELD,
  PLAN_MANAGED_GOAL_FIELD_NAMES,
} from "../planLifecycle.js";
import type { FieldValue, Item, Ledger } from "../types.js";
import { LedgerError } from "../types.js";
import type { LedgerStore, UpdateItemPatch } from "./LedgerStore.js";
import { findItem } from "./core.js";
import { readInMemoryPlanState } from "./inMemoryPlanLifecycle.js";
import { taskDependenciesSatisfied } from "./predicates.js";

export type LoadPlanGuardLedger = (ledgerId: string) => Ledger;

function fieldIsPresent(item: Item, name: string): boolean {
  return item.fields[name] !== undefined;
}

function fieldArray(item: Item, name: string): string[] {
  const value = item.fields[name];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function findOptionalItem(source: Ledger, itemId: string): Item | undefined {
  for (const milestone of source.milestones) {
    const item = milestone.items.find(({ id }) => id === itemId);
    if (item !== undefined) return item;
  }
  return undefined;
}

function managedGoalReferences(
  loadLedger: LoadPlanGuardLedger,
  value: unknown,
): string[] {
  if (!Array.isArray(value)) return [];
  const goals = loadLedger(GOALS_LEDGER);
  return value.filter((ref): ref is string => {
    if (typeof ref !== "string" || !ref.startsWith(`${GOALS_LEDGER}:`)) {
      return false;
    }
    const goal = findOptionalItem(goals, ref.slice(GOALS_LEDGER.length + 1));
    return goal !== undefined && fieldIsPresent(goal, PLAN_GENERATION_FIELD);
  });
}

function assertNoManagedGoalReference(
  loadLedger: LoadPlanGuardLedger,
  value: unknown,
): void {
  if (managedGoalReferences(loadLedger, value).length > 0) {
    throw new LedgerError(
      "managed plan work may mutate only through PlanLifecycleStore",
    );
  }
}

function assertManagedTaskOwnershipRefsPreserved(
  loadLedger: LoadPlanGuardLedger,
  task: Item,
  value: unknown,
): void {
  const current = new Set(
    managedGoalReferences(loadLedger, task.fields["ledgerRefs"]),
  );
  const proposed = Array.isArray(value)
    ? new Set(value.filter((ref): ref is string => typeof ref === "string"))
    : new Set<string>();
  const proposedManaged = managedGoalReferences(loadLedger, value);
  if (
    [...current].some((ref) => !proposed.has(ref)) ||
    proposedManaged.some((ref) => !current.has(ref))
  ) {
    throw new LedgerError(
      "managed plan work may mutate only through PlanLifecycleStore",
    );
  }
}

export function assertManagedGoalTransitionAllowed(
  goal: Item,
  targetStatus: string,
): void {
  if (!fieldIsPresent(goal, PLAN_GENERATION_FIELD)) return;
  const lifecycleOwned =
    goal.status === "done" ||
    goal.status === "abandoned" ||
    (goal.status === "building" && targetStatus === "planning") ||
    (fieldIsPresent(goal, PLAN_ACTIVE_CLAIM_FIELD) &&
      (targetStatus === "done" || targetStatus === "abandoned")) ||
    (goal.status === "clarifying" && targetStatus === "planning") ||
    (goal.status === "planning" &&
      (targetStatus === "clarifying" || targetStatus === "planned")) ||
    (goal.status === "planned" && targetStatus === "planning");
  if (lifecycleOwned) {
    throw new LedgerError(
      "managed plan transition may mutate only through PlanLifecycleStore",
    );
  }
}

export function assertManagedTaskTransitionAllowed(
  store: Pick<LedgerStore, "enumerate" | "fetch">,
  loadLedger: LoadPlanGuardLedger,
  task: Item,
  targetStatus: string,
): void {
  const goalRefs = fieldArray(task, "ledgerRefs").filter((ref) =>
    ref.startsWith(`${GOALS_LEDGER}:`),
  );
  for (const ref of goalRefs) {
    const goal = findOptionalItem(
      loadLedger(GOALS_LEDGER),
      ref.slice(GOALS_LEDGER.length + 1),
    );
    if (goal === undefined || !fieldIsPresent(goal, PLAN_GENERATION_FIELD)) continue;
    const manifest = readInMemoryPlanState(goal).finalizedManifest;
    if (
      manifest === null ||
      !manifest.tasks.some(({ id }) => id === task.id)
    ) {
      throw new LedgerError("task belongs to a draft or superseded manifest");
    }
    if (targetStatus !== "wip") continue;
    if (!taskDependenciesSatisfied(store, task)) {
      throw new LedgerError("task dependencies are not satisfied");
    }
  }
}

export function assertRawPlanCreateAllowed(
  loadLedger: LoadPlanGuardLedger,
  ledgerId: string,
  fields: Record<string, FieldValue>,
): void {
  if (
    ledgerId === GOALS_LEDGER &&
    PLAN_MANAGED_GOAL_FIELD_NAMES.some((name) => fields[name] !== undefined)
  ) {
    throw new LedgerError(
      "managed plan state may mutate only through PlanLifecycleStore",
    );
  }
  if (ledgerId === TASKS_LEDGER) {
    assertNoManagedGoalReference(loadLedger, fields["ledgerRefs"]);
  }
}

export function assertRawPlanUpdateAllowed(
  store: Pick<LedgerStore, "enumerate" | "fetch">,
  loadLedger: LoadPlanGuardLedger,
  ledgerId: string,
  source: Ledger,
  itemId: string,
  patch: UpdateItemPatch,
): void {
  if (ledgerId === GOALS_LEDGER) {
    const goal = findItem(source, itemId).item;
    if (
      PLAN_MANAGED_GOAL_FIELD_NAMES.some(
        (name) => patch.fields?.[name] !== undefined,
      ) ||
      (fieldIsPresent(goal, PLAN_GENERATION_FIELD) &&
        patch.fields?.["milestones"] !== undefined)
    ) {
      throw new LedgerError(
        "managed plan state may mutate only through PlanLifecycleStore",
      );
    }
    const to = patch.status;
    if (to !== undefined && to !== goal.status) {
      assertManagedGoalTransitionAllowed(goal, to);
    }
  }
  if (ledgerId === TASKS_LEDGER) {
    const task = findItem(source, itemId).item;
    if (patch.fields?.["ledgerRefs"] !== undefined) {
      assertManagedTaskOwnershipRefsPreserved(
        loadLedger,
        task,
        patch.fields["ledgerRefs"],
      );
    }
    if (patch.status !== undefined && patch.status !== task.status) {
      assertManagedTaskTransitionAllowed(
        store,
        loadLedger,
        task,
        patch.status,
      );
    }
  }
}
