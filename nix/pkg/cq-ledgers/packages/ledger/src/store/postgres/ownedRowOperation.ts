import { LedgerError } from "../../types.js";
import { assertOwnedMutationAdmission, WorksetOwnedLifecycleError, type AdmittedOwnedMutation } from "../../worksetOwnedLifecycle.js";
import { resolveAsyncGenericMutationClosure } from "../genericMutationDataSource.js";
import { createAsyncKeyedOwnedWriteTransaction, type KeyedOwnedWriteTransaction } from "../keyedOwnedWriteTransaction.js";
import { createPostgresGenericMutationDataSource } from "./genericMutationDataSource.js";
import { createPostgresLifecycleRowRepository } from "./lifecycleRowRepository.js";
import type { PostgresOperationQueries } from "./operationAccess.js";
import type { PostgresOperationClosure } from "./operationKernel.js";
import { orderedPostgresRowLocks, type PostgresLockTarget, type PostgresRowLock } from "./rowLocks.js";
import { postgresAdmissionMatches } from "./worksetAdmissionRows.js";

type ResolvedOwnedRows = { readonly kind: "loaded"; readonly owned: KeyedOwnedWriteTransaction }
  | { readonly kind: "rejected"; readonly error: LedgerError | WorksetOwnedLifecycleError };

async function assertDurableAdmission(queries: PostgresOperationQueries, context: AdmittedOwnedMutation): Promise<void> {
  assertOwnedMutationAdmission(context);
  if (!(await postgresAdmissionMatches(queries, context.admission))) {
    throw new WorksetOwnedLifecycleError("stale-epoch", "owned transaction admission is no longer the exact durable owner/roots epoch");
  }
}

export async function resolvePostgresOwnedRows(queries: PostgresOperationQueries, context: AdmittedOwnedMutation,
  now: () => string): Promise<PostgresOperationClosure<ResolvedOwnedRows>> {
  const targets: PostgresLockTarget[] = [];
  const selected = queries.withReadTargets((target) => targets.push(target));
  let resolution: ResolvedOwnedRows;
  try {
    await assertDurableAdmission(selected, context);
    const publicRows = createPostgresGenericMutationDataSource(selected);
    const closure = await resolveAsyncGenericMutationClosure(publicRows, context.admission.roots, {
      candidateRefs: context.admission.targets, incidentReferenceFields: [],
    });
    const owned = await createAsyncKeyedOwnedWriteTransaction({ ...createPostgresLifecycleRowRepository(selected), publicRows },
      closure.activeState, context.operation, now);
    resolution = { kind: "loaded", owned };
  } catch (error) {
    if (!(error instanceof LedgerError) && !(error instanceof WorksetOwnedLifecycleError)) throw error;
    resolution = { kind: "rejected", error };
  }
  const owners = new Set(context.admission.targets);
  const locks: PostgresRowLock[] = targets.map((target) => ({ target,
    mode: target.table === "items" && owners.has(`${target.ledgerId}:${target.id}`) ? "update" : "share",
  }));
  if (resolution.kind === "loaded") {
    for (const ledgerId of resolution.owned.allocationLedgers) locks.push({ target: { table: "ledgers", ledgerId }, mode: "update" });
  }
  return { plan: resolution, locks: orderedPostgresRowLocks(locks), exactReplay: false };
}
