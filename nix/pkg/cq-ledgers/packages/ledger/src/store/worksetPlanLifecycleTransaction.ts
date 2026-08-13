import type { WorksetPlanLifecycleTx } from "../worksetPlanLifecycle.js";
import {
  claimInMemoryPlan,
  finalizeInMemoryPlan,
  publishInMemoryPlanDraft,
  releaseInMemoryPlanClaim,
  type InMemoryPlanLifecycleState,
  type InMemoryPlanMutation,
} from "./inMemoryPlanLifecycle.js";
import { buildPrefixRegistry } from "../refs.js";
import { buildWorksetActiveState } from "../worksetGraph.js";

export interface WorksetPlanLifecycleTransaction {
  readonly tx: WorksetPlanLifecycleTx;
  readonly dirtyLedgers: ReadonlySet<string>;
}

/**
 * Build the synchronous guarded-plan transaction shared by durable adapters.
 * Its state must have been loaded after the backend acquired its complete
 * native write boundary; the caller persists every dirty ledger plus both
 * private lifecycle maps before that boundary commits.
 */
export function createWorksetPlanLifecycleTransaction(
  state: InMemoryPlanLifecycleState,
): WorksetPlanLifecycleTransaction {
  const dirtyLedgers = new Set<string>();
  const apply = <T>(mutation: InMemoryPlanMutation<T>): T => {
    for (const ledgerId of mutation.dirtyLedgers) dirtyLedgers.add(ledgerId);
    return mutation.result;
  };
  const registry = buildPrefixRegistry(
    [...state.ledgers].map(([name, ledger]) => ({ name, schema: ledger.schema })),
  );
  const tx: WorksetPlanLifecycleTx = {
    activeState: () =>
      buildWorksetActiveState(
        [...state.ledgers].map(([ledger, value]) => ({
          ledger,
          items: value.milestones.flatMap((group) => group.items),
        })),
        registry,
      ),
    claimPlan: (input) => apply(claimInMemoryPlan(state, input)),
    publishPlanDraft: (input) => apply(publishInMemoryPlanDraft(state, input)),
    releasePlanClaim: (input) => apply(releaseInMemoryPlanClaim(state, input)),
    finalizePlan: (input) => apply(finalizeInMemoryPlan(state, input)),
  };
  return { tx, dirtyLedgers };
}
