import { LedgerError } from "../../types.js";
import { prepareAsyncOperatorActionLifecycleRows, type OperatorActionLifecycleMutation, type OperatorActionLifecycleMutationOutcome } from "../operatorActionLifecycle.js";
import type { PostgresOperationQueries } from "./operationAccess.js";
import type { PostgresOperationClosure } from "./operationKernel.js";
import { createPostgresSelectedPublicRows } from "./selectedPublicRows.js";
import { orderedPostgresRowLocks, type PostgresRowLock } from "./rowLocks.js";

export type PostgresResolvedOperatorRows =
  | { readonly kind: "loaded"; readonly rows: ReturnType<typeof createPostgresSelectedPublicRows>; readonly apply: () => OperatorActionLifecycleMutationOutcome }
  | { readonly kind: "rejected"; readonly error: LedgerError };

export async function resolvePostgresOperatorRows(queries: PostgresOperationQueries, mutation: OperatorActionLifecycleMutation,
  now: () => string): Promise<PostgresOperationClosure<PostgresResolvedOperatorRows>> {
  const locks: PostgresRowLock[] = [];
  const rows = createPostgresSelectedPublicRows(queries.withReadTargets((target) => {
    locks.push({ target, mode: target.table === "items" ? "update" : "share" });
  }));
  let plan: PostgresResolvedOperatorRows;
  try { plan = { kind: "loaded", rows, apply: await prepareAsyncOperatorActionLifecycleRows(rows, mutation, now) }; }
  catch (error) {
    if (!(error instanceof LedgerError)) throw error;
    plan = { kind: "rejected", error };
  }
  return { plan, locks: orderedPostgresRowLocks(locks), exactReplay: false };
}
