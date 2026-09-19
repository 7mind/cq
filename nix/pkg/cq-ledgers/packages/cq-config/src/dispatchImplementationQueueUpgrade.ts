import {
  dispatchPayloadDigest,
  isAttestationTombstone,
  type AttestationEnvelope,
  type DispatchGitEffectBinding,
  type DispatchProvenanceBinding,
  type NativeChildIdentity,
} from "./dispatchAttestation.js";
import type { AttestationBackend } from "./dispatchAttestationBackend.js";
import {
  enqueueImplementationCandidateOn,
  qualifyDispatchStagedCompletionOn,
  type EnqueueImplementationCandidateRequest,
  type ImplementationQueueRollout,
} from "./dispatchImplementationQueue.js";
import type { DispatchJSONValue, NativeCompletionProof } from "./compactDispatchProtocol.js";

export const IMPLEMENTATION_QUEUE_ROLLOUT_CONTRACT = Object.freeze({
  id: "g213-t4" as const,
  version: 1 as const,
  consumer: "G191" as const,
  producerDependsOnConsumer: false as const,
});

type Candidate = Omit<
  EnqueueImplementationCandidateRequest,
  "namespace" | "actor" | "attestationId" | "generation" | "rollout"
>;

export interface RecoveredImplementationCompletion {
  readonly stagedOutputDigest: string;
  readonly expectedChild: NativeChildIdentity;
  readonly expectedProvenance: DispatchProvenanceBinding;
  readonly nativeCompletion: NativeCompletionProof;
}

export interface RecoveredCompletedGreenEvidence {
  readonly outputDigest: string;
  readonly resultCommit: string;
  readonly managedWorktreeBindingDigest: string;
  readonly supervisedGateEvidenceDigest: string;
}

export type LegacyImplementationResolution =
  | {
      readonly state: "compatible";
      readonly candidate: Candidate;
      readonly completion?: RecoveredImplementationCompletion;
    }
  | {
      readonly state: "completed-green";
      readonly evidence: RecoveredCompletedGreenEvidence;
    }
  | {
      readonly state: "incompatible";
      readonly detail: DispatchJSONValue;
    };

export interface UpgradeLiveImplementationQueueOptions {
  readonly backend: AttestationBackend;
  readonly now: () => string;
  resolve(row: AttestationEnvelope): Promise<LegacyImplementationResolution>;
  protectManagedWorktree(binding: DispatchGitEffectBinding): Promise<void>;
}

export interface UpgradeLiveImplementationQueueSummary {
  readonly contract: "g213-t4";
  readonly version: 1;
  readonly considered: number;
  readonly adoptedUnqualified: number;
  readonly adoptedQualified: number;
  readonly adoptedCompletedGreen: number;
  readonly parkedIncompatible: number;
  readonly executionUncertain: number;
  readonly orderedHandles: readonly string[];
}

function handleKey(row: Pick<AttestationEnvelope, "attestationId" | "generation">): string {
  return `${row.attestationId}#${String(row.generation)}`;
}

function orderRows(left: AttestationEnvelope, right: AttestationEnvelope): number {
  const leftSubmitted = left.gateSubmittedAt ?? left.createdAt;
  const rightSubmitted = right.gateSubmittedAt ?? right.createdAt;
  return (
    leftSubmitted.localeCompare(rightSubmitted) ||
    left.attestationId.localeCompare(right.attestationId) ||
    left.generation - right.generation
  );
}

function rollout(
  disposition: ImplementationQueueRollout["disposition"],
  decidedAt: string,
  detail: DispatchJSONValue,
  worktreeProtected: boolean,
): ImplementationQueueRollout {
  const retainedDetail = structuredClone(detail);
  return Object.freeze({
    kind: "cq-implementation-queue-rollout" as const,
    version: 1 as const,
    contract: IMPLEMENTATION_QUEUE_ROLLOUT_CONTRACT.id,
    disposition,
    decidedAt,
    detailDigest: dispatchPayloadDigest(retainedDetail),
    diagnosticArtifact: Object.freeze({
      kind: "cq-implementation-queue-rollout-diagnostic" as const,
      version: 1 as const,
      detail: retainedDetail,
    }),
    worktreeProtected,
  });
}

