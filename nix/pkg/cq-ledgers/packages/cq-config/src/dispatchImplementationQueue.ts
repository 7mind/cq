import {
  AttestationBindingError,
  AttestationContractError,
  AttestationNamespaceError,
  AttestationNotFoundError,
  DispatchAuthorizationError,
  DispatchAttestationExtensionError,
  DispatchStateConflictError,
  assertDispatchHandle,
  attestationInstantMs,
  attestationNamespacesEqual,
  dispatchPayloadDigest,
  formatAttestationNamespace,
  isAttestationTombstone,
  type AttestationEnvelope,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationStore,
  type DispatchGitChangeReceipt,
  type DispatchGitEffectBinding,
  type DispatchProvenanceBinding,
  type DispatchServiceDeps,
  type NativeChildIdentity,
} from "./dispatchAttestation.js";
import type { AttestationBackend } from "./dispatchAttestationBackend.js";
import type {
  AbortedDispatchResult,
  DispatchAbortReason,
  DispatchTerminalAbortReason,
  DispatchHandle,
  DispatchJSONValue,
  NativeCompletionProof,
} from "./compactDispatchProtocol.js";
import { IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND } from "./schemas/implement-worker.js";
import { CODEX_STAGED_TIMING_BASIS } from "./codexStagedTiming.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const FULL_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PROTECTED_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const TRUSTED_QUEUE_ACTORS: ReadonlySet<string> = new Set(["trusted-parent", "trusted-extension"]);

export type ImplementationCandidateQueueState =
  | "enqueued"
  | "qualified"
  | "leased"
  | "parked"
  | "yielded"
  | "released"
  | "terminal"
  | "staged-rebase-retired";

export type ImplementationCandidateDirectTerminalReason =
  | "cancelled"
  | "native-failure"
  | "foreign-completion"
  | "mismatched-completion"
  | "completion-unobserved"
  | "superseded";

export type ImplementationCandidateTerminalReason =
  | DispatchAbortReason
  | ImplementationCandidateDirectTerminalReason
  | "gate-complete"
  | "staged-rebase";

const DIRECT_TERMINAL_ABORT_REASON: Readonly<
  Record<ImplementationCandidateDirectTerminalReason, DispatchAbortReason>
> = Object.freeze({
  cancelled: "cancelled",
  "native-failure": "native-failure",
  "foreign-completion": "protocol-violation",
  "mismatched-completion": "protocol-violation",
  "completion-unobserved": "native-failure",
  superseded: "cancelled",
});

function assertDirectTerminalReason(
  reason: unknown,
): asserts reason is ImplementationCandidateDirectTerminalReason {
  if (typeof reason !== "string" || !Object.hasOwn(DIRECT_TERMINAL_ABORT_REASON, reason)) {
    throw new AttestationContractError(
      "reason",
      `unknown implementation candidate terminal reason "${String(reason)}"`,
    );
  }
}

export interface ImplementationQueuePartition {
  readonly kind: "cq-implementation-queue-partition";
  readonly version: 1;
  readonly partitionKey: string;
  readonly projectKey: string;
  readonly repositoryId: string;
  readonly integrationRef: string;
}

export interface ImplementationQueueAuthority {
  readonly taskId: string;
  readonly goalRef: string;
  readonly finalizedManifestDigest: string;
}

export interface ImplementationQueueEnrollment extends ImplementationQueueAuthority {
  readonly kind: "cq-implementation-queue-enrollment";
  readonly version: 1;
  readonly enrollmentId: string;
  readonly partitionKey: string;
  readonly admissionOrdinal: number;
}

export interface ImplementationQueueAttempt {
  readonly kind: "cq-implementation-queue-attempt";
  readonly version: 1;
  readonly attemptId: string;
  readonly observedBaseCommit: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly gateCommand: typeof IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND;
  readonly packagedEnvironmentDigest: string;
  readonly taskId: string;
  readonly goalRef: string;
  readonly finalizedManifestDigest: string;
  readonly managedWorktreeBindingDigest: string;
  readonly gitReceiptLineageDigest: string;
  readonly gitReceipts: readonly DispatchGitChangeReceipt[];
  readonly worktreePath: string;
  readonly repositoryId: string;
}

export interface ImplementationStagedCompletionQualification {
  readonly kind: "cq-staged-completion-qualification";
  readonly version: 1;
  readonly qualificationDigest: string;
  readonly qualifiedAt: string;
  readonly partitionKey: string;
  readonly enrollmentId: string;
  readonly attemptId: string;
  readonly outputDigest: string;
  readonly expectedChild: NativeChildIdentity;
  readonly expectedProvenance: DispatchProvenanceBinding;
  readonly nativeCompletion: NativeCompletionProof;
}

export interface ImplementationQueueLease {
  readonly holderId: string;
  readonly generation: number;
  readonly acquiredAt: string;
}

export interface ImplementationCompletionLeaseReservation {
  readonly kind: "cq-implementation-completion-lease-reservation";
  readonly version: 1;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly taskRef: string;
  readonly completionRef: string;
  readonly mergeOperationId: string;
  readonly resultCommit: string;
  readonly qualificationDigest: string;
  readonly reservedAt: string;
}

export interface DispatchStagedRebaseSourceBinding {
  readonly kind: "cq-staged-rebase-source-binding";
  readonly version: 1;
  readonly sourceReference: string;
  readonly source: DispatchHandle;
  readonly partitionKey: string;
  readonly enrollmentId: string;
  readonly attemptId: string;
  readonly leaseGeneration: number;
  readonly stagedOutputDigest: string;
  readonly sourceResultCommit: string;
  readonly sourceResultTree: string;
  readonly gitReceiptLineageDigest: string;
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly ontoCommit: string;
  readonly guardedRebase: string;
  readonly guardedRebaseJournalDigest: string;
  readonly retiredAt: string;
  readonly serverBindingDigest: string;
  readonly successor?: DispatchHandle;
}

export interface DispatchStagedRebaseDisposition {
  readonly kind: "cq-staged-rebase-disposition";
  readonly version: 1;
  readonly state: "conflict-pending";
  readonly dispositionAt: string;
  readonly detailsDigest: string;
}

export interface ImplementationQueueTerminal {
  readonly reason: ImplementationCandidateTerminalReason;
  readonly terminalAt: string;
  readonly detailsDigest: string;
}

export type ImplementationQueueRolloutDisposition =
  | "adopted-unqualified"
  | "adopted-qualified"
  | "adopted-completed-green"
  | "parked-incompatible"
  | "execution-uncertain";

/** Durable decision made while upgrading a pre-queue live attestation. */
export interface ImplementationQueueRollout {
  readonly kind: "cq-implementation-queue-rollout";
  readonly version: 1;
  readonly contract: "g213-t4";
  readonly disposition: ImplementationQueueRolloutDisposition;
  readonly decidedAt: string;
  readonly detailDigest: string;
  readonly worktreeProtected: boolean;
}

export interface ImplementationQueueControl {
  readonly kind: "cq-implementation-queue-control";
  readonly version: 1;
  readonly partition: ImplementationQueuePartition;
  readonly enrollment: ImplementationQueueEnrollment;
  readonly attempt: ImplementationQueueAttempt;
  readonly state: ImplementationCandidateQueueState;
  readonly partitionRevision: number;
  readonly leaseGeneration: number;
  readonly qualificationDeadline: string;
  readonly qualification?: ImplementationStagedCompletionQualification;
  readonly lease?: ImplementationQueueLease;
  readonly completionReservation?: ImplementationCompletionLeaseReservation;
  readonly terminal?: ImplementationQueueTerminal;
  readonly stagedRebaseSource?: DispatchStagedRebaseSourceBinding;
  readonly stagedRebaseDisposition?: DispatchStagedRebaseDisposition;
}

export interface ImplementationQueueTombstoneBinding {
  readonly kind: "cq-implementation-queue-tombstone-binding";
  readonly version: 1;
  readonly partitionKey: string;
  readonly enrollmentId: string;
  readonly admissionOrdinal: number;
  readonly attemptId: string;
  readonly state: Extract<
    ImplementationCandidateQueueState,
    "released" | "terminal" | "staged-rebase-retired"
  >;
  readonly partitionRevision: number;
  readonly leaseGeneration: number;
  readonly qualificationDigest?: string;
  readonly terminal?: ImplementationQueueTerminal;
  readonly stagedRebaseSource?: DispatchStagedRebaseSourceBinding;
  readonly stagedRebaseDisposition?: DispatchStagedRebaseDisposition;
}

export class ImplementationQueueConflictError extends DispatchAttestationExtensionError {
  readonly reason:
    | "binding-mismatch"
    | "not-front"
    | "not-qualified"
    | "stale-lease"
    | "already-terminal"
    | "enrollment-active"
    | "completion-reserved"
    | "partition-revision";

  constructor(reason: ImplementationQueueConflictError["reason"], detail: string) {
    super(detail);
    this.name = "ImplementationQueueConflictError";
    this.reason = reason;
  }
}

export class DispatchStagedRebaseSourceError extends DispatchAttestationExtensionError {
  readonly reason:
    | "binding-mismatch"
    | "not-qualified-front"
    | "stale-lease"
    | "not-clean"
    | "already-claimed"
    | "ineligible-source";

  constructor(reason: DispatchStagedRebaseSourceError["reason"], detail: string) {
    super(detail);
    this.name = "DispatchStagedRebaseSourceError";
    this.reason = reason;
  }
}

type PersistedQueueBinding = ImplementationQueueControl | ImplementationQueueTombstoneBinding;

function persistedPartitionKey(binding: PersistedQueueBinding): string {
  return "partition" in binding ? binding.partition.partitionKey : binding.partitionKey;
}

function persistedEnrollmentId(binding: PersistedQueueBinding): string {
  return "enrollment" in binding ? binding.enrollment.enrollmentId : binding.enrollmentId;
}

