import {
  implementWorkerSupervisedGateEvidenceSchema,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  validateAgainstSchema,
  validateSupervisedWorkerGateEvidenceForReview,
  implementationQueueSubjectsMatch,
  implementationQueueAuthoritiesMatch,
  type AttestationStore,
  type DispatchJSONValue,
  type ImplementWorkerSupervisedGateEvidence,
} from "@cq/config";
import {
  cohortValueDigestV1 as digest,
  createCohortEvidenceSubjectV1,
  type CohortCandidateSealV1,
  type StagedCohortCandidateAttemptV1,
} from "./workCohort.js";

export interface CohortG213GateReceiptV1 {
  readonly kind: "cq-cohort-g213-gate-receipt";
  readonly version: 1;
  readonly candidateAttemptDigest: string;
  readonly sealDigest: string;
  readonly partitionKey: string;
  readonly enrollmentId: string;
  readonly attemptId: string;
  readonly qualificationDigest: string;
  readonly gate: ImplementWorkerSupervisedGateEvidence;
  readonly receiptDigest: string;
}

class IssuedCohortG213GateV1 {
  readonly #receipt: CohortG213GateReceiptV1;
  constructor(receipt: CohortG213GateReceiptV1) { this.#receipt = structuredClone(receipt); }
  receipt(): CohortG213GateReceiptV1 { return structuredClone(this.#receipt); }
}

export type AuthorizedCohortG213GateV1 = IssuedCohortG213GateV1;

function gateSubjectMatches(gate: ImplementWorkerSupervisedGateEvidence,
  attempt: StagedCohortCandidateAttemptV1, seal: CohortCandidateSealV1): boolean {
  const dispatch = attempt.preparedDispatch;
  if (dispatch.cohort === undefined) {
    return gate.version === 1 && gate.taskId === dispatch.taskId &&
      validateSupervisedWorkerGateEvidenceForReview(gate, {
        taskId: dispatch.taskId, resultCommit: seal.resultCommit,
        branch: dispatch.branch, worktreePath: gate.worktreePath,
      });
  }
  return gate.version === 2 && !Object.hasOwn(gate, "taskId") &&
    digest(gate.evidenceSubject) === digest(createCohortEvidenceSubjectV1(dispatch.cohort.definition, seal));
}

export function validateCohortG213GateReceiptV1(
  receipt: CohortG213GateReceiptV1, attempt: StagedCohortCandidateAttemptV1, seal: CohortCandidateSealV1,
): void {
  const { receiptDigest, ...payload } = receipt;
  if (receipt.kind !== "cq-cohort-g213-gate-receipt" || receipt.version !== 1 ||
      digest(payload) !== receiptDigest || receipt.candidateAttemptDigest !== attempt.candidateAttemptDigest ||
      receipt.sealDigest !== seal.sealDigest || receipt.partitionKey !== attempt.g213.partitionKey ||
      receipt.enrollmentId !== attempt.g213.enrollmentId || receipt.attemptId !== attempt.g213.attemptId ||
      receipt.qualificationDigest !== attempt.g213.qualificationDigest ||
      !validateAgainstSchema(implementWorkerSupervisedGateEvidenceSchema, receipt.gate).ok ||
      receipt.gate.command !== IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND || !Number.isInteger(receipt.gate.passCount) ||
      !gateSubjectMatches(receipt.gate, attempt, seal) ||
      receipt.gate.attestationId !== attempt.preparedDispatch.attestationId ||
      receipt.gate.generation !== attempt.preparedDispatch.generation ||
      receipt.gate.branch !== attempt.preparedDispatch.branch ||
      receipt.gate.resultCommit !== seal.resultCommit ||
      receipt.gate.gitReceiptsDigest !== seal.gitReceiptBridgeDigest) {
    throw new Error("cohort full gate receipt differs from its authenticated candidate completion");
  }
}

export function readAuthorizedCohortG213GateV1(value: AuthorizedCohortG213GateV1): CohortG213GateReceiptV1 {
  if (!(value instanceof IssuedCohortG213GateV1)) throw new Error("cohort full gate requires authenticated G213 completion");
  return value.receipt();
}

export class CohortG213GateAuthenticatorV1 {
  readonly #store: Pick<AttestationStore, "namespace" | "read">;
  constructor(store: Pick<AttestationStore, "namespace" | "read">) { this.#store = store; }

  authenticate(attempt: StagedCohortCandidateAttemptV1, seal: CohortCandidateSealV1): AuthorizedCohortG213GateV1 {
    const row = this.#store.read(attempt.preparedDispatch);
    if (row === undefined || row.kind !== "envelope" ||
        (row.state !== "result-stored" && row.state !== "consumed") ||
        digest(row.namespace) !== digest(this.#store.namespace) ||
        row.attestationId !== attempt.preparedDispatch.attestationId ||
        row.generation !== attempt.preparedDispatch.generation) {
      throw new Error("cohort full gate lacks the exact completed G213 row");
    }
    const queue = row.implementationQueue;
    const binding = row.gitEffectBinding;
    if (typeof row.output !== "object" || row.output === null || Array.isArray(row.output)) {
      throw new Error("cohort full gate lacks its stored output");
    }
    const output = row.output as Readonly<Record<string, DispatchJSONValue>>;
    const stagedOutput = { ...output };
    delete stagedOutput["supervisedGateEvidence"];
    if (queue === undefined || binding === undefined || queue.qualification === undefined ||
        (queue.state === "leased" && queue.lease === undefined) ||
        (queue.state !== "leased" && queue.state !== "released") ||
        queue.partition.partitionKey !== attempt.g213.partitionKey ||
        queue.enrollment.enrollmentId !== attempt.g213.enrollmentId ||
        queue.attempt.attemptId !== attempt.g213.attemptId ||
        queue.qualification.qualificationDigest !== attempt.g213.qualificationDigest ||
        row.stagedCompletionQualification?.qualificationDigest !== attempt.g213.qualificationDigest ||
        row.gateSubmittedOutputDigest !== attempt.g213.qualifiedOutputDigest ||
        queue.qualification.outputDigest !== attempt.g213.qualifiedOutputDigest ||
        digest(stagedOutput) !== attempt.g213.qualifiedOutputDigest ||
        digest(row.stagedCompletionQualification) !== digest(queue.qualification) ||
        queue.qualification.expectedChild.childId !== row.expectedChild.childId ||
        queue.qualification.expectedChild.runId !== row.expectedChild.runId ||
        queue.qualification.expectedProvenance.roleId !== row.promptProvenance.roleId ||
        queue.qualification.expectedProvenance.version !== row.promptProvenance.version ||
        queue.qualification.expectedProvenance.promptDigest !== row.promptProvenance.promptDigest ||
        queue.qualification.expectedProvenance.inputDigest !== row.promptProvenance.inputDigest ||
        queue.attempt.resultCommit !== seal.resultCommit || queue.attempt.resultTree !== seal.resultTree ||
        queue.attempt.observedBaseCommit !== seal.baseCommit ||
        seal.candidateAttemptDigest !== attempt.candidateAttemptDigest ||
        queue.attempt.gitReceiptLineageDigest !== seal.gitReceiptBridgeDigest ||
        queue.attempt.managedWorktreeBindingDigest !== digest(binding) ||
        !implementationQueueSubjectsMatch(binding, attempt.preparedDispatch, false) ||
        !implementationQueueSubjectsMatch(queue.attempt, binding, false) ||
        !implementationQueueAuthoritiesMatch(queue.enrollment, queue.attempt, false) ||
        output["status"] !== "pass" || row.outputDigest !== digest(output)) {
      throw new Error("cohort full gate differs from its sealed G213 attempt");
    }
    const value = output["supervisedGateEvidence"];
    if (!validateAgainstSchema(implementWorkerSupervisedGateEvidenceSchema, value).ok) {
      throw new Error("cohort full gate lacks canonical green supervised evidence");
    }
    const gate = value as unknown as ImplementWorkerSupervisedGateEvidence;
    if (gate.attestationId !== row.attestationId || gate.generation !== row.generation ||
        !implementationQueueSubjectsMatch(output, binding, false) || output["branch"] !== gate.branch || output["resultCommit"] !== gate.resultCommit ||
        gate.roleId !== row.promptProvenance.roleId || gate.roleVersion !== row.promptProvenance.version ||
        gate.promptDigest !== row.promptProvenance.promptDigest || gate.catalogHash !== row.promptProvenance.catalogHash ||
        gate.inputDigest !== row.promptProvenance.inputDigest ||
        !gateSubjectMatches(gate, attempt, seal) ||
        gate.branch !== binding.branch || gate.worktreePath !== binding.worktreePath ||
        gate.baseCommit !== seal.baseCommit || gate.startingCommit !== attempt.preparedDispatch.startingCommit ||
        gate.resultCommit !== seal.resultCommit || gate.command !== queue.attempt.gateCommand ||
        gate.filesTouchedDigest !== digest(output["filesTouched"]) ||
        gate.mutationTableDigest !== digest(output["mutationTable"] ?? null) ||
        gate.gitReceiptsDigest !== seal.gitReceiptBridgeDigest ||
        digest(output["gitReceipts"]) !== seal.gitReceiptBridgeDigest) {
      throw new Error("cohort full gate evidence has a substituted candidate or provenance binding");
    }
    const payload = { kind: "cq-cohort-g213-gate-receipt" as const, version: 1 as const,
      candidateAttemptDigest: attempt.candidateAttemptDigest, sealDigest: seal.sealDigest,
      partitionKey: attempt.g213.partitionKey, enrollmentId: attempt.g213.enrollmentId,
      attemptId: attempt.g213.attemptId, qualificationDigest: attempt.g213.qualificationDigest, gate };
    return new IssuedCohortG213GateV1({ ...payload, receiptDigest: digest(payload) });
  }

  revalidate(attempt: StagedCohortCandidateAttemptV1, seal: CohortCandidateSealV1, receipt: CohortG213GateReceiptV1): void {
    validateCohortG213GateReceiptV1(receipt, attempt, seal);
    const current = readAuthorizedCohortG213GateV1(this.authenticate(attempt, seal));
    if (digest(current) !== digest(receipt)) throw new Error("cohort full gate receipt no longer matches G213");
  }
}