function provenanceOf(row: AttestationEnvelope): DispatchProvenanceBinding {
  return Object.freeze({
    roleId: row.promptProvenance.roleId,
    version: row.promptProvenance.version,
    promptDigest: row.promptProvenance.promptDigest,
    inputDigest: row.promptProvenance.inputDigest,
  });
}

function exactRecoveredCompletion(
  row: AttestationEnvelope,
  completion: RecoveredImplementationCompletion | undefined,
): completion is RecoveredImplementationCompletion {
  return (
    completion !== undefined &&
    completion.stagedOutputDigest === row.gateSubmittedOutputDigest &&
    dispatchPayloadDigest(completion.expectedChild as unknown as DispatchJSONValue) ===
      dispatchPayloadDigest(row.expectedChild as unknown as DispatchJSONValue) &&
    dispatchPayloadDigest(completion.expectedProvenance as unknown as DispatchJSONValue) ===
      dispatchPayloadDigest(provenanceOf(row) as unknown as DispatchJSONValue) &&
    completion.nativeCompletion.actor === "trusted-parent" &&
    completion.nativeCompletion.childId === row.expectedChild.childId &&
    completion.nativeCompletion.runId === row.expectedChild.runId
  );
}

function exactCompletedGreenEvidence(
  row: AttestationEnvelope,
  evidence: RecoveredCompletedGreenEvidence,
): boolean {
  if (
    row.state !== "result-stored" ||
    row.gitEffectBinding === undefined ||
    row.output === undefined ||
    row.output === null ||
    typeof row.output !== "object" ||
    Array.isArray(row.output)
  ) {
    return false;
  }
  const output = row.output as Readonly<Record<string, DispatchJSONValue>>;
  const supervised = output["supervisedGateEvidence"];
  return (
    output["status"] === "pass" &&
    output["resultCommit"] === evidence.resultCommit &&
    row.outputDigest === evidence.outputDigest &&
    dispatchPayloadDigest(row.gitEffectBinding as unknown as DispatchJSONValue) ===
      evidence.managedWorktreeBindingDigest &&
    supervised !== undefined &&
    dispatchPayloadDigest(supervised) === evidence.supervisedGateEvidenceDigest
  );
}

async function recordDisposition(
  options: UpgradeLiveImplementationQueueOptions,
  row: AttestationEnvelope,
  decision: ImplementationQueueRollout,
): Promise<void> {
  await options.backend.transact({ kind: "handle", handle: row }, (store) => {
    const current = store.read(row);
    if (current === undefined || isAttestationTombstone(current)) {
      throw new Error(`legacy implementation row ${handleKey(row)} disappeared during rollout`);
    }
    if (current.implementationQueueRollout !== undefined) return;
    if (current.implementationQueue !== undefined) {
      throw new Error(`legacy implementation row ${handleKey(row)} entered the queue concurrently`);
    }
    store.replace(current, Object.freeze({ ...current, implementationQueueRollout: decision }));
  });
}

/**
 * Upgrade pre-queue live worker rows in stable submitted-time/handle order.
 * Resolution and worktree protection are ports so the same contract runs
 * against the in-memory dummy and the production PostgreSQL adapter.
 */
