import type { MaterializeOperatorActionInput, SupersedeOperatorActionInput } from "../operatorActions.js";
import type { AdmittedOwnedMutation } from "../worksetOwnedLifecycle.js";
import type { WorksetOwnedWriteTx } from "../worksetOwnedLifecycle.js";
import type { CreateItemInit, UpdateItemPatch } from "./LedgerStore.js";

export type DirectOwnedOperation =
  | { readonly kind: "implementation-adoption"; readonly taskId: string; readonly ownerGoalId: string; readonly approvalQuestionId: string; readonly taskPatch: UpdateItemPatch }
  | { readonly kind: "materialize-operator"; readonly input: MaterializeOperatorActionInput }
  | { readonly kind: "supersede-operator"; readonly input: SupersedeOperatorActionInput }
  | { readonly kind: "implementation-completion"; readonly taskId: string;
      readonly reviewInit: CreateItemInit; readonly taskPatch: UpdateItemPatch; readonly defectPatch: UpdateItemPatch };

export interface DirectOwnedMutation { readonly direct: DirectOwnedOperation }
export type OwnedMutationContext = AdmittedOwnedMutation | DirectOwnedMutation | null;

export interface DirectOwnedWriteTx extends WorksetOwnedWriteTx {
  fetchImplementationCompletionBinding(taskId: string): string | undefined;
  bindImplementationCompletionReview(taskId: string, reviewRef: string): void;
}
