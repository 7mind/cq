import { assertCohortEffectEnvelopeV1, cohortValueDigestV1, type CohortEffectEnvelopeV1,
  type CohortDefinitionIdentityV1, type CohortCommonBoundaryAtomV1 } from "./workCohort.js";
import type { CohortCompletionReceiptV1, WorkCohortLeaseV1, WorkCohortStore } from "./workCohortStore.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import { recordProtectedCohortCompletion } from "./implementationEvidence.js";
import type { CohortCompletionPrimaryFenceV1, CohortCompletionSweepV1 } from "./store/directOwnedMutation.js";
import type { DispatchHandle } from "@cq/config";
import { createCohortActivityV1, type CohortActivityMeasurementV1 } from "./workCohortActivity.js";

export interface RecordCohortReviewInputV1 {
  readonly reviewerDispatch: DispatchHandle;
  readonly envelope: CohortEffectEnvelopeV1;
  readonly operationId: string;
  readonly author: string;
  readonly session: string;
}

export type CohortCompletionRuntimeResultV1 =
  | { readonly state: "executor-unavailable" }
  | { readonly state: "deployment-required"; readonly operatorActionRef: string; readonly handoff: CohortCompletionHandoffV1 }
  | { readonly state: "complete"; readonly handoff: CohortCompletionHandoffV1 };

export interface CohortCompletionCapabilityV1 {
  recordReview(input: RecordCohortReviewInputV1): Promise<{ readonly reviewRef: string; readonly memberRefs: readonly string[] }>;
  complete(input: { readonly batch: CohortCompletionBatchV1 }): Promise<CohortCompletionRuntimeResultV1>;
  status(input: { readonly operationId: string }): Promise<{ readonly executor: "local-xdg" | "unavailable"; readonly handoff: CohortCompletionHandoffV1 | null }>;
}

export interface CohortMemberCompletionV1 {
  readonly taskRef: string;
  readonly completion: string;
  readonly reviewAttemptRefs: readonly string[];
  readonly logPaths: readonly string[];
}

export interface CohortDeploymentPlanV1 {
  readonly kind: "cq-cohort-deployment-plan";
  readonly version: 1;
  readonly deploymentClass: string;
  readonly packagedBuildIdentity: { readonly packageIdentity: string; readonly sourceCommit: string };
  readonly members: readonly { readonly taskRef: string; readonly argv: readonly string[];
    readonly cwd: string; readonly environment: Readonly<Record<string, string>> }[];
}

export interface CohortCompletionBatchV1 {
  readonly kind: "cq-cohort-completion-batch";
  readonly version: 1;
  readonly operationId: string;
  readonly envelope: CohortEffectEnvelopeV1 & { readonly state: "sealed" };
  readonly acceptance: CohortCompletionReceiptV1;
  readonly resultCommit: string;
  readonly members: readonly CohortMemberCompletionV1[];
  readonly deploymentPlan: CohortDeploymentPlanV1 | null;
  readonly sweep: CohortCompletionSweepV1;
  readonly author: string;
  readonly session: string;
  readonly batchDigest: string;
}

export interface CohortCompletionLedgerResultV1 {
  readonly batchDigest: string;
  readonly reviews: readonly { readonly taskRef: string; readonly reviewRef: string }[];
  readonly resolvedDefectRefs: readonly string[];
  readonly readyForUserClosureGoalRefs: readonly string[];
  readonly archivedRefs: readonly string[];
  readonly archivedMilestoneIds: readonly string[];
  readonly operatorHandoffRef: string | null;
}

export interface CohortDeploymentIdentityV1 {
  readonly deploymentClass: string;
  readonly operatorActionRef: string;
  readonly packagedBuildDigest: string;
  readonly startupBuildCommit: string;
  readonly probeEpoch: string;
}

export interface CohortDeploymentProbeV1 {
  readonly taskRef: string;
  readonly sealDigest: string;
  readonly packagedBuildDigest: string;
  readonly startupBuildCommit: string;
  readonly probeEpoch: string;
  readonly passed: boolean;
  readonly receiptDigest: string;
}

