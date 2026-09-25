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
import type { CohortEffectEnvelopeV1 } from "@cq/process-control";
import type { DispatchLineageFenceAuthority } from "../dispatchLineageCutoverFence.js";
import type {
  GitConflictContinuationReceipt,
  GitConflictResolution,
  GitRebaseConflictState,
} from "../gitConflictContinuation.js";
import type {
  ImplementationCandidateAuthorityReceipt,
  ImplementationCandidateCompletionReservationBinding,
} from "../implementationEvidence.js";

export interface PrepareDispatchToolInput {
  readonly roleId?: string;
  readonly input?: DispatchJSONValue;
  /** G224: the TARGET harness's prompt surface for an inline-input prepare (refs carry their own). */
  readonly surface?: string;
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

interface DispatchStagedRebaseResolutionBase {
  readonly taskId: string;
  readonly liveTip: string;
  readonly source: DispatchHandle;
  readonly sourceReference: string;
  readonly guardedRebase: string;
}

export type DispatchStagedRebaseResolution = DispatchStagedRebaseResolutionBase &
  (
    | { readonly status: "staged-rebase-conflict-pending" }
    | {
        readonly status: "staged-rebase-preparation-ready";
        readonly preparation: {
          readonly kind: "guarded-rebase";
          readonly reprepareOf: DispatchHandle;
          readonly guardedRebase: string;
        };
      }
    | {
        readonly status: "staged-rebase-successor-bound";
        readonly successor: DispatchHandle;
      }
  );

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
  CoordinateImplementationCandidatePartitionInput | CoordinateImplementationCandidateHandleInput;

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
    }
  | Extract<ConfirmDispatchCompletionOutcome, { readonly state: "consumed" }>;

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

export interface AuthenticatedImplementationLineageVerification {
  readonly kind: "cq-authenticated-implementation-lineage-verification";
  readonly version: 1;
  readonly taskId: string;
  readonly resultCommit: string;
  readonly receiptAttestationId: string;
  readonly latestReceiptGeneration: number;
  readonly receiptCount: number;
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

export type StartDispatchToolInput = Omit<PrepareDispatchToolInput, "expectedChild" | "surface"> & {
  readonly model?: string;
};

export interface DispatchWaitToolInput extends DispatchHandle {
  readonly waitMs: number;
}

/**
 * G224: CQ-driven dispatch; the server prepares, launches and settles. The
 * parent reads the outcome with `fetch_dispatch_result`, the one body surface.
 */
export interface DispatchDriverCapability {
  start(input: StartDispatchToolInput): Promise<unknown>;
  waitFor(input: DispatchWaitToolInput): Promise<void>;
}

export interface DispatchCapability {
  /** Present when this server can launch dispatches itself (G224). */
  readonly driver?: DispatchDriverCapability;
  /** Trusted local outer-flow operation; not exposed as a child or MCP tool. */
  resumeCohortRebaseSuccessor?(input: {
    readonly source: { readonly attestationId: string; readonly generation: number };
    readonly guardedRebase: string;
    readonly ontoCommit: string;
    readonly priorResultCommit: string;
    readonly holderId: string;
  }): Promise<{
    readonly state: "successor-queued";
    readonly source: { readonly attestationId: string; readonly generation: number };
    readonly successor: { readonly attestationId: string; readonly generation: number };
  }>;
  renewCohortParentExecution?(input: {
    readonly workerDispatch: DispatchHandle;
    readonly cohort: CohortEffectEnvelopeV1;
  }): Promise<ParentGateCapability>;
  /**
   * G224: the one result capability a child-owned server was started with.
   * `store_result` then stores with it, and refuses any other capability.
   */
  readonly boundResultCapability?: StoreResultToolInput["resultCapability"];
  /** G224: the one git-conflict capability a child-owned resolver server was started with. */
  readonly boundGitConflictCapability?: GitResolveContinueToolInput["gitConflictCapability"];
  /** D561: the same env-bound delivery for a cohort worker's Git change capability. */
  readonly boundGitChangeCapability?: GitCommitToolInput["gitChangeCapability"];
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
  /** Server-only reauthentication of one consumed worker's complete durable Git lineage. */
  verifyImplementationLineage?(input: {
    readonly workerDispatch: DispatchHandle;
    readonly resultCommit: string;
  }): Promise<AuthenticatedImplementationLineageVerification>;
  resolveImplementationCandidateAuthority?(input: {
    readonly workerDispatch: DispatchHandle;
    readonly taskRef: string;
    readonly resultCommit: string;
  }): Promise<ImplementationCandidateAuthorityReceipt>;
  reserveImplementationCandidateAuthority?(
    receipt: ImplementationCandidateAuthorityReceipt,
    binding: ImplementationCandidateCompletionReservationBinding,
  ): Promise<void>;
  releaseImplementationCandidateAuthority?(
    receipt: ImplementationCandidateAuthorityReceipt,
    binding: ImplementationCandidateCompletionReservationBinding,
  ): Promise<void>;
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
  resolveStagedRebase?(
    gitEffectBinding: DispatchGitEffectBinding,
    liveTip: string,
    source: DispatchHandle,
    sourceReference: string,
  ): Promise<DispatchStagedRebaseResolution>;
}

export class DispatchNotImplementedError extends Error {
  constructor() {
    super(
      "dispatch lifecycle tools are not implemented for this server: no durable attestation capability is available",
    );
    this.name = "DispatchNotImplementedError";
  }
}
