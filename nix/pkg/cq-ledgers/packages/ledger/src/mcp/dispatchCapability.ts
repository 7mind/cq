import type {
  AbortDispatch,
  AbortedDispatchResult,
  ConfirmDispatchCompletionOutcome,
  DispatchHandle,
  DispatchJSONValue,
  DispatchOverlayApplication,
  FetchDispatchResult,
  InputCapability,
  GitChangeCapability,
  MaterializedDispatchInput,
  NativeChildIdentity,
  NativeCompletionProof,
  PrepareDispatchOutcome,
  ResultCapability,
  StoreDispatchResultOutcome,
} from "@cq/config";
import type {
  GitChangeBrokerReceipt,
  GitChangeManifestEntry,
} from "../gitChangeBroker.js";

export interface PrepareDispatchToolInput {
  readonly roleId?: string;
  readonly input?: DispatchJSONValue;
  readonly refs?: unknown;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly overlays?: readonly DispatchOverlayApplication[];
  readonly expectedChild: NativeChildIdentity;
  readonly reprepareOf?: DispatchHandle;
}

export interface StoreResultToolInput {
  readonly resultCapability: ResultCapability;
  readonly output: DispatchJSONValue;
}

export interface FetchDispatchInputToolInput extends DispatchHandle {
  readonly inputCapability: InputCapability;
}

export interface ConfirmDispatchCompletionToolInput extends DispatchHandle {
  readonly nativeCompletion: NativeCompletionProof;
  readonly expectedProvenance: {
    readonly roleId: string;
    readonly version: number;
    readonly promptDigest: string;
    readonly inputDigest: string;
  };
}

export type AbortDispatchToolInput = AbortDispatch;
export type FetchDispatchResultToolInput = DispatchHandle;

export interface GitCommitToolInput extends DispatchHandle {
  readonly gitChangeCapability: GitChangeCapability;
  readonly operationId: string;
  readonly expectedHead: string;
  readonly message: string;
  readonly changes: readonly GitChangeManifestEntry[];
}

export interface DispatchCapability {
  prepare(input: PrepareDispatchToolInput): Promise<PrepareDispatchOutcome>;
  fetchInput(input: FetchDispatchInputToolInput): Promise<MaterializedDispatchInput>;
  storeResult(input: StoreResultToolInput): Promise<StoreDispatchResultOutcome>;
  confirmCompletion(
    input: ConfirmDispatchCompletionToolInput,
  ): Promise<ConfirmDispatchCompletionOutcome>;
  abort(input: AbortDispatchToolInput): Promise<AbortedDispatchResult>;
  fetch(input: FetchDispatchResultToolInput): Promise<FetchDispatchResult>;
  gitCommit?(input: GitCommitToolInput): Promise<GitChangeBrokerReceipt>;
}

export class DispatchNotImplementedError extends Error {
  constructor() {
    super(
      "dispatch lifecycle tools are not implemented for this server: no durable attestation capability is available",
    );
    this.name = "DispatchNotImplementedError";
  }
}
