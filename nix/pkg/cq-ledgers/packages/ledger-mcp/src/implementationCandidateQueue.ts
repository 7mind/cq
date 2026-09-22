import {
  acquireImplementationCandidateOn,
  dispatchPayloadDigest,
  enqueueImplementationCandidateOn,
  isAttestationTombstone,
  parkDispatchStagedRebaseConflictOn,
  parkImplementationCandidateOn,
  qualifyDispatchStagedCompletionOn,
  recoverImplementationCandidateOn,
  releaseImplementationCandidateOn,
  releaseImplementationCompletionLeaseOn,
  reserveImplementationCompletionLeaseOn,
  resumeImplementationCandidateOn,
  retireDispatchStagedRebaseSourceOn,
  terminalizeImplementationCandidateOn,
  yieldImplementationCandidateOn,
  type AcquireImplementationCandidateOutcome,
  type AttestationBackend,
  type DispatchProvenanceBinding,
  type DispatchStagedRebaseSourceBinding,
  type EnqueueImplementationCandidateRequest,
  type ImplementationQueueControl,
  type ImplementationQueueLeaseBinding,
  type NativeChildIdentity,
  type NativeCompletionProof,
  type QualifyDispatchStagedCompletionOutcome,
  type ReleaseImplementationCompletionLeaseRequest,
  type ReserveImplementationCompletionLeaseRequest,
} from "@cq/config";

type TrustedQueueActor = EnqueueImplementationCandidateRequest["actor"];
type QueueAuthorityOmitted<T> = T extends unknown ? Omit<T, "namespace" | "actor"> : never;
type QueueCandidate = Omit<EnqueueImplementationCandidateRequest, "namespace" | "actor">;
type AcquireRequest = Omit<
  Parameters<typeof acquireImplementationCandidateOn>[1],
  "namespace" | "actor"
>;
type LeaseTransitionRequest = Omit<
  Parameters<typeof parkImplementationCandidateOn>[1],
  "namespace" | "actor"
>;
type RecoveryRequest = Omit<
  Parameters<typeof recoverImplementationCandidateOn>[1],
  "namespace" | "actor"
>;
type TerminalRequest = Omit<
  Parameters<typeof terminalizeImplementationCandidateOn>[1],
  "namespace" | "actor"
>;
type RetirementRequest = Omit<
  Parameters<typeof retireDispatchStagedRebaseSourceOn>[1],
  "namespace" | "actor"
>;

export interface QualifyNativeImplementationCandidateRequest {
  readonly candidate: QueueCandidate;
  readonly expectedChild: NativeChildIdentity;
  readonly expectedProvenance: DispatchProvenanceBinding;
  readonly nativeCompletion: NativeCompletionProof;
}

export interface QualifiedImplementationCandidate {
  readonly queue: ImplementationQueueControl;
  readonly qualification: QualifyDispatchStagedCompletionOutcome;
}

export interface PendingStagedRebaseCheckpoint {
  readonly control: ImplementationQueueControl;
  readonly source: DispatchStagedRebaseSourceBinding;
}

export interface ImplementationCandidateQueueAdapterOptions {
  readonly backend: AttestationBackend;
  readonly actor: TrustedQueueActor;
  readonly now: () => string;
}

export const IMPLEMENTATION_CANDIDATE_HEAD_OF_LINE_POLICIES = Object.freeze({
  park: "park",
  yield: "yield",
  resume: "resume",
  cancel: "cancelled",
  supersede: "superseded",
  "review-question": "park",
  "non-converging-criticism": "yield",
  "task-abandonment": "cancelled",
  "owner-revocation": "cancelled",
  "worktree-authority-revocation": "cancelled",
  "permanent-ineligibility": "superseded",
  conflict: "park",
  "deterministic-red": "yield",
  "execution-uncertainty": "park",
} as const);

export type ImplementationCandidateHeadOfLineDisposition =
  keyof typeof IMPLEMENTATION_CANDIDATE_HEAD_OF_LINE_POLICIES;

export interface ApplyImplementationCandidateHeadOfLineDispositionRequest {
  readonly disposition: ImplementationCandidateHeadOfLineDisposition;
  readonly lease: ImplementationQueueLeaseBinding;
  readonly expectedPartitionRevision: number;
  readonly detail?: LeaseTransitionRequest["detail"];
}

