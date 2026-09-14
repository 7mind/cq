import { GOALS_LEDGER, REVIEWS_LEDGER } from "../constants.js";
import { buildPrefixRegistry } from "../refs.js";
import type { Item, Ledger } from "../types.js";
import { buildWorksetActiveState } from "../worksetGraph.js";
import { affectedPlanLifecycleRefs, assertChangedPlanItemsSelected, assertPlanCreatedOwnership, selectedPlanLifecycleMembers, type AdmittedPlanMutation, type WorksetPlanLifecycleOperation } from "../worksetPlanLifecycle.js";
import { resolveGenericMutationClosure, resolveAsyncGenericMutationClosure, type GenericMutationDataSource, type GenericMutationResolvedClosure, type ResolveGenericMutationClosureOptions } from "./genericMutationDataSource.js";
import type { LifecycleRowRepository } from "./lifecycleRowRepository.js";
import type { PlanLifecycleRowPlan, PlanLifecycleRowRequest } from "./planLifecycleRowPlan.js";
import type { PlanClaimResult, PlanFinalizeResult, PlanPublishDraftResult, PlanReleaseResult } from "../planLifecycle.js";
import type { AsyncGenericMutationDataSource, AsyncLifecycleRowRepository } from "./asyncRowRepository.js";
import { repositoryRead, runRepositoryReads, runAsyncRepositoryReads, type RepositoryReadProgram } from "./readProgram.js";

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
  return runRepositoryReads({ source, rows, resolveClosure: (roots, options) => resolveGenericMutationClosure(source, roots, options) },
    authorizationReads(context, plan));
}

export function authorizeAsyncKeyedWorksetPlan(source: AsyncGenericMutationDataSource, rows: AsyncLifecycleRowRepository,
  context: AdmittedPlanMutation, plan: PlanLifecycleRowPlan): Promise<ReadonlySet<string> | null> {
  return runAsyncRepositoryReads({ source, rows, resolveClosure: (roots, options) => resolveAsyncGenericMutationClosure(source, roots, options) },
    authorizationReads(context, plan));
}

interface AuthorizationReadSource {
  readonly source: GenericMutationDataSource | AsyncGenericMutationDataSource;
  readonly rows: LifecycleRowRepository | AsyncLifecycleRowRepository;
  resolveClosure(roots: readonly string[], options: ResolveGenericMutationClosureOptions): GenericMutationResolvedClosure | Promise<GenericMutationResolvedClosure>;
}

function* authorizationReads(context: AdmittedPlanMutation, plan: PlanLifecycleRowPlan): RepositoryReadProgram<AuthorizationReadSource, ReadonlySet<string> | null> {
  const { operation, admission } = context;
  const metadata = yield* repositoryRead((input: AuthorizationReadSource) => input.source.listLedgers());
  const goal = yield* repositoryRead((input: AuthorizationReadSource) => input.source.fetchActiveItem(`${GOALS_LEDGER}:${operation.input.goalId}`));
  const seed: { ledger: string; items: Item[] }[] = goal === undefined ? [] : [{ ledger: GOALS_LEDGER, items: [goal] }];
  const reviewId = operation.kind === "finalize-plan" ? operation.input.reviewId
    : operation.kind === "claim-plan" ? undefined : operation.input.reviewDefects?.reviewId;
  if (reviewId !== undefined) {
    const review = yield* repositoryRead((input: AuthorizationReadSource) => input.source.fetchActiveItem(`${REVIEWS_LEDGER}:${reviewId}`));
    if (review !== undefined) seed.push({ ledger: REVIEWS_LEDGER, items: [review] });
  }
  const initial = buildWorksetActiveState(seed, buildPrefixRegistry(metadata.map(({ id, schema }) => ({ name: id, schema }))));
  const candidates = new Set(affectedPlanLifecycleRefs(initial, operation));
  const milestones = goal === undefined ? undefined : goal.fields.milestones;
  if (Array.isArray(milestones)) {
    for (const ref of yield* repositoryRead((input: AuthorizationReadSource) => input.rows.taskRefsByMilestones(milestones))) candidates.add(ref);
  }
  for (const [ledgerId, ledger] of plan.beforeLedgers) {
    for (const group of ledger.milestones) for (const item of group.items) candidates.add(`${ledgerId}:${item.id}`);
  }
  const closure = yield* repositoryRead((input: AuthorizationReadSource) => input.resolveClosure(admission.roots, { candidateRefs: [...candidates], incidentReferenceFields: [] }));
  return selectedPlanLifecycleMembers(closure.activeState, admission.roots, affectedPlanLifecycleRefs(closure.activeState, operation));
}

export function assertKeyedPlanMutationChanges(plan: PlanLifecycleRowPlan, operation: WorksetPlanLifecycleOperation,
  selected: ReadonlySet<string> | null, result: PlanClaimResult | PlanPublishDraftResult | PlanReleaseResult | PlanFinalizeResult): void {
  const itemMap = (ledgers: ReadonlyMap<string, Ledger>) => new Map<string, Item>([...ledgers].flatMap(([ledgerId, ledger]) =>
    ledger.milestones.flatMap(({ items }) => items.map((item) => [`${ledgerId}:${item.id}`, item] as const))));
  const before = itemMap(plan.beforeLedgers);
  const after = itemMap(plan.state.ledgers);
  const changedExisting = [...before].filter(([ref, item]) => JSON.stringify(item) !== JSON.stringify(after.get(ref))).map(([ref]) => ref);
  assertChangedPlanItemsSelected(changedExisting, selected);
  assertPlanCreatedOwnership((ref) => after.get(ref), operation.kind, operation.input.goalId, result);
}