function persistedAdmissionOrdinal(binding: PersistedQueueBinding): number {
  return "enrollment" in binding ? binding.enrollment.admissionOrdinal : binding.admissionOrdinal;
}

export interface EnqueueImplementationCandidateRequest extends DispatchHandle {
  readonly namespace: AttestationNamespace;
  readonly actor: "trusted-parent" | "trusted-extension";
  readonly repositoryId: string;
  readonly integrationRef: string;
  readonly authority: ImplementationQueueAuthority;
  readonly observedBaseCommit: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly gateCommand: typeof IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND;
  readonly packagedEnvironmentDigest: string;
  readonly gitReceipts: readonly DispatchGitChangeReceipt[];
  readonly gitEffectBinding: DispatchGitEffectBinding;
  readonly stagedOutputDigest: string;
  /** Migration-only durable decision, persisted atomically with queue enrollment. */
  readonly rollout?: ImplementationQueueRollout;
  /** Required when this attempt succeeds one staged-rebase-retired enrollment. */
  readonly stagedRebaseSource?: {
    readonly sourceReference: string;
    readonly source: DispatchHandle;
    readonly leaseGeneration: number;
    readonly guardedRebase: string;
    readonly ontoCommit: string;
    readonly guardedRebaseJournalDigest: string;
  };
}

export interface QualifyDispatchStagedCompletionRequest extends DispatchHandle {
  readonly namespace: AttestationNamespace;
  readonly actor: "trusted-parent" | "trusted-extension";
  readonly partitionKey: string;
  readonly enrollmentId: string;
  readonly attemptId: string;
  readonly stagedOutputDigest: string;
  readonly expectedChild: NativeChildIdentity;
  readonly expectedProvenance: DispatchProvenanceBinding;
  readonly nativeCompletion: NativeCompletionProof;
  /** Migration-only promotion after an exact recovered completion binding. */
  readonly rollout?: ImplementationQueueRollout;
  /** Digest of additional trusted transport evidence not represented by NativeCompletionProof. */
  readonly completionObservationDigest?: string;
}

export interface ImplementationQueueLeaseBinding extends DispatchHandle {
  readonly partitionKey: string;
  readonly enrollmentId: string;
  readonly attemptId: string;
  readonly holderId: string;
  readonly leaseGeneration: number;
}

export interface AcquireImplementationCandidateRequest {
  readonly namespace: AttestationNamespace;
  readonly actor: "trusted-parent" | "trusted-extension";
  readonly partitionKey: string;
  readonly holderId: string;
  readonly expectedCandidate?: DispatchHandle;
  readonly expectedPartitionRevision?: number;
}

export type AcquireImplementationCandidateOutcome =
  | { readonly state: "empty"; readonly partitionKey: string; readonly partitionRevision: number }
  | {
      readonly state: "blocked";
      readonly partitionKey: string;
      readonly partitionRevision: number;
      readonly front: DispatchHandle;
      readonly frontState: ImplementationCandidateQueueState;
    }
  | {
      readonly state: "leased";
      readonly lease: ImplementationQueueLeaseBinding;
      readonly partitionRevision: number;
      readonly replayed: boolean;
    };

export interface ImplementationQueueLeaseTransitionRequest extends ImplementationQueueLeaseBinding {
  readonly namespace: AttestationNamespace;
  readonly actor: "trusted-parent" | "trusted-extension";
  readonly expectedPartitionRevision: number;
  readonly detail?: DispatchJSONValue;
}

export interface ReserveImplementationCompletionLeaseRequest
  extends ImplementationQueueLeaseTransitionRequest {
  readonly operationId: string;
  readonly taskRef: string;
  readonly completionRef: string;
  readonly mergeOperationId: string;
  readonly resultCommit: string;
  readonly qualificationDigest: string;
}

export interface ReleaseImplementationCompletionLeaseRequest
  extends ImplementationQueueLeaseTransitionRequest {
  readonly operationId: string;
  readonly taskRef: string;
  readonly completionRef: string;
  readonly mergeOperationId: string;
  readonly resultCommit: string;
}

export interface RecoverImplementationCandidateRequest extends DispatchHandle {
  readonly namespace: AttestationNamespace;
  readonly actor: "trusted-parent" | "trusted-extension";
  readonly partitionKey: string;
  readonly enrollmentId: string;
  readonly attemptId: string;
  readonly staleLeaseGeneration: number;
  readonly expectedPartitionRevision: number;
}

export interface RetireDispatchStagedRebaseSourceRequest extends ImplementationQueueLeaseTransitionRequest {
  readonly stagedOutputDigest: string;
  readonly effectLock: {
    readonly kind: "managed-worktree-effect-lock";
    readonly bindingDigest: string;
  };
  readonly live: {
    readonly clean: boolean;
    readonly liveTip: string;
    readonly resultCommit: string;
    readonly resultTree: string;
    readonly repositoryId: string;
    readonly worktreePath: string;
    readonly gitReceipts: readonly DispatchGitChangeReceipt[];
  };
  readonly ontoCommit: string;
  readonly guardedRebase: string;
  readonly guardedRebaseJournalDigest: string;
}

export interface ParkDispatchStagedRebaseConflictRequest extends DispatchHandle {
  readonly namespace: AttestationNamespace;
  readonly actor: "trusted-parent" | "trusted-extension";
  readonly partitionKey: string;
  readonly enrollmentId: string;
  readonly attemptId: string;
  readonly leaseGeneration: number;
  readonly sourceReference: string;
  readonly expectedPartitionRevision: number;
  readonly detail?: DispatchJSONValue;
}

function digest(value: unknown): string {
  return dispatchPayloadDigest(value as DispatchJSONValue);
}

const IMPLEMENTATION_COMPLETION_REF = /^cq-implementation-completion:v1:[0-9a-f]{64}$/u;
const IMPLEMENTATION_TASK_REF = /^tasks:T[0-9]+$/u;
const IMPLEMENTATION_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

function assertCompletionLeaseCoordinates(
  request: ReserveImplementationCompletionLeaseRequest | ReleaseImplementationCompletionLeaseRequest,
): void {
  if (
    !IMPLEMENTATION_OPERATION_ID.test(request.operationId) ||
    !IMPLEMENTATION_TASK_REF.test(request.taskRef) ||
    !IMPLEMENTATION_COMPLETION_REF.test(request.completionRef) ||
    !IMPLEMENTATION_OPERATION_ID.test(request.mergeOperationId) ||
    !FULL_GIT_SHA.test(request.resultCommit)
  ) {
    throw new AttestationContractError(
      "implementationCompletionReservation",
      "expected exact task, completion, merge-operation, operation, and result coordinates",
    );
  }
}

function completionLeaseRequestDigest(
  request: ReserveImplementationCompletionLeaseRequest | ReleaseImplementationCompletionLeaseRequest,
): string {
  return digest({
    attestationId: request.attestationId,
    generation: request.generation,
    partitionKey: request.partitionKey,
    enrollmentId: request.enrollmentId,
    attemptId: request.attemptId,
    holderId: request.holderId,
    leaseGeneration: request.leaseGeneration,
    operationId: request.operationId,
    taskRef: request.taskRef,
    completionRef: request.completionRef,
    mergeOperationId: request.mergeOperationId,
    resultCommit: request.resultCommit,
    ...(Object.hasOwn(request, "qualificationDigest")
      ? {
          qualificationDigest: (request as ReserveImplementationCompletionLeaseRequest)
            .qualificationDigest,
        }
      : {}),
  });
}

function assertTrustedActor(actor: string): void {
  if (!TRUSTED_QUEUE_ACTORS.has(actor)) {
    throw new DispatchAuthorizationError(
      "confirm_dispatch_completion",
      `untrusted implementation queue actor "${String(actor)}"`,
    );
  }
}

function assertOwnNamespace(namespace: AttestationNamespace, store: AttestationStore): void {
  if (!attestationNamespacesEqual(namespace, store.namespace)) {
    throw new AttestationNamespaceError(
      `implementation queue is scoped to ${formatAttestationNamespace(namespace)} but the store is ` +
        `bound to ${formatAttestationNamespace(store.namespace)}`,
    );
  }
}

function requireEnvelope(handle: DispatchHandle, deps: DispatchServiceDeps): AttestationEnvelope {
  const resolved = assertDispatchHandle(handle);
  const row = deps.store.read(resolved);
  if (row === undefined) throw new AttestationNotFoundError(resolved);
  if (isAttestationTombstone(row)) {
    throw new ImplementationQueueConflictError(
      "already-terminal",
      `attestation "${row.attestationId}" is already a terminal tombstone`,
    );
  }
  return row;
}

function queueRows(store: AttestationStore, partitionKey?: string): AttestationRow[] {
  return store
    .rows()
    .filter(
      (row) =>
        row.implementationQueue !== undefined &&
        (partitionKey === undefined ||
          persistedPartitionKey(row.implementationQueue) === partitionKey),
    );
}

function currentPartitionRevision(store: AttestationStore, partitionKey: string): number {
  return queueRows(store, partitionKey).reduce(
    (maximum, row) => Math.max(maximum, row.implementationQueue!.partitionRevision),
    0,
  );
}

function nextPartitionRevision(store: AttestationStore, partitionKey: string): number {
  return currentPartitionRevision(store, partitionKey) + 1;
}

function active(control: ImplementationQueueControl): boolean {
  return !["released", "terminal", "staged-rebase-retired"].includes(control.state);
}

