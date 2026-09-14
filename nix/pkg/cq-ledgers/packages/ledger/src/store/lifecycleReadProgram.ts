import { LedgerError } from "../types.js";
import type { AsyncLifecycleRowRepository } from "./asyncRowRepository.js";
import type { LifecycleRowRepository } from "./lifecycleRowRepository.js";

type LifecycleReadSource = LifecycleRowRepository | AsyncLifecycleRowRepository;

interface LifecycleRead {
  execute(rows: LifecycleReadSource): unknown;
}

export type LifecycleReadProgram<Result> = Generator<LifecycleRead, Result, unknown>;

function* read<Result>(execute: (rows: LifecycleReadSource) => Result | Promise<Result>): LifecycleReadProgram<Result> {
  // The interpreter sends back precisely the result of this suspended read.
  return (yield { execute }) as Result;
}

export function createLifecycleReadRequests() {
  return {
    publicRows: {
      listLedgers: () => read((rows) => rows.publicRows.listLedgers()),
      fetchActiveItem: (ref: string) => read((rows) => rows.publicRows.fetchActiveItem(ref)),
      fetchArchivedItem: (ref: string) => read((rows) => rows.publicRows.fetchArchivedItem(ref)),
      referenceSources: (ref: string, fields: readonly string[]) => read((rows) => rows.publicRows.referenceSources(ref, fields)),
    },
    fetchGroup: (ledgerId: string, groupId: string) => read((rows) => rows.fetchGroup(ledgerId, groupId)),
    taskRefsByMilestones: (ids: readonly string[]) => read((rows) => rows.taskRefsByMilestones(ids)),
    fetchClaimByRequest: (...args: Parameters<LifecycleRowRepository["fetchClaimByRequest"]>) => read((rows) => rows.fetchClaimByRequest(...args)),
    fetchClaimByIdentity: (...args: Parameters<LifecycleRowRepository["fetchClaimByIdentity"]>) => read((rows) => rows.fetchClaimByIdentity(...args)),
    fetchActiveClaim: (goalId: string) => read((rows) => rows.fetchActiveClaim(goalId)),
    fetchOperation: (...args: Parameters<LifecycleRowRepository["fetchOperation"]>) => read((rows) => rows.fetchOperation(...args)),
  };
}

export function runLifecycleReads<Result>(rows: LifecycleRowRepository, program: LifecycleReadProgram<Result>): Result {
  let step = program.next();
  while (!step.done) {
    const value = step.value.execute(rows);
    if (value instanceof Promise) throw new LedgerError("a synchronous lifecycle repository returned an asynchronous read");
    step = program.next(value);
  }
  return step.value;
}

export async function runAsyncLifecycleReads<Result>(rows: AsyncLifecycleRowRepository, program: LifecycleReadProgram<Result>): Promise<Result> {
  let step = program.next();
  while (!step.done) step = program.next(await step.value.execute(rows));
  return step.value;
}
