import { MILESTONES_LEDGER } from "../../constants.js";
import { LedgerError } from "../../types.js";
import type { DirectOwnedOperation } from "../directOwnedMutation.js";
import { createAsyncDirectOwnedWriteTransaction, type KeyedOwnedWriteTransaction } from "../keyedOwnedWriteTransaction.js";
import { createPostgresLifecycleRowRepository } from "./lifecycleRowRepository.js";
import type { PostgresOperationQueries } from "./operationAccess.js";
import type { PostgresOperationClosure } from "./operationKernel.js";
import { orderedPostgresRowLocks, type PostgresLockTarget, type PostgresRowLock } from "./rowLocks.js";

type ResolvedDirectRows = { readonly kind: "loaded"; readonly owned: KeyedOwnedWriteTransaction }
  | { readonly kind: "rejected"; readonly error: LedgerError };

export async function resolvePostgresDirectOwnedRows(queries: PostgresOperationQueries, operation: DirectOwnedOperation,
  now: () => string): Promise<PostgresOperationClosure<ResolvedDirectRows>> {
  const targets: PostgresLockTarget[] = [];
  const rows = createPostgresLifecycleRowRepository(queries.withReadTargets((target) => targets.push(target)));
  let resolution: ResolvedDirectRows;
  try { resolution = { kind: "loaded", owned: await createAsyncDirectOwnedWriteTransaction(rows, operation, now) }; }
  catch (error) {
    if (!(error instanceof LedgerError)) throw error;
    resolution = { kind: "rejected", error };
  }
  const locks: PostgresRowLock[] = targets.map((target) => ({ target,
    mode: target.table === "implementation_completion_bindings" ||
      (target.table === "items" && target.ledgerId !== MILESTONES_LEDGER) ? "update" : "share",
  }));
  if (resolution.kind === "loaded") {
    for (const ledgerId of resolution.owned.allocationLedgers) locks.push({ target: { table: "ledgers", ledgerId }, mode: "update" });
  }
  return { plan: resolution, locks: orderedPostgresRowLocks(locks), exactReplay: false };
}