function isConsumedGuardedContinuationAncestor(
  candidate: AttestationRow,
  successor: AttestationEnvelope,
  successorBinding: DispatchGitEffectBinding,
): boolean {
  const bridge = successorBinding.guardedRebaseBridge;
  const control = candidate.implementationQueue;
  if (
    bridge === undefined ||
    control === undefined ||
    candidate.attestationId !== successor.attestationId ||
    candidate.generation >= successor.generation ||
    (isAttestationTombstone(candidate) ? candidate.terminalKind : candidate.state) !== "consumed" ||
    control.state !== "released" ||
    control.terminal?.reason !== "gate-complete"
  ) {
    return false;
  }
  if (isAttestationTombstone(candidate)) {
    const tombstoneControl = candidate.implementationQueue;
    const retained = candidate.dispatchContinuationBinding;
    return (
      tombstoneControl?.qualificationDigest !== undefined &&
      retained !== undefined &&
      retained.gitEffectBinding.taskId === successorBinding.taskId &&
      retained.gitEffectBinding.repositoryId === successorBinding.repositoryId &&
      retained.gitEffectBinding.worktreePath === successorBinding.worktreePath &&
      (retained.liveTip === bridge.oldResultCommit ||
        (retained.gitEffectBinding.guardedRebaseBridge !== undefined &&
          digest(retained.gitEffectBinding.guardedRebaseBridge) === digest(bridge)))
    );
  }
  const liveControl = candidate.implementationQueue;
  if (liveControl === undefined) return false;
  const priorBinding = candidate.gitEffectBinding;
  return (
    liveControl.qualification !== undefined &&
    liveControl.attempt.taskId === successorBinding.taskId &&
    liveControl.attempt.repositoryId === successorBinding.repositoryId &&
    liveControl.attempt.worktreePath === successorBinding.worktreePath &&
    (liveControl.attempt.resultCommit === bridge.oldResultCommit ||
      (priorBinding?.guardedRebaseBridge !== undefined &&
        digest(priorBinding.guardedRebaseBridge) === digest(bridge)))
  );
}

function isConsumedOrdinaryContinuationAncestor(
  candidate: AttestationRow,
  successor: AttestationEnvelope,
  successorBinding: DispatchGitEffectBinding,
): boolean {
  const control = candidate.implementationQueue;
  const claim = successor.dispatchContinuationClaim;
  const retained = candidate.dispatchContinuationBinding;
  const retainedBinding = retained?.gitEffectBinding;
  const claimsImmediatePredecessor =
    claim !== undefined &&
    claim.source.attestationId === successor.attestationId &&
    claim.source.generation + 1 === successor.generation;
  const candidateIsImmediatePredecessor = candidate.generation + 1 === successor.generation;
  const sameManagerBinding =
    retainedBinding !== undefined &&
    ([
      "taskId",
      "handleToken",
      "handleFingerprint",
      "repositoryRoot",
      "repositoryId",
      "commonDir",
      "worktreePath",
      "branch",
      "ref",
      "baseCommit",
    ] as const).every((field) => retainedBinding[field] === successorBinding[field]);
  const sameLineageBridge =
    retainedBinding?.guardedRebaseBridge === undefined
      ? successorBinding.guardedRebaseBridge === undefined
      : successorBinding.guardedRebaseBridge !== undefined &&
        digest(retainedBinding.guardedRebaseBridge) ===
          digest(successorBinding.guardedRebaseBridge);
  const inheritedReceipts = successorBinding.inheritedGitReceipts ?? [];
  const retainedReceiptPrefixMatches =
    retained !== undefined &&
    retained.gitReceipts.length <= inheritedReceipts.length &&
    digest(retained.gitReceipts) ===
      digest(inheritedReceipts.slice(0, retained.gitReceipts.length));
  if (
    control === undefined ||
    claim === undefined ||
    retained === undefined ||
    candidate.attestationId !== successor.attestationId ||
    candidate.generation >= successor.generation ||
    !claimsImmediatePredecessor ||
    (candidateIsImmediatePredecessor &&
      (claim.source.attestationId !== candidate.attestationId ||
        claim.source.generation !== candidate.generation ||
        claim.continuationReference !== retained.continuationReference)) ||
    (isAttestationTombstone(candidate) ? candidate.terminalKind : candidate.state) !== "consumed" ||
    control.state !== "terminal" ||
    control.terminal?.reason !== "superseded" ||
    !sameManagerBinding ||
    !sameLineageBridge ||
    !retainedReceiptPrefixMatches
  ) {
    return false;
  }
  if (isAttestationTombstone(candidate)) {
    return candidate.implementationQueue?.qualificationDigest !== undefined;
  }
  const liveControl = candidate.implementationQueue;
  if (liveControl === undefined) return false;
  return (
    liveControl.qualification !== undefined &&
    retained.liveTip === liveControl.attempt.resultCommit &&
    digest(retained.gitReceipts) === liveControl.attempt.gitReceiptLineageDigest
  );
}

function runnable(control: ImplementationQueueControl): boolean {
  return active(control) && control.state !== "parked" && control.state !== "yielded";
}

function frontRow(store: AttestationStore, partitionKey: string): AttestationEnvelope | undefined {
  return queueRows(store, partitionKey)
    .filter(
      (row): row is AttestationEnvelope =>
        !isAttestationTombstone(row) && runnable(row.implementationQueue!),
    )
    .sort(
      (left, right) =>
        left.implementationQueue!.enrollment.admissionOrdinal -
          right.implementationQueue!.enrollment.admissionOrdinal ||
        left.generation - right.generation,
    )[0];
}

function livePartitionLease(
  store: AttestationStore,
  partitionKey: string,
): AttestationEnvelope | undefined {
  const leased = queueRows(store, partitionKey).filter(
    (row): row is AttestationEnvelope =>
      !isAttestationTombstone(row) && row.implementationQueue?.state === "leased",
  );
  if (leased.length > 1) {
    throw new AttestationContractError(
      "queue.lease",
      `implementation queue partition "${partitionKey}" has multiple live leases`,
    );
  }
  const row = leased[0];
  if (row !== undefined && row.implementationQueue?.lease === undefined) {
    throw new AttestationContractError(
      "queue.lease",
      "leased implementation candidate is missing its live lease authority",
    );
  }
  return row;
}

function assertQueueIdentity(
  row: AttestationEnvelope,
  request: Pick<ImplementationQueueLeaseBinding, "partitionKey" | "enrollmentId" | "attemptId">,
): ImplementationQueueControl {
  const control = row.implementationQueue;
  if (
    control === undefined ||
    control.partition.partitionKey !== request.partitionKey ||
    control.enrollment.enrollmentId !== request.enrollmentId ||
    control.attempt.attemptId !== request.attemptId
  ) {
    throw new ImplementationQueueConflictError(
      "binding-mismatch",
      "implementation queue partition, enrollment, or immutable attempt does not match",
    );
  }
  return control;
}

function assertExpectedRevision(
  store: AttestationStore,
  partitionKey: string,
  expected: number | undefined,
): void {
  if (expected === undefined) return;
  const current = currentPartitionRevision(store, partitionKey);
  if (current !== expected) {
    throw new ImplementationQueueConflictError(
      "partition-revision",
      `implementation queue partition revision ${String(expected)} is stale; current revision is ${String(current)}`,
    );
  }
}

export function implementationQueuePartition(input: {
  readonly projectKey: string;
  readonly repositoryId: string;
  readonly integrationRef: string;
}): ImplementationQueuePartition {
  if (typeof input.projectKey !== "string" || input.projectKey.trim() === "") {
    throw new AttestationContractError("projectKey", "expected a trusted project identity");
  }
  if (!SHA256.test(input.repositoryId)) {
    throw new AttestationContractError(
      "repositoryId",
      "expected a lowercase SHA-256 repository identity",
    );
  }
  if (!PROTECTED_REF.test(input.integrationRef)) {
    throw new AttestationContractError(
      "integrationRef",
      "expected a full protected refs/heads ref",
    );
  }
  const identity = {
    projectKey: input.projectKey,
    repositoryId: input.repositoryId,
    integrationRef: input.integrationRef,
  };
  return Object.freeze({
    kind: "cq-implementation-queue-partition" as const,
    version: 1 as const,
    partitionKey: `cq-implementation-queue:v1:${digest(identity)}`,
    ...identity,
  });
}

function assertAuthority(authority: ImplementationQueueAuthority): ImplementationQueueAuthority {
  if (!/^T[0-9]+$/u.test(authority.taskId)) {
    throw new AttestationContractError("authority.taskId", "expected a task id");
  }
  if (!/^goals:[A-Za-z0-9._-]+$/u.test(authority.goalRef)) {
    throw new AttestationContractError("authority.goalRef", "expected a canonical goal ref");
  }
  if (!SHA256.test(authority.finalizedManifestDigest)) {
    throw new AttestationContractError(
      "authority.finalizedManifestDigest",
      "expected a lowercase SHA-256 finalized-manifest digest",
    );
  }
  return Object.freeze({ ...authority });
}

function enrollmentId(
  partition: ImplementationQueuePartition,
  authority: ImplementationQueueAuthority,
): string {
  return `cq-implementation-enrollment:v1:${digest({
    partitionKey: partition.partitionKey,
    taskId: authority.taskId,
    goalRef: authority.goalRef,
    finalizedManifestDigest: authority.finalizedManifestDigest,
  })}`;
}

function outputRecord(row: AttestationEnvelope): Readonly<Record<string, DispatchJSONValue>> {
  if (
    row.output === undefined ||
    row.output === null ||
    typeof row.output !== "object" ||
    Array.isArray(row.output)
  ) {
    throw new AttestationContractError("row.output", "a queued staged result must be an object");
  }
  return row.output as Readonly<Record<string, DispatchJSONValue>>;
}

