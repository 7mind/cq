import { createHash, randomUUID } from "node:crypto";
import { createCohortActivityV1, parseCohortActivityV1, type CohortActivityV1 } from "./workCohortActivity.js";

import {
  CohortCandidateSealConflictError,
  G213CandidateAuthenticatorV1,
  createCohortEvidenceSubjectV1,
  assertCohortCandidateIntentV1,
  assertCohortEffectEnvelopeV1,
  assertCohortGuardedCandidateBridgeV1,
  createCohortEffectEnvelopeV1,
  resolveCohortDefinitionObservationV1,
  materializeCohortCandidateSealV1,
  type CohortAcceptanceMatrixV1,
  type CohortAdmissionObservationV1,
  type CohortCandidateAttemptV1,
  type CohortCandidateIntentV1,
  type CohortEffectEnvelopeV1,
  type CohortCandidateSealRequestV1,
  type CohortCandidateSealV1,
  type CohortCommonBoundaryAtomV1,
  type CohortDecisionV1,
  type CohortDefinitionIdentityV1,
  type CohortEvidenceSubjectV1,
  type CohortGitChangeReceiptV1,
  type PendingCohortCandidateAttemptV1,
  type StagedCohortCandidateAttemptV1,
} from "./workCohort.js";
import { WORK_COHORT_STATE_FILENAME } from "./store/ledgerArtifacts.js";
import { assertCohortCompletionPrimaryFenceV1, type CohortCompletionPrimaryFenceV1 } from "./store/directOwnedMutation.js";
import { assertCohortCompletionHandoffBindingsV1, assertCohortCompletionHandoffTransitionV1, readAuthorizedCohortCompletionHandoffV1,
  type AuthorizedCohortCompletionHandoffV1, type CohortCompletionHandoffV1 } from "./workCohortCompletion.js";
import {
  readAuthorizedCohortCommandExecutionV1,
  validateCohortExecutionBindingV1,
  type AuthorizedCohortCommandExecutionV1,
  type CohortCommandExecutionV1,
} from "./workCohortAcceptance.js";
import {
  readAuthorizedInvestigationRunV1,
  validateInvestigationCohortRunV1,
  createInvestigationCohortPlanV1,
  type AuthorizedInvestigationRunV1,
  type InvestigationCohortRunV1,
} from "./workCohortInvestigation.js";

export const WORK_COHORT_DUMP_PATH = WORK_COHORT_STATE_FILENAME;

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("work cohort value contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const member = record[key];
        if (member === undefined) throw new Error(`work cohort value field ${key} is undefined`);
        return `${JSON.stringify(key)}:${canonical(member)}`;
      })
      .join(",")}}`;
  }
  throw new Error("work cohort value contains non-JSON data");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} must be non-empty`);
}

const SHA256 = /^[0-9a-f]{64}$/u;

function closedRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`);
  const missing = fields.find((field) => !(field in record));
  if (missing !== undefined) throw new Error(`${label} lacks ${missing}`);
  return record;
}

function taggedRecord(
  value: unknown,
  fields: readonly string[],
  kind: string,
  label: string,
): Record<string, unknown> {
  const record = closedRecord(value, fields, label);
  if (record["kind"] !== kind || record["version"] !== 1) {
    throw new Error(`${label} has unsupported identity`);
  }
  return record;
}

function assertDerivedDigest(
  record: Record<string, unknown>,
  digestField: string,
  label: string,
): void {
  const actual = record[digestField];
  if (typeof actual !== "string" || !SHA256.test(actual)) {
    throw new Error(`${label} digest must be one lowercase SHA-256`);
  }
  const payload = { ...record };
  delete payload[digestField];
  if (digest(payload) !== actual) throw new Error(`${label} digest is inconsistent`);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((member) => typeof member !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
}

function validateGitReceipt(value: unknown, label: string): CohortGitChangeReceiptV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = closedRecord(
    value,
    [
      "kind",
      "version",
      "attestationId",
      "generation",
      ...(Object.hasOwn(value, "cohort") ? ["cohort"] : ["taskId"]),
      "operationId",
      "requestDigest",
      "oldHead",
      "newHead",
      "tree",
      "objectOids",
      "paths",
      "committedAt",
    ],
    label,
  );
  if (record["kind"] !== "cq-git-change-receipt") throw new Error(`${label} has an unsupported kind`);
  if (record["version"] === 1) {
    if (typeof record["taskId"] !== "string" || !/^T\d+$/u.test(record["taskId"]) || Object.hasOwn(record, "cohort")) {
      throw new Error(`${label} must contain only its task subject`);
    }
  } else if (record["version"] === 2) {
    if (Object.hasOwn(record, "taskId")) throw new Error(`${label} cannot contain a task anchor`);
    assertCohortEffectEnvelopeV1(record["cohort"] as CohortEffectEnvelopeV1);
  } else throw new Error(`${label} has an unsupported version`);
  assertStringArray(record["objectOids"], `${label} object OIDs`);
  assertStringArray(record["paths"], `${label} paths`);
  return record as unknown as CohortGitChangeReceiptV1;
}

function validatePortableState(value: unknown): WorkCohortPortableStateV1 {
  const empty = emptyWorkCohortPortableStateV1();
  const portableFields = Object.keys(empty);
  const record = taggedRecord(
    value,
    portableFields,
    "cq-work-cohort-portable-state",
    "work cohort portable state",
  );
  for (const field of portableFields) {
    if (field === "kind" || field === "version") continue;
    if (!Array.isArray(record[field])) throw new Error(`work cohort portable state lacks ${field}`);
  }
  const portable = record as unknown as WorkCohortPortableStateV1;
  portable.activity.forEach(parseCohortActivityV1);
  if (new Set(portable.activity.map((event) => event.activityId)).size !== portable.activity.length) throw new Error("cohort activity repeats an event identity");
  for (const [index, run] of portable.investigationRuns.entries()) {
    validateInvestigationRunAgainstState(portable, run);
    const prior = portable.investigationRuns.slice(0, index).findLast((value) => value.plan.planDigest === run.plan.planDigest);
    if ((prior?.runDigest ?? null) !== run.priorRunDigest || run.sequence !== (prior === undefined ? 0 : prior.sequence + 1)) {
      throw new Error("investigation run restore lacks its exact contiguous history");
    }
  }
  if (new Set(portable.investigationRuns.map((run) => run.runDigest)).size !== portable.investigationRuns.length) {
    throw new Error("investigation run restore repeats a run revision");
  }

  for (const observation of portable.observations) {
    const validated = taggedRecord(
      observation,
      [
        "kind", "version", "producer", "producerRevision", "inputDigest",
        "observationSetDigest", "workset", "manifest", "repository", "environment",
        "sourceGraphDigest", "atoms", "members", "authenticatedBenefitReceipts",
        "unavailableFacts", "observationDigest",
      ],
      "cq-cohort-admission-observation",
      "cohort observation",
    );
    assertDerivedDigest(validated, "observationDigest", "cohort observation");
  }
  for (const atom of portable.commonAtoms) {
    const validated = taggedRecord(
      atom,
      [
        "kind", "version", "phase", "witness", "sharedRegression", "canonicalFullGate",
        "reviewerClass", "deploymentClass", "finalizationClass", "repository", "environment",
        "splitConditions", "atomDigest",
      ],
      "cq-cohort-common-boundary-atom",
      "cohort common atom",
    );
    assertDerivedDigest(validated, "atomDigest", "cohort common atom");
  }
  for (const matrix of portable.frozenMatrices) {
    const validated = taggedRecord(
      matrix,
      [
        "kind", "version", "atomDigest", "members", "normalizedCommandClasses",
        "sharedRegression", "canonicalFullGate", "matrixDigest",
      ],
      "cq-cohort-acceptance-matrix",
      "cohort acceptance matrix",
    );
    assertDerivedDigest(validated, "matrixDigest", "cohort acceptance matrix");
  }
  for (const decision of portable.decisions) {
    const validated = taggedRecord(
      decision,
      [
        "kind", "version", "producer", "producerRevision", "observationSetDigest",
        "worksetRevision", "manifestRevision", "repository", "environment", "inputDigest",
        "selectedAtomDigest", "matrix", "includedMemberRefs", "excluded", "memberProofs",
        "splitConditions", "benefit", "decisionDigest",
      ],
      "cq-cohort-decision",
      "cohort decision",
    );
    assertDerivedDigest(validated, "decisionDigest", "cohort decision");
  }
  for (const definition of portable.definitions) {
    const validated = taggedRecord(
      definition,
      [
        "kind", "version", "cohortId", "definitionGeneration", "phase", "members",
        "selectedAtomDigest", "acceptanceMatrixDigest", "repository", "environment",
        "splitConditions", "semanticDigest", "definitionDigest",
      ],
      "cq-cohort-definition-identity",
      "cohort definition",
    );
    const semantic = {
      cohortId: validated["cohortId"],
      phase: validated["phase"],
      members: validated["members"],
      selectedAtomDigest: validated["selectedAtomDigest"],
      acceptanceMatrixDigest: validated["acceptanceMatrixDigest"],
      repository: validated["repository"],
      environment: validated["environment"],
      splitConditions: validated["splitConditions"],
    };
    if (digest(semantic) !== validated["semanticDigest"]) {
      throw new Error("cohort definition digest is inconsistent with its semantic payload");
    }
    assertDerivedDigest(validated, "definitionDigest", "cohort definition");
  }
  for (const intent of portable.candidateIntents) {
    const definition = portable.definitions.find((value) => value.definitionDigest === intent.definitionDigest);
    if (definition === undefined) throw new Error("cohort candidate intent lacks its definition");
    assertCohortCandidateIntentV1(intent, definition);
  }
  if (new Set(portable.candidateIntents.map((intent) => intent.operationId)).size !== portable.candidateIntents.length) {
    throw new Error("cohort candidate intent operation is duplicated or rebound");
  }
  const intentDispatches = new Map<string, string>();
  for (const attempt of portable.candidateAttempts) {
    const staged = attempt.state === "staged";
    const validated = taggedRecord(
      attempt,
      staged
        ? [
            "kind", "version", "definitionDigest", "intent", "preparedDispatch", "state",
            "pendingAttemptDigest", "g213", "candidateAttemptDigest",
          ]
        : [
            "kind", "version", "definitionDigest", "intent", "preparedDispatch", "state",
            "pendingAttemptDigest", "candidateAttemptDigest",
          ],
      "cq-cohort-candidate-attempt",
      "cohort candidate attempt",
    );
    if ((staged && validated["state"] !== "staged") || (!staged && validated["state"] !== "pending")) {
      throw new Error("cohort candidate attempt has unsupported state");
    }
    const pendingBase = {
      kind: validated["kind"],
      version: validated["version"],
      definitionDigest: validated["definitionDigest"],
      intent: validated["intent"],
      preparedDispatch: validated["preparedDispatch"],
    };
    if (digest(pendingBase) !== validated["pendingAttemptDigest"]) {
      throw new Error("cohort pending attempt digest is inconsistent");
    }
    assertDerivedDigest(validated, "candidateAttemptDigest", "cohort candidate attempt");
    const definition = portable.definitions.find((value) => value.definitionDigest === attempt.definitionDigest);
    if (definition === undefined) throw new Error("cohort candidate intent lacks its definition");
    assertCohortCandidateIntentV1(attempt.intent, definition);
    if (!portable.candidateIntents.some((intent) => canonical(intent) === canonical(attempt.intent))) {
      throw new Error("cohort prepared attempt lacks its durable pre-dispatch intent");
    }
    const prior = intentDispatches.get(attempt.intent.intentDigest);
    const prepared = canonical(attempt.preparedDispatch);
    if (prior !== undefined && prior !== prepared) throw new Error("cohort candidate intent binds competing dispatches");
    intentDispatches.set(attempt.intent.intentDigest, prepared);
  }
  for (const seal of portable.candidateSeals) {
    const validated = taggedRecord(
      seal,
      [
        "kind", "version", "definitionDigest", "candidateAttemptDigest", "baseCommit",
        "resultCommit", "resultTree", "wholeDiff", "wholeDiffDigest", "gitReceipts",
        "gitReceiptBridgeDigest", "sealDigest",
      ],
      "cq-cohort-candidate-seal",
      "cohort candidate seal",
    );
    if (digest(validated["wholeDiff"]) !== validated["wholeDiffDigest"]) {
      throw new Error("cohort candidate seal whole-diff digest is inconsistent");
    }
    if (!Array.isArray(validated["gitReceipts"])) {
      throw new Error("cohort candidate seal receipts must be an array");
    }
    validated["gitReceipts"].forEach((receipt, index) =>
      validateGitReceipt(receipt, `cohort candidate seal receipt ${index}`),
    );
    if (digest(validated["gitReceipts"]) !== validated["gitReceiptBridgeDigest"]) {
      throw new Error("cohort candidate seal receipt digest is inconsistent");
    }
    assertDerivedDigest(validated, "sealDigest", "cohort candidate seal");
  }

  const simpleCollections: readonly {
    readonly values: readonly unknown[];
    readonly fields: readonly string[];
    readonly kind: string;
    readonly digestField: string;
    readonly label: string;
  }[] = [
    { values: portable.evidenceSubjects, fields: ["kind", "version", "definitionDigest", "sealDigest", "evidenceSubjectDigest"], kind: "cq-cohort-evidence-subject", digestField: "evidenceSubjectDigest", label: "cohort evidence subject" },
    { values: portable.receiptBridges, fields: ["kind", "version", "candidateAttemptDigest", "sealDigest", "receipts", "bridgeDigest"], kind: "cq-cohort-receipt-bridge", digestField: "bridgeDigest", label: "cohort receipt bridge" },
    { values: portable.g213Acknowledgements, fields: ["kind", "version", "candidateAttemptDigest", "attestationId", "generation", "partitionKey", "enrollmentId", "attemptId", "qualificationDigest", "qualifiedOutputDigest", "sealDigest", "acknowledgementDigest"], kind: "cq-cohort-g213-binding-acknowledgement", digestField: "acknowledgementDigest", label: "cohort G213 acknowledgement" },
    { values: portable.acceptanceTransitions, fields: ["kind", "version", "definitionDigest", "evidenceSubjectDigest", "eligible", "replacementEvidenceSubjectDigest", "transitionDigest"], kind: "cq-cohort-candidate-acceptance-transition", digestField: "transitionDigest", label: "cohort acceptance transition" },
    { values: portable.reservationTransitions, fields: ["kind", "version", "reservationId", "cohortId", "definitionDigest", "memberRefs", "transition", "transitionDigest"], kind: "cq-cohort-reservation-transition", digestField: "transitionDigest", label: "cohort reservation transition" },
    { values: portable.memberTransitions, fields: ["kind", "version", "cohortId", "definitionDigest", "memberRef", "from", "to", "transitionDigest"], kind: "cq-cohort-member-transition", digestField: "transitionDigest", label: "cohort member transition" },
    { values: portable.splitLineage, fields: ["kind", "version", "parentDefinitionDigest", "childDefinitionDigests", "reason", "splitDigest"], kind: "cq-cohort-split-lineage", digestField: "splitDigest", label: "cohort split lineage" },
    { values: portable.probeIdentities, fields: ["kind", "version", "evidenceSubjectDigest", "probeKind", "probeEpoch", "commandDigest", "probeDigest"], kind: "cq-cohort-probe-identity", digestField: "probeDigest", label: "cohort probe identity" },
    { values: portable.commandEvidence, fields: ["kind", "version", "evidenceSubjectDigest", "acceptanceMatrixDigest", "probeDigest", "evidenceKind", "passed", "receiptDigest", "execution", "evidenceDigest"], kind: "cq-cohort-command-evidence", digestField: "evidenceDigest", label: "cohort command evidence" },
    { values: portable.completionReceipts, fields: ["kind", "version", "definitionDigest", "sealDigest", "evidenceSubjectDigest", "focusedEvidenceDigests", "sharedRegressionEvidenceDigest", "fullGateEvidenceDigest", "completionDigest"], kind: "cq-cohort-completion-receipt", digestField: "completionDigest", label: "cohort completion receipt" },
  ];
  for (const collection of simpleCollections) {
    for (const value of collection.values) {
      const validated = taggedRecord(value, collection.fields, collection.kind, collection.label);
      if (collection.kind === "cq-cohort-receipt-bridge") {
        if (!Array.isArray(validated["receipts"])) {
          throw new Error("cohort receipt bridge receipts must be an array");
        }
        validated["receipts"].forEach((receipt, index) =>
          validateGitReceipt(receipt, `cohort receipt bridge receipt ${index}`),
        );
      }
      assertDerivedDigest(validated, collection.digestField, collection.label);
    }
  }
  for (const operation of portable.operations) {
    const validated = closedRecord(
      operation,
      ["operationId", "requestDigest", "result"],
      "work cohort operation",
    );
    if (
      typeof validated["operationId"] !== "string" ||
      typeof validated["requestDigest"] !== "string" ||
      !SHA256.test(validated["requestDigest"])
    ) {
      throw new Error("work cohort operation has invalid identity");
    }
  }
  if (new Set(portable.operations.map((operation) => operation.operationId)).size !== portable.operations.length) {
    throw new Error("work cohort portable state repeats an operation id");
  }

  const definitions = new Set(portable.definitions.map((definition) => definition.definitionDigest));
  const attempts = new Set(portable.candidateAttempts.map((attempt) => attempt.candidateAttemptDigest));
  const seals = new Map(portable.candidateSeals.map((seal) => [seal.sealDigest, seal]));
  for (const definition of portable.definitions) {
    if (!portable.frozenMatrices.some((matrix) => matrix.matrixDigest === definition.acceptanceMatrixDigest)) {
      throw new Error("cohort definition lacks its frozen acceptance matrix");
    }
  }
  for (const attempt of portable.candidateAttempts) {
    if (!definitions.has(attempt.definitionDigest)) {
      throw new Error("cohort candidate attempt lacks its definition");
    }
    if (attempt.state === "staged" && attempt.g213.guardedRebase !== undefined) {
      const guarded = attempt.g213.guardedRebase;
      assertCohortGuardedCandidateBridgeV1(guarded, attempt.preparedDispatch, attempt.g213.observedBaseCommit);
      if (guarded.bridge.cohort.state !== "sealed") throw new Error("cohort guarded source is not sealed");
      const subject = guarded.bridge.cohort.evidenceSubject;
      const sourceSeal = seals.get(subject.sealDigest);
      const sourceAttempt = portable.candidateAttempts.find((entry) => entry.candidateAttemptDigest === sourceSeal?.candidateAttemptDigest);
      if (sourceSeal?.resultCommit !== guarded.bridge.oldResultCommit || sourceSeal.definitionDigest !== attempt.definitionDigest ||
          sourceAttempt?.preparedDispatch.attestationId !== guarded.transition.source.attestationId ||
          sourceAttempt.preparedDispatch.generation !== guarded.transition.source.generation ||
          !portable.evidenceSubjects.some((entry) => canonical(entry) === canonical(subject))) {
        throw new Error("cohort guarded candidate lost its exact historical sealed source");
      }
    }
  }
  for (const seal of portable.candidateSeals) {
    if (!definitions.has(seal.definitionDigest) || !attempts.has(seal.candidateAttemptDigest)) {
      throw new Error("cohort candidate seal lacks its definition or attempt");
    }
  }
  for (const subject of portable.evidenceSubjects) {
    const seal = seals.get(subject.sealDigest);
    if (seal === undefined || seal.definitionDigest !== subject.definitionDigest) {
      throw new Error("cohort evidence subject lacks its exact definition and seal");
    }
  }
  for (const bridge of portable.receiptBridges) {
    const seal = seals.get(bridge.sealDigest);
    if (
      seal === undefined ||
      seal.candidateAttemptDigest !== bridge.candidateAttemptDigest ||
      canonical(seal.gitReceipts) !== canonical(bridge.receipts)
    ) {
      throw new Error("cohort receipt bridge differs from its exact seal");
    }
  }
  for (const evidence of portable.commandEvidence) {
    if (evidence.execution === null) continue;
    const subject = portable.evidenceSubjects.find((value) => value.evidenceSubjectDigest === evidence.evidenceSubjectDigest);
    const definition = portable.definitions.find((value) => value.definitionDigest === subject?.definitionDigest);
    const seal = portable.candidateSeals.find((value) => value.sealDigest === subject?.sealDigest);
    const attempt = portable.candidateAttempts.find((value) => value.candidateAttemptDigest === seal?.candidateAttemptDigest);
    const matrix = portable.frozenMatrices.find((value) => value.matrixDigest === definition?.acceptanceMatrixDigest);
    if (definition === undefined || seal === undefined || attempt?.state !== "staged" || matrix === undefined ||
        evidence.receiptDigest !== evidence.execution.receiptDigest ||
        evidence.passed !== (evidence.execution.outcome.exitCode === 0) || evidence.evidenceKind !== evidence.execution.purpose) {
      throw new Error("portable cohort evidence differs from its runner receipt");
    }
    validateCohortExecutionBindingV1(evidence.execution, {
      definition, seal, attempt, matrix, evidenceSubjectDigest: evidence.evidenceSubjectDigest,
    });
  }
  const completionHandoffs = new Map<string, CohortCompletionHandoffV1>();
  for (const handoff of portable.completionHandoffs) {
    assertCohortCompletionHandoffTransitionV1(completionHandoffs.get(handoff.operationId) ?? null, handoff);
    const definition = portable.definitions.find((value) => value.definitionDigest === handoff.definitionDigest);
    const atom = portable.commonAtoms.find((value) => value.atomDigest === definition?.selectedAtomDigest);
    if (definition === undefined || atom === undefined) throw new Error("cohort completion handoff lacks its exact common boundary");
    assertCohortCompletionHandoffBindingsV1(handoff, definition, atom);
    if (!portable.completionReceipts.some((receipt) => receipt.definitionDigest === handoff.definitionDigest &&
        receipt.sealDigest === handoff.sealDigest && receipt.evidenceSubjectDigest === handoff.evidenceSubjectDigest)) {
      throw new Error("cohort completion handoff lacks its accepted sealed candidate");
    }
    completionHandoffs.set(handoff.operationId, handoff);
  }
  return clone(portable);
}

export class WorkCohortOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkCohortOperationConflictError";
  }
}

export class WorkCohortReservationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkCohortReservationConflictError";
  }
}

export class WorkCohortStaleAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkCohortStaleAuthorityError";
  }
}

export class CohortRepositoryExecutorUnavailableError extends Error {
  constructor(operation: string) {
    super(`work cohort ${operation} requires a repository executor`);
    this.name = "CohortRepositoryExecutorUnavailableError";
  }
}

export interface CohortReceiptBridgeV1 {
  readonly kind: "cq-cohort-receipt-bridge";
  readonly version: 1;
  readonly candidateAttemptDigest: string;
  readonly sealDigest: string;
  readonly receipts: readonly CohortGitChangeReceiptV1[];
  readonly bridgeDigest: string;
}

export interface CohortG213BindingAcknowledgementV1 {
  readonly kind: "cq-cohort-g213-binding-acknowledgement";
  readonly version: 1;
  readonly candidateAttemptDigest: string;
  readonly attestationId: string;
  readonly generation: number;
  readonly partitionKey: string;
  readonly enrollmentId: string;
  readonly attemptId: string;
  readonly qualificationDigest: string;
  readonly qualifiedOutputDigest: string;
  readonly sealDigest: string;
  readonly acknowledgementDigest: string;
}

export interface CohortCandidateAcceptanceTransitionV1 {
  readonly kind: "cq-cohort-candidate-acceptance-transition";
  readonly version: 1;
  readonly definitionDigest: string;
  readonly evidenceSubjectDigest: string;
  readonly eligible: boolean;
  readonly replacementEvidenceSubjectDigest: string | null;
  readonly transitionDigest: string;
}

export interface CohortReservationTransitionV1 {
  readonly kind: "cq-cohort-reservation-transition";
  readonly version: 1;
  readonly reservationId: string;
  readonly cohortId: string;
  readonly definitionDigest: string;
  readonly memberRefs: readonly string[];
  readonly transition: "reserved" | "released";
  readonly transitionDigest: string;
}

export interface CohortMemberTransitionV1 {
  readonly kind: "cq-cohort-member-transition";
  readonly version: 1;
  readonly cohortId: string;
  readonly definitionDigest: string;
  readonly memberRef: string;
  readonly from: "planned" | "reserved" | "running" | "completed" | "released";
  readonly to: "reserved" | "running" | "completed" | "released";
  readonly transitionDigest: string;
}

export interface CohortSplitLineageV1 {
  readonly kind: "cq-cohort-split-lineage";
  readonly version: 1;
  readonly parentDefinitionDigest: string;
  readonly childDefinitionDigests: readonly string[];
  readonly reason: string;
  readonly splitDigest: string;
}

export interface CohortProbeIdentityV1 {
  readonly kind: "cq-cohort-probe-identity";
  readonly version: 1;
  readonly evidenceSubjectDigest: string;
  readonly probeKind: "focused" | "shared-regression" | "full-gate";
  readonly probeEpoch: number;
  readonly commandDigest: string;
  readonly probeDigest: string;
}

export interface CohortCommandEvidenceV1 {
  readonly kind: "cq-cohort-command-evidence";
  readonly version: 1;
  readonly evidenceSubjectDigest: string;
  readonly acceptanceMatrixDigest: string;
  readonly probeDigest: string;
  readonly evidenceKind: "focused" | "shared-regression" | "full-gate";
  readonly passed: boolean;
  readonly receiptDigest: string;
  readonly execution: CohortCommandExecutionV1 | null;
  readonly evidenceDigest: string;
}

export interface CohortCompletionReceiptV1 {
  readonly kind: "cq-cohort-completion-receipt";
  readonly version: 1;
  readonly definitionDigest: string;
  readonly sealDigest: string;
  readonly evidenceSubjectDigest: string;
  readonly focusedEvidenceDigests: readonly string[];
  readonly sharedRegressionEvidenceDigest: string;
  readonly fullGateEvidenceDigest: string;
  readonly completionDigest: string;
}

export interface WorkCohortOperationRecordV1 {
  readonly operationId: string;
  readonly requestDigest: string;
  readonly result: unknown;
}

export interface WorkCohortPortableStateV1 {
  readonly kind: "cq-work-cohort-portable-state";
  readonly version: 1;
  readonly observations: readonly CohortAdmissionObservationV1[];
  readonly commonAtoms: readonly CohortCommonBoundaryAtomV1[];
  readonly frozenMatrices: readonly CohortAcceptanceMatrixV1[];
  readonly decisions: readonly CohortDecisionV1[];
  readonly definitions: readonly CohortDefinitionIdentityV1[];
  readonly candidateIntents: readonly CohortCandidateIntentV1[];
  readonly candidateAttempts: readonly CohortCandidateAttemptV1[];
  readonly candidateSeals: readonly CohortCandidateSealV1[];
  readonly evidenceSubjects: readonly CohortEvidenceSubjectV1[];
  readonly receiptBridges: readonly CohortReceiptBridgeV1[];
  readonly g213Acknowledgements: readonly CohortG213BindingAcknowledgementV1[];
  readonly acceptanceTransitions: readonly CohortCandidateAcceptanceTransitionV1[];
  readonly reservationTransitions: readonly CohortReservationTransitionV1[];
  readonly memberTransitions: readonly CohortMemberTransitionV1[];
  readonly splitLineage: readonly CohortSplitLineageV1[];
  readonly probeIdentities: readonly CohortProbeIdentityV1[];
  readonly commandEvidence: readonly CohortCommandEvidenceV1[];
  readonly completionReceipts: readonly CohortCompletionReceiptV1[];
  readonly completionHandoffs: readonly CohortCompletionHandoffV1[];
  readonly investigationRuns: readonly InvestigationCohortRunV1[];
  readonly activity: readonly CohortActivityV1[];
  readonly operations: readonly WorkCohortOperationRecordV1[];
}

interface WorkCohortRuntimeStateV1 {
  readonly executionEpoch: string;
  readonly resumeRequired: boolean;
  readonly lease: {
    readonly holderId: string;
    readonly semanticSubject: string;
    readonly capabilityDigest: string;
  } | null;
  readonly resumeValidation: {
    readonly evidenceSubjectDigest: string;
    readonly validationDigest: string;
  } | null;
}

export interface WorkCohortStoredDocumentV1 {
  readonly portable: WorkCohortPortableStateV1;
  readonly runtime: WorkCohortRuntimeStateV1;
  readonly revision: number;
}

function renewedEpochActivity(current: WorkCohortStoredDocumentV1, semanticSubject: string): WorkCohortPortableStateV1 {
  if (!current.runtime.resumeRequired) return current.portable;
  return { ...current.portable, activity: [...current.portable.activity, createCohortActivityV1({
    semanticSubject, executionEpoch: current.runtime.executionEpoch, executions: [],
    measurements: [{ measurement: "executionEpochRenewals", value: 1 }],
  })] };
}

function validateInvestigationRunAgainstState(state: WorkCohortPortableStateV1, run: InvestigationCohortRunV1): void {
  validateInvestigationCohortRunV1(run);
  const definition = state.definitions.find((value) => value.definitionDigest === run.plan.definition.definitionDigest);
  if (definition === undefined || canonical(definition) !== canonical(run.plan.definition)) throw new Error("investigation run lacks its exact durable definition");
  const observation = resolveCohortDefinitionObservationV1({ definition, decisions: state.decisions, observations: state.observations });
  const plan = createInvestigationCohortPlanV1({ definition, observation, members: run.plan.members,
    explorer: run.plan.explorer, prober: run.plan.prober });
  if (canonical(plan) !== canonical(run.plan)) throw new Error("investigation plan differs from its frozen observation");
}

export interface WorkCohortPersistence {
  read(): Promise<WorkCohortStoredDocumentV1>;
  transact<T>(
    mutation: (current: WorkCohortStoredDocumentV1) => {
      readonly next: WorkCohortStoredDocumentV1;
      readonly result: T;
    },
  ): Promise<T>;
  replacePortable(portable: WorkCohortPortableStateV1): Promise<void>;
  clear(): Promise<void>;
  rotateRuntime(): Promise<void>;
}

export function emptyWorkCohortPortableStateV1(): WorkCohortPortableStateV1 {
  return {
    kind: "cq-work-cohort-portable-state",
    version: 1,
    observations: [],
    commonAtoms: [],
    frozenMatrices: [],
    decisions: [],
    definitions: [],
    candidateIntents: [],
    candidateAttempts: [],
    candidateSeals: [],
    evidenceSubjects: [],
    receiptBridges: [],
    g213Acknowledgements: [],
    acceptanceTransitions: [],
    reservationTransitions: [],
    memberTransitions: [],
    splitLineage: [],
    probeIdentities: [],
    commandEvidence: [],
    completionReceipts: [],
    completionHandoffs: [],
    investigationRuns: [],
    activity: [],
    operations: [],
  };
}

export function newWorkCohortStoredDocumentV1(
  portable: WorkCohortPortableStateV1 = emptyWorkCohortPortableStateV1(),
): WorkCohortStoredDocumentV1 {
  return {
    portable: clone(portable),
    runtime: {
      executionEpoch: randomUUID(),
      resumeRequired: false,
      lease: null,
      resumeValidation: null,
    },
    revision: 0,
  };
}

export function parseWorkCohortPortableStateV1(source: string): WorkCohortPortableStateV1 {
  return validatePortableState(JSON.parse(source) as unknown);
}

export function serializeWorkCohortPortableStateV1(state: WorkCohortPortableStateV1): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function appendExact<T>(
  values: T[],
  key: (value: T) => string,
  candidate: T,
  label: string,
): T {
  const candidateKey = key(candidate);
  const prior = values.find((value) => key(value) === candidateKey);
  if (prior !== undefined) {
    if (canonical(prior) !== canonical(candidate)) {
      throw new WorkCohortOperationConflictError(`altered ${label} replay`);
    }
    return prior;
  }
  values.push(candidate);
  return candidate;
}

type MutablePortable = {
  -readonly [K in keyof WorkCohortPortableStateV1]:
    WorkCohortPortableStateV1[K] extends readonly (infer V)[] ? V[] : WorkCohortPortableStateV1[K];
};

function mutablePortable(state: WorkCohortPortableStateV1): MutablePortable {
  return clone(state) as MutablePortable;
}

function latestDefinition(
  state: WorkCohortPortableStateV1,
  cohortId: string,
): CohortDefinitionIdentityV1 | undefined {
  return state.definitions
    .filter((definition) => definition.cohortId === cohortId)
    .sort((left, right) => right.definitionGeneration - left.definitionGeneration)[0];
}

function assertEligibleEvidenceSubject(
  state: WorkCohortPortableStateV1,
  evidenceSubjectDigest: string,
): void {
  const subject = state.evidenceSubjects.find(
    (value) => value.evidenceSubjectDigest === evidenceSubjectDigest,
  );
  const definition = state.definitions.find(
    (value) => value.definitionDigest === subject?.definitionDigest,
  );
  const acceptance = state.acceptanceTransitions.findLast(
    (value) => value.evidenceSubjectDigest === evidenceSubjectDigest,
  );
  if (
    definition === undefined ||
    latestDefinition(state, definition.cohortId)?.definitionDigest !== definition.definitionDigest ||
    acceptance?.definitionDigest !== definition.definitionDigest ||
    !acceptance.eligible
  ) {
    throw new WorkCohortStaleAuthorityError("cohort evidence subject is superseded or ineligible");
  }
  const seal = state.candidateSeals.find((value) => value.sealDigest === subject?.sealDigest);
  const attempt = state.candidateAttempts.find((value) => value.candidateAttemptDigest === seal?.candidateAttemptDigest);
  if (attempt === undefined) throw new WorkCohortStaleAuthorityError("cohort evidence lacks its candidate intent");
  assertCurrentCandidateIntent(state, definition.definitionDigest, attempt.intent.intentDigest);
}

function exactReservationDefinition(
  state: WorkCohortPortableStateV1,
  input: {
    readonly cohortId: string;
    readonly definitionDigest: string;
    readonly memberRefs: readonly string[];
  },
): CohortDefinitionIdentityV1 {
  const definition = state.definitions.find(
    (candidate) => candidate.definitionDigest === input.definitionDigest,
  );
  const expectedMembers = definition?.members.map((member) => member.memberRef);
  if (
    definition === undefined ||
    definition.cohortId !== input.cohortId ||
    canonical(expectedMembers) !== canonical(input.memberRefs)
  ) {
    throw new WorkCohortReservationConflictError(
      "reservation differs from the exact definition membership",
    );
  }
  return definition;
}

function assertCurrentCandidateIntent(
  state: WorkCohortPortableStateV1, definitionDigest: string, intentDigest: string,
): void {
  const definition = state.definitions.find((value) => value.definitionDigest === definitionDigest);
  if (definition === undefined || latestDefinition(state, definition.cohortId)?.definitionDigest !== definitionDigest ||
      state.candidateIntents.findLast((value) => value.definitionDigest === definitionDigest)?.intentDigest !== intentDigest) {
    throw new WorkCohortStaleAuthorityError("cohort authority refers to a superseded candidate intent or definition");
  }
}

function activeReservations(
  state: WorkCohortPortableStateV1,
): ReadonlyMap<string, CohortReservationTransitionV1> {
  const active = new Map<string, CohortReservationTransitionV1>();
  for (const transition of state.reservationTransitions) {
    if (transition.transition === "reserved") active.set(transition.reservationId, transition);
    else active.delete(transition.reservationId);
  }
  return active;
}

function assertAcceptanceReservation(state: WorkCohortPortableStateV1, evidenceSubjectDigest: string): void {
  assertEligibleEvidenceSubject(state, evidenceSubjectDigest);
  const subject = state.evidenceSubjects.find((value) => value.evidenceSubjectDigest === evidenceSubjectDigest);
  const definition = state.definitions.find((value) => value.definitionDigest === subject?.definitionDigest);
  if (definition === undefined || ![...activeReservations(state).values()].some((reservation) =>
    reservation.definitionDigest === definition.definitionDigest && reservation.cohortId === definition.cohortId &&
    canonical(reservation.memberRefs) === canonical(definition.members.map((member) => member.memberRef)))) {
    throw new WorkCohortReservationConflictError("cohort acceptance requires its exact all-member reservation");
  }
}

function operationMutation<T>(
  current: WorkCohortStoredDocumentV1,
  operationId: string,
  request: unknown,
  apply: (portable: MutablePortable) => T,
): { readonly next: WorkCohortStoredDocumentV1; readonly result: T } {
  assertNonEmpty(operationId, "work cohort operation id");
  const requestDigest = digest(request);
  const prior = current.portable.operations.find((operation) => operation.operationId === operationId);
  if (prior !== undefined) {
    if (prior.requestDigest !== requestDigest) {
      throw new WorkCohortOperationConflictError("altered work cohort operation replay");
    }
    return { next: current, result: clone(prior.result) as T };
  }
  const portable = mutablePortable(current.portable);
  const result = apply(portable);
  portable.operations.push({ operationId, requestDigest, result: clone(result) });
  return {
    next: { ...current, portable, revision: current.revision + 1 },
    result,
  };
}

export interface CohortSealResultV1 {
  readonly seal: CohortCandidateSealV1;
  readonly evidenceSubject: CohortEvidenceSubjectV1;
  readonly receiptBridge: CohortReceiptBridgeV1;
  readonly g213Acknowledgement: CohortG213BindingAcknowledgementV1;
}

export interface WorkCohortLeaseV1 {
  readonly holderId: string;
  readonly semanticSubject: string;
  readonly executionEpoch: string;
  readonly capability: string;
}

export interface WorkCohortStore {
  snapshot(): Promise<WorkCohortStoredDocumentV1>;
  recordActivity(activity: CohortActivityV1): Promise<void>;
  recordObservation(operationId: string, observation: CohortAdmissionObservationV1): Promise<CohortAdmissionObservationV1>;
  recordDecision(operationId: string, decision: CohortDecisionV1): Promise<CohortDecisionV1>;
  recordDefinition(operationId: string, definition: CohortDefinitionIdentityV1): Promise<CohortDefinitionIdentityV1>;
  recordCandidateIntent(operationId: string, intent: CohortCandidateIntentV1): Promise<CohortCandidateIntentV1>;
  recordInvestigationRun(lease: WorkCohortLeaseV1, operationId: string, proof: AuthorizedInvestigationRunV1): Promise<InvestigationCohortRunV1>;
  revalidateInvestigationForResume(proof: AuthorizedInvestigationRunV1): Promise<void>;
  recordCandidateAttempt(operationId: string, attempt: CohortCandidateAttemptV1): Promise<CohortCandidateAttemptV1>;
  sealCandidate(operationId: string, request: CohortCandidateSealRequestV1): Promise<CohortSealResultV1>;
  transitionReservation(operationId: string, transition: Omit<CohortReservationTransitionV1, "kind" | "version" | "transitionDigest">): Promise<CohortReservationTransitionV1>;
  transitionMember(operationId: string, transition: Omit<CohortMemberTransitionV1, "kind" | "version" | "transitionDigest">): Promise<CohortMemberTransitionV1>;
  recordSplit(operationId: string, split: Omit<CohortSplitLineageV1, "kind" | "version" | "splitDigest">): Promise<CohortSplitLineageV1>;
  recordProbe(operationId: string, probe: Omit<CohortProbeIdentityV1, "kind" | "version" | "probeDigest">): Promise<CohortProbeIdentityV1>;
  recordCommandEvidence(operationId: string, evidence: Omit<CohortCommandEvidenceV1, "kind" | "version" | "evidenceDigest" | "execution">): Promise<CohortCommandEvidenceV1>;
  recordProtectedCommandEvidence(operationId: string, lease: WorkCohortLeaseV1, receipt: AuthorizedCohortCommandExecutionV1): Promise<CohortCommandEvidenceV1>;
  finalize(operationId: string, input: { readonly definitionDigest: string; readonly evidenceSubjectDigest: string }): Promise<CohortCompletionReceiptV1>;
  recordCompletionHandoff(operationId: string, lease: WorkCohortLeaseV1, envelope: CohortEffectEnvelopeV1,
    authority: AuthorizedCohortCompletionHandoffV1): Promise<CohortCompletionHandoffV1>;
  acquireLease(input: { readonly holderId: string; readonly semanticSubject: string }): Promise<WorkCohortLeaseV1>;
  acquireLeaseAndPublish(input: { readonly holderId: string; readonly semanticSubject: string },
    publish: (lease: WorkCohortLeaseV1) => undefined): Promise<WorkCohortLeaseV1>;
  bindLeaseToSeal(lease: WorkCohortLeaseV1, envelope: CohortEffectEnvelopeV1): Promise<WorkCohortLeaseV1>;
  transitionLeaseToSuccessor(lease: WorkCohortLeaseV1, source: CohortEffectEnvelopeV1,
    successor: CohortEffectEnvelopeV1, publish: (lease: WorkCohortLeaseV1) => undefined): Promise<WorkCohortLeaseV1>;
  releaseLease(lease: WorkCohortLeaseV1): Promise<void>;
  revalidateForResume(input: { readonly definitionDigest: string; readonly sealDigest: string; readonly evidenceSubjectDigest: string; readonly acceptanceMatrixDigest: string; readonly environmentDigest: string; readonly receiptBridgeDigest: string }): Promise<string>;
  revalidatePreparationForResume(envelope: CohortEffectEnvelopeV1): Promise<string>;
  beginNewExecutionEpoch(): Promise<void>;
  assertLiveAuthority(lease: WorkCohortLeaseV1): Promise<void>;
  assertLiveAcceptanceAuthority(lease: WorkCohortLeaseV1): Promise<void>;
  assertLiveCohortAuthority(lease: WorkCohortLeaseV1, envelope: CohortEffectEnvelopeV1): Promise<void>;
  publishLiveCohortEffect(lease: WorkCohortLeaseV1, envelope: CohortEffectEnvelopeV1, publish: () => undefined): Promise<void>;
  exportPortableState(): Promise<string>;
  restorePortableState(state: WorkCohortPortableStateV1): Promise<void>;
}

export class PersistentWorkCohortStore implements WorkCohortStore {
  readonly #persistence: WorkCohortPersistence;

  constructor(persistence: WorkCohortPersistence) {
    this.#persistence = persistence;
  }

  snapshot(): Promise<WorkCohortStoredDocumentV1> {
    return this.#persistence.read();
  }

  async recordActivity(input: CohortActivityV1): Promise<void> {
    const activity = parseCohortActivityV1(input);
    await this.#persistence.transact((current) => {
      const events = [...current.portable.activity];
      appendExact(events, (event) => event.activityId, activity, "cohort activity");
      if (events.length === current.portable.activity.length) return { next: current, result: undefined };
      return { next: { ...current, portable: { ...current.portable, activity: events }, revision: current.revision + 1 }, result: undefined };
    });
  }

  recordInvestigationRun(lease: WorkCohortLeaseV1, operationId: string, proof: AuthorizedInvestigationRunV1) {
    const run = readAuthorizedInvestigationRunV1(proof);
    return this.#persistence.transact((current) => {
      this.assertLease(current, lease);
      if (lease.semanticSubject !== run.plan.planDigest) throw new WorkCohortStaleAuthorityError("investigation lease names another plan");
      validateInvestigationRunAgainstState(current.portable, run);
      const latest = latestDefinition(current.portable, run.plan.definition.cohortId);
      if (latest?.definitionDigest !== run.plan.definition.definitionDigest && run.state !== "split") {
        throw new WorkCohortStaleAuthorityError("investigation run refers to a superseded definition");
      }
      return operationMutation(current, operationId, run, (state) => {
        const prior = state.investigationRuns.findLast((value) => value.plan.planDigest === run.plan.planDigest);
        if ((prior?.runDigest ?? null) !== run.priorRunDigest || run.sequence !== (prior === undefined ? 0 : prior.sequence + 1)) {
          throw new WorkCohortOperationConflictError("investigation run changed its exact predecessor");
        }
        return appendExact(state.investigationRuns, (value) => value.runDigest, run, "investigation run");
      });
    });
  }

  async revalidateInvestigationForResume(proof: AuthorizedInvestigationRunV1): Promise<void> {
    const run = readAuthorizedInvestigationRunV1(proof);
    await this.#persistence.transact((current) => {
      validateInvestigationRunAgainstState(current.portable, run);
      const latest = current.portable.investigationRuns.findLast((value) => value.plan.planDigest === run.plan.planDigest);
      const emptyStart = latest === undefined && run.sequence === 0 && run.priorRunDigest === null &&
        run.state === "running" && run.split === null && run.implementationAtomDigest === null &&
        run.members.every((member) => member.explorer === null && member.explorerResult === null &&
          member.prober === null && member.proberResult === null && member.citations.length === 0 &&
          member.adjudication === null && member.confirmedCause === null);
      if ((!emptyStart && latest?.runDigest !== run.runDigest) ||
          latestDefinition(current.portable, run.plan.definition.cohortId)?.definitionDigest !== run.plan.definition.definitionDigest ||
          current.runtime.lease !== null) throw new WorkCohortStaleAuthorityError("investigation resume differs from durable current run");
      return { next: { ...current, portable: renewedEpochActivity(current, run.plan.planDigest), runtime: { ...current.runtime, resumeRequired: false,
        resumeValidation: { evidenceSubjectDigest: run.plan.planDigest, validationDigest: digest({ runDigest: run.runDigest, executionEpoch: current.runtime.executionEpoch }) } },
        revision: current.revision + 1 }, result: undefined };
    });
  }

  recordObservation(operationId: string, observation: CohortAdmissionObservationV1) {
    return this.#persistence.transact((current) =>
      operationMutation(current, operationId, observation, (state) => {
        const stored = appendExact(state.observations, (value) => value.observationDigest, observation, "observation");
        for (const atom of observation.atoms) {
          appendExact(state.commonAtoms, (value) => value.atomDigest, atom, "common atom");
        }
        return stored;
      }),
    );
  }

  recordDecision(operationId: string, decision: CohortDecisionV1) {
    return this.#persistence.transact((current) =>
      operationMutation(current, operationId, decision, (state) => {
        const observation = state.observations.find(
          (value) => value.observationSetDigest === decision.observationSetDigest,
        );
        if (observation === undefined) throw new Error("cohort decision lacks its durable observation");
        appendExact(state.frozenMatrices, (value) => value.matrixDigest, decision.matrix, "acceptance matrix");
        return appendExact(state.decisions, (value) => value.decisionDigest, decision, "decision");
      }),
    );
  }

  recordDefinition(operationId: string, definition: CohortDefinitionIdentityV1) {
    return this.#persistence.transact((current) =>
      operationMutation(current, operationId, definition, (state) => {
        const matrix = state.frozenMatrices.find(
          (value) => value.matrixDigest === definition.acceptanceMatrixDigest,
        );
        if (matrix === undefined) throw new Error("cohort definition lacks its frozen acceptance matrix");
        const latest = latestDefinition(state, definition.cohortId);
        if (latest !== undefined && latest.definitionDigest !== definition.definitionDigest) {
          if (latest.semanticDigest === definition.semanticDigest) {
            throw new WorkCohortOperationConflictError("unchanged cohort definition advanced generation");
          }
          if (definition.definitionGeneration !== latest.definitionGeneration + 1) {
            throw new WorkCohortOperationConflictError("semantic cohort definition change did not advance one generation");
          }
        }
        return appendExact(state.definitions, (value) => value.definitionDigest, definition, "definition");
      }),
    );
  }

  recordCandidateIntent(operationId: string, intent: CohortCandidateIntentV1) {
    return this.#persistence.transact((current) => {
      const definition = current.portable.definitions.find((value) => value.definitionDigest === intent.definitionDigest);
      if (definition === undefined || latestDefinition(current.portable, definition.cohortId)?.definitionDigest !== definition.definitionDigest) {
        throw new WorkCohortStaleAuthorityError("candidate intent lacks its current durable definition");
      }
      assertCohortCandidateIntentV1(intent, definition);
      return operationMutation(current, operationId, intent, (state) => {
        if (state.candidateIntents.some((prior) => prior.operationId === intent.operationId && canonical(prior) !== canonical(intent))) {
          throw new WorkCohortOperationConflictError("candidate intent operation is already bound to another definition");
        }
        return appendExact(state.candidateIntents, (value) => value.intentDigest, intent, "candidate intent");
      });
    });
  }

  recordCandidateAttempt(operationId: string, attempt: CohortCandidateAttemptV1) {
    return this.#persistence.transact((current) =>
      operationMutation(current, operationId, attempt, (state) => {
        if (attempt.state !== "pending") {
          throw new WorkCohortOperationConflictError(
            "staged candidate attempts enter cohort storage only through an authenticated seal",
          );
        }
        if (!state.definitions.some((value) => value.definitionDigest === attempt.definitionDigest)) {
          throw new Error("candidate attempt lacks its durable cohort definition");
        }
        if (!state.candidateIntents.some((value) => canonical(value) === canonical(attempt.intent))) {
          throw new Error("prepared candidate attempt lacks its durable pre-dispatch intent");
        }
        assertCurrentCandidateIntent(state, attempt.definitionDigest, attempt.intent.intentDigest);
        if (state.candidateAttempts.some((value) => value.intent.intentDigest === attempt.intent.intentDigest &&
            canonical(value.preparedDispatch) !== canonical(attempt.preparedDispatch))) {
          throw new WorkCohortOperationConflictError("candidate intent is already bound to another prepared dispatch");
        }
        return appendExact(state.candidateAttempts, (value) => value.candidateAttemptDigest, attempt, "candidate attempt");
      }),
    );
  }

  sealCandidate(operationId: string, request: CohortCandidateSealRequestV1) {
    return this.#persistence.transact((current) =>
      operationMutation(current, operationId, request, (state): CohortSealResultV1 => {
        assertCurrentCandidateIntent(state, request.definition.definitionDigest, request.attempt.intent.intentDigest);
        const definition = state.definitions.find(
          (value) => value.definitionDigest === request.definition.definitionDigest,
        );
        if (definition === undefined || canonical(definition) !== canonical(request.definition)) {
          throw new CohortCandidateSealConflictError("candidate seal lacks its exact durable definition");
        }
        const pending = state.candidateAttempts.find(
          (value) =>
            value.state === "pending" &&
            value.pendingAttemptDigest === request.attempt.pendingAttemptDigest,
        );
        if (pending === undefined) {
          throw new CohortCandidateSealConflictError("candidate seal lacks its durable pending attempt");
        }
        const candidateSeal = materializeCohortCandidateSealV1(request);
        const attempt = appendExact(
          state.candidateAttempts,
          (value) => value.candidateAttemptDigest,
          request.attempt,
          "staged candidate attempt",
        ) as StagedCohortCandidateAttemptV1;
        const seal = appendExact(
          state.candidateSeals,
          (value) => value.candidateAttemptDigest,
          candidateSeal,
          "candidate seal",
        );
        const evidenceSubject = appendExact(
          state.evidenceSubjects,
          (value) => value.evidenceSubjectDigest,
          createCohortEvidenceSubjectV1(definition, seal),
          "evidence subject",
        );
        const bridgePayload = {
          kind: "cq-cohort-receipt-bridge" as const,
          version: 1 as const,
          candidateAttemptDigest: attempt.candidateAttemptDigest,
          sealDigest: seal.sealDigest,
          receipts: clone(seal.gitReceipts),
        };
        const receiptBridge = appendExact(
          state.receiptBridges,
          (value) => value.candidateAttemptDigest,
          { ...bridgePayload, bridgeDigest: digest(bridgePayload) },
          "receipt bridge",
        );
        const acknowledgementPayload = {
          kind: "cq-cohort-g213-binding-acknowledgement" as const,
          version: 1 as const,
          candidateAttemptDigest: attempt.candidateAttemptDigest,
          attestationId: attempt.preparedDispatch.attestationId,
          generation: attempt.preparedDispatch.generation,
          partitionKey: attempt.g213.partitionKey,
          enrollmentId: attempt.g213.enrollmentId,
          attemptId: attempt.g213.attemptId,
          qualificationDigest: attempt.g213.qualificationDigest,
          qualifiedOutputDigest: attempt.g213.qualifiedOutputDigest,
          sealDigest: seal.sealDigest,
        };
        const g213Acknowledgement = appendExact(
          state.g213Acknowledgements,
          (value) => value.candidateAttemptDigest,
          { ...acknowledgementPayload, acknowledgementDigest: digest(acknowledgementPayload) },
          "G213 binding acknowledgement",
        );
        const eligibleSubjects = new Set<string>();
        for (const transition of state.acceptanceTransitions) {
          if (transition.definitionDigest !== definition.definitionDigest) continue;
          if (transition.eligible) eligibleSubjects.add(transition.evidenceSubjectDigest);
          else eligibleSubjects.delete(transition.evidenceSubjectDigest);
        }
        for (const priorSubject of eligibleSubjects) {
          if (priorSubject === evidenceSubject.evidenceSubjectDigest) continue;
          const invalidation = {
            kind: "cq-cohort-candidate-acceptance-transition" as const,
            version: 1 as const,
            definitionDigest: definition.definitionDigest,
            evidenceSubjectDigest: priorSubject,
            eligible: false,
            replacementEvidenceSubjectDigest: evidenceSubject.evidenceSubjectDigest,
          };
          appendExact(
            state.acceptanceTransitions,
            (value) => value.transitionDigest,
            { ...invalidation, transitionDigest: digest(invalidation) },
            "candidate acceptance transition",
          );
        }
        const acceptance = {
          kind: "cq-cohort-candidate-acceptance-transition" as const,
          version: 1 as const,
          definitionDigest: definition.definitionDigest,
          evidenceSubjectDigest: evidenceSubject.evidenceSubjectDigest,
          eligible: true,
          replacementEvidenceSubjectDigest: null,
        };
        appendExact(
          state.acceptanceTransitions,
          (value) => value.transitionDigest,
          { ...acceptance, transitionDigest: digest(acceptance) },
          "candidate acceptance transition",
        );
        return { seal, evidenceSubject, receiptBridge, g213Acknowledgement };
      }),
    );
  }

  transitionReservation(
    operationId: string,
    input: Omit<CohortReservationTransitionV1, "kind" | "version" | "transitionDigest">,
  ) {
    return this.#persistence.transact((current) =>
      operationMutation(current, operationId, input, (state) => {
        exactReservationDefinition(state, input);
        const active = activeReservations(state);
        const held = active.get(input.reservationId);
        if (input.transition === "reserved") {
          const requestedMembers = new Set(input.memberRefs);
          for (const reservation of active.values()) {
            if (reservation.reservationId === input.reservationId) {
              if (
                reservation.cohortId !== input.cohortId ||
                reservation.definitionDigest !== input.definitionDigest ||
                canonical(reservation.memberRefs) !== canonical(input.memberRefs)
              ) {
                throw new WorkCohortReservationConflictError(
                  "reservation id is already bound to another definition",
                );
              }
              continue;
            }
            if (reservation.memberRefs.some((memberRef) => requestedMembers.has(memberRef))) {
              throw new WorkCohortReservationConflictError(
                `cohort ${input.cohortId} overlaps reservation ${reservation.reservationId}`,
              );
            }
          }
        }
        if (
          input.transition === "released" &&
          (held === undefined ||
            held.cohortId !== input.cohortId ||
            held.definitionDigest !== input.definitionDigest ||
            canonical(held.memberRefs) !== canonical(input.memberRefs))
        ) {
          throw new WorkCohortReservationConflictError("reservation release does not own the active reservation");
        }
        const payload = { kind: "cq-cohort-reservation-transition" as const, version: 1 as const, ...input };
        return appendExact(
          state.reservationTransitions,
          (value) => value.transitionDigest,
          { ...payload, transitionDigest: digest(payload) },
          "reservation transition",
        );
      }),
    );
  }

  transitionMember(
    operationId: string,
    input: Omit<CohortMemberTransitionV1, "kind" | "version" | "transitionDigest">,
  ) {
    return this.#persistence.transact((current) =>
      operationMutation(current, operationId, input, (state) => {
        const definition = state.definitions.find(
          (candidate) => candidate.definitionDigest === input.definitionDigest,
        );
        if (
          definition === undefined ||
          definition.cohortId !== input.cohortId ||
          !definition.members.some((member) => member.memberRef === input.memberRef)
        ) {
          throw new WorkCohortOperationConflictError(
            "member transition differs from the exact definition membership",
          );
        }
        const currentState = state.memberTransitions
          .filter((value) => value.definitionDigest === input.definitionDigest && value.memberRef === input.memberRef)
          .at(-1)?.to ?? "planned";
        if (currentState !== input.from) {
          throw new WorkCohortOperationConflictError("member transition starts from stale state");
        }
        const payload = { kind: "cq-cohort-member-transition" as const, version: 1 as const, ...input };
        return appendExact(
          state.memberTransitions,
          (value) => value.transitionDigest,
          { ...payload, transitionDigest: digest(payload) },
          "member transition",
        );
      }),
    );
  }

  recordSplit(
    operationId: string,
    input: Omit<CohortSplitLineageV1, "kind" | "version" | "splitDigest">,
  ) {
    return this.#persistence.transact((current) =>
      operationMutation(current, operationId, input, (state) => {
        if (!state.definitions.some((value) => value.definitionDigest === input.parentDefinitionDigest)) {
          throw new Error("cohort split lacks its parent definition");
        }
        if (input.childDefinitionDigests.some((child) => !state.definitions.some((value) => value.definitionDigest === child))) {
          throw new Error("cohort split lacks a child definition");
        }
        const payload = { kind: "cq-cohort-split-lineage" as const, version: 1 as const, ...input };
        return appendExact(state.splitLineage, (value) => value.splitDigest, { ...payload, splitDigest: digest(payload) }, "split lineage");
      }),
    );
  }

  recordProbe(
    operationId: string,
    input: Omit<CohortProbeIdentityV1, "kind" | "version" | "probeDigest">,
  ) {
    return this.#persistence.transact((current) =>
      operationMutation(current, operationId, input, (state) => {
        if (!Number.isInteger(input.probeEpoch) || input.probeEpoch < 1) throw new Error("probe epoch must be positive");
        if (!state.evidenceSubjects.some((value) => value.evidenceSubjectDigest === input.evidenceSubjectDigest)) {
          throw new Error("probe lacks its exact evidence subject");
        }
        const payload = { kind: "cq-cohort-probe-identity" as const, version: 1 as const, ...input };
        return appendExact(state.probeIdentities, (value) => value.probeDigest, { ...payload, probeDigest: digest(payload) }, "probe identity");
      }),
    );
  }

  recordCommandEvidence(
    operationId: string,
    input: Omit<CohortCommandEvidenceV1, "kind" | "version" | "evidenceDigest" | "execution">,
  ) {
    return this.#persistence.transact((current) =>
      operationMutation(current, operationId, input, (state) => {
        const probe = state.probeIdentities.find((value) => value.probeDigest === input.probeDigest);
        if (probe === undefined || probe.evidenceSubjectDigest !== input.evidenceSubjectDigest || probe.probeKind !== input.evidenceKind) {
          throw new Error("command evidence lacks its exact candidate probe");
        }
        const subject = state.evidenceSubjects.find((value) => value.evidenceSubjectDigest === input.evidenceSubjectDigest);
        const definition = state.definitions.find((value) => value.definitionDigest === subject?.definitionDigest);
        if (definition?.acceptanceMatrixDigest !== input.acceptanceMatrixDigest) {
          throw new Error("command evidence differs from the frozen acceptance matrix");
        }
        const payload = { ...input, kind: "cq-cohort-command-evidence" as const, version: 1 as const, execution: null };
        return appendExact(state.commandEvidence, (value) => value.evidenceDigest, { ...payload, evidenceDigest: digest(payload) }, "command evidence");
      }),
    );
  }

  recordProtectedCommandEvidence(
    operationId: string,
    lease: WorkCohortLeaseV1,
    authorized: AuthorizedCohortCommandExecutionV1,
  ): Promise<CohortCommandEvidenceV1> {
    const execution = readAuthorizedCohortCommandExecutionV1(authorized);
    return this.#persistence.transact((current) => {
      this.assertLease(current, lease);
      assertAcceptanceReservation(current.portable, execution.evidenceSubjectDigest);
      if (lease.semanticSubject !== execution.evidenceSubjectDigest ||
          lease.executionEpoch !== execution.authorizingExecutionEpoch) {
        throw new WorkCohortStaleAuthorityError("runner receipt belongs to another execution envelope");
      }
      return operationMutation(current, operationId, execution, (state) => {
        const subject = state.evidenceSubjects.find((value) => value.evidenceSubjectDigest === execution.evidenceSubjectDigest);
        const definition = state.definitions.find((value) => value.definitionDigest === subject?.definitionDigest);
        const seal = state.candidateSeals.find((value) => value.sealDigest === subject?.sealDigest);
        const matrix = state.frozenMatrices.find((value) => value.matrixDigest === definition?.acceptanceMatrixDigest);
        const attempt = state.candidateAttempts.find((value) => value.candidateAttemptDigest === seal?.candidateAttemptDigest);
        if (definition === undefined || seal === undefined || matrix === undefined || attempt?.state !== "staged") {
          throw new Error("runner receipt lacks its exact definition, seal, or matrix");
        }
        validateCohortExecutionBindingV1(execution, {
          definition, seal, attempt, matrix, evidenceSubjectDigest: execution.evidenceSubjectDigest,
        });
        const probePayload = {
          kind: "cq-cohort-probe-identity" as const, version: 1 as const,
          evidenceSubjectDigest: execution.evidenceSubjectDigest,
          probeKind: execution.purpose,
          probeEpoch: state.probeIdentities.filter((probe) =>
            probe.evidenceSubjectDigest === execution.evidenceSubjectDigest &&
            probe.probeKind === execution.purpose && probe.commandDigest === execution.commandDigest).length + 1,
          commandDigest: execution.commandDigest,
        };
        const probe = appendExact(state.probeIdentities, (value) => value.probeDigest,
          { ...probePayload, probeDigest: digest(probePayload) }, "runner probe");
        const payload = {
          kind: "cq-cohort-command-evidence" as const, version: 1 as const,
          evidenceSubjectDigest: execution.evidenceSubjectDigest,
          acceptanceMatrixDigest: execution.acceptanceMatrixDigest,
          probeDigest: probe.probeDigest, evidenceKind: execution.purpose,
          passed: execution.outcome.exitCode === 0, receiptDigest: execution.receiptDigest, execution,
        };
        return appendExact(state.commandEvidence, (value) => value.evidenceDigest,
          { ...payload, evidenceDigest: digest(payload) }, "runner command evidence");
      });
    });
  }

  async finalize(
    operationId: string,
    input: { readonly definitionDigest: string; readonly evidenceSubjectDigest: string },
  ) {
    await this.recordActivity(createCohortActivityV1({ semanticSubject: input.evidenceSubjectDigest,
      executionEpoch: (await this.snapshot()).runtime.executionEpoch, executions: [],
      measurements: [{ measurement: "acceptanceFinalizationAttempts", value: 1 }],
    }));
    return this.#persistence.transact((current) => {
      assertEligibleEvidenceSubject(current.portable, input.evidenceSubjectDigest);
      return operationMutation(current, operationId, input, (state) => {
        const subject = state.evidenceSubjects.find((value) => value.evidenceSubjectDigest === input.evidenceSubjectDigest);
        const seal = state.candidateSeals.find((value) => value.sealDigest === subject?.sealDigest);
        if (subject?.definitionDigest !== input.definitionDigest || seal === undefined) {
          throw new Error("cohort finalization lacks its exact definition/seal subject");
        }
        const definition = state.definitions.find((value) => value.definitionDigest === input.definitionDigest);
        const matrix = state.frozenMatrices.find((value) => value.matrixDigest === definition?.acceptanceMatrixDigest);
        const attempt = state.candidateAttempts.find((value) => value.candidateAttemptDigest === seal.candidateAttemptDigest);
        if (definition === undefined || matrix === undefined || attempt?.state !== "staged") throw new Error("cohort completion lacks its frozen matrix or attempt");
        const latest = new Map<string, CohortCommandEvidenceV1>();
        for (const value of state.commandEvidence) {
          if (value.evidenceSubjectDigest !== input.evidenceSubjectDigest || value.execution === null) continue;
          validateCohortExecutionBindingV1(value.execution, {
            definition, seal, attempt, matrix, evidenceSubjectDigest: input.evidenceSubjectDigest,
          });
          if (value.receiptDigest !== value.execution.receiptDigest || value.evidenceKind !== value.execution.purpose ||
              value.passed !== (value.execution.outcome.exitCode === 0)) {
            throw new Error("cohort evidence differs from its runner receipt");
          }
          latest.set(`${value.evidenceKind}:${value.execution.commandDigest}`, value);
        }
        const passed = [...latest.values()].filter((value) => value.passed);
        const focused = passed.filter((value) => value.evidenceKind === "focused");
        const shared = passed.find((value) => value.evidenceKind === "shared-regression");
        const full = passed.find((value) => value.evidenceKind === "full-gate");
        const covered = new Set(focused.flatMap((value) => value.execution?.memberPlanDigests ?? []));
        if (matrix.members.some((member) => !covered.has(member.focusedPlanDigest)) || shared === undefined || full === undefined) {
          throw new Error("cohort finalization requires runner-owned green evidence for every focused plan, shared regression, and full gate");
        }
        const payload = {
          kind: "cq-cohort-completion-receipt" as const,
          version: 1 as const,
          definitionDigest: input.definitionDigest,
          sealDigest: seal.sealDigest,
          evidenceSubjectDigest: subject.evidenceSubjectDigest,
          focusedEvidenceDigests: focused.map((value) => value.evidenceDigest).sort(),
          sharedRegressionEvidenceDigest: shared.evidenceDigest,
          fullGateEvidenceDigest: full.evidenceDigest,
        };
        return appendExact(state.completionReceipts, (value) => value.completionDigest, { ...payload, completionDigest: digest(payload) }, "completion receipt");
      });
    });
  }

  recordCompletionHandoff(operationId: string, lease: WorkCohortLeaseV1, envelope: CohortEffectEnvelopeV1,
    authority: AuthorizedCohortCompletionHandoffV1): Promise<CohortCompletionHandoffV1> {
    const handoff = readAuthorizedCohortCompletionHandoffV1(authority);
    return this.#persistence.transact((current) => {
      this.assertCohortAuthoritySnapshot(current, lease, envelope);
      return operationMutation(current, operationId, handoff, (state) => {
        if (envelope.state !== "sealed" || handoff.definitionDigest !== envelope.definition.definitionDigest ||
            handoff.evidenceSubjectDigest !== envelope.evidenceSubject.evidenceSubjectDigest || handoff.sealDigest !== envelope.evidenceSubject.sealDigest ||
            !state.completionReceipts.some((value) => value.evidenceSubjectDigest === handoff.evidenceSubjectDigest)) {
          throw new Error("cohort completion handoff lacks exact accepted envelope");
        }
        assertCohortCompletionHandoffTransitionV1(state.completionHandoffs.findLast((value) => value.operationId === handoff.operationId) ?? null, handoff);
        const atom = state.commonAtoms.find((value) => value.atomDigest === envelope.definition.selectedAtomDigest);
        if (atom === undefined) throw new Error("cohort completion handoff lacks its exact common boundary");
        assertCohortCompletionHandoffBindingsV1(handoff, envelope.definition, atom);
        return appendExact(state.completionHandoffs, (value) => value.handoffDigest, handoff, "completion handoff");
      });
    });
  }

  acquireLease(input: { readonly holderId: string; readonly semanticSubject: string }) {
    return this.acquireLeaseAndPublish(input, () => undefined);
  }

  acquireLeaseAndPublish(input: { readonly holderId: string; readonly semanticSubject: string },
    publish: (lease: WorkCohortLeaseV1) => undefined) {
    assertNonEmpty(input.holderId, "cohort lease holder");
    assertNonEmpty(input.semanticSubject, "cohort lease subject");
    const capability = randomUUID();
    return this.#persistence.transact((current) => {
      if (current.runtime.resumeRequired) {
        throw new WorkCohortStaleAuthorityError(
          "restored cohort requires exact resume revalidation before authority acquisition",
        );
      }
      if (
        current.runtime.resumeValidation !== null &&
        current.runtime.resumeValidation.evidenceSubjectDigest !== input.semanticSubject
      ) {
        throw new WorkCohortStaleAuthorityError(
          "cohort lease subject differs from the revalidated evidence subject",
        );
      }
      if (current.runtime.lease !== null) throw new WorkCohortReservationConflictError("cohort lease is already held");
      const lease: WorkCohortLeaseV1 = {
        holderId: input.holderId,
        semanticSubject: input.semanticSubject,
        executionEpoch: current.runtime.executionEpoch,
        capability,
      };
      publish(lease);
      return {
        next: {
          ...current,
          runtime: {
            ...current.runtime,
            lease: { ...input, capabilityDigest: digest(capability) },
          },
          revision: current.revision + 1,
        },
        result: lease,
      };
    });
  }

  bindLeaseToSeal(lease: WorkCohortLeaseV1, envelope: CohortEffectEnvelopeV1): Promise<WorkCohortLeaseV1> {
    assertCohortEffectEnvelopeV1(envelope);
    if (envelope.state !== "sealed") throw new WorkCohortStaleAuthorityError("cohort lease transition requires a sealed candidate");
    const pendingSubject = digest({ definitionDigest: envelope.definition.definitionDigest,
      intentDigest: envelope.intent.intentDigest, memberSetDigest: envelope.memberSetDigest });
    if (lease.executionEpoch !== envelope.executionEpoch ||
        (lease.semanticSubject !== pendingSubject && lease.semanticSubject !== envelope.semanticSubject)) {
      throw new WorkCohortStaleAuthorityError("cohort seal cannot transfer a lease from another candidate");
    }
    return this.#persistence.transact((current) => {
      const nextLease = { ...lease, semanticSubject: envelope.semanticSubject };
      this.assertLease(current, current.runtime.lease?.semanticSubject === envelope.semanticSubject ? nextLease : lease);
      const next = { ...current, revision: current.revision + 1,
        runtime: { ...current.runtime, lease: { holderId: nextLease.holderId,
          semanticSubject: nextLease.semanticSubject, capabilityDigest: digest(nextLease.capability) } } };
      this.assertCohortAuthoritySnapshot(next, nextLease, envelope);
      return { next, result: nextLease };
    });
  }

  transitionLeaseToSuccessor(lease: WorkCohortLeaseV1, source: CohortEffectEnvelopeV1,
    successor: CohortEffectEnvelopeV1, publish: (lease: WorkCohortLeaseV1) => undefined): Promise<WorkCohortLeaseV1> {
    assertCohortEffectEnvelopeV1(source);
    assertCohortEffectEnvelopeV1(successor);
    if (source.state !== "sealed" || successor.state !== "pre-seal" || source.intent.intentDigest === successor.intent.intentDigest ||
        canonical(source.definition) !== canonical(successor.definition) || canonical(source.memberAuthorities) !== canonical(successor.memberAuthorities) ||
        source.executionEpoch !== successor.executionEpoch || source.executionEpoch !== lease.executionEpoch) {
      throw new WorkCohortStaleAuthorityError("cohort successor requires one distinct intent over the exact sealed source definition and epoch");
    }
    const nextLease = { ...lease, semanticSubject: successor.semanticSubject };
    return this.#persistence.transact((current) => {
      if (current.runtime.lease?.semanticSubject === successor.semanticSubject) {
        this.assertCohortAuthoritySnapshot(current, nextLease, successor);
        publish(nextLease);
        return { next: current, result: nextLease };
      }
      this.assertCohortAuthoritySnapshot(current, lease, source);
      assertCohortCandidateIntentV1(successor.intent, source.definition);
      const mutation = operationMutation(current, `successor:${successor.intent.intentDigest}`, {
        source: source.semanticSubject, successor: successor.semanticSubject,
      }, (portable) => appendExact(portable.candidateIntents, (value) => value.intentDigest, successor.intent, "candidate intent"));
      const next = { ...mutation.next, runtime: { ...mutation.next.runtime, resumeValidation: null,
        lease: { holderId: nextLease.holderId, semanticSubject: nextLease.semanticSubject, capabilityDigest: digest(nextLease.capability) } } };
      this.assertCohortAuthoritySnapshot(next, nextLease, successor);
      publish(nextLease);
      return { next, result: nextLease };
    });
  }

  async releaseLease(lease: WorkCohortLeaseV1): Promise<void> {
    await this.#persistence.transact((current) => {
      this.assertLease(current, lease);
      return {
        next: { ...current, runtime: { ...current.runtime, lease: null }, revision: current.revision + 1 },
        result: undefined,
      };
    });
  }

  revalidateForResume(input: {
    readonly definitionDigest: string;
    readonly sealDigest: string;
    readonly evidenceSubjectDigest: string;
    readonly acceptanceMatrixDigest: string;
    readonly environmentDigest: string;
    readonly receiptBridgeDigest: string;
  }) {
    return this.#persistence.transact((current) => {
      assertEligibleEvidenceSubject(current.portable, input.evidenceSubjectDigest);
      const definition = current.portable.definitions.find((value) => value.definitionDigest === input.definitionDigest);
      const seal = current.portable.candidateSeals.find((value) => value.sealDigest === input.sealDigest);
      const subject = current.portable.evidenceSubjects.find((value) => value.evidenceSubjectDigest === input.evidenceSubjectDigest);
      const bridge = current.portable.receiptBridges.find((value) => value.bridgeDigest === input.receiptBridgeDigest);
      if (
        definition === undefined ||
        seal?.definitionDigest !== definition.definitionDigest ||
        subject?.sealDigest !== seal.sealDigest ||
        definition.acceptanceMatrixDigest !== input.acceptanceMatrixDigest ||
        definition.environment.environmentDigest !== input.environmentDigest ||
        bridge?.sealDigest !== seal.sealDigest
      ) {
        throw new WorkCohortStaleAuthorityError("cohort resume revalidation differs from durable identity");
      }
      const validationDigest = digest({ ...input, executionEpoch: current.runtime.executionEpoch });
      return {
        next: {
          ...current,
          portable: renewedEpochActivity(current, input.evidenceSubjectDigest),
          runtime: {
            ...current.runtime,
            resumeRequired: false,
            resumeValidation: { evidenceSubjectDigest: subject.evidenceSubjectDigest, validationDigest },
          },
          revision: current.revision + 1,
        },
        result: current.runtime.executionEpoch,
      };
    });
  }

  beginNewExecutionEpoch(): Promise<void> {
    return this.#persistence.rotateRuntime();
  }

  revalidatePreparationForResume(envelope: CohortEffectEnvelopeV1): Promise<string> {
    return this.#persistence.transact((current) => {
      if (envelope.state !== "pre-seal" || current.runtime.lease !== null ||
          current.portable.candidateAttempts.some((attempt) => attempt.intent.intentDigest === envelope.intent.intentDigest)) {
        throw new WorkCohortStaleAuthorityError("preparation resume cannot revive an already prepared dispatch or an active lease");
      }
      this.assertCohortEnvelopeSnapshot(current, envelope);
      return { next: { ...current, portable: renewedEpochActivity(current, envelope.semanticSubject), revision: current.revision + 1,
        runtime: { ...current.runtime, resumeRequired: false, resumeValidation: {
          evidenceSubjectDigest: envelope.semanticSubject, validationDigest: digest(envelope) } } },
        result: current.runtime.executionEpoch };
    });
  }

  async assertLiveAuthority(lease: WorkCohortLeaseV1): Promise<void> {
    return this.observeEpochRejection(lease, (current) => {
      this.assertLease(current, lease);
      if (current.portable.evidenceSubjects.some(
        (subject) => subject.evidenceSubjectDigest === lease.semanticSubject,
      )) {
        assertEligibleEvidenceSubject(current.portable, lease.semanticSubject);
      }
    });
  }

  async assertLiveAcceptanceAuthority(lease: WorkCohortLeaseV1): Promise<void> {
    return this.observeEpochRejection(lease, (current) => {
      this.assertLease(current, lease);
      assertAcceptanceReservation(current.portable, lease.semanticSubject);
    });
  }

  async assertLiveCohortAuthority(lease: WorkCohortLeaseV1, envelope: CohortEffectEnvelopeV1): Promise<void> {
    return this.observeEpochRejection(lease, (current) => {
      this.assertCohortAuthoritySnapshot(current, lease, envelope);
    });
  }

  private async observeEpochRejection(lease: WorkCohortLeaseV1, assertion: (current: WorkCohortStoredDocumentV1) => void): Promise<void> {
    const current = await this.#persistence.read();
    try { assertion(current); }
    catch (error) {
      if (error instanceof WorkCohortStaleAuthorityError && lease.executionEpoch !== current.runtime.executionEpoch) {
        await this.recordActivity(createCohortActivityV1({ semanticSubject: lease.semanticSubject, executionEpoch: lease.executionEpoch,
          executions: [], measurements: [{ measurement: "executionEpochRejections", value: 1 }] }));
      }
      throw error;
    }
  }

  publishLiveCohortEffect(lease: WorkCohortLeaseV1, envelope: CohortEffectEnvelopeV1, publish: () => undefined): Promise<void> {
    return this.#persistence.transact((current) => {
      this.assertCohortAuthoritySnapshot(current, lease, envelope);
      return { next: current, result: publish() };
    });
  }

  private assertCohortAuthoritySnapshot(current: WorkCohortStoredDocumentV1, lease: WorkCohortLeaseV1, envelope: CohortEffectEnvelopeV1): void {
    assertCohortEffectEnvelopeV1(envelope);
    this.assertLease(current, lease);
    if (envelope.executionEpoch !== lease.executionEpoch || envelope.semanticSubject !== lease.semanticSubject) {
      throw new WorkCohortStaleAuthorityError("cohort envelope differs from the current lease");
    }
    this.assertCohortEnvelopeSnapshot(current, envelope);
  }

  private assertCohortEnvelopeSnapshot(current: WorkCohortStoredDocumentV1, envelope: CohortEffectEnvelopeV1): void {
    assertCohortEffectEnvelopeV1(envelope);
    const { definition, intent } = envelope;
    if (canonical(latestDefinition(current.portable, definition.cohortId) ?? null) !== canonical(definition) ||
        canonical(current.portable.candidateIntents.findLast((value) => value.definitionDigest === definition.definitionDigest) ?? null) !== canonical(intent)) {
      throw new WorkCohortStaleAuthorityError("cohort envelope lacks its current durable definition and intent");
    }
    const reserved = [...activeReservations(current.portable).values()].some((value) =>
      value.definitionDigest === definition.definitionDigest && value.cohortId === definition.cohortId &&
      canonical(value.memberRefs) === canonical(definition.members.map((member) => member.memberRef)));
    if (!reserved) throw new WorkCohortStaleAuthorityError("cohort effect lacks its exact all-member reservation");
    const observation = resolveCohortDefinitionObservationV1({ definition,
      decisions: current.portable.decisions, observations: current.portable.observations });
    const expected = createCohortEffectEnvelopeV1({ definition, intent, observation,
      evidenceSubject: envelope.state === "sealed" ? envelope.evidenceSubject : null,
      executionEpoch: current.runtime.executionEpoch });
    if (canonical(envelope) !== canonical(expected)) throw new WorkCohortStaleAuthorityError("cohort effect substituted a frozen member manifest");
    if (envelope.state === "sealed") {
      assertEligibleEvidenceSubject(current.portable, envelope.evidenceSubject.evidenceSubjectDigest);
      const seal = current.portable.candidateSeals.find((value) => value.sealDigest === envelope.evidenceSubject.sealDigest);
      const attempt = current.portable.candidateAttempts.find((value) => value.candidateAttemptDigest === seal?.candidateAttemptDigest);
      if (attempt?.intent.intentDigest !== intent.intentDigest) throw new WorkCohortStaleAuthorityError("cohort seal belongs to another candidate intent");
    } else if (current.portable.candidateSeals.some((seal) => current.portable.candidateAttempts.some((attempt) =>
      attempt.candidateAttemptDigest === seal.candidateAttemptDigest && attempt.intent.intentDigest === intent.intentDigest))) {
      throw new WorkCohortStaleAuthorityError("cohort pre-seal authority cannot mutate an already sealed candidate");
    }
  }

  private assertLease(current: WorkCohortStoredDocumentV1, lease: WorkCohortLeaseV1): void {
    const held = current.runtime.lease;
    if (
      lease.executionEpoch !== current.runtime.executionEpoch ||
      held === null ||
      held.holderId !== lease.holderId ||
      held.semanticSubject !== lease.semanticSubject ||
      held.capabilityDigest !== digest(lease.capability)
    ) {
      throw new WorkCohortStaleAuthorityError("cohort lease or capability belongs to another execution epoch");
    }
  }

  async exportPortableState(): Promise<string> {
    return serializeWorkCohortPortableStateV1((await this.#persistence.read()).portable);
  }

  restorePortableState(state: WorkCohortPortableStateV1): Promise<void> {
    return this.#persistence.replacePortable(parseWorkCohortPortableStateV1(JSON.stringify(state)));
  }

}

export class InMemoryWorkCohortPersistence implements WorkCohortPersistence {
  #document = newWorkCohortStoredDocumentV1();
  #tail: Promise<void> = Promise.resolve();

  assertPrimaryCompletionFence(fence: CohortCompletionPrimaryFenceV1): void {
    assertCohortCompletionPrimaryFenceV1(fence, { revision: this.#document.revision, executionEpoch: this.#document.runtime.executionEpoch });
  }

  async read(): Promise<WorkCohortStoredDocumentV1> {
    await this.#tail;
    return clone(this.#document);
  }

  async transact<T>(
    mutation: (current: WorkCohortStoredDocumentV1) => { readonly next: WorkCohortStoredDocumentV1; readonly result: T },
  ): Promise<T> {
    let output!: T;
    const run = this.#tail.then(() => {
      const changed = mutation(clone(this.#document));
      this.#document = clone(changed.next);
      output = clone(changed.result);
    });
    this.#tail = run.then(() => undefined, () => undefined);
    await run;
    return output;
  }

  async replacePortable(portable: WorkCohortPortableStateV1): Promise<void> {
    await this.transact(() => {
      const restored = newWorkCohortStoredDocumentV1(portable);
      return {
        next: {
          ...restored,
          runtime: { ...restored.runtime, resumeRequired: true },
        },
        result: undefined,
      };
    });
  }

  async clear(): Promise<void> {
    await this.transact(() => ({ next: newWorkCohortStoredDocumentV1(), result: undefined }));
  }

  async rotateRuntime(): Promise<void> {
    await this.transact((current) => ({
      next: {
        ...current,
        runtime: {
          ...newWorkCohortStoredDocumentV1().runtime,
          resumeRequired: current.portable.candidateSeals.length > 0,
        },
        revision: current.revision + 1,
      },
      result: undefined,
    }));
  }
}

export function createInMemoryWorkCohortStore(): WorkCohortStore {
  return new PersistentWorkCohortStore(new InMemoryWorkCohortPersistence());
}

export interface CohortRepositoryExecutorV1 {
  readonly identity: string;
}

export class WorkCohortServiceV1 {
  readonly #store: WorkCohortStore;
  readonly #executor: CohortRepositoryExecutorV1 | null;

  constructor(input: { readonly store: WorkCohortStore; readonly executor: CohortRepositoryExecutorV1 | null }) {
    this.#store = input.store;
    this.#executor = input.executor;
  }

  status(): Promise<WorkCohortStoredDocumentV1> {
    return this.#store.snapshot();
  }

  enrollCandidate(operationId: string, attempt: CohortCandidateAttemptV1) {
    this.#requireExecutor("candidate enrollment");
    return this.#store.recordCandidateAttempt(operationId, attempt);
  }

  resume(input: Parameters<WorkCohortStore["revalidateForResume"]>[0]) {
    this.#requireExecutor("resume");
    return this.#store.revalidateForResume(input);
  }

  acquireRepositoryEffect(input: { readonly holderId: string; readonly semanticSubject: string }) {
    this.#requireExecutor("repository effect");
    return this.#store.acquireLease(input);
  }

  #requireExecutor(operation: string): CohortRepositoryExecutorV1 {
    if (this.#executor === null) throw new CohortRepositoryExecutorUnavailableError(operation);
    return this.#executor;
  }
}

export interface WorkCohortG213HandoffHooksV1 {
  afterQualification(): void | Promise<void>;
  afterCohortSeal(result: CohortSealResultV1): void | Promise<void>;
}

const NO_G213_HANDOFF_HOOKS: WorkCohortG213HandoffHooksV1 = Object.freeze({
  afterQualification: () => undefined,
  afterCohortSeal: () => undefined,
});

export class WorkCohortG213HandoffV1 {
  readonly #store: WorkCohortStore;
  readonly #authenticator: G213CandidateAuthenticatorV1;
  readonly #hooks: WorkCohortG213HandoffHooksV1;

  constructor(input: {
    readonly store: WorkCohortStore;
    readonly authenticator: G213CandidateAuthenticatorV1;
    readonly hooks?: WorkCohortG213HandoffHooksV1;
  }) {
    this.#store = input.store;
    this.#authenticator = input.authenticator;
    this.#hooks = input.hooks ?? NO_G213_HANDOFF_HOOKS;
  }

  async sealCandidate(
    operationId: string,
    input: {
      readonly pending: PendingCohortCandidateAttemptV1;
      readonly g213Handle: { readonly attestationId: string; readonly generation: number };
      readonly definition: CohortDefinitionIdentityV1;
      readonly baseCommit: string;
      readonly resultCommit: string;
      readonly resultTree: string;
      readonly wholeDiff: CohortCandidateSealRequestV1["wholeDiff"];
      readonly gitReceipts: CohortCandidateSealRequestV1["gitReceipts"];
    },
  ): Promise<CohortSealResultV1> {
    const row = await this.#authenticator.resolve(input.g213Handle);
    await this.#hooks.afterQualification();
    const attempt = this.#authenticator.stage(input.pending, { row });
    const result = await this.#store.sealCandidate(operationId, {
      definition: input.definition,
      attempt,
      baseCommit: input.baseCommit,
      resultCommit: input.resultCommit,
      resultTree: input.resultTree,
      wholeDiff: input.wholeDiff,
      gitReceipts: input.gitReceipts,
    });
    await this.#hooks.afterCohortSeal(result);
    return result;
  }
}
