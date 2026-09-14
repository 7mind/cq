import { LedgerError } from "../../types.js";
import { assertPlanMutationAdmission, WorksetPlanLifecycleError, type AdmittedPlanMutation } from "../../worksetPlanLifecycle.js";
import { authorizeAsyncKeyedWorksetPlan, guardedPlanRowRequest } from "../keyedWorksetPlanAuthorization.js";
import type { PlanLifecycleRowPlan } from "../planLifecycleRowPlan.js";
import { createPostgresGenericMutationDataSource } from "./genericMutationDataSource.js";
import { createPostgresLifecycleRowRepository } from "./lifecycleRowRepository.js";
import type { PostgresOperationQueries } from "./operationAccess.js";
import type { PostgresOperationClosure } from "./operationKernel.js";
import { resolvePostgresPlanRows } from "./planRowOperation.js";
import { orderedPostgresRowLocks, type PostgresLockTarget, type PostgresRowLock } from "./rowLocks.js";
import { postgresAdmissionMatches } from "./worksetAdmissionRows.js";

type ResolvedGuardedPlan = { readonly kind: "loaded"; readonly plan: PlanLifecycleRowPlan; readonly selected: ReadonlySet<string> | null }
  | { readonly kind: "rejected"; readonly error: unknown };

export async function resolvePostgresGuardedPlanRows(queries: PostgresOperationQueries, context: AdmittedPlanMutation,
  now: () => string): Promise<PostgresOperationClosure<ResolvedGuardedPlan>> {
  const targets: PostgresLockTarget[] = [];
  const authority = queries.withReadTargets((target) => targets.push(target));
  let locks: readonly PostgresRowLock[] = [];
  let resolution: ResolvedGuardedPlan;
  try {
    assertPlanMutationAdmission(context);
    if (!(await postgresAdmissionMatches(authority, context.admission))) {
      throw new WorksetPlanLifecycleError("stale-epoch", "plan transaction admission is no longer the exact durable operation/goal/roots epoch", context.admission.targets);
    }
    const native = await resolvePostgresPlanRows(queries, guardedPlanRowRequest(context.operation), now);
    locks = native.locks;
    if (native.plan.kind === "rejected") resolution = native.plan;
    else {
      const selected = await authorizeAsyncKeyedWorksetPlan(createPostgresGenericMutationDataSource(authority),
        createPostgresLifecycleRowRepository(authority), context, native.plan.plan);
      resolution = { kind: "loaded", plan: native.plan.plan, selected };
    }
  } catch (error) {
    if (!(error instanceof LedgerError) && !(error instanceof WorksetPlanLifecycleError)) throw error;
    resolution = { kind: "rejected", error };
  }
  return { plan: resolution, exactReplay: false, locks: orderedPostgresRowLocks([
    ...locks, ...targets.map((target): PostgresRowLock => ({ target, mode: "share" })),
  ]) };
}