export function enqueueImplementationCandidate(
  request: EnqueueImplementationCandidateRequest,
  deps: DispatchServiceDeps,
): ImplementationQueueControl {
  assertOwnNamespace(request.namespace, deps.store);
  assertTrustedActor(request.actor);
  const row = requireEnvelope(request, deps);
  if (
    (row.state !== "gate-pending" || row.gateSubmittedOutputDigest === undefined) &&
    !(row.state === "gate-running" && row.implementationQueue !== undefined)
  ) {
    throw new DispatchStateConflictError(
      "store_result",
      row.state,
      "only a gate-pending staged result can enter the implementation queue",
    );
  }
  if (request.stagedOutputDigest !== row.gateSubmittedOutputDigest) {
    throw new AttestationBindingError(
      "stagedOutputDigest",
      "queue enrollment does not bind the exact staged output bytes",
    );
  }
  if (row.gateSubmittedAt === undefined) {
    throw new AttestationContractError(
      "row.gateSubmittedAt",
      "implementation queue enrollment requires the durable staging instant",
    );
  }
  const binding = row.gitEffectBinding;
  if (binding === undefined || row.promptProvenance.roleId !== "implement-worker") {
    throw new AttestationContractError(
      "row.gitEffectBinding",
      "implementation queue enrollment requires a managed implement-worker",
    );
  }
  if (digest(binding) !== digest(request.gitEffectBinding)) {
    throw new AttestationBindingError(
      "gitEffectBinding",
      "queue enrollment changed the prepared managed-worktree binding",
    );
  }
  const partition = implementationQueuePartition({
    projectKey: request.namespace.projectKey,
    repositoryId: request.repositoryId,
    integrationRef: request.integrationRef,
  });
  if (binding.repositoryId !== partition.repositoryId) {
    throw new AttestationBindingError(
      "repositoryId",
      "queue partition does not match the managed repository",
    );
  }
  const authority = assertAuthority(request.authority);
  if (authority.taskId !== binding.taskId) {
    throw new AttestationBindingError(
      "authority.taskId",
      "queue authority does not match the managed task",
    );
  }
  for (const [field, value, pattern] of [
    ["observedBaseCommit", request.observedBaseCommit, FULL_COMMIT],
    ["resultCommit", request.resultCommit, FULL_COMMIT],
    ["resultTree", request.resultTree, FULL_OBJECT],
    ["packagedEnvironmentDigest", request.packagedEnvironmentDigest, SHA256],
  ] as const) {
    if (!pattern.test(value)) {
      throw new AttestationContractError(field, "expected a full authenticated digest");
    }
  }
  if (request.gateCommand !== IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND) {
    throw new AttestationBindingError(
      "gateCommand",
      "implementation queue requires the canonical gate command",
    );
  }
  const output = outputRecord(row);
  if (output["taskId"] !== authority.taskId || output["resultCommit"] !== request.resultCommit) {
    throw new AttestationBindingError(
      "resultCommit",
      "queue attempt does not match the staged worker result",
    );
  }
  const preparedInput = row.input as Readonly<Record<string, DispatchJSONValue>>;
  if (preparedInput["baseCommit"] !== request.observedBaseCommit) {
    throw new AttestationBindingError(
      "observedBaseCommit",
      "queue attempt does not match the observed dispatch base",
    );
  }
  if (digest(output["gitReceipts"] ?? []) !== digest(request.gitReceipts)) {
    throw new AttestationBindingError(
      "gitReceipts",
      "queue attempt does not match the verified broker receipt lineage",
    );
  }

  const stableEnrollmentId = enrollmentId(partition, authority);
  const priorEnrollment = queueRows(deps.store, partition.partitionKey).filter(
    (candidate) => persistedEnrollmentId(candidate.implementationQueue!) === stableEnrollmentId,
  );
  const activePrior = priorEnrollment.find(
    (candidate) =>
      !isAttestationTombstone(candidate) &&
      candidate.attestationId !== row.attestationId &&
      active(candidate.implementationQueue!),
  );
  if (activePrior !== undefined) {
    throw new ImplementationQueueConflictError(
      "enrollment-active",
      `enrollment is already active on ${activePrior.attestationId}#${String(activePrior.generation)}`,
    );
  }
  const terminalPrior = priorEnrollment.find(
    (candidate) =>
      (candidate.attestationId !== row.attestationId ||
        candidate.generation !== row.generation) &&
      candidate.implementationQueue!.state !== "staged-rebase-retired" &&
      !isConsumedGuardedContinuationAncestor(candidate, row, binding) &&
      !isConsumedOrdinaryContinuationAncestor(candidate, row, binding),
  );
  if (terminalPrior !== undefined) {
    throw new ImplementationQueueConflictError(
      "already-terminal",
      `terminal enrollment authority on ${terminalPrior.attestationId}#${String(terminalPrior.generation)} cannot be resurrected`,
    );
  }
  const retiredSourceRows = priorEnrollment.filter(
    (candidate) => {
      const control = candidate.implementationQueue!;
      const claimed = control.stagedRebaseSource?.successor;
      return (
        control.state === "staged-rebase-retired" &&
        control.stagedRebaseSource !== undefined &&
        (claimed === undefined ||
          (claimed.attestationId === row.attestationId && claimed.generation === row.generation))
      );
    },
  );
  const successorSource = request.stagedRebaseSource;
  if (retiredSourceRows.length > 0 && successorSource === undefined) {
    throw new DispatchStagedRebaseSourceError(
      "ineligible-source",
      "a retired enrollment requires its exact staged-rebase source authority",
    );
  }
  let retiredSourceBinding: DispatchStagedRebaseSourceBinding | undefined;
  if (successorSource !== undefined) {
    const retiredSourceRow = retiredSourceRows.find((candidate) => {
      const source = candidate.implementationQueue?.stagedRebaseSource;
      return (
        source?.sourceReference === successorSource.sourceReference &&
        source.source.attestationId === successorSource.source.attestationId &&
        source.source.generation === successorSource.source.generation
      );
    });
    if (retiredSourceRow === undefined) {
      throw new DispatchStagedRebaseSourceError(
        "ineligible-source",
        "staged-rebase successor requires its exact retired source enrollment",
      );
    }
    retiredSourceBinding = retiredSourceRow.implementationQueue!.stagedRebaseSource!;
    if (
      retiredSourceBinding.sourceReference !== successorSource.sourceReference ||
      retiredSourceBinding.source.attestationId !== successorSource.source.attestationId ||
      retiredSourceBinding.source.generation !== successorSource.source.generation ||
      retiredSourceBinding.leaseGeneration !== successorSource.leaseGeneration ||
      retiredSourceBinding.guardedRebase !== successorSource.guardedRebase ||
      retiredSourceBinding.ontoCommit !== successorSource.ontoCommit ||
      retiredSourceBinding.guardedRebaseJournalDigest !==
        successorSource.guardedRebaseJournalDigest ||
      retiredSourceBinding.sourceResultCommit !==
        request.gitEffectBinding.guardedRebaseBridge?.oldResultCommit ||
      retiredSourceBinding.ontoCommit !==
        request.gitEffectBinding.guardedRebaseBridge?.ontoCommit ||
      retiredSourceBinding.guardedRebase !==
        request.gitEffectBinding.guardedRebaseBridge?.guardedRebase ||
      retiredSourceBinding.successor?.attestationId !== row.attestationId ||
      retiredSourceBinding.successor?.generation !== row.generation ||
      row.attestationId !== retiredSourceBinding.source.attestationId ||
      row.generation !== retiredSourceBinding.source.generation + 1
    ) {
      throw new DispatchStagedRebaseSourceError(
        "binding-mismatch",
        "successor attempt does not match the retired source and finalized guarded-rebase journal",
      );
    }
    const claimed = retiredSourceBinding.successor;
    if (
      claimed !== undefined &&
      (claimed.attestationId !== row.attestationId || claimed.generation !== row.generation)
    ) {
      throw new DispatchStagedRebaseSourceError(
        "already-claimed",
        "staged-rebase source already allocated a different successor generation",
      );
    }
  }
  const admissionOrdinal =
    (priorEnrollment[0]?.implementationQueue === undefined
      ? undefined
      : persistedAdmissionOrdinal(priorEnrollment[0].implementationQueue)) ??
    queueRows(deps.store, partition.partitionKey).reduce(
      (maximum, candidate) =>
        Math.max(maximum, persistedAdmissionOrdinal(candidate.implementationQueue!)),
      0,
    ) + 1;
  const enrollment: ImplementationQueueEnrollment = Object.freeze({
    kind: "cq-implementation-queue-enrollment" as const,
    version: 1 as const,
    enrollmentId: stableEnrollmentId,
    partitionKey: partition.partitionKey,
    admissionOrdinal,
    ...authority,
  });
  const attemptPayload = {
    observedBaseCommit: request.observedBaseCommit,
    resultCommit: request.resultCommit,
    resultTree: request.resultTree,
    gateCommand: request.gateCommand,
    packagedEnvironmentDigest: request.packagedEnvironmentDigest,
    taskId: authority.taskId,
    goalRef: authority.goalRef,
    finalizedManifestDigest: authority.finalizedManifestDigest,
    managedWorktreeBindingDigest: digest(binding),
    gitReceiptLineageDigest: digest(request.gitReceipts),
    gitReceipts: Object.freeze(request.gitReceipts.map((receipt) => Object.freeze({ ...receipt }))),
    worktreePath: binding.worktreePath,
    repositoryId: binding.repositoryId,
  };
  const attempt: ImplementationQueueAttempt = Object.freeze({
    kind: "cq-implementation-queue-attempt" as const,
    version: 1 as const,
    attemptId: `cq-implementation-attempt:v1:${digest(attemptPayload)}`,
    ...attemptPayload,
  });
  const candidate: ImplementationQueueControl = Object.freeze({
    kind: "cq-implementation-queue-control" as const,
    version: 1 as const,
    partition,
    enrollment,
    attempt,
    state: "enqueued" as const,
    partitionRevision: nextPartitionRevision(deps.store, partition.partitionKey),
    leaseGeneration: 0,
    qualificationDeadline: new Date(
      attestationInstantMs(row.gateSubmittedAt, "gateSubmittedAt") +
        CODEX_STAGED_TIMING_BASIS.qualificationWindowMs,
    ).toISOString(),
  });
  const existing = row.implementationQueue;
  if (existing !== undefined) {
    if (
      digest(existing.partition) === digest(candidate.partition) &&
      digest(existing.enrollment) === digest(candidate.enrollment) &&
      digest(existing.attempt) === digest(candidate.attempt)
    ) {
      return existing;
    }
    throw new ImplementationQueueConflictError(
      "binding-mismatch",
      "a different immutable queue attempt is already bound to this dispatch",
    );
  }
  if (row.state !== "gate-pending" || row.gateSubmittedOutputDigest === undefined) {
    throw new DispatchStateConflictError(
      "store_result",
      row.state,
      "only a gate-pending staged result can enter the implementation queue",
    );
  }
  deps.store.replace(
    row,
    Object.freeze({
      ...row,
      implementationQueue: candidate,
      ...(request.rollout === undefined ? {} : { implementationQueueRollout: request.rollout }),
    }),
  );
  return candidate;
}

