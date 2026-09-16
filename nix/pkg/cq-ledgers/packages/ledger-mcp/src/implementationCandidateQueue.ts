import {
  acquireImplementationCandidateOn,
  enqueueImplementationCandidateOn,
  isAttestationTombstone,
  parkImplementationCandidateOn,
  qualifyDispatchStagedCompletionOn,
  recoverImplementationCandidateOn,
  releaseImplementationCandidateOn,
  resumeImplementationCandidateOn,
  retireDispatchStagedRebaseSourceOn,
  terminalizeImplementationCandidateOn,
  yieldImplementationCandidateOn,
  type AcquireImplementationCandidateOutcome,
  type AttestationBackend,
  type DispatchProvenanceBinding,
  type EnqueueImplementationCandidateRequest,
  type ImplementationQueueControl,
  type ImplementationQueueLeaseBinding,
  type NativeChildIdentity,
  type NativeCompletionProof,
  type QualifyDispatchStagedCompletionOutcome,
} from "@cq/config";

type TrustedQueueActor = EnqueueImplementationCandidateRequest["actor"];
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
      if (row === undefined || isAttestationTombstone(row) || row.implementationQueue === undefined) {
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
}

export interface ImplementationCandidateCoordinatorOperations {
  observeProtectedHead(control: ImplementationQueueControl): Promise<string>;
  finalizeQualifiedFront(input: {
    readonly lease: ImplementationQueueLeaseBinding;
    readonly control: ImplementationQueueControl;
  }): Promise<void>;
  confirmAndFetchQualifiedFront(input: {
    readonly lease: ImplementationQueueLeaseBinding;
    readonly nativeCompletion: NativeCompletionProof;
  }): Promise<void>;
  retireStaleSource(input: {
    readonly lease: ImplementationQueueLeaseBinding;
    readonly control: ImplementationQueueControl;
    readonly ontoCommit: string;
  }): Promise<{ readonly sourceReference: string }>;
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

  async run(
    request: AcquireRequest,
  ): Promise<CoordinateImplementationCandidateOutcome> {
    const acquired = await this.queue.acquire(request);
    if (acquired.state !== "leased") return acquired;
    const control = await this.queue.inspectLease(acquired.lease);
    const protectedHead = await this.operations.observeProtectedHead(control);
    if (protectedHead === control.attempt.observedBaseCommit) {
      if (control.qualification === undefined) {
        throw new Error("leased implementation candidate lost its native completion proof");
      }
      await this.operations.finalizeQualifiedFront({ lease: acquired.lease, control });
      await this.operations.confirmAndFetchQualifiedFront({
        lease: acquired.lease,
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
    const operationId = `cq-implementation-rebase:${control.enrollment.enrollmentId}:${control.attempt.attemptId}`;
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
