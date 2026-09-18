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
  AcquireImplementationCandidateOutcome,
  ParentGateCapability,
  PrepareDispatchOutcome,
  ResultCapability,
  StoreDispatchResultOutcome,
} from "@cq/config";
import type { GitChangeBrokerReceipt, GitChangeManifestEntry } from "../gitChangeBroker.js";
import type { DispatchLineageFenceAuthority } from "../dispatchLineageCutoverFence.js";
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
  /** Opaque single-use authority to continue one consumed managed worker generation. */
  readonly continuation?: string;
  /** Opaque protected admission for the fresh historical evidence worker. */
  readonly implementationEvidenceBootstrap?: string;
  /** Trusted journal-recovery saga authority; legacy recovery paths must omit it. */
  readonly recoveryPreparation?: DispatchLineageFenceAuthority;
}

interface DispatchRecoveryResolutionBase {
  readonly status: "dispatch-recovery-resolved";
  readonly taskId: string;
  readonly liveTip: string;
}

export type DispatchRecoveryResolution = DispatchRecoveryResolutionBase &
  (
    | {
        readonly preparation: {
          readonly kind: "current";
          readonly recoveryPreparation: DispatchLineageFenceAuthority;
        };
      }
    | {
        readonly terminalAt: string;
        readonly preparation: {
          readonly kind: "legacy";
          readonly recovery: string;
        };
      }
  );

export interface DispatchContinuationResolution {
  readonly status: "dispatch-continuation-resolved";
  readonly continuationReference: string;
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

export interface QualifyImplementationCandidateInput extends DispatchHandle {
  readonly roleId: string;
  readonly correlationId: string;
  readonly childThreadId: string;
  readonly expectedRunId: string;
  readonly outcome: "completed" | "transport-failed";
  readonly exitStatus: number;
  readonly observedAt: string;
  readonly promptDigest: string;
}

export interface CoordinateImplementationCandidatePartitionInput {
  readonly partitionKey: string;
  readonly holderId: string;
}

export interface CoordinateImplementationCandidateHandleInput extends DispatchHandle {
  readonly holderId: string;
  readonly parentGateCapability: ParentGateCapability;
}

export type CoordinateImplementationCandidateInput =
  | CoordinateImplementationCandidatePartitionInput
  | CoordinateImplementationCandidateHandleInput;

export type CoordinateImplementationCandidateOutcome =
  | AcquireImplementationCandidateOutcome
  | {
      readonly state: "completed";
      readonly handle: DispatchHandle;
    }
  | {
      readonly state: "successor-queued";
      readonly source: DispatchHandle;
      readonly successor: DispatchHandle;
    };

export type QualifyImplementationCandidateOutcome =
  | {
      readonly state: "queued";
      readonly attestationId: string;
      readonly generation: number;
      readonly partitionKey: string;
      readonly outputDigest: string;
      readonly qualificationDigest: string;
    }
  | {
      readonly state: "aborted";
      readonly result: AbortedDispatchResult;
    };

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

export type DispatchEvidenceObservation =
  | {
      readonly state: "consumed";
      readonly roleId: string;
      readonly input: DispatchJSONValue;
      readonly output: DispatchJSONValue;
      readonly retainedAttestation: string;
    }
  | {
      readonly state: "aborted" | "missing" | "nonterminal";
      readonly roleId?: string;
      readonly input?: DispatchJSONValue;
      readonly retainedAttestation?: string;
    };

export interface DispatchCapability {
  prepare(input: PrepareDispatchToolInput): Promise<PrepareDispatchOutcome>;
  fetchInput(input: FetchDispatchInputToolInput): Promise<MaterializedDispatchInput>;
  storeResult(input: StoreResultToolInput): Promise<StoreDispatchResultOutcome>;
  qualifyImplementationCandidate?(
    input: QualifyImplementationCandidateInput,
  ): Promise<QualifyImplementationCandidateOutcome>;
  coordinateImplementationCandidate?(
    input: CoordinateImplementationCandidateInput,
  ): Promise<CoordinateImplementationCandidateOutcome>;
  finalizeParentGate?(input: FinalizeParentGateInput): Promise<StoreDispatchResultOutcome>;
  confirmCompletion(
    input: ConfirmDispatchCompletionToolInput,
  ): Promise<ConfirmDispatchCompletionOutcome>;
  abort(input: AbortDispatchToolInput): Promise<AbortedDispatchResult>;
  fetch(input: FetchDispatchResultToolInput): Promise<FetchDispatchResult>;
  /** Trusted non-materializing observation used only by protected completion evidence. */
  observeEvidence?(input: DispatchHandle): Promise<DispatchEvidenceObservation>;
  gitCommit?(input: GitCommitToolInput): Promise<GitChangeBrokerReceipt>;
  gitResolveContinue?(input: GitResolveContinueToolInput): Promise<GitConflictContinuationReceipt>;
  observeWorktreeActivity?(worktreePath: string): Promise<DispatchWorktreeActivityObservation>;
  resolveRecovery?(
    gitEffectBinding: DispatchGitEffectBinding,
    liveTip: string,
  ): Promise<DispatchRecoveryResolution>;
  resolveContinuation?(
    gitEffectBinding: DispatchGitEffectBinding,
    liveTip: string,
  ): Promise<DispatchContinuationResolution>;
}

export class DispatchNotImplementedError extends Error {
  constructor() {
    super(
      "dispatch lifecycle tools are not implemented for this server: no durable attestation capability is available",
    );
    this.name = "DispatchNotImplementedError";
  }
}
