import type { MaterializeOperatorActionInput, SupersedeOperatorActionInput } from "../operatorActions.js";
import type { AdmittedOwnedMutation } from "../worksetOwnedLifecycle.js";
import type { CreateItemInit, UpdateItemPatch } from "./LedgerStore.js";

export type DirectOwnedOperation =
  | { readonly kind: "materialize-operator"; readonly input: MaterializeOperatorActionInput }
  | { readonly kind: "supersede-operator"; readonly input: SupersedeOperatorActionInput }
  | { readonly kind: "implementation-completion"; readonly taskId: string; readonly reviewId: string;
      readonly reviewInit: CreateItemInit; readonly taskPatch: UpdateItemPatch; readonly defectPatch: UpdateItemPatch };

export interface DirectOwnedMutation { readonly direct: DirectOwnedOperation }
export type OwnedMutationContext = AdmittedOwnedMutation | DirectOwnedMutation | null;