export async function upgradeLiveImplementationQueueRows(
  options: UpgradeLiveImplementationQueueOptions,
): Promise<UpgradeLiveImplementationQueueSummary> {
  const rows = await options.backend.transact({ kind: "namespace" }, (store) =>
    store
      .rows()
      .filter(
        (candidate): candidate is AttestationEnvelope =>
          !isAttestationTombstone(candidate) &&
          candidate.promptProvenance.roleId === "implement-worker" &&
          candidate.implementationQueue === undefined &&
          candidate.implementationQueueRollout === undefined &&
          (candidate.state === "gate-pending" ||
            candidate.state === "gate-running" ||
            candidate.state === "result-stored"),
      )
      .sort(orderRows),
  );
  const counts = {
    adoptedUnqualified: 0,
    adoptedQualified: 0,
    adoptedCompletedGreen: 0,
    parkedIncompatible: 0,
    executionUncertain: 0,
  };

  for (const row of rows) {
    let worktreeProtected = false;
    if (row.gitEffectBinding !== undefined) {
      await options.protectManagedWorktree(row.gitEffectBinding);
      worktreeProtected = true;
    }
    const decidedAt = options.now();
    if (row.state === "gate-running") {
      await recordDisposition(
        options,
        row,
        rollout(
          "execution-uncertain",
          decidedAt,
          { state: row.state, handle: handleKey(row) },
          worktreeProtected,
        ),
      );
      counts.executionUncertain += 1;
      continue;
    }

    const resolution = await options.resolve(row);
    if (resolution.state === "incompatible") {
      await recordDisposition(
        options,
        row,
        rollout("parked-incompatible", decidedAt, resolution.detail, worktreeProtected),
      );
      counts.parkedIncompatible += 1;
      continue;
    }
    if (resolution.state === "completed-green") {
      if (!exactCompletedGreenEvidence(row, resolution.evidence)) {
        await recordDisposition(
          options,
          row,
          rollout(
            "parked-incompatible",
            decidedAt,
            { reason: "completed-green-evidence-binding-mismatch" },
            worktreeProtected,
          ),
        );
        counts.parkedIncompatible += 1;
        continue;
      }
      await recordDisposition(
        options,
        row,
        rollout(
          "adopted-completed-green",
          decidedAt,
          resolution.evidence as unknown as DispatchJSONValue,
          worktreeProtected,
        ),
      );
      counts.adoptedCompletedGreen += 1;
      continue;
    }
    if (row.state !== "gate-pending") {
      throw new Error(`compatible queue adoption requires gate-pending, observed ${row.state}`);
    }
    const exactCompletion = exactRecoveredCompletion(row, resolution.completion);
    const unqualifiedRollout = rollout(
      "adopted-unqualified",
      decidedAt,
      { handle: handleKey(row), recoveredCompletion: exactCompletion },
      worktreeProtected,
    );
    const queue = await enqueueImplementationCandidateOn(
      options.backend,
      {
        namespace: options.backend.namespace,
        actor: "trusted-parent",
        attestationId: row.attestationId,
        generation: row.generation,
        ...resolution.candidate,
        rollout: unqualifiedRollout,
      },
      { now: options.now },
    );
    if (!exactCompletion) {
      counts.adoptedUnqualified += 1;
      continue;
    }
    const qualifiedRollout = rollout(
      "adopted-qualified",
      decidedAt,
      resolution.completion as unknown as DispatchJSONValue,
      worktreeProtected,
    );
    const qualified = await qualifyDispatchStagedCompletionOn(
      options.backend,
      {
        namespace: options.backend.namespace,
        actor: "trusted-parent",
        attestationId: row.attestationId,
        generation: row.generation,
        partitionKey: queue.partition.partitionKey,
        enrollmentId: queue.enrollment.enrollmentId,
        attemptId: queue.attempt.attemptId,
        ...resolution.completion,
        rollout: qualifiedRollout,
      },
      { now: options.now },
    );
    if (qualified.state !== "qualified") {
      throw new Error(`exact recovered completion for ${handleKey(row)} was not qualified`);
    }
    counts.adoptedQualified += 1;
  }

  return Object.freeze({
    contract: IMPLEMENTATION_QUEUE_ROLLOUT_CONTRACT.id,
    version: IMPLEMENTATION_QUEUE_ROLLOUT_CONTRACT.version,
    considered: rows.length,
    ...counts,
    orderedHandles: Object.freeze(rows.map(handleKey)),
  });
}