export type CohortCompletionPhaseV1 = "prepared" | "merged" | "probes-complete" | "ledger-recording" | "ledger-recorded" | "released";

export class CohortPrimaryCompletionMissingError extends Error {
  constructor() { super("cohort handoff has no protected primary completion binding"); }
}

export interface CohortCompletionHandoffV1 {
  readonly kind: "cq-cohort-completion-handoff";
  readonly version: 1;
  readonly operationId: string;
  readonly batchDigest: string;
  readonly definitionDigest: string;
  readonly sealDigest: string;
  readonly evidenceSubjectDigest: string;
  readonly phase: CohortCompletionPhaseV1;
  readonly mergeReceiptDigest: string | null;
  readonly deployment: CohortDeploymentIdentityV1 | null;
  readonly probes: readonly CohortDeploymentProbeV1[];
  readonly ledgerResult: CohortCompletionLedgerResultV1 | null;
  readonly handoffDigest: string;
}

const PHASES: readonly CohortCompletionPhaseV1[] = ["prepared", "merged", "probes-complete", "ledger-recording", "ledger-recorded", "released"];
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

function assertDigest(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} requires a lowercase SHA-256`);
}

function immutableClone<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object") return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(clone);
  return clone;
}

export function createCohortCompletionBatchV1(input: Omit<CohortCompletionBatchV1, "kind" | "version" | "batchDigest">): CohortCompletionBatchV1 {
  const payload = { kind: "cq-cohort-completion-batch" as const, version: 1 as const, ...input };
  const batch = { ...payload, batchDigest: completionBatchDigest(payload) };
  assertCohortCompletionBatchV1(batch);
  return structuredClone(batch);
}

function completionBatchDigest(payload: Omit<CohortCompletionBatchV1, "batchDigest">): string {
  const { executionEpoch: _epoch, envelopeDigest: _digest, ...semanticEnvelope } = payload.envelope;
  return cohortValueDigestV1({ ...payload, envelope: semanticEnvelope });
}

export function assertCohortCompletionBatchV1(batch: CohortCompletionBatchV1): void {
  const closed = (value: object, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
  if (!closed(batch, ["kind", "version", "operationId", "envelope", "acceptance", "resultCommit", "members", "deploymentPlan", "sweep", "author", "session", "batchDigest"])) {
    throw new Error("cohort completion batch contains missing or undeclared fields");
  }
  assertCohortEffectEnvelopeV1(batch.envelope);
  const { batchDigest, ...payload } = batch;
  if (batch.kind !== "cq-cohort-completion-batch" || batch.version !== 1 || completionBatchDigest(payload) !== batchDigest ||
      batch.operationId.trim() === "" || batch.author.trim() === "" || batch.session.trim() === "" || !COMMIT.test(batch.resultCommit)) {
    throw new Error("cohort completion batch identity is malformed");
  }
  if (batch.envelope.state !== "sealed" || batch.envelope.evidenceSubject.evidenceSubjectDigest !== batch.acceptance.evidenceSubjectDigest ||
      batch.envelope.definition.definitionDigest !== batch.acceptance.definitionDigest ||
      batch.envelope.evidenceSubject.sealDigest !== batch.acceptance.sealDigest) {
    throw new Error("cohort completion batch differs from its sealed acceptance subject");
  }
  if (batch.members.length !== batch.envelope.memberAuthorities.length || batch.members.some((member, index) => {
    const authority = batch.envelope.memberAuthorities[index];
    return authority === undefined || member.taskRef !== authority.taskRef || member.completion.trim() === "" ||
      member.reviewAttemptRefs.length === 0 || new Set(member.reviewAttemptRefs).size !== member.reviewAttemptRefs.length ||
      member.reviewAttemptRefs.some((ref) => ref.trim() === "") || member.logPaths.length === 0 || member.logPaths.some((path) => path.trim() === "");
  })) throw new Error("cohort completion requires exact ordered all-member review and log coverage");
  if (batch.deploymentPlan !== null) {
    const plan = batch.deploymentPlan;
    if (!closed(plan, ["kind", "version", "deploymentClass", "packagedBuildIdentity", "members"]) ||
        !closed(plan.packagedBuildIdentity, ["packageIdentity", "sourceCommit"]) ||
        plan.kind !== "cq-cohort-deployment-plan" || plan.version !== 1 || !SHA256.test(plan.deploymentClass) ||
        plan.packagedBuildIdentity.packageIdentity.trim() === "" || plan.packagedBuildIdentity.sourceCommit !== batch.resultCommit ||
        plan.members.length !== batch.members.length || plan.members.some((member, index) =>
          !closed(member, ["taskRef", "argv", "cwd", "environment"]) ||
          member.taskRef !== batch.members[index]?.taskRef || member.argv.length === 0 || member.argv.some((part) => part.length === 0 || part.includes("\0")) ||
          member.cwd.startsWith("/") || member.cwd.trim() === "" || member.cwd.split("/").some((part) => part === ".." || part === "") ||
          Object.entries(member.environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || value.includes("\0")))) {
      throw new Error("cohort deployment plan requires exact immutable source/package identity and ordered normalized member commands");
    }
  }
  if (typeof batch.sweep.archiveCompletedMembers !== "boolean" || batch.sweep.summary.trim() === "" ||
      new Set(batch.sweep.terminalItems.map(({ targetId }) => targetId)).size !== batch.sweep.terminalItems.length ||
      new Set(batch.sweep.milestones.map(({ id }) => id)).size !== batch.sweep.milestones.length ||
      batch.sweep.terminalItems.some((item) => item.action !== "archive-terminal-item" || item.version !== 1 || !/^defects:D[0-9]+$/u.test(item.targetId))) {
    throw new Error("cohort completion explicit sweeps are limited to exact covered defects; task/review sweeps are derived");
  }
}

export function createCohortCompletionHandoffV1(input: Omit<CohortCompletionHandoffV1, "kind" | "version" | "handoffDigest">): CohortCompletionHandoffV1 {
  const payload = { kind: "cq-cohort-completion-handoff" as const, version: 1 as const, ...input };
  const handoff = { ...payload, handoffDigest: cohortValueDigestV1(payload) };
  assertCohortCompletionHandoffV1(handoff);
  return handoff;
}

export function assertCohortCompletionHandoffV1(handoff: CohortCompletionHandoffV1): void {
  const { handoffDigest, ...payload } = handoff;
  const keys = ["kind", "version", "operationId", "batchDigest", "definitionDigest", "sealDigest", "evidenceSubjectDigest", "phase", "mergeReceiptDigest", "deployment", "probes", "ledgerResult", "handoffDigest"];
  if (Object.keys(handoff).length !== keys.length || Object.keys(handoff).some((key) => !keys.includes(key)) ||
      handoff.kind !== "cq-cohort-completion-handoff" || handoff.version !== 1 || handoff.operationId.trim() === "" ||
      !PHASES.includes(handoff.phase) || cohortValueDigestV1(payload) !== handoffDigest || !Array.isArray(handoff.probes)) {
    throw new Error("cohort completion handoff is malformed");
  }
  for (const value of [handoff.batchDigest, handoff.definitionDigest, handoff.sealDigest, handoff.evidenceSubjectDigest, handoff.handoffDigest]) assertDigest(value, "completion handoff");
  if ((handoff.phase === "prepared") !== (handoff.mergeReceiptDigest === null)) throw new Error("completion handoff merge phase lacks exact merge evidence");
  if (handoff.mergeReceiptDigest !== null) assertDigest(handoff.mergeReceiptDigest, "cohort merge receipt");
  if (handoff.deployment !== null) {
    const deployment = handoff.deployment;
    if (deployment.deploymentClass.trim() === "" || deployment.operatorActionRef.trim() === "" || deployment.probeEpoch.trim() === "" ||
        !COMMIT.test(deployment.startupBuildCommit)) throw new Error("cohort deployment identity is malformed");
    assertDigest(deployment.packagedBuildDigest, "cohort packaged build");
    if (new Set(handoff.probes.map(({ taskRef }) => taskRef)).size !== handoff.probes.length) throw new Error("cohort deployment has duplicate member probes");
    for (const probe of handoff.probes) {
      if (!/^tasks:T[0-9]+$/u.test(probe.taskRef) || probe.sealDigest !== handoff.sealDigest ||
          probe.packagedBuildDigest !== deployment.packagedBuildDigest || probe.startupBuildCommit !== deployment.startupBuildCommit ||
          probe.probeEpoch !== deployment.probeEpoch || typeof probe.passed !== "boolean") throw new Error("cohort probe differs from its shared deployment identity");
      assertDigest(probe.receiptDigest, "cohort probe receipt");
    }
  } else if (handoff.probes.length !== 0) throw new Error("cohort probes require a deployment identity");
  if (PHASES.indexOf(handoff.phase) >= PHASES.indexOf("probes-complete") && handoff.probes.some(({ passed }) => !passed)) {
    throw new Error("cohort completion cannot proceed with failed deployment probes");
  }
  const recorded = handoff.phase === "ledger-recorded" || handoff.phase === "released";
  if (recorded !== (handoff.ledgerResult !== null) || (handoff.ledgerResult !== null && handoff.ledgerResult.batchDigest !== handoff.batchDigest)) {
    throw new Error("cohort ledger handoff phase lacks exact batch result");
  }
  if (handoff.ledgerResult !== null) {
    const result = handoff.ledgerResult;
    const keys = ["batchDigest", "reviews", "resolvedDefectRefs", "readyForUserClosureGoalRefs", "archivedRefs", "archivedMilestoneIds", "operatorHandoffRef"];
    if (Object.keys(result).length !== keys.length || Object.keys(result).some((key) => !keys.includes(key)) ||
        !Array.isArray(result.reviews) || result.reviews.some((review) =>
          Object.keys(review).length !== 2 || !/^tasks:T[0-9]+$/u.test(review.taskRef) || !/^reviews:R[0-9]+$/u.test(review.reviewRef)) ||
        new Set(result.reviews.map(({ taskRef }) => taskRef)).size !== result.reviews.length ||
        new Set(result.reviews.map(({ reviewRef }) => reviewRef)).size !== result.reviews.length ||
        (result.operatorHandoffRef !== null && (handoff.deployment === null || !/^handoffs:HO[0-9]+$/u.test(result.operatorHandoffRef) ||
          !result.archivedRefs.includes(result.operatorHandoffRef)))) throw new Error("cohort recorded ledger result has malformed exact review bindings");
    for (const refs of [result.resolvedDefectRefs, result.readyForUserClosureGoalRefs, result.archivedRefs, result.archivedMilestoneIds]) {
      if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string") || new Set(refs).size !== refs.length) throw new Error("cohort recorded ledger result has malformed reference arrays");
    }
  }
}

export function assertCohortCompletionHandoffBindingsV1(handoff: CohortCompletionHandoffV1,
  definition: CohortDefinitionIdentityV1, atom: CohortCommonBoundaryAtomV1): void {
  assertCohortCompletionHandoffV1(handoff);
  const members = definition.members.map(({ memberRef }) => memberRef);
  if (handoff.definitionDigest !== definition.definitionDigest || definition.selectedAtomDigest !== atom.atomDigest ||
      definition.phase !== "implementation") throw new Error("cohort completion handoff has a foreign definition or common boundary");
  const probesComplete = PHASES.indexOf(handoff.phase) >= PHASES.indexOf("probes-complete");
  if (handoff.phase === "prepared" && (handoff.deployment !== null || handoff.probes.length !== 0)) throw new Error("prepared cohort handoff cannot carry deployment effects");
  if (probesComplete && atom.deploymentClass.identity !== "deployment:none" && handoff.deployment === null) {
    throw new Error("cohort completion handoff lacks its required shared deployment");
  }
  if (handoff.deployment !== null && (handoff.deployment.deploymentClass !== atom.deploymentClass.digest ||
      (probesComplete && cohortValueDigestV1(handoff.probes.map(({ taskRef }) => taskRef)) !== cohortValueDigestV1(members)))) {
    throw new Error("cohort completion handoff lacks exact all-member shared deployment probes");
  }
  if (handoff.probes.some(({ taskRef }) => !members.includes(taskRef))) throw new Error("cohort completion probe belongs to another member set");
  if (handoff.ledgerResult !== null) {
    const result = handoff.ledgerResult;
    const goals = new Set(definition.members.map(({ authorityRef }) => authorityRef));
    const allowed = new Set([...members, ...result.reviews.map(({ reviewRef }) => reviewRef), ...result.resolvedDefectRefs]);
    if (result.operatorHandoffRef !== null) allowed.add(result.operatorHandoffRef);
    if (cohortValueDigestV1(result.reviews.map(({ taskRef }) => taskRef)) !== cohortValueDigestV1(members) ||
        result.resolvedDefectRefs.some((ref) => !/^defects:D[0-9]+$/u.test(ref)) || result.archivedRefs.some((ref) => !allowed.has(ref)) ||
        result.readyForUserClosureGoalRefs.some((ref) => !goals.has(ref))) throw new Error("cohort recorded result lacks exact all-member completion coverage");
  }
}

export function assertCohortCompletionHandoffTransitionV1(prior: CohortCompletionHandoffV1 | null, next: CohortCompletionHandoffV1): void {
  assertCohortCompletionHandoffV1(next);
  if (prior === null) {
    if (next.phase !== "prepared") throw new Error("cohort completion handoff must begin prepared");
    return;
  }
  if (prior.handoffDigest === next.handoffDigest) return;
  if (prior.operationId !== next.operationId || prior.batchDigest !== next.batchDigest || prior.definitionDigest !== next.definitionDigest ||
      prior.sealDigest !== next.sealDigest || prior.evidenceSubjectDigest !== next.evidenceSubjectDigest) {
    throw new Error("cohort completion operation cannot be rebound");
  }
  const before = PHASES.indexOf(prior.phase);
  const after = PHASES.indexOf(next.phase);
  const probeRetry = before >= PHASES.indexOf("merged") && before <= PHASES.indexOf("ledger-recording") && next.phase === "merged";
  if (!probeRetry && after !== before + 1) throw new Error("cohort completion handoff phase is not contiguous");
  if (prior.mergeReceiptDigest !== null && prior.mergeReceiptDigest !== next.mergeReceiptDigest) throw new Error("cohort completion merge receipt changed");
  if (!probeRetry && prior.deployment !== null && cohortValueDigestV1(prior.deployment) !== cohortValueDigestV1(next.deployment)) {
    throw new Error("cohort deployment changed without a new probe cycle");
  }
  if (probeRetry && prior.deployment !== null && next.deployment !== null &&
      prior.deployment.packagedBuildDigest !== next.deployment.packagedBuildDigest && prior.deployment.probeEpoch === next.deployment.probeEpoch) {
    throw new Error("changed cohort deployment requires a fresh probe epoch");
  }
  if (prior.ledgerResult !== null && cohortValueDigestV1(prior.ledgerResult) !== cohortValueDigestV1(next.ledgerResult)) throw new Error("cohort completion ledger result changed");
}

export interface CohortCompletionHostV1 {
  authenticateReviews(batch: CohortCompletionBatchV1): Promise<void>;
  authenticateHandoff(batch: CohortCompletionBatchV1, handoff: CohortCompletionHandoffV1): Promise<void>;
  withPrimaryAdmission<T>(batch: CohortCompletionBatchV1, effect: () => Promise<T>): Promise<T>;
  merge(batch: CohortCompletionBatchV1): Promise<{ readonly sealDigest: string; readonly resultCommit: string; readonly receiptDigest: string }>;
  deployment(batch: CohortCompletionBatchV1, prior: CohortDeploymentIdentityV1 | null): Promise<CohortDeploymentIdentityV1 | null>;
  probe(batch: CohortCompletionBatchV1, deployment: CohortDeploymentIdentityV1, taskRef: string): Promise<CohortDeploymentProbeV1>;
  operatorSettlement(batch: CohortCompletionBatchV1, handoff: CohortCompletionHandoffV1): Promise<CohortOperatorSettlementV1 | null>;
  settle(batch: CohortCompletionBatchV1, result: CohortCompletionLedgerResultV1): Promise<void>;
}

export interface CohortOperatorSettlementV1 {
  readonly actionId: string;
  readonly actionRevision: string;
  readonly handoffId: string;
  readonly handoffRevision: string;
}

class IssuedCohortCompletionV1 {
  readonly #brand = "cq-cohort-completion-authorization";
  readonly #batch: CohortCompletionBatchV1;
  readonly #handoff: CohortCompletionHandoffV1;
  readonly #fence: CohortCompletionPrimaryFenceV1;
  readonly #mode: "record" | "verify";
  readonly #operatorSettlement: CohortOperatorSettlementV1 | null;
  constructor(batch: CohortCompletionBatchV1, handoff: CohortCompletionHandoffV1, fence: CohortCompletionPrimaryFenceV1, mode: "record" | "verify", operatorSettlement: CohortOperatorSettlementV1 | null) {
    this.#batch = immutableClone(batch);
    this.#handoff = immutableClone(handoff);
    this.#fence = immutableClone(fence);
    this.#mode = mode;
    this.#operatorSettlement = immutableClone(operatorSettlement);
  }
  read(): { readonly batch: CohortCompletionBatchV1; readonly handoff: CohortCompletionHandoffV1; readonly fence: CohortCompletionPrimaryFenceV1; readonly mode: "record" | "verify"; readonly operatorSettlement: CohortOperatorSettlementV1 | null } {
    if (this.#brand !== "cq-cohort-completion-authorization") throw new Error("invalid cohort completion authorization");
    assertCohortCompletionBatchV1(this.#batch);
    assertCohortCompletionHandoffV1(this.#handoff);
    return { batch: structuredClone(this.#batch), handoff: structuredClone(this.#handoff), fence: structuredClone(this.#fence), mode: this.#mode,
      operatorSettlement: structuredClone(this.#operatorSettlement) };
  }
}

class IssuedCohortCompletionHandoffV1 {
  readonly #value: CohortCompletionHandoffV1;
  constructor(value: CohortCompletionHandoffV1) { this.#value = structuredClone(value); }
  read(): CohortCompletionHandoffV1 { return structuredClone(this.#value); }
}

export type AuthorizedCohortCompletionHandoffV1 = IssuedCohortCompletionHandoffV1;

export function readAuthorizedCohortCompletionHandoffV1(value: AuthorizedCohortCompletionHandoffV1): CohortCompletionHandoffV1 {
  if (!(value instanceof IssuedCohortCompletionHandoffV1)) throw new Error("cohort handoff requires coordinator-issued authority");
  return value.read();
}

export type AuthorizedCohortCompletionV1 = IssuedCohortCompletionV1;

export function readAuthorizedCohortCompletionV1(value: AuthorizedCohortCompletionV1) {
  if (!(value instanceof IssuedCohortCompletionV1)) throw new Error("cohort completion requires coordinator-issued authority");
  return value.read();
}

export class CohortCompletionCoordinatorV1 {
  constructor(readonly store: WorkCohortStore, readonly ledger: LedgerStore, readonly host: CohortCompletionHostV1) {}

  async run(input: CohortCompletionBatchV1, lease: WorkCohortLeaseV1): Promise<CohortCompletionHandoffV1> {
    const batch = immutableClone(input);
    assertCohortCompletionBatchV1(batch);
    const measured: Partial<Record<CohortActivityMeasurementV1, number>> = { primaryFinalizationAttempts: 1 };
    const measure = (measurement: CohortActivityMeasurementV1, value: number) => { measured[measurement] = (measured[measurement] ?? 0) + value; };
    try { return await this.runMeasured(batch, lease, measure); }
    finally {
      await this.store.recordActivity(createCohortActivityV1({ semanticSubject: batch.envelope.semanticSubject,
        executionEpoch: lease.executionEpoch, executions: [],
        measurements: (Object.entries(measured) as [CohortActivityMeasurementV1, number][])
          .filter(([, value]) => value > 0).map(([measurement, value]) => ({ measurement, value })),
      }));
    }
  }

  private async runMeasured(batch: CohortCompletionBatchV1, lease: WorkCohortLeaseV1,
    measure: (measurement: CohortActivityMeasurementV1, value: number) => void): Promise<CohortCompletionHandoffV1> {
    await this.store.assertLiveCohortAuthority(lease, batch.envelope);
    const snapshot = await this.store.snapshot();
    const acceptance = snapshot.portable.completionReceipts.find(({ completionDigest }) => completionDigest === batch.acceptance.completionDigest);
    const seal = snapshot.portable.candidateSeals.find(({ sealDigest }) => sealDigest === batch.acceptance.sealDigest);
    const atom = snapshot.portable.commonAtoms.find(({ atomDigest }) => atomDigest === batch.envelope.definition.selectedAtomDigest);
    if (acceptance === undefined || cohortValueDigestV1(acceptance) !== cohortValueDigestV1(batch.acceptance) ||
        seal === undefined || seal.resultCommit !== batch.resultCommit || atom === undefined) {
      throw new Error("cohort completion lacks exact durable accepted candidate");
    }
    if ((atom.deploymentClass.identity === "deployment:none") !== (batch.deploymentPlan === null) ||
        (batch.deploymentPlan !== null && batch.deploymentPlan.deploymentClass !== atom.deploymentClass.digest)) {
      throw new Error("cohort completion lacks its exact declared deployment plan");
    }
    try { await this.host.authenticateReviews(batch); }
    catch (error) { measure("reviewRejections", 1); throw error; }
    measure("reviewReuses", new Set(batch.members.flatMap((member) => member.reviewAttemptRefs)).size);
    let handoff = snapshot.portable.completionHandoffs.findLast((value) => value.operationId === batch.operationId);
    if (handoff !== undefined) {
      assertCohortCompletionHandoffBindingsV1(handoff, batch.envelope.definition, atom);
      if (handoff.batchDigest !== batch.batchDigest) throw new Error("cohort completion retry changed its batch");
      await this.host.authenticateHandoff(batch, immutableClone(handoff));
    }
    const persist = async (input: Omit<CohortCompletionHandoffV1, "kind" | "version" | "handoffDigest">) => {
      await this.store.assertLiveCohortAuthority(lease, batch.envelope);
      const next = createCohortCompletionHandoffV1(input);
      return await this.store.recordCompletionHandoff(`${batch.operationId}:${next.handoffDigest}`, lease, batch.envelope, new IssuedCohortCompletionHandoffV1(next));
    };
    const body = (value: CohortCompletionHandoffV1) => {
      const { kind: _kind, version: _version, handoffDigest: _digest, ...input } = value;
      return input;
    };
    if (handoff === undefined) handoff = await persist({ operationId: batch.operationId, batchDigest: batch.batchDigest,
      definitionDigest: batch.acceptance.definitionDigest, sealDigest: batch.acceptance.sealDigest,
      evidenceSubjectDigest: batch.acceptance.evidenceSubjectDigest, phase: "prepared", mergeReceiptDigest: null,
      deployment: null, probes: [], ledgerResult: null });
    if (handoff.batchDigest !== batch.batchDigest) throw new Error("cohort completion retry changed its batch");
    let primaryResultVerified = false;
    if (handoff.phase === "ledger-recording") {
      const recording = handoff;
      handoff = await (async () => {
        const current = await this.store.snapshot();
        await this.store.assertLiveCohortAuthority(lease, batch.envelope);
        let recorded: CohortCompletionLedgerResultV1 | null;
        try {
          recorded = await recordProtectedCohortCompletion(this.ledger, new IssuedCohortCompletionV1(batch, recording,
            { revision: current.revision, executionEpoch: current.runtime.executionEpoch }, "verify", null));
        } catch (error) {
          if (!(error instanceof CohortPrimaryCompletionMissingError)) throw error;
          recorded = null;
        }
        primaryResultVerified = recorded !== null;
        return recorded === null
          ? await persist({ ...body(recording), phase: "merged" })
          : await persist({ ...body(recording), phase: "ledger-recorded", ledgerResult: recorded });
      })();
    }
    if (handoff.phase === "prepared") {
      const merge = await this.host.merge(batch);
      if (merge.sealDigest !== batch.acceptance.sealDigest || merge.resultCommit !== batch.resultCommit) throw new Error("cohort merge changed its sealed candidate");
      handoff = await persist({ ...body(handoff), phase: "merged", mergeReceiptDigest: merge.receiptDigest });
    }
    if (handoff.phase === "merged" || handoff.phase === "probes-complete") {
      const deployment = await this.host.deployment(batch, immutableClone(handoff.deployment));
      if (deployment === null && atom.deploymentClass.identity !== "deployment:none") throw new Error("cohort deployment class requires a shared operator action and probes");
      if (deployment !== null && (deployment.startupBuildCommit !== batch.resultCommit || deployment.deploymentClass !== atom.deploymentClass.digest)) {
        throw new Error("cohort deployment differs from its sealed commit or compatibility class");
      }
      const changed = cohortValueDigestV1(deployment) !== cohortValueDigestV1(handoff.deployment);
      if (changed || handoff.phase === "merged") {
        if (changed) handoff = await persist({ ...body(handoff), phase: "merged", deployment, probes: [] });
        const priorProbes = handoff.probes;
        const probes: CohortDeploymentProbeV1[] = [];
        if (deployment !== null) for (const member of batch.members) {
          await this.store.assertLiveCohortAuthority(lease, batch.envelope);
          const priorProbe = priorProbes.find((probe) => probe.taskRef === member.taskRef && probe.passed);
          if (priorProbe !== undefined) measure("deploymentProbeReuses", 1);
          const probe = priorProbe === undefined ? await this.host.probe(batch, immutableClone(deployment), member.taskRef) : priorProbe;
          if (probe.taskRef !== member.taskRef) throw new Error("cohort deployment probe substituted a member");
          probes.push(probe);
          handoff = await persist({ ...body(handoff), phase: "merged", deployment, probes: [...probes] });
          if (!probe.passed) throw new Error(`cohort deployment probe failed for ${member.taskRef}`);
        }
        handoff = await persist({ ...body(handoff), phase: "probes-complete", deployment, probes });
      }
    }
    if (handoff.phase === "probes-complete") handoff = await persist({ ...body(handoff), phase: "ledger-recording" });
    if (handoff.phase === "ledger-recording") {
      await this.host.authenticateHandoff(batch, immutableClone(handoff));
      const recording = handoff;
      handoff = await this.host.withPrimaryAdmission(batch, async () => {
        const operatorSettlement = await this.host.operatorSettlement(batch, immutableClone(recording));
        const current = await this.store.snapshot();
        await this.store.assertLiveCohortAuthority(lease, batch.envelope);
        const result = await recordProtectedCohortCompletion(this.ledger, new IssuedCohortCompletionV1(batch, recording,
          { revision: current.revision, executionEpoch: current.runtime.executionEpoch }, "record", operatorSettlement));
        return await persist({ ...body(recording), phase: "ledger-recorded", ledgerResult: result });
      });
      primaryResultVerified = true;
    }
    if (!primaryResultVerified && (handoff.phase === "ledger-recorded" || handoff.phase === "released")) {
      const recordedHandoff = handoff;
      await (async () => {
        const current = await this.store.snapshot();
        await this.store.assertLiveCohortAuthority(lease, batch.envelope);
        const recorded = await recordProtectedCohortCompletion(this.ledger, new IssuedCohortCompletionV1(batch, recordedHandoff,
          { revision: current.revision, executionEpoch: current.runtime.executionEpoch }, "verify", null));
        if (cohortValueDigestV1(recorded) !== cohortValueDigestV1(recordedHandoff.ledgerResult)) throw new Error("cohort handoff differs from its protected primary completion evidence");
      })();
    }
    if (handoff.phase === "ledger-recorded") {
      if (handoff.ledgerResult === null) throw new Error("cohort completion ledger result is absent");
      await this.host.settle(batch, immutableClone(handoff.ledgerResult));
      handoff = await persist({ ...body(handoff), phase: "released" });
    }
    return handoff;
  }
}
