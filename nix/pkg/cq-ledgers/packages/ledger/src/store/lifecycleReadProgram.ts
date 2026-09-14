import type { AsyncLifecycleRowRepository } from "./asyncRowRepository.js";
import type { LifecycleRowRepository } from "./lifecycleRowRepository.js";
import { repositoryRead, runRepositoryReads, runAsyncRepositoryReads, type RepositoryReadProgram } from "./readProgram.js";

type LifecycleReadSource = LifecycleRowRepository | AsyncLifecycleRowRepository;

export type LifecycleReadProgram<Result> = RepositoryReadProgram<LifecycleReadSource, Result>;

function read<Result>(execute: (rows: LifecycleReadSource) => Result | Promise<Result>): LifecycleReadProgram<Result> {
  return repositoryRead(execute);
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
  return runRepositoryReads(rows, program);
}

export async function runAsyncLifecycleReads<Result>(rows: AsyncLifecycleRowRepository, program: LifecycleReadProgram<Result>): Promise<Result> {
  return runAsyncRepositoryReads(rows, program);
}
