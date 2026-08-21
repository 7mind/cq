import type {
  AbortDispatch,
  AbortedDispatchResult,
  ConfirmDispatchCompletionOutcome,
  DispatchHandle,
  DispatchGitEffectBinding,
  DispatchJSONValue,
  DispatchOverlayApplication,
  FetchDispatchResult,
  InputCapability,
  GitChangeCapability,
  GitConflictCapability,
  MaterializedDispatchInput,
  NativeChildIdentity,
  NativeCompletionProof,
  ParentGateCapability,
  PrepareDispatchOutcome,
  ResultCapability,
  StoreDispatchResultOutcome,
} from "@cq/config";
import type {
  GitChangeBrokerReceipt,
  GitChangeManifestEntry,
} from "../gitChangeBroker.js";
import type {
  GitConflictContinuationReceipt,
  GitConflictResolution,
  GitRebaseConflictState,
} from "../gitConflictContinuation.js";

export interface PrepareDispatchToolInput {
  readonly roleId?: string;
  readonly input?: DispatchJSONValue;
  readonly refs?: unknown;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly overlays?: readonly DispatchOverlayApplication[];
  readonly expectedChild: NativeChildIdentity;
  readonly reprepareOf?: DispatchHandle;
  /** Opaque manager-minted guarded-rebase reference (D334); requires reprepareOf. */
  readonly guardedRebase?: string;
  /** Opaque manager-bound parent-lost recovery reference; mutually exclusive with reprepareOf. */
  readonly recovery?: string;
}

export interface DispatchRecoveryResolution {
  readonly status: "dispatch-recovery-resolved";
  readonly recoveryReference: string;
  readonly taskId: string;
  readonly liveTip: string;
  readonly terminalAt: string;
}

export interface StoreResultToolInput {
  readonly resultCapability: ResultCapability;
  readonly output: DispatchJSONValue;
}

export interface FinalizeParentGateInput extends DispatchHandle {
  readonly parentGateCapability: ParentGateCapability;
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

export interface GitResolveContinueToolInput extends DispatchHandle {
  readonly gitConflictCapability: GitConflictCapability;
  readonly operationId: string;
  readonly expectedState: GitRebaseConflictState;
  readonly resolutions: readonly GitConflictResolution[];
}

export interface DispatchWorktreeActivityObservation {
  readonly liveDispatches: readonly string[];
  readonly liveLeases: readonly string[];
}

export interface DispatchCapability {
  prepare(input: PrepareDispatchToolInput): Promise<PrepareDispatchOutcome>;
  fetchInput(input: FetchDispatchInputToolInput): Promise<MaterializedDispatchInput>;
  storeResult(input: StoreResultToolInput): Promise<StoreDispatchResultOutcome>;
  finalizeParentGate?(input: FinalizeParentGateInput): Promise<StoreDispatchResultOutcome>;
  confirmCompletion(
    input: ConfirmDispatchCompletionToolInput,
  ): Promise<ConfirmDispatchCompletionOutcome>;
  abort(input: AbortDispatchToolInput): Promise<AbortedDispatchResult>;
  fetch(input: FetchDispatchResultToolInput): Promise<FetchDispatchResult>;
  gitCommit?(input: GitCommitToolInput): Promise<GitChangeBrokerReceipt>;
  gitResolveContinue?(input: GitResolveContinueToolInput): Promise<GitConflictContinuationReceipt>;
  observeWorktreeActivity?(
    worktreePath: string,
  ): Promise<DispatchWorktreeActivityObservation>;
  resolveRecovery?(
    gitEffectBinding: DispatchGitEffectBinding,
    liveTip: string,
  ): Promise<DispatchRecoveryResolution>;
}

export class DispatchNotImplementedError extends Error {
  constructor() {
    super(
      "dispatch lifecycle tools are not implemented for this server: no durable attestation capability is available",
    );
    this.name = "DispatchNotImplementedError";
  }
}