function normalizedCompletion(proof: NativeCompletionProof): NativeCompletionProof {
  if (proof?.kind !== "native-completion" || !TRUSTED_QUEUE_ACTORS.has(proof.actor)) {
    throw new DispatchAuthorizationError(
      "confirm_dispatch_completion",
      "expected a trusted native-completion proof",
    );
  }
  if (
    typeof proof.childId !== "string" ||
    proof.childId.trim() === "" ||
    typeof proof.runId !== "string" ||
    proof.runId.trim() === ""
  ) {
    throw new AttestationContractError(
      "nativeCompletion",
      "expected a non-empty child and run identity",
    );
  }
  attestationInstantMs(proof.completedAt, "nativeCompletion.completedAt");
  return Object.freeze({ ...proof });
}

function rowProvenance(row: AttestationEnvelope): DispatchProvenanceBinding {
  return Object.freeze({
    roleId: row.promptProvenance.roleId,
    version: row.promptProvenance.version,
    promptDigest: row.promptProvenance.promptDigest,
    inputDigest: row.promptProvenance.inputDigest,
  });
}

function provenanceMatches(
  left: DispatchProvenanceBinding,
  right: DispatchProvenanceBinding,
): boolean {
  return digest(left) === digest(right);
}

function withoutLease(
  control: ImplementationQueueControl,
): Omit<ImplementationQueueControl, "lease"> {
  const { lease: _lease, ...remaining } = control;
  return remaining;
}

function queuedAbort<Reason extends DispatchTerminalAbortReason>(
  row: AttestationEnvelope,
  control: ImplementationQueueControl,
  at: string,
  reason: Reason,
  queueReason: ImplementationCandidateTerminalReason,
  details: DispatchJSONValue,
  deps: DispatchServiceDeps,
  stagedRebaseSource?: DispatchStagedRebaseSourceBinding,
): AbortedDispatchResult<Reason> {
  const detailsDigest = digest(details);
  const terminalDigest = digest({ terminalKind: "aborted", reason, detailsDigest });
  const queue: ImplementationQueueControl = Object.freeze({
    ...withoutLease(control),
    state:
      stagedRebaseSource === undefined ? ("terminal" as const) : ("staged-rebase-retired" as const),
    partitionRevision: nextPartitionRevision(deps.store, control.partition.partitionKey),
    terminal: Object.freeze({ reason: queueReason, terminalAt: at, detailsDigest }),
    ...(stagedRebaseSource === undefined ? {} : { stagedRebaseSource }),
  });
  const next: AttestationEnvelope = Object.freeze({
    kind: "envelope" as const,
    namespace: row.namespace,
    attestationId: row.attestationId,
    generation: row.generation,
    idempotencyKey: row.idempotencyKey,
    state: "aborted" as const,
    promptProvenance: row.promptProvenance,
    prepareRequestDigest: row.prepareRequestDigest,
    input: row.input,
    overlays: row.overlays,
    deadlines: row.deadlines,
    expectedChild: row.expectedChild,
    inputCapabilityHash: row.inputCapabilityHash,
    ...(row.inputMaterializedAt === undefined
      ? {}
      : { inputMaterializedAt: row.inputMaterializedAt }),
    resultCapabilityHash: row.resultCapabilityHash,
    ...(row.gitChangeCapabilityHash === undefined
      ? {}
      : { gitChangeCapabilityHash: row.gitChangeCapabilityHash }),
    ...(row.gitEffectBinding === undefined ? {} : { gitEffectBinding: row.gitEffectBinding }),
    createdAt: row.createdAt,
    ...(row.gateSubmittedAt === undefined ? {} : { gateSubmittedAt: row.gateSubmittedAt }),
    ...(row.gateSubmittedOutputDigest === undefined
      ? {}
      : { gateSubmittedOutputDigest: row.gateSubmittedOutputDigest }),
    ...(row.output === undefined ? {} : { output: row.output }),
    ...(row.outputDigest === undefined ? {} : { outputDigest: row.outputDigest }),
    ...(control.qualification === undefined
      ? {}
      : { stagedCompletionQualification: control.qualification }),
    implementationQueue: queue,
    ...(row.implementationQueueRollout === undefined
      ? {}
      : { implementationQueueRollout: row.implementationQueueRollout }),
    ...(stagedRebaseSource === undefined ? {} : { stagedRebaseSourceBinding: stagedRebaseSource }),
    abortedAt: at,
    abortReason: reason,
    abortDetails: details,
    abortDetailsDigest: detailsDigest,
    terminalAt: at,
    terminalDigest,
  });
  deps.store.replace(row, next);
  return Object.freeze({
    state: "aborted" as const,
    attestationId: row.attestationId,
    generation: row.generation,
    abortedAt: at,
    reason,
    details,
  });
}

export type QualifyDispatchStagedCompletionOutcome =
  | {
      readonly state: "qualified";
      readonly qualification: ImplementationStagedCompletionQualification;
      readonly replayed: boolean;
    }
  | {
      readonly state: "aborted";
      readonly result: AbortedDispatchResult<"protocol-violation" | "native-failure">;
    };

export function qualifyDispatchStagedCompletion(
  request: QualifyDispatchStagedCompletionRequest,
  deps: DispatchServiceDeps,
): QualifyDispatchStagedCompletionOutcome {
  assertOwnNamespace(request.namespace, deps.store);
  assertTrustedActor(request.actor);
  const row = requireEnvelope(request, deps);
  const control = assertQueueIdentity(row, request);
  const qualificationPayload = {
    partitionKey: request.partitionKey,
    enrollmentId: request.enrollmentId,
    attemptId: request.attemptId,
    outputDigest: request.stagedOutputDigest,
    expectedChild: request.expectedChild,
    expectedProvenance: request.expectedProvenance,
    nativeCompletion: request.nativeCompletion,
    completionObservationDigest:
      request.completionObservationDigest ?? digest(request.nativeCompletion),
  };
  const replayDigest = digest(qualificationPayload);
  const existing = control.qualification ?? row.stagedCompletionQualification;
  if (row.state !== "gate-pending" && !(row.state === "gate-running" && existing !== undefined)) {
    throw new DispatchStateConflictError(
      "confirm_dispatch_completion",
      row.state,
      "staged-completion qualification requires a gate-pending dispatch",
    );
  }
  if (existing !== undefined) {
    if (existing.qualificationDigest === replayDigest) {
      return Object.freeze({
        state: "qualified" as const,
        qualification: existing,
        replayed: true,
      });
    }
    throw new ImplementationQueueConflictError(
      "binding-mismatch",
      "an altered staged-completion proof cannot replace the qualified proof",
    );
  }
  const proof = normalizedCompletion(request.nativeCompletion);
  const exactProvenance = rowProvenance(row);
  const completionMatches =
    proof.actor === request.actor &&
    proof.childId === row.expectedChild.childId &&
    proof.runId === row.expectedChild.runId &&
    request.expectedChild.childId === row.expectedChild.childId &&
    request.expectedChild.runId === row.expectedChild.runId;
  const bindingsMatch =
    request.stagedOutputDigest === row.gateSubmittedOutputDigest &&
    provenanceMatches(request.expectedProvenance, exactProvenance);
  const at = deps.now();
  if (
    attestationInstantMs(at, "now") >
    attestationInstantMs(control.qualificationDeadline, "queue.qualificationDeadline")
  ) {
    return Object.freeze({
      state: "aborted" as const,
      result: queuedAbort(
        row,
        control,
        at,
        "native-failure",
        "completion-unobserved",
        { qualificationDeadline: control.qualificationDeadline },
        deps,
      ),
    });
  }
  if (!completionMatches || !bindingsMatch) {
    const queueReason: ImplementationCandidateTerminalReason =
      proof.childId === row.expectedChild.childId ? "mismatched-completion" : "foreign-completion";
    return Object.freeze({
      state: "aborted" as const,
      result: queuedAbort(
        row,
        control,
        at,
        "protocol-violation",
        queueReason,
        {
          observationDigest: digest(proof),
          expectedOutputDigest: row.gateSubmittedOutputDigest ?? null,
        },
        deps,
      ),
    });
  }
  const qualification: ImplementationStagedCompletionQualification = Object.freeze({
    kind: "cq-staged-completion-qualification" as const,
    version: 1 as const,
    qualificationDigest: replayDigest,
    qualifiedAt: at,
    partitionKey: request.partitionKey,
    enrollmentId: request.enrollmentId,
    attemptId: request.attemptId,
    outputDigest: request.stagedOutputDigest,
    expectedChild: request.expectedChild,
    expectedProvenance: request.expectedProvenance,
    nativeCompletion: proof,
  });
  const queue: ImplementationQueueControl = Object.freeze({
    ...control,
    state: "qualified" as const,
    partitionRevision: nextPartitionRevision(deps.store, request.partitionKey),
    qualification,
  });
  deps.store.replace(
    row,
    Object.freeze({
      ...row,
      stagedCompletionQualification: qualification,
      implementationQueue: queue,
      ...(request.rollout === undefined ? {} : { implementationQueueRollout: request.rollout }),
    }),
  );
  return Object.freeze({ state: "qualified" as const, qualification, replayed: false });
}

