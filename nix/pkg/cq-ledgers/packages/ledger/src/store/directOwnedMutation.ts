import type { MaterializeOperatorActionInput, SupersedeOperatorActionInput } from "../operatorActions.js";
import type { AdmittedOwnedMutation } from "../worksetOwnedLifecycle.js";
import type { WorksetOwnedWriteTx } from "../worksetOwnedLifecycle.js";
import type { CreateItemInit, UpdateItemPatch } from "./LedgerStore.js";
import type { Item } from "../types.js";
import type { ExactTerminalItemArchiveV1 } from "../finalize.js";
import type { WorksetGenericMutationTx } from "./genericMutationTransaction.js";
import type { CohortCompletionBatchV1, CohortOperatorSettlementV1 } from "../workCohortCompletion.js";

export interface CohortCompletionSweepV1 {
  readonly archiveCompletedMembers: boolean;
  readonly terminalItems: readonly ExactTerminalItemArchiveV1[];
  readonly milestones: readonly { readonly id: string; readonly expectedItemDigest: string }[];
  readonly summary: string;
}

export interface CohortCompletionPrimaryFenceV1 {
  readonly revision: number;
  readonly executionEpoch: string;
}

export function assertCohortCompletionPrimaryFenceV1(expected: CohortCompletionPrimaryFenceV1,
  actual: CohortCompletionPrimaryFenceV1): void {
  if (!Number.isSafeInteger(expected.revision) || expected.revision < 0 || expected.executionEpoch.length === 0 ||
      expected.revision !== actual.revision || expected.executionEpoch !== actual.executionEpoch) {
    throw new Error("cohort primary completion authority changed before its atomic transaction");
  }
}

export interface DirectImplementationCompletionOperation {
  readonly kind: "implementation-completion";
  readonly taskId: string;
  readonly reviewInit: CreateItemInit;
  readonly taskPatch: UpdateItemPatch;
  readonly defectPatch: UpdateItemPatch;
}

export type DirectOwnedOperation =
  | { readonly kind: "implementation-adoption"; readonly taskId: string; readonly ownerGoalId: string; readonly approvalQuestionId: string; readonly taskPatch: UpdateItemPatch }
  | { readonly kind: "materialize-operator"; readonly input: MaterializeOperatorActionInput }
  | { readonly kind: "supersede-operator"; readonly input: SupersedeOperatorActionInput }
  | DirectImplementationCompletionOperation
  | { readonly kind: "materialize-cohort-operator"; readonly batch: CohortCompletionBatchV1 }
  | { readonly kind: "cohort-completion";
      readonly members: readonly (DirectImplementationCompletionOperation & { readonly ownerGoalId: string })[];
      readonly sweep: CohortCompletionSweepV1;
      readonly operatorSettlement: CohortOperatorSettlementV1 | null;
      readonly fence: CohortCompletionPrimaryFenceV1 | null };

export function directCompletionTaskIds(operation: DirectOwnedOperation | null): ReadonlySet<string> {
  if (operation === null) return new Set();
  if (operation.kind === "implementation-completion") return new Set([operation.taskId]);
  if (operation.kind !== "cohort-completion") return new Set();
  const ids = new Set(operation.members.map(({ taskId }) => taskId));
  if (ids.size === 0 || ids.size !== operation.members.length || [...ids].some((id) => !/^T[0-9]+$/u.test(id))) {
    throw new Error("cohort completion requires a nonempty distinct task member set");
  }
  return ids;
}

export interface DirectOwnedMutation { readonly direct: DirectOwnedOperation }
export type OwnedMutationContext = AdmittedOwnedMutation | DirectOwnedMutation | null;

export interface DirectOwnedWriteTx extends WorksetOwnedWriteTx {
  findCohortOperatorAction(batchDigest: string): { readonly action: Item; readonly handoff: Item } | undefined;
  fetchImplementationCompletionItem(ledgerId: string, itemId: string): Item;
  completionArchive: Pick<WorksetGenericMutationTx, "archiveTerminalItems" | "collectArchiveTerminalItemRefs" | "archiveMilestone" | "updateMilestone" | "collectArchiveSweepRefs">;
  fetchImplementationCompletionBinding(taskId: string): string | undefined;
  bindImplementationCompletionReview(taskId: string, reviewRef: string): void;
  implementationCompletionDefectFixes(taskId: string): readonly {
    readonly defect: Item;
    readonly fixTasks: readonly Item[];
  }[];
}
