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