export function acquireImplementationCandidate(
  request: AcquireImplementationCandidateRequest,
  deps: DispatchServiceDeps,
): AcquireImplementationCandidateOutcome {
  assertOwnNamespace(request.namespace, deps.store);
  assertTrustedActor(request.actor);
  if (typeof request.holderId !== "string" || request.holderId.trim() === "") {
    throw new AttestationContractError("holderId", "expected a non-empty lease holder identity");
  }
  assertExpectedRevision(deps.store, request.partitionKey, request.expectedPartitionRevision);
  let revision = currentPartitionRevision(deps.store, request.partitionKey);
  let front = frontRow(deps.store, request.partitionKey);
  while (front !== undefined) {
    const control = front.implementationQueue;
    if (control === undefined) {
      throw new Error("implementation queue front lost its durable control");
    }
    if (control.state !== "enqueued" || control.qualification !== undefined) break;
    const observedAt = deps.now();
    if (
      attestationInstantMs(observedAt, "now") <=
      attestationInstantMs(control.qualificationDeadline, "queue.qualificationDeadline")
    ) {
      break;
    }
    queuedAbort(
      front,
      control,
      observedAt,
      "native-failure",
      "completion-unobserved",
      { qualificationDeadline: control.qualificationDeadline },
      deps,
    );
    revision = currentPartitionRevision(deps.store, request.partitionKey);
    front = frontRow(deps.store, request.partitionKey);
  }
  if (front === undefined) {
    return Object.freeze({
      state: "empty" as const,
      partitionKey: request.partitionKey,
      partitionRevision: revision,
    });
  }
  if (
    request.expectedCandidate !== undefined &&
    (front.attestationId !== request.expectedCandidate.attestationId ||
      front.generation !== request.expectedCandidate.generation)
  ) {
    return Object.freeze({
      state: "blocked" as const,
      partitionKey: request.partitionKey,
      partitionRevision: revision,
      front: Object.freeze({
        attestationId: front.attestationId,
        generation: front.generation,
      }),
      frontState: front.implementationQueue!.state,
    });
  }
  const leased = livePartitionLease(deps.store, request.partitionKey);
  if (leased !== undefined) {
    const leasedControl = leased.implementationQueue!;
    if (leasedControl.lease?.holderId === request.holderId) {
      return Object.freeze({
        state: "leased" as const,
        lease: leaseBinding(leased, leasedControl),
        partitionRevision: revision,
        replayed: true,
      });
    }
    return Object.freeze({
      state: "blocked" as const,
      partitionKey: request.partitionKey,
      partitionRevision: revision,
      front: Object.freeze({
        attestationId: leased.attestationId,
        generation: leased.generation,
      }),
      frontState: "leased" as const,
    });
  }
  const control = front.implementationQueue!;
  if (
    control.state !== "qualified" ||
    control.qualification === undefined ||
    front.stagedCompletionQualification === undefined
  ) {
    return Object.freeze({
      state: "blocked" as const,
      partitionKey: request.partitionKey,
      partitionRevision: revision,
      front: Object.freeze({
        attestationId: front.attestationId,
        generation: front.generation,
      }),
      frontState: control.state,
    });
  }
  const lease: ImplementationQueueLease = Object.freeze({
    holderId: request.holderId,
    generation: control.leaseGeneration + 1,
    acquiredAt: deps.now(),
  });
  const nextControl: ImplementationQueueControl = Object.freeze({
    ...control,
    state: "leased" as const,
    partitionRevision: nextPartitionRevision(deps.store, request.partitionKey),
    leaseGeneration: lease.generation,
    lease,
  });
  deps.store.replace(front, Object.freeze({ ...front, implementationQueue: nextControl }));
  return Object.freeze({
    state: "leased" as const,
    lease: leaseBinding(front, nextControl),
    partitionRevision: nextControl.partitionRevision,
    replayed: false,
  });
}

function leaseBinding(
  row: AttestationEnvelope,
  control: ImplementationQueueControl,
): ImplementationQueueLeaseBinding {
  if (control.lease === undefined) {
    throw new AttestationContractError("queue.lease", "expected an active lease");
  }
  return Object.freeze({
    attestationId: row.attestationId,
    generation: row.generation,
    partitionKey: control.partition.partitionKey,
    enrollmentId: control.enrollment.enrollmentId,
    attemptId: control.attempt.attemptId,
    holderId: control.lease.holderId,
    leaseGeneration: control.lease.generation,
  });
}

function leasedControl(
  request: ImplementationQueueLeaseTransitionRequest,
  deps: DispatchServiceDeps,
): { readonly row: AttestationEnvelope; readonly control: ImplementationQueueControl } {
  assertOwnNamespace(request.namespace, deps.store);
  assertTrustedActor(request.actor);
  assertExpectedRevision(deps.store, request.partitionKey, request.expectedPartitionRevision);
  const row = requireEnvelope(request, deps);
  const control = assertQueueIdentity(row, request);
  if (
    control.state !== "leased" ||
    control.lease === undefined ||
    control.lease.holderId !== request.holderId ||
    control.lease.generation !== request.leaseGeneration ||
    control.leaseGeneration !== request.leaseGeneration
  ) {
    throw new ImplementationQueueConflictError(
      "stale-lease",
      "queue transition requires the exact live lease generation",
    );
  }
  return { row, control };
}

export function reserveImplementationCompletionLease(
  request: ReserveImplementationCompletionLeaseRequest,
  deps: DispatchServiceDeps,
): ImplementationCompletionLeaseReservation {
  assertCompletionLeaseCoordinates(request);
  if (!SHA256_HEX.test(request.qualificationDigest)) {
    throw new AttestationContractError(
      "implementationCompletionReservation.qualificationDigest",
      "expected a SHA-256 digest",
    );
  }
  const { row, control } = leasedControl(request, deps);
  if (
    control.qualification === undefined ||
    control.qualification.qualificationDigest !== request.qualificationDigest ||
    control.attempt.taskId !== request.taskRef.slice("tasks:".length) ||
    control.attempt.resultCommit !== request.resultCommit
  ) {
    throw new ImplementationQueueConflictError(
      "binding-mismatch",
      "completion reservation does not match the qualified candidate",
    );
  }
  const requestDigest = completionLeaseRequestDigest(request);
  const existing = control.completionReservation;
  if (existing !== undefined) {
    if (existing.operationId === request.operationId && existing.requestDigest === requestDigest) {
      return existing;
    }
    throw new ImplementationQueueConflictError(
      "completion-reserved",
      "implementation candidate lease already has a different completion reservation",
    );
  }
  const reservation: ImplementationCompletionLeaseReservation = Object.freeze({
    kind: "cq-implementation-completion-lease-reservation" as const,
    version: 1 as const,
    operationId: request.operationId,
    requestDigest,
    taskRef: request.taskRef,
    completionRef: request.completionRef,
    mergeOperationId: request.mergeOperationId,
    resultCommit: request.resultCommit,
    qualificationDigest: request.qualificationDigest,
    reservedAt: deps.now(),
  });
  const next: ImplementationQueueControl = Object.freeze({
    ...control,
    partitionRevision: nextPartitionRevision(deps.store, request.partitionKey),
    completionReservation: reservation,
  });
  deps.store.replace(row, Object.freeze({ ...row, implementationQueue: next }));
  return reservation;
}

export function releaseImplementationCompletionLease(
  request: ReleaseImplementationCompletionLeaseRequest,
  deps: DispatchServiceDeps,
): ImplementationQueueControl {
  assertCompletionLeaseCoordinates(request);
  const { row, control } = leasedControl(request, deps);
  const reservation = control.completionReservation;
  if (
    reservation === undefined ||
    reservation.operationId !== request.operationId ||
    reservation.taskRef !== request.taskRef ||
    reservation.completionRef !== request.completionRef ||
    reservation.mergeOperationId !== request.mergeOperationId ||
    reservation.resultCommit !== request.resultCommit
  ) {
    throw new ImplementationQueueConflictError(
      "completion-reserved",
      "completion release does not match the durable lease reservation",
    );
  }
  const { lease: _lease, completionReservation: _reservation, ...retained } = control;
  const terminal = Object.freeze({
    reason: "gate-complete" as const,
    terminalAt: deps.now(),
    detailsDigest: digest(request.detail ?? null),
  });
  const next: ImplementationQueueControl = Object.freeze({
    ...retained,
    state: "released" as const,
    partitionRevision: nextPartitionRevision(deps.store, request.partitionKey),
    terminal,
  });
  deps.store.replace(row, Object.freeze({ ...row, implementationQueue: next }));
  return next;
}

function moveLeased(
  request: ImplementationQueueLeaseTransitionRequest,
  deps: DispatchServiceDeps,
  state: "parked" | "yielded" | "released",
): ImplementationQueueControl {
  const { row, control } = leasedControl(request, deps);
  if (control.completionReservation !== undefined) {
    throw new ImplementationQueueConflictError(
      "completion-reserved",
      "generic queue transition cannot move a completion-reserved lease",
    );
  }
  const terminal =
    state === "released"
      ? Object.freeze({
          reason: "gate-complete" as const,
          terminalAt: deps.now(),
          detailsDigest: digest(request.detail ?? null),
        })
      : undefined;
  const next: ImplementationQueueControl = Object.freeze({
    ...withoutLease(control),
    state,
    partitionRevision: nextPartitionRevision(deps.store, request.partitionKey),
    ...(terminal === undefined ? {} : { terminal }),
  });
  deps.store.replace(row, Object.freeze({ ...row, implementationQueue: next }));
  return next;
}

export function parkImplementationCandidate(
  request: ImplementationQueueLeaseTransitionRequest,
  deps: DispatchServiceDeps,
): ImplementationQueueControl {
  return moveLeased(request, deps, "parked");
}

export function yieldImplementationCandidate(
  request: ImplementationQueueLeaseTransitionRequest,
  deps: DispatchServiceDeps,
): ImplementationQueueControl {
  return moveLeased(request, deps, "yielded");
}

