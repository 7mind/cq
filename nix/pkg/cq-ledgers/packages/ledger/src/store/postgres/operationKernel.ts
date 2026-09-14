import type { SQL } from "bun";
import { LedgerError } from "../../types.js";
import { WRITE_TXN_MAX_ATTEMPTS, writeTransaction } from "./connection.js";
import { PostgresOperationQueries, type PostgresAccessObserver } from "./operationAccess.js";
import { lockPostgresRows, postgresRowLocksCover, type PostgresRowLock } from "./rowLocks.js";

export interface PostgresOperationClosure<Plan> {
  readonly plan: Plan;
  readonly locks: readonly PostgresRowLock[];
  readonly exactReplay: boolean;
}

export interface PostgresKeyedOperation<Plan, Result> {
  readonly name: string;
  resolve(queries: PostgresOperationQueries): Promise<PostgresOperationClosure<Plan>>;
  apply(queries: PostgresOperationQueries, plan: Plan): Promise<Result>;
}

export interface PostgresClosureRetry {
  readonly operation: string;
  readonly attempt: number;
  readonly reason: "closure-changed-after-lock";
}

export interface PostgresOperationKernelOptions {
  readonly projectKey: string;
  readonly observer: PostgresAccessObserver | null;
  readonly monotonicNow: () => number;
  readonly onClosureRetry: ((retry: PostgresClosureRetry) => void) | null;
}

class ClosureChangedAfterLock extends Error {
  constructor() { super("PostgreSQL affected closure changed after locking"); }
}

export async function runPostgresKeyedOperation<Plan, Result>(pool: SQL, options: PostgresOperationKernelOptions,
  operation: PostgresKeyedOperation<Plan, Result>): Promise<Result> {
  for (let attempt = 1; attempt <= WRITE_TXN_MAX_ATTEMPTS; attempt++) {
    try {
      const committed = await writeTransaction(pool, async (tx) => {
        const queries = new PostgresOperationQueries(tx, options.projectKey, operation.name, options.observer, options.monotonicNow, null);
        const discovered = await operation.resolve(queries);
        if (discovered.exactReplay) {
          if (discovered.locks.length !== 0) throw new LedgerError("an exact PostgreSQL replay declared domain locks");
          return { result: await operation.apply(queries, discovered.plan) };
        }
        await lockPostgresRows(queries, discovered.locks);
        // READ COMMITTED gives this second resolution the state committed by a lock holder.
        const authoritative = await operation.resolve(queries);
        if (!postgresRowLocksCover(discovered.locks, authoritative.locks)) throw new ClosureChangedAfterLock();
        return { result: await operation.apply(queries, authoritative.plan) };
      });
      return committed.result;
    } catch (error) {
      if (!(error instanceof ClosureChangedAfterLock)) throw error;
      if (options.onClosureRetry !== null) options.onClosureRetry({ operation: operation.name, attempt, reason: "closure-changed-after-lock" });
      if (attempt === WRITE_TXN_MAX_ATTEMPTS) throw new LedgerError(`${operation.name}: affected closure did not stabilize after ${attempt} transactions`);
    }
  }
  throw new LedgerError("PostgreSQL transaction attempt bound was not positive");
}