/** Trusted ledger-MCP boundary over the durable attestation queue transaction. */
export class ImplementationCandidateQueueAdapter {
  private readonly backend: AttestationBackend;
  private readonly actor: TrustedQueueActor;
  private readonly now: () => string;

  constructor(options: ImplementationCandidateQueueAdapterOptions) {
    this.backend = options.backend;
    this.actor = options.actor;
    this.now = options.now;
  }

  async qualifyNativeCompletion(
    request: QualifyNativeImplementationCandidateRequest,
  ): Promise<QualifiedImplementationCandidate> {
    const queue = await enqueueImplementationCandidateOn(
      this.backend,
      {
        namespace: this.backend.namespace,
        actor: this.actor,
        ...request.candidate,
      },
      { now: this.now },
    );
    const qualification = await qualifyDispatchStagedCompletionOn(
      this.backend,
      {
        namespace: this.backend.namespace,
        actor: this.actor,
        attestationId: request.candidate.attestationId,
        generation: request.candidate.generation,
        partitionKey: queue.partition.partitionKey,
        enrollmentId: queue.enrollment.enrollmentId,
        attemptId: queue.attempt.attemptId,
        stagedOutputDigest: request.candidate.stagedOutputDigest,
        expectedChild: request.expectedChild,
        expectedProvenance: request.expectedProvenance,
        nativeCompletion: request.nativeCompletion,
      },
      { now: this.now },
    );
    return this.backend.transact({ kind: "handle", handle: request.candidate }, (store) => {
      const persisted = store.read(request.candidate);
      if (
        persisted === undefined ||
        isAttestationTombstone(persisted) ||
        persisted.implementationQueue === undefined
      ) {
        throw new Error("qualified implementation candidate did not persist its queue control");
      }
      return Object.freeze({ queue: persisted.implementationQueue, qualification });
    });
  }

  acquire(request: AcquireRequest): Promise<AcquireImplementationCandidateOutcome> {
    return acquireImplementationCandidateOn(
      this.backend,
      { namespace: this.backend.namespace, actor: this.actor, ...request },
      { now: this.now },
    );
  }

  inspectLease(lease: ImplementationQueueLeaseBinding): Promise<ImplementationQueueControl> {
    return this.backend.transact({ kind: "handle", handle: lease }, (store) => {
      const row = store.read(lease);
      if (
        row === undefined ||
        isAttestationTombstone(row) ||
        row.implementationQueue === undefined
      ) {
        throw new Error("implementation candidate lease no longer has a live queue row");
      }
      const control = row.implementationQueue;
      if (
        control.state !== "leased" ||
        control.partition.partitionKey !== lease.partitionKey ||
        control.enrollment.enrollmentId !== lease.enrollmentId ||
        control.attempt.attemptId !== lease.attemptId ||
        control.lease?.holderId !== lease.holderId ||
        control.lease.generation !== lease.leaseGeneration
      ) {
        throw new Error("implementation candidate lease is stale");
      }
      return control;
    });
  }

  inspectPendingStagedRebase(
    partitionKey: string,
    disposition: "undisposed" | "conflict-pending" = "undisposed",
  ): Promise<PendingStagedRebaseCheckpoint | undefined> {
    return this.backend.transact({ kind: "namespace" }, (store) => {
      const rows = store.rows();
      const checkpoints = rows
        .filter((row) => !isAttestationTombstone(row))
        .flatMap((row) => {
          const control = row.implementationQueue;
          const source = row.stagedRebaseSourceBinding ?? control?.stagedRebaseSource;
          if (
            control === undefined ||
            source === undefined ||
            control.state !== "staged-rebase-retired" ||
            (disposition === "undisposed"
              ? control.stagedRebaseDisposition !== undefined
              : control.stagedRebaseDisposition?.state !== "conflict-pending") ||
            control.partition.partitionKey !== partitionKey
          ) {
            return [];
          }
          if (source.successor !== undefined) {
            const successorHandle = source.successor;
            const successor = rows.find(
              (candidate) =>
                candidate.attestationId === successorHandle.attestationId &&
                candidate.generation === successorHandle.generation,
            );
            if (successor === undefined) {
              throw new Error("staged-rebase source claimed a missing successor");
            }
            if (
              successor.implementationQueue !== undefined ||
              isAttestationTombstone(successor) ||
              successor.state === "aborted" ||
              successor.state === "consumed"
            ) {
              return [];
            }
          }
          return [{ control, source }];
        })
        .sort(
          (left, right) =>
            left.control.enrollment.admissionOrdinal - right.control.enrollment.admissionOrdinal,
        );
      return checkpoints[0];
    });
  }