export function releaseImplementationCandidate(
  request: ImplementationQueueLeaseTransitionRequest,
  deps: DispatchServiceDeps,
): ImplementationQueueControl {
  return moveLeased(request, deps, "released");
}

export function resumeImplementationCandidate(
  request: ImplementationQueueLeaseTransitionRequest,
  deps: DispatchServiceDeps,
): ImplementationQueueControl {
  assertOwnNamespace(request.namespace, deps.store);
  assertTrustedActor(request.actor);
  assertExpectedRevision(deps.store, request.partitionKey, request.expectedPartitionRevision);
  const row = requireEnvelope(request, deps);
  const control = assertQueueIdentity(row, request);
  if (
    (control.state !== "parked" && control.state !== "yielded") ||
    control.leaseGeneration !== request.leaseGeneration
  ) {
    throw new ImplementationQueueConflictError(
      "stale-lease",
      "resume requires the latest parked or yielded lease generation",
    );
  }
  if (livePartitionLease(deps.store, request.partitionKey) !== undefined) {
    throw new ImplementationQueueConflictError(
      "not-front",
      "resume cannot preempt another enrollment's live partition lease",
    );
  }
  const next: ImplementationQueueControl = Object.freeze({
    ...withoutLease(control),
    state: "qualified" as const,
    partitionRevision: nextPartitionRevision(deps.store, request.partitionKey),
  });
  deps.store.replace(row, Object.freeze({ ...row, implementationQueue: next }));
  return next;
}

export function recoverImplementationCandidate(
  request: RecoverImplementationCandidateRequest,
  deps: DispatchServiceDeps,
): ImplementationQueueControl {
  assertOwnNamespace(request.namespace, deps.store);
  assertTrustedActor(request.actor);
  assertExpectedRevision(deps.store, request.partitionKey, request.expectedPartitionRevision);
  const row = requireEnvelope(request, deps);
  const control = assertQueueIdentity(row, request);
  if (control.completionReservation !== undefined) {
    throw new ImplementationQueueConflictError(
      "completion-reserved",
      "restart recovery cannot transfer a completion-reserved lease",
    );
  }
  if (control.state !== "leased" || control.leaseGeneration !== request.staleLeaseGeneration) {
    throw new ImplementationQueueConflictError(
      "stale-lease",
      "restart recovery does not match the persisted lease generation",
    );
  }
  const next: ImplementationQueueControl = Object.freeze({
    ...withoutLease(control),
    state: "qualified" as const,
    partitionRevision: nextPartitionRevision(deps.store, request.partitionKey),
    leaseGeneration: control.leaseGeneration + 1,
  });
  deps.store.replace(row, Object.freeze({ ...row, implementationQueue: next }));
  return next;
}

export function terminalizeImplementationCandidate(
  request: Omit<ImplementationQueueLeaseTransitionRequest, "holderId" | "leaseGeneration"> & {
    readonly reason: ImplementationCandidateDirectTerminalReason;
  },
  deps: DispatchServiceDeps,
): AbortedDispatchResult<DispatchAbortReason> {
  assertOwnNamespace(request.namespace, deps.store);
  assertTrustedActor(request.actor);
  const terminalReason: unknown = request.reason;
  assertDirectTerminalReason(terminalReason);
  const row = requireEnvelope(request, deps);
  const control = assertQueueIdentity(row, request);
  if (control.completionReservation !== undefined) {
    throw new ImplementationQueueConflictError(
      "completion-reserved",
      "terminalization cannot retire a completion-reserved lease",
    );
  }
  const reason = DIRECT_TERMINAL_ABORT_REASON[terminalReason];
  const details = request.detail ?? { reason: terminalReason };
  const detailsDigest = digest(details);
  if (!active(control)) {
    if (
      control.state === "terminal" &&
      row.state === "aborted" &&
      row.abortReason === reason &&
      row.abortedAt !== undefined &&
      row.abortDetailsDigest === detailsDigest &&
      control.terminal?.reason === terminalReason &&
      control.terminal.detailsDigest === detailsDigest
    ) {
      return Object.freeze({
        state: "aborted" as const,
        attestationId: row.attestationId,
        generation: row.generation,
        abortedAt: row.abortedAt,
        reason,
        ...(row.abortDetails === undefined ? {} : { details: row.abortDetails }),
      });
    }
    throw new ImplementationQueueConflictError(
      "already-terminal",
      `implementation queue control is already ${control.state}`,
    );
  }
  assertExpectedRevision(deps.store, request.partitionKey, request.expectedPartitionRevision);
  return queuedAbort(
    row,
    control,
    deps.now(),
    reason,
    terminalReason,
    details,
    deps,
  );
}

export function retireDispatchStagedRebaseSource(
  request: RetireDispatchStagedRebaseSourceRequest,
  deps: DispatchServiceDeps,
): DispatchStagedRebaseSourceBinding {
  assertOwnNamespace(request.namespace, deps.store);
  assertTrustedActor(request.actor);
  const replayRow = requireEnvelope(request, deps);
  const replayControl = assertQueueIdentity(replayRow, request);
  const existingSource = replayRow.stagedRebaseSourceBinding ?? replayControl.stagedRebaseSource;
  if (existingSource !== undefined) {
    const exactReplay =
      existingSource.source.attestationId === request.attestationId &&
      existingSource.source.generation === request.generation &&
      existingSource.partitionKey === request.partitionKey &&
      existingSource.enrollmentId === request.enrollmentId &&
      existingSource.attemptId === request.attemptId &&
      existingSource.leaseGeneration === request.leaseGeneration &&
      existingSource.stagedOutputDigest === request.stagedOutputDigest &&
      existingSource.sourceResultCommit === request.live.resultCommit &&
      existingSource.sourceResultTree === request.live.resultTree &&
      existingSource.gitReceiptLineageDigest === digest(request.live.gitReceipts) &&
      existingSource.repositoryId === request.live.repositoryId &&
      existingSource.worktreePath === request.live.worktreePath &&
      existingSource.ontoCommit === request.ontoCommit &&
      existingSource.guardedRebase === request.guardedRebase &&
      existingSource.guardedRebaseJournalDigest === request.guardedRebaseJournalDigest &&
      request.effectLock.bindingDigest === replayControl.attempt.managedWorktreeBindingDigest &&
      request.live.clean &&
      request.live.liveTip === request.live.resultCommit;
    if (exactReplay) return existingSource;
    throw new DispatchStagedRebaseSourceError(
      "binding-mismatch",
      "altered staged-rebase retirement cannot replace the terminal source binding",
    );
  }
  const { row, control } = leasedControl(request, deps);
  if (control.completionReservation !== undefined) {
    throw new ImplementationQueueConflictError(
      "completion-reserved",
      "staged rebase cannot retire a completion-reserved lease",
    );
  }
  const front = frontRow(deps.store, request.partitionKey);
  if (
    row.state !== "gate-pending" ||
    control.qualification === undefined ||
    row.stagedCompletionQualification?.qualificationDigest !==
      control.qualification.qualificationDigest ||
    front?.attestationId !== row.attestationId ||
    front.generation !== row.generation
  ) {
    throw new DispatchStagedRebaseSourceError(
      "not-qualified-front",
      "staged rebase retirement requires the currently leased qualified gate-pending front",
    );
  }
  const attempt = control.attempt;
  if (!request.live.clean) {
    throw new DispatchStagedRebaseSourceError(
      "not-clean",
      "staged rebase retirement requires a clean managed worktree",
    );
  }
  if (
    request.live.liveTip !== attempt.resultCommit ||
    request.live.resultCommit !== attempt.resultCommit ||
    request.live.resultTree !== attempt.resultTree ||
    request.live.repositoryId !== attempt.repositoryId ||
    request.live.worktreePath !== attempt.worktreePath ||
    request.stagedOutputDigest !== row.gateSubmittedOutputDigest ||
    request.effectLock.bindingDigest !== attempt.managedWorktreeBindingDigest ||
    digest(request.live.gitReceipts) !== attempt.gitReceiptLineageDigest
  ) {
    throw new DispatchStagedRebaseSourceError(
      "binding-mismatch",
      "live managed state differs from the immutable staged queue attempt",
    );
  }
  if (!FULL_COMMIT.test(request.ontoCommit) || !SHA256.test(request.guardedRebaseJournalDigest)) {
    throw new AttestationContractError(
      "stagedRebase",
      "expected a full onto commit and journal digest",
    );
  }
  if (!/^cq-guarded-rebase:v1:[0-9a-f]{64}$/u.test(request.guardedRebase)) {
    throw new AttestationContractError(
      "guardedRebase",
      "expected an opaque finalized guarded-rebase journal reference",
    );
  }
  const retiredAt = deps.now();
  const sourcePayload = {
    source: { attestationId: row.attestationId, generation: row.generation },
    partitionKey: request.partitionKey,
    enrollmentId: request.enrollmentId,
    attemptId: request.attemptId,
    leaseGeneration: request.leaseGeneration,
    stagedOutputDigest: request.stagedOutputDigest,
    sourceResultCommit: attempt.resultCommit,
    sourceResultTree: attempt.resultTree,
    gitReceiptLineageDigest: attempt.gitReceiptLineageDigest,
    repositoryId: attempt.repositoryId,
    worktreePath: attempt.worktreePath,
    ontoCommit: request.ontoCommit,
    guardedRebase: request.guardedRebase,
    guardedRebaseJournalDigest: request.guardedRebaseJournalDigest,
    retiredAt,
  };
  const sourceReference = `cq-staged-rebase-source:v1:${digest(sourcePayload)}`;
  const sourceWithoutServerDigest = {
    kind: "cq-staged-rebase-source-binding" as const,
    version: 1 as const,
    sourceReference,
    ...sourcePayload,
  };
  const source: DispatchStagedRebaseSourceBinding = Object.freeze({
    ...sourceWithoutServerDigest,
    serverBindingDigest: digest(sourceWithoutServerDigest),
  });
  queuedAbort(
    row,
    control,
    retiredAt,
    "staged-rebase",
    "staged-rebase",
    {
      sourceReference,
      serverBindingDigest: source.serverBindingDigest,
      ontoCommit: request.ontoCommit,
    },
    deps,
    source,
  );
  return source;
}

