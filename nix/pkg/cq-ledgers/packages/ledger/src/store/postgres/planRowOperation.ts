import { DECISIONS_LEDGER, DEFECTS_LEDGER, GOALS_LEDGER, MILESTONES_LEDGER, QUESTIONS_LEDGER, RESEARCHES_LEDGER, TASKS_LEDGER } from "../../constants.js";
import { LedgerError, type Item } from "../../types.js";
import { loadAsyncPlanLifecycleRowPlan, type PlanLifecycleRowPlan, type PlanLifecycleRowRequest } from "../planLifecycleRowPlan.js";
import type { PostgresOperationClosure } from "./operationKernel.js";
import { createPostgresLifecycleRowRepository } from "./lifecycleRowRepository.js";
import type { PostgresOperationQueries } from "./operationAccess.js";
import { orderedPostgresRowLocks, type PostgresLockTarget, type PostgresRowLock } from "./rowLocks.js";

export type PostgresResolvedPlanRows =
  | { readonly kind: "loaded"; readonly plan: PlanLifecycleRowPlan }
  | { readonly kind: "rejected"; readonly error: unknown };

function allocationLedgers(request: PlanLifecycleRowRequest): readonly string[] {
  const ledgers: string[] = [];
  if (request.operation === "publish-draft") {
    if (request.input.manifest.milestones.length > 0) ledgers.push(MILESTONES_LEDGER);
    if (request.input.manifest.tasks.length > 0) ledgers.push(TASKS_LEDGER);
  } else if (request.operation === "finalize") ledgers.push(DECISIONS_LEDGER);
  else if (request.operation === "release" && request.input.kind === "pause") {
    const effect = request.input.effect;
    if (effect.kind === "questions" && effect.questions.length > 0) ledgers.push(QUESTIONS_LEDGER);
    if (effect.kind === "researches" && effect.researches.length > 0) ledgers.push(RESEARCHES_LEDGER);
  }
  if (request.operation !== "claim" && request.input.reviewDefects !== undefined && request.input.reviewDefects.defects.length > 0) ledgers.push(DEFECTS_LEDGER);
  return ledgers;
}

export async function resolvePostgresPlanRows(queries: PostgresOperationQueries, request: PlanLifecycleRowRequest,
  now: () => string): Promise<PostgresOperationClosure<PostgresResolvedPlanRows>> {
  const targets: PostgresLockTarget[] = [];
  const rows = createPostgresLifecycleRowRepository(queries.withReadTargets((target) => targets.push(target)));
  const fetchActive = rows.publicRows.fetchActiveItem;
  let goal: Item | undefined;
  rows.publicRows.fetchActiveItem = async (ref) => {
    const item = await fetchActive(ref);
    if (ref === `${GOALS_LEDGER}:${request.input.goalId}`) goal = item;
    return item;
  };
  let resolution: PostgresResolvedPlanRows;
  try {
    const plan = await loadAsyncPlanLifecycleRowPlan(rows, request, now);
    if (plan.state.ledgers.size === 0) return { plan: { kind: "loaded", plan }, exactReplay: true, locks: [] };
    resolution = { kind: "loaded", plan };
  } catch (error) {
    if (!(error instanceof LedgerError)) throw error;
    // Discovery may encounter a stale guard failure. Decide it only after the keyed locks and re-read.
    resolution = { kind: "rejected", error };
  }
  const parent = goal === undefined ? null : goal.milestoneId;
  const locks: PostgresRowLock[] = targets.map((target) => ({ target,
    mode: target.table === "items"
      ? target.ledgerId === MILESTONES_LEDGER && target.id === parent ? "share" : "update"
      : target.table === "plan_claims" ? "update" : "share",
  }));
  for (const ledgerId of allocationLedgers(request)) locks.push({ target: { table: "ledgers", ledgerId }, mode: "update" });
  return { plan: resolution, locks: orderedPostgresRowLocks(locks), exactReplay: false };
}
