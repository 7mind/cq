import { dispatchPayloadDigest, implementReviewerSidecar, validateAgainstSchema,
  type AttestationStore, type DispatchHandle, type DispatchPromptProvenance, type ImplementWorkerSupervisedGateEvidence } from "@cq/config";
import { assertCohortEffectEnvelopeV1, cohortValueDigestV1 as digest, type CohortEffectEnvelopeV1 } from "./workCohort.js";

export interface CohortReviewRoleContractV1 {
  readonly version: number;
  readonly surface: DispatchPromptProvenance["surface"];
  readonly promptDigest: string;
  readonly catalogHash: string;
  readonly schemaDigest: string;
}

export interface CohortReviewReceiptV1 {
  readonly kind: "cq-implementation-cohort-review";
  readonly version: 1;
  readonly reviewRef: string;
  readonly envelope: CohortEffectEnvelopeV1 & { readonly state: "sealed" };
  readonly reviewerDispatch: DispatchHandle;
  readonly role: CohortReviewRoleContractV1;
  readonly namespaceDigest: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly terminalDigest: string;
  readonly gateDigest: string;
  readonly recording: { readonly operationId: string; readonly author: string; readonly session: string };
  readonly resultCommit: string;
  readonly memberObservations: readonly { readonly memberRef: string; readonly observation: string }[];
}

class IssuedCohortReviewV1 {
  readonly #receipt: CohortReviewReceiptV1;
  constructor(receipt: CohortReviewReceiptV1) { this.#receipt = structuredClone(receipt); }
  receipt(): CohortReviewReceiptV1 { return structuredClone(this.#receipt); }
}
export type AuthorizedCohortReviewV1 = IssuedCohortReviewV1;
export function readAuthorizedCohortReviewV1(value: AuthorizedCohortReviewV1): CohortReviewReceiptV1 {
  if (!(value instanceof IssuedCohortReviewV1)) throw new Error("cohort review requires authenticated consumed dispatch authority");
  return value.receipt();
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CohortReviewAuthenticatorV1 {
  constructor(private readonly store: Pick<AttestationStore, "read" | "namespace">) {}
  authenticate(input: { readonly reviewerDispatch: DispatchHandle; readonly envelope: CohortEffectEnvelopeV1;
    readonly resultCommit: string; readonly role: CohortReviewRoleContractV1;
    readonly gateEvidence: ImplementWorkerSupervisedGateEvidence;
    readonly recording: CohortReviewReceiptV1["recording"] }): AuthorizedCohortReviewV1 {
    assertCohortEffectEnvelopeV1(input.envelope);
    if (Object.values(input.recording).some((value) => value.trim() === "")) throw new Error("cohort review recording requires operation and provenance");
    if (input.envelope.state !== "sealed") throw new Error("cohort review requires a sealed candidate");
    const row = this.store.read(input.reviewerDispatch);
    if (row === undefined || row.kind !== "envelope" || row.state !== "consumed" ||
        row.attestationId !== input.reviewerDispatch.attestationId || row.generation !== input.reviewerDispatch.generation ||
        digest(row.namespace) !== digest(this.store.namespace) || row.promptProvenance.roleId !== "implement-reviewer" ||
        row.promptProvenance.version !== input.role.version || row.promptProvenance.surface !== input.role.surface ||
        row.promptProvenance.promptDigest !== input.role.promptDigest || row.promptProvenance.catalogHash !== input.role.catalogHash ||
        !object(row.input) || !object(row.output) ||
        row.promptProvenance.inputDigest !== dispatchPayloadDigest(row.input) || row.outputDigest !== dispatchPayloadDigest(row.output) ||
        row.nativeCompletion === undefined || row.nativeCompletion.kind !== "native-completion" ||
        !["trusted-parent", "trusted-extension"].includes(row.nativeCompletion.actor) ||
        row.nativeCompletion.childId !== row.expectedChild.childId || row.nativeCompletion.runId !== row.expectedChild.runId ||
        !Number.isFinite(Date.parse(row.nativeCompletion.completedAt)) || row.consumedAt === undefined || row.terminalAt !== row.consumedAt ||
        row.terminalDigest !== dispatchPayloadDigest({ terminalKind: "consumed", outputDigest: row.outputDigest,
          childId: row.nativeCompletion.childId, runId: row.nativeCompletion.runId, completedAt: row.nativeCompletion.completedAt })) {
      throw new Error("cohort review lacks exact installed role and consumed native result bindings");
    }
    if (digest(row.input["cohort"]) !== digest(input.envelope) || digest(row.output["cohort"]) !== digest(input.envelope) ||
        !validateAgainstSchema(implementReviewerSidecar.inputSchema, row.input).ok ||
        !validateAgainstSchema(implementReviewerSidecar.outputSchema, row.output).ok ||
        row.output["verdict"] !== "approve" || !Array.isArray(row.output["criticism"]) || row.output["criticism"].length !== 0 ||
        !Array.isArray(row.output["questions"]) || row.output["questions"].length !== 0 || row.output["gateReRan"] !== false) {
      throw new Error("cohort review is not a complete approving sealed-candidate result");
    }
    const gate = row.input["supervisedGateEvidence"];
    const worker = row.input["workerResult"];
    const result = row.output["resultCommitEvidence"];
    const ancestry = row.output["baseAncestry"];
    if (!object(gate) || !object(worker) || gate["version"] !== 2 ||
        digest(gate) !== digest(input.gateEvidence) ||
        digest(gate["evidenceSubject"]) !== digest(input.envelope.evidenceSubject) || gate["resultCommit"] !== input.resultCommit ||
        worker["resultCommit"] !== input.resultCommit || worker["status"] !== "pass" ||
        !object(result) || result["resultCommit"] !== input.resultCommit || result["branchTip"] !== input.resultCommit ||
        !object(ancestry) || ancestry["resultCommit"] !== input.resultCommit || ancestry["baseCommit"] !== row.input["baseCommit"] ||
        ancestry["mergeBase"] !== row.input["baseCommit"] || gate["baseCommit"] !== row.input["baseCommit"] ||
        gate["branch"] !== row.input["branch"] || gate["worktreePath"] !== row.input["worktreePath"]) {
      throw new Error("cohort review substituted whole-candidate gate or worker evidence");
    }
    const observations = row.output["memberObservations"];
    const members = input.envelope.memberAuthorities.map(({ taskRef }) => taskRef);
    if (!Array.isArray(observations) || observations.length !== members.length || observations.some((value, index) =>
      !object(value) || value["memberRef"] !== members[index] || typeof value["observation"] !== "string" || value["observation"].trim() === "")) {
      throw new Error("cohort review lacks exact distinct ordered member observations");
    }
    const payload = { kind: "cq-implementation-cohort-review" as const, version: 1 as const,
      envelope: input.envelope, reviewerDispatch: input.reviewerDispatch, role: input.role,
      namespaceDigest: digest(this.store.namespace), inputDigest: row.promptProvenance.inputDigest,
      gateDigest: digest(gate),
      recording: input.recording,
      outputDigest: row.outputDigest, terminalDigest: row.terminalDigest, resultCommit: input.resultCommit,
      memberObservations: observations as unknown as CohortReviewReceiptV1["memberObservations"] };
    return new IssuedCohortReviewV1({ ...payload, reviewRef: `cq-implementation-cohort-review:v1:${digest(payload)}` });
  }
}