export function parkDispatchStagedRebaseConflict(
  request: ParkDispatchStagedRebaseConflictRequest,
  deps: DispatchServiceDeps,
): ImplementationQueueControl {
  assertOwnNamespace(request.namespace, deps.store);
  assertTrustedActor(request.actor);
  const row = requireEnvelope(request, deps);
  const control = assertQueueIdentity(row, request);
  const source = row.stagedRebaseSourceBinding ?? control.stagedRebaseSource;
  if (
    control.state !== "staged-rebase-retired" ||
    source === undefined ||
    source.sourceReference !== request.sourceReference ||
    source.leaseGeneration !== request.leaseGeneration ||
    control.leaseGeneration !== request.leaseGeneration
  ) {
    throw new ImplementationQueueConflictError(
      "stale-lease",
      "conflict disposition requires the exact retired staged-rebase authority",
    );
  }
  const detailsDigest = digest(request.detail ?? { disposition: "conflict" });
  const existing = control.stagedRebaseDisposition;
  if (existing !== undefined) {
    if (existing.state === "conflict-pending" && existing.detailsDigest === detailsDigest) {
      return control;
    }
    throw new ImplementationQueueConflictError(
      "binding-mismatch",
      "an altered conflict disposition cannot replace the retired staged-rebase disposition",
    );
  }
  assertExpectedRevision(deps.store, request.partitionKey, request.expectedPartitionRevision);
  const disposition: DispatchStagedRebaseDisposition = Object.freeze({
    kind: "cq-staged-rebase-disposition" as const,
    version: 1 as const,
    state: "conflict-pending" as const,
    dispositionAt: deps.now(),
    detailsDigest,
  });
  const next: ImplementationQueueControl = Object.freeze({
    ...control,
    partitionRevision: nextPartitionRevision(deps.store, request.partitionKey),
    stagedRebaseDisposition: disposition,
  });
  deps.store.replace(row, Object.freeze({ ...row, implementationQueue: next }));
  return next;
}

export function implementationQueueTombstoneBinding(
  control: ImplementationQueueControl,
): ImplementationQueueTombstoneBinding {
  if (
    control.state !== "released" &&
    control.state !== "terminal" &&
    control.state !== "staged-rebase-retired"
  ) {
    throw new AttestationContractError(
      "implementationQueue.state",
      "only a terminal queue control can collapse",
    );
  }
  return Object.freeze({
    kind: "cq-implementation-queue-tombstone-binding" as const,
    version: 1 as const,
    partitionKey: control.partition.partitionKey,
    enrollmentId: control.enrollment.enrollmentId,
    admissionOrdinal: control.enrollment.admissionOrdinal,
    attemptId: control.attempt.attemptId,
    state: control.state,
    partitionRevision: control.partitionRevision,
    leaseGeneration: control.leaseGeneration,
    ...(control.qualification === undefined
      ? {}
      : { qualificationDigest: control.qualification.qualificationDigest }),
    ...(control.terminal === undefined ? {} : { terminal: control.terminal }),
    ...(control.stagedRebaseSource === undefined
      ? {}
      : { stagedRebaseSource: control.stagedRebaseSource }),
    ...(control.stagedRebaseDisposition === undefined
      ? {}
      : { stagedRebaseDisposition: control.stagedRebaseDisposition }),
  });
}

export function assertQueuedParentGateLease(
  row: AttestationEnvelope,
  lease: ImplementationQueueLeaseBinding | undefined,
): void {
  const control = row.implementationQueue;
  if (control === undefined) return;
  if (control.qualification === undefined || row.stagedCompletionQualification === undefined) {
    throw new ImplementationQueueConflictError(
      "not-qualified",
      "parent gate requires an exactly qualified staged completion",
    );
  }
  if (
    lease === undefined ||
    control.state !== "leased" ||
    control.lease === undefined ||
    lease.attestationId !== row.attestationId ||
    lease.generation !== row.generation ||
    lease.partitionKey !== control.partition.partitionKey ||
    lease.enrollmentId !== control.enrollment.enrollmentId ||
    lease.attemptId !== control.attempt.attemptId ||
    lease.holderId !== control.lease.holderId ||
    lease.leaseGeneration !== control.lease.generation
  ) {
    throw new ImplementationQueueConflictError(
      "stale-lease",
      "parent gate requires the exact current queue lease",
    );
  }
}

export async function enqueueImplementationCandidateOn(
  backend: AttestationBackend,
  request: EnqueueImplementationCandidateRequest,
  deps: { readonly now: () => string },
): Promise<ImplementationQueueControl> {
  return backend.transact({ kind: "namespace" }, (store) =>
    enqueueImplementationCandidate(request, { store, now: deps.now }),
  );
}

export async function qualifyDispatchStagedCompletionOn(
  backend: AttestationBackend,
  request: QualifyDispatchStagedCompletionRequest,
  deps: { readonly now: () => string },
): Promise<QualifyDispatchStagedCompletionOutcome> {
  return backend.transact({ kind: "namespace" }, (store) =>
    qualifyDispatchStagedCompletion(request, { store, now: deps.now }),
  );
}

export async function acquireImplementationCandidateOn(
  backend: AttestationBackend,
  request: AcquireImplementationCandidateRequest,
  deps: { readonly now: () => string },
): Promise<AcquireImplementationCandidateOutcome> {
  return backend.transact({ kind: "namespace" }, (store) =>
    acquireImplementationCandidate(request, { store, now: deps.now }),
  );
}

type LeaseTransition = (
  request: ImplementationQueueLeaseTransitionRequest,
  deps: DispatchServiceDeps,
) => ImplementationQueueControl;

async function leaseTransitionOn(
  backend: AttestationBackend,
  request: ImplementationQueueLeaseTransitionRequest,
  deps: { readonly now: () => string },
  transition: LeaseTransition,
): Promise<ImplementationQueueControl> {
  return backend.transact({ kind: "namespace" }, (store) =>
    transition(request, { store, now: deps.now }),
  );
}

export function parkImplementationCandidateOn(
  backend: AttestationBackend,
  request: ImplementationQueueLeaseTransitionRequest,
  deps: { readonly now: () => string },
): Promise<ImplementationQueueControl> {
  return leaseTransitionOn(backend, request, deps, parkImplementationCandidate);
}

export function yieldImplementationCandidateOn(
  backend: AttestationBackend,
  request: ImplementationQueueLeaseTransitionRequest,
  deps: { readonly now: () => string },
): Promise<ImplementationQueueControl> {
  return leaseTransitionOn(backend, request, deps, yieldImplementationCandidate);
}

export function resumeImplementationCandidateOn(
  backend: AttestationBackend,
  request: ImplementationQueueLeaseTransitionRequest,
  deps: { readonly now: () => string },
): Promise<ImplementationQueueControl> {
  return leaseTransitionOn(backend, request, deps, resumeImplementationCandidate);
}

export function releaseImplementationCandidateOn(
  backend: AttestationBackend,
  request: ImplementationQueueLeaseTransitionRequest,
  deps: { readonly now: () => string },
): Promise<ImplementationQueueControl> {
  return leaseTransitionOn(backend, request, deps, releaseImplementationCandidate);
}

export async function reserveImplementationCompletionLeaseOn(
  backend: AttestationBackend,
  request: ReserveImplementationCompletionLeaseRequest,
  deps: { readonly now: () => string },
): Promise<ImplementationCompletionLeaseReservation> {
  return backend.transact({ kind: "namespace" }, (store) =>
    reserveImplementationCompletionLease(request, { store, now: deps.now }),
  );
}

export async function releaseImplementationCompletionLeaseOn(
  backend: AttestationBackend,
  request: ReleaseImplementationCompletionLeaseRequest,
  deps: { readonly now: () => string },
): Promise<ImplementationQueueControl> {
  return backend.transact({ kind: "namespace" }, (store) =>
    releaseImplementationCompletionLease(request, { store, now: deps.now }),
  );
}

export async function recoverImplementationCandidateOn(
  backend: AttestationBackend,
  request: RecoverImplementationCandidateRequest,
  deps: { readonly now: () => string },
): Promise<ImplementationQueueControl> {
  return backend.transact({ kind: "namespace" }, (store) =>
    recoverImplementationCandidate(request, { store, now: deps.now }),
  );
}

export async function terminalizeImplementationCandidateOn(
  backend: AttestationBackend,
  request: Parameters<typeof terminalizeImplementationCandidate>[0],
  deps: { readonly now: () => string },
): Promise<AbortedDispatchResult<DispatchAbortReason>> {
  return backend.transact({ kind: "namespace" }, (store) =>
    terminalizeImplementationCandidate(request, { store, now: deps.now }),
  );
}

export async function retireDispatchStagedRebaseSourceOn(
  backend: AttestationBackend,
  request: RetireDispatchStagedRebaseSourceRequest,
  deps: { readonly now: () => string },
): Promise<DispatchStagedRebaseSourceBinding> {
  return backend.transact({ kind: "namespace" }, (store) =>
    retireDispatchStagedRebaseSource(request, { store, now: deps.now }),
  );
}

export async function parkDispatchStagedRebaseConflictOn(
  backend: AttestationBackend,
  request: ParkDispatchStagedRebaseConflictRequest,
  deps: { readonly now: () => string },
): Promise<ImplementationQueueControl> {
  return backend.transact({ kind: "namespace" }, (store) =>
    parkDispatchStagedRebaseConflict(request, { store, now: deps.now }),
  );
}

export function queueBindingOf(
  row: AttestationRow,
): ImplementationQueueControl | ImplementationQueueTombstoneBinding | undefined {
  return row.implementationQueue;
}
