import { MILESTONES_LEDGER } from "../../constants.js";
import { LedgerError } from "../../types.js";
import type { DirectOwnedOperation } from "../directOwnedMutation.js";
import { assertCohortCompletionPrimaryFenceV1 } from "../directOwnedMutation.js";
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
  const observed = queries.withReadTargets((target) => targets.push(target));
  const rows = createPostgresLifecycleRowRepository(observed);
  let resolution: ResolvedDirectRows;
  try {
    if (operation.kind === "cohort-completion" && operation.fence !== null) {
      observed.recordReadTarget({ table: "work_cohort_state" });
      const current = (await observed.execute<{ revision: string | number; execution_epoch: string }>({
        table: "work_cohort_state", phase: "transaction", mode: "read", predicate: { kind: "primary-key", keys: [queries.projectKey] }, lockMode: "none",
      }, { sql: "SELECT revision, execution_epoch FROM work_cohort_state WHERE project_key = $1", parameters: [queries.projectKey] }, () => queries.projectKey))[0];
      if (current === undefined) throw new LedgerError("cohort primary completion state is absent");
      assertCohortCompletionPrimaryFenceV1(operation.fence, { revision: Number(current.revision), executionEpoch: current.execution_epoch });
    }
    resolution = { kind: "loaded", owned: await createAsyncDirectOwnedWriteTransaction(rows, operation, now) };
  }
  catch (error) {
    if (!(error instanceof LedgerError)) throw error;
    resolution = { kind: "rejected", error };
  }
  const locks: PostgresRowLock[] = targets.map((target) => ({ target,
    mode: target.table === "implementation_completion_bindings" ||
      (operation.kind === "cohort-completion" && (target.table === "archive_pointers" || target.table === "archived_items" || target.table === "groups")) ||
      (target.table === "items" && (target.ledgerId !== MILESTONES_LEDGER || operation.kind === "cohort-completion")) ? "update" : "share",
  }));
  if (resolution.kind === "loaded") {
    for (const ledgerId of resolution.owned.allocationLedgers) locks.push({ target: { table: "ledgers", ledgerId }, mode: "update" });
  }
  return { plan: resolution, locks: orderedPostgresRowLocks(locks), exactReplay: false };
}