  parkRetiredStagedRebaseConflict(
    checkpoint: PendingStagedRebaseCheckpoint,
  ): Promise<ImplementationQueueControl> {
    return parkDispatchStagedRebaseConflictOn(
      this.backend,
      {
        namespace: this.backend.namespace,
        actor: this.actor,
        ...checkpoint.source.source,
        partitionKey: checkpoint.source.partitionKey,
        enrollmentId: checkpoint.source.enrollmentId,
        attemptId: checkpoint.source.attemptId,
        leaseGeneration: checkpoint.source.leaseGeneration,
        sourceReference: checkpoint.source.sourceReference,
        expectedPartitionRevision: checkpoint.control.partitionRevision,
        detail: { disposition: "conflict" },
      },
      { now: this.now },
    );
  }

  park(request: LeaseTransitionRequest): Promise<ImplementationQueueControl> {
    return parkImplementationCandidateOn(
      this.backend,
      { namespace: this.backend.namespace, actor: this.actor, ...request },
      { now: this.now },
    );
  }

  yield(request: LeaseTransitionRequest): Promise<ImplementationQueueControl> {
    return yieldImplementationCandidateOn(
      this.backend,
      { namespace: this.backend.namespace, actor: this.actor, ...request },
      { now: this.now },
    );
  }

  resume(request: LeaseTransitionRequest): Promise<ImplementationQueueControl> {
    return resumeImplementationCandidateOn(
      this.backend,
      { namespace: this.backend.namespace, actor: this.actor, ...request },
      { now: this.now },
    );
  }

  release(request: LeaseTransitionRequest): Promise<ImplementationQueueControl> {
    return releaseImplementationCandidateOn(
      this.backend,
      { namespace: this.backend.namespace, actor: this.actor, ...request },
      { now: this.now },
    );
  }

  reserveCompletion(
    request: QueueAuthorityOmitted<ReserveImplementationCompletionLeaseRequest>,
  ) {
    return reserveImplementationCompletionLeaseOn(
      this.backend,
      { namespace: this.backend.namespace, actor: this.actor, ...request },
      { now: this.now },
    );
  }

  releaseCompletion(
    request: QueueAuthorityOmitted<ReleaseImplementationCompletionLeaseRequest>,
  ): Promise<ImplementationQueueControl> {
    return releaseImplementationCompletionLeaseOn(
      this.backend,
      { namespace: this.backend.namespace, actor: this.actor, ...request },
      { now: this.now },
    );
  }

  recover(request: RecoveryRequest): Promise<ImplementationQueueControl> {
    return recoverImplementationCandidateOn(
      this.backend,
      { namespace: this.backend.namespace, actor: this.actor, ...request },
      { now: this.now },
    );
  }

  terminalize(request: TerminalRequest) {
    return terminalizeImplementationCandidateOn(
      this.backend,
      { namespace: this.backend.namespace, actor: this.actor, ...request },
      { now: this.now },
    );
  }

  retireStagedRebaseSource(request: RetirementRequest) {
    return retireDispatchStagedRebaseSourceOn(
      this.backend,
      { namespace: this.backend.namespace, actor: this.actor, ...request },
      { now: this.now },
    );
  }

