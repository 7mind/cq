import { GOALS_LEDGER, REVIEWS_LEDGER } from "../constants.js";
import { buildPrefixRegistry } from "../refs.js";
import type { Item } from "../types.js";
import { buildWorksetActiveState } from "../worksetGraph.js";
import { affectedPlanLifecycleRefs, selectedPlanLifecycleMembers, type AdmittedPlanMutation, type WorksetPlanLifecycleOperation } from "../worksetPlanLifecycle.js";
import { resolveGenericMutationClosure, type GenericMutationDataSource } from "./genericMutationDataSource.js";
import type { LifecycleRowRepository } from "./lifecycleRowRepository.js";
import type { PlanLifecycleRowPlan, PlanLifecycleRowRequest } from "./planLifecycleRowPlan.js";

export function guardedPlanRowRequest(operation: WorksetPlanLifecycleOperation): PlanLifecycleRowRequest {
  switch (operation.kind) {
    case "claim-plan": return { operation: "claim", input: operation.input };
    case "publish-plan-draft": return { operation: "publish-draft", input: operation.input };
    case "release-plan-claim": return { operation: "release", input: operation.input };
    case "finalize-plan": return { operation: "finalize", input: operation.input };
  }
}

export function authorizeKeyedWorksetPlan(
  source: GenericMutationDataSource,
  rows: LifecycleRowRepository,
  context: AdmittedPlanMutation,
  plan: PlanLifecycleRowPlan,
): ReadonlySet<string> | null {
  const { operation, admission } = context;
  const metadata = source.listLedgers();
  const goal = source.fetchActiveItem(`${GOALS_LEDGER}:${operation.input.goalId}`);
  const seed: { ledger: string; items: Item[] }[] = goal === undefined ? [] : [{ ledger: GOALS_LEDGER, items: [goal] }];
  const reviewId = operation.kind === "finalize-plan" ? operation.input.reviewId
    : operation.kind === "claim-plan" ? undefined : operation.input.reviewDefects?.reviewId;
  if (reviewId !== undefined) {
    const review = source.fetchActiveItem(`${REVIEWS_LEDGER}:${reviewId}`);
    if (review !== undefined) seed.push({ ledger: REVIEWS_LEDGER, items: [review] });
  }
  const initial = buildWorksetActiveState(seed, buildPrefixRegistry(metadata.map(({ id, schema }) => ({ name: id, schema }))));
  const candidates = new Set(affectedPlanLifecycleRefs(initial, operation));
  const milestones = goal === undefined ? undefined : goal.fields.milestones;
  if (Array.isArray(milestones)) for (const ref of rows.taskRefsByMilestones(milestones)) candidates.add(ref);
  for (const [ledgerId, ledger] of plan.beforeLedgers) {
    for (const group of ledger.milestones) for (const item of group.items) candidates.add(`${ledgerId}:${item.id}`);
  }
  const closure = resolveGenericMutationClosure(source, admission.roots, { candidateRefs: [...candidates], incidentReferenceFields: [] });
  return selectedPlanLifecycleMembers(closure.activeState, admission.roots, affectedPlanLifecycleRefs(closure.activeState, operation));
}