  applyHeadOfLineDisposition(request: ApplyImplementationCandidateHeadOfLineDispositionRequest) {
    const action = IMPLEMENTATION_CANDIDATE_HEAD_OF_LINE_POLICIES[request.disposition];
    const transition = {
      ...request.lease,
      expectedPartitionRevision: request.expectedPartitionRevision,
      detail: request.detail ?? { disposition: request.disposition },
    };
    if (action === "park") return this.park(transition);
    if (action === "yield") return this.yield(transition);
    if (action === "resume") return this.resume(transition);
    const { holderId: _holderId, leaseGeneration: _leaseGeneration, ...terminal } = transition;
    return this.terminalize({
      ...terminal,
      reason: action,
    });
  }
}

export interface ImplementationCandidateCoordinatorOperations {
  isQualifiedFrontSettled?(input: {
    readonly lease: ImplementationQueueLeaseBinding;
    readonly control: ImplementationQueueControl;
  }): Promise<boolean>;
  reconcileRetiredSource?(input: PendingStagedRebaseCheckpoint): Promise<
    | { readonly state: "conflict-pending" }
    | {
        readonly state: "successor-queued";
        readonly successor: { readonly attestationId: string; readonly generation: number };
      }
  >;
  observeProtectedHead(control: ImplementationQueueControl): Promise<string>;
  finalizeQualifiedFront(input: {
    readonly lease: ImplementationQueueLeaseBinding;
    readonly control: ImplementationQueueControl;
  }): Promise<void>;
  confirmQualifiedFront(input: {
    readonly lease: ImplementationQueueLeaseBinding;
    readonly control: ImplementationQueueControl;
    readonly nativeCompletion: NativeCompletionProof;
  }): Promise<void>;
  retireStaleSource(input: {
    readonly lease: ImplementationQueueLeaseBinding;
    readonly control: ImplementationQueueControl;
    readonly ontoCommit: string;
  }): Promise<{
    readonly sourceReference: string;
    readonly conflictPending?: true;
  }>;
  rebaseRetiredSource(input: {
    readonly lease: ImplementationQueueLeaseBinding;
    readonly control: ImplementationQueueControl;
    readonly retirement: { readonly sourceReference: string };
    readonly operation: "rebase";
    readonly operationId: string;
    readonly ontoCommit: string;
  }): Promise<{ readonly guardedRebase: string }>;
  prepareSuccessor(input: {
    readonly lease: ImplementationQueueLeaseBinding;
    readonly control: ImplementationQueueControl;
    readonly retirement: { readonly sourceReference: string };
    readonly rebase: { readonly guardedRebase: string };
    readonly ontoCommit: string;
  }): Promise<{ readonly attestationId: string; readonly generation: number }>;
}

export type CoordinateImplementationCandidateOutcome =
  | AcquireImplementationCandidateOutcome
  | {
      readonly state: "completed";
      readonly handle: { readonly attestationId: string; readonly generation: number };
    }
  | {
      readonly state: "successor-queued";
      readonly source: { readonly attestationId: string; readonly generation: number };
      readonly successor: { readonly attestationId: string; readonly generation: number };
    };

/** Route one qualified runnable front; stale fronts retire/rebase without invoking the gate. */
export class ImplementationCandidateCoordinator {
  constructor(
    private readonly queue: ImplementationCandidateQueueAdapter,
    private readonly operations: ImplementationCandidateCoordinatorOperations,
  ) {}

  async run(request: AcquireRequest): Promise<CoordinateImplementationCandidateOutcome> {
    const pending = await this.queue.inspectPendingStagedRebase(request.partitionKey);
    if (pending !== undefined) {
      if (pending.source.successor !== undefined) {
        return Object.freeze({
          state: "successor-queued" as const,
          source: Object.freeze({ ...pending.source.source }),
          successor: Object.freeze({ ...pending.source.successor }),
        });
      }
      if (this.operations.reconcileRetiredSource === undefined) {
        throw new Error("retired staged-rebase recovery is unavailable");
      }
      const reconciled = await this.operations.reconcileRetiredSource(pending);
      if (reconciled.state === "conflict-pending") {
        const parked = await this.queue.parkRetiredStagedRebaseConflict(pending);
        return Object.freeze({
          state: "blocked" as const,
          partitionKey: pending.source.partitionKey,
          partitionRevision: parked.partitionRevision,
          front: Object.freeze({ ...pending.source.source }),
          frontState: "staged-rebase-retired" as const,
          sourceReference: pending.source.sourceReference,
        });
      }
      return Object.freeze({
        state: "successor-queued" as const,
        source: Object.freeze({ ...pending.source.source }),
        successor: Object.freeze({ ...reconciled.successor }),
      });
    }
    const acquired = await this.queue.acquire(request);
    if (acquired.state === "empty") {
      const deferredConflict = await this.queue.inspectPendingStagedRebase(
        request.partitionKey,
        "conflict-pending",
      );
      if (deferredConflict !== undefined) {
        if (this.operations.reconcileRetiredSource === undefined) {
          throw new Error("retired staged-rebase recovery is unavailable");
        }
        const reconciled = await this.operations.reconcileRetiredSource(deferredConflict);
        if (reconciled.state === "conflict-pending") {
          const parked = await this.queue.parkRetiredStagedRebaseConflict(deferredConflict);
          return Object.freeze({
            state: "blocked" as const,
            partitionKey: deferredConflict.source.partitionKey,
            partitionRevision: parked.partitionRevision,
            front: Object.freeze({ ...deferredConflict.source.source }),
            frontState: "staged-rebase-retired" as const,
            sourceReference: deferredConflict.source.sourceReference,
          });
        }
        return Object.freeze({
          state: "successor-queued" as const,
          source: Object.freeze({ ...deferredConflict.source.source }),
          successor: Object.freeze({ ...reconciled.successor }),
        });
      }
    }
    if (acquired.state !== "leased") return acquired;
    const control = await this.queue.inspectLease(acquired.lease);
    if (
      this.operations.isQualifiedFrontSettled !== undefined &&
      (await this.operations.isQualifiedFrontSettled({ lease: acquired.lease, control }))
    ) {
      return Object.freeze({
        state: "empty" as const,
        partitionKey: acquired.lease.partitionKey,
        partitionRevision: acquired.partitionRevision,
      });
    }
    const protectedHead = await this.operations.observeProtectedHead(control);
    if (protectedHead === control.attempt.observedBaseCommit) {
      if (control.qualification === undefined) {
        throw new Error("leased implementation candidate lost its native completion proof");
      }
      await this.operations.finalizeQualifiedFront({ lease: acquired.lease, control });
      await this.operations.confirmQualifiedFront({
        lease: acquired.lease,
        control,
        nativeCompletion: control.qualification.nativeCompletion,
      });
      return Object.freeze({
        state: "completed" as const,
        handle: Object.freeze({
          attestationId: acquired.lease.attestationId,
          generation: acquired.lease.generation,
        }),
      });
    }
    const retirement = await this.operations.retireStaleSource({
      lease: acquired.lease,
      control,
      ontoCommit: protectedHead,
    });
    if (retirement.conflictPending === true) {
      const retired = await this.queue.inspectPendingStagedRebase(request.partitionKey);
      if (retired === undefined || retired.source.sourceReference !== retirement.sourceReference) {
        throw new Error("conflicted staged-rebase retirement lost its durable checkpoint");
      }
      const parked = await this.queue.parkRetiredStagedRebaseConflict(retired);
      return Object.freeze({
        state: "blocked" as const,
        partitionKey: retired.source.partitionKey,
        partitionRevision: parked.partitionRevision,
        front: Object.freeze({ ...retired.source.source }),
        frontState: "staged-rebase-retired" as const,
        sourceReference: retired.source.sourceReference,
      });
    }
    const operationId = `implementation-rebase-${dispatchPayloadDigest({
      enrollmentId: control.enrollment.enrollmentId,
      attemptId: control.attempt.attemptId,
    }).slice(0, 32)}`;
    const rebase = await this.operations.rebaseRetiredSource({
      lease: acquired.lease,
      control,
      retirement,
      operation: "rebase",
      operationId,
      ontoCommit: protectedHead,
    });
    const successor = await this.operations.prepareSuccessor({
      lease: acquired.lease,
      control,
      retirement,
      rebase,
      ontoCommit: protectedHead,
    });
    return Object.freeze({
      state: "successor-queued" as const,
      source: Object.freeze({
        attestationId: acquired.lease.attestationId,
        generation: acquired.lease.generation,
      }),
      successor: Object.freeze({ ...successor }),
    });
  }
}
