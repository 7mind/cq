import {
  assertDispatchHandle,
  dispatchPayloadDigest,
  investigateExplorerSidecar,
  investigateProberSidecar,
  validateAgainstSchema,
  type AttestationStore,
  type DispatchHandle,
  type DispatchJSONValue,
  type DispatchPromptProvenance,
} from "@cq/config";
import {
  cohortValueDigestV1 as digest,
  type CohortAdmissionObservationV1,
  type CohortDefinitionIdentityV1,
} from "./workCohort.js";
import type { WorkCohortLeaseV1, WorkCohortStore } from "./workCohortStore.js";

export type InvestigationRoleV1 = "investigate-explorer" | "investigate-prober";
export class InvestigationBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigationBindingError";
  }
}
class InvestigationCitationError extends Error {}
export interface InvestigationRoleContractV1 {
  readonly roleId: InvestigationRoleV1;
  readonly version: number;
  readonly surface: DispatchPromptProvenance["surface"];
  readonly promptDigest: string;
  readonly catalogHash: string;
  readonly schemaDigest: string;
}
export interface InvestigationMemberPlanV1 {
  readonly defectRef: string;
  readonly defectRevision: string;
  readonly hypothesisRef: string;
  readonly hypothesisRevision: string;
  readonly statement: string;
  readonly branchContext: string;
  readonly leads: readonly string[];
}
export interface InvestigationCohortPlanV1 {
  readonly kind: "cq-investigation-cohort-plan";
  readonly version: 1;
  readonly definition: CohortDefinitionIdentityV1;
  readonly members: readonly InvestigationMemberPlanV1[];
  readonly explorer: InvestigationRoleContractV1;
  readonly prober: InvestigationRoleContractV1;
  readonly planDigest: string;
}
export interface InvestigationDispatchBindingV1 {
  readonly definitionDigest: string;
  readonly planDigest: string;
  readonly memberIndex: number;
  readonly member: InvestigationMemberPlanV1;
  readonly role: InvestigationRoleContractV1;
  readonly input: DispatchJSONValue;
  readonly inputDigest: string;
  readonly explorerReceiptDigest: string | null;
  readonly bindingDigest: string;
}
export interface InvestigationPreparedDispatchV1 {
  readonly binding: InvestigationDispatchBindingV1;
  readonly handle: DispatchHandle;
  readonly expectedChild: { readonly childId: string; readonly runId: string };
  readonly provenance: DispatchPromptProvenance;
  readonly preparedDigest: string;
}
export interface InvestigationEvidenceItemV1 {
  readonly n: number;
  readonly citation: string;
  readonly excerpt: string;
  readonly relevance: string;
}
export interface InvestigationEvidenceV1 {
  readonly hypothesisId: string;
  readonly evidence: readonly InvestigationEvidenceItemV1[];
  readonly lean: "supports" | "contradicts" | "mixed" | "insufficient";
  readonly notes?: string;
  readonly probeRequest?: { readonly what: string; readonly why: string };
}
export interface InvestigationConsumedReceiptV1 {
  readonly prepared: InvestigationPreparedDispatchV1;
  readonly output: InvestigationEvidenceV1;
  readonly outputDigest: string;
  readonly consumedAt: string;
  readonly terminalDigest: string;
  readonly receiptDigest: string;
}
export interface InvestigationValidatedCitationV1 {
  readonly evidenceNumber: number;
  readonly citation: string;
  readonly excerptDigest: string;
  readonly sourceDigest: string;
}
export interface InvestigationMemberAdjudicationV1 {
  readonly verdict: "confirmed" | "wrong" | "uncertain";
  readonly rationale: string;
  readonly causeDigest: string | null;
  readonly correctionBoundaryDigest: string | null;
  readonly implementationAtomDigests: readonly string[];
}
export interface InvestigationConfirmedCauseReceiptV1 {
  readonly definitionDigest: string;
  readonly planDigest: string;
  readonly memberIndex: number;
  readonly defectRef: string;
  readonly defectRevision: string;
  readonly hypothesisRef: string;
  readonly hypothesisRevision: string;
  readonly resultReceiptDigests: readonly string[];
  readonly citationDigest: string;
  readonly adjudicationDigest: string;
  readonly causeDigest: string;
  readonly correctionBoundaryDigest: string;
  readonly implementationAtomDigests: readonly string[];
  readonly receiptDigest: string;
}
export interface InvestigationMemberRunV1 {
  readonly explorer: InvestigationPreparedDispatchV1 | null;
  readonly explorerResult: InvestigationConsumedReceiptV1 | null;
  readonly prober: InvestigationPreparedDispatchV1 | null;
  readonly proberResult: InvestigationConsumedReceiptV1 | null;
  readonly citations: readonly InvestigationValidatedCitationV1[];
  readonly adjudication: InvestigationMemberAdjudicationV1 | null;
  readonly confirmedCause: InvestigationConfirmedCauseReceiptV1 | null;
}
export type InvestigationSplitReasonV1 =
  | "contradiction"
  | "stale-binding"
  | "invalid-citation"
  | "non-shared-cause"
  | "incompatible-correction-boundary";
export interface InvestigationCohortRunV1 {
  readonly kind: "cq-investigation-cohort-run";
  readonly version: 1;
  readonly plan: InvestigationCohortPlanV1;
  readonly sequence: number;
  readonly priorRunDigest: string | null;
  readonly members: readonly InvestigationMemberRunV1[];
  readonly state: "running" | "awaiting-evidence" | "correction-ready" | "split";
  readonly split: {
    readonly reason: InvestigationSplitReasonV1;
    readonly memberRef: string | null;
    readonly detail: string;
  } | null;
  readonly implementationAtomDigest: string | null;
  readonly runDigest: string;
}

function same(left: unknown, right: unknown): boolean {
  return digest(left) === digest(right);
}
function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new Error("investigation binding requires SHA-256");
}
function closed(value: object, fields: readonly string[], label: string): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...fields].sort())
  )
    throw new Error(`${label} has an invalid closed shape`);
}
function sidecar(role: InvestigationRoleV1) {
  return role === "investigate-explorer" ? investigateExplorerSidecar : investigateProberSidecar;
}
function validateRole(role: InvestigationRoleContractV1, roleId: InvestigationRoleV1): void {
  closed(
    role,
    ["roleId", "version", "surface", "promptDigest", "catalogHash", "schemaDigest"],
    "investigation role",
  );
  if (
    role.roleId !== roleId ||
    role.version !== sidecar(roleId).version ||
    !["claude", "codex", "pi"].includes(role.surface)
  )
    throw new Error("investigation role contract changed");
  for (const value of [role.promptDigest, role.catalogHash, role.schemaDigest]) assertDigest(value);
}
export function createInvestigationCohortPlanV1(input: {
  readonly definition: CohortDefinitionIdentityV1;
  readonly observation: CohortAdmissionObservationV1;
  readonly members: readonly InvestigationMemberPlanV1[];
  readonly explorer: InvestigationRoleContractV1;
  readonly prober: InvestigationRoleContractV1;
}): InvestigationCohortPlanV1 {
  validateRole(input.explorer, "investigate-explorer");
  validateRole(input.prober, "investigate-prober");
  if (input.members.length === 0 || input.members.length !== input.definition.members.length)
    throw new Error("investigation plan omits a member");
  input.members.forEach((member, index) => {
    closed(
      member,
      [
        "defectRef",
        "defectRevision",
        "hypothesisRef",
        "hypothesisRevision",
        "statement",
        "branchContext",
        "leads",
      ],
      "investigation member",
    );
    const frozen = input.definition.members[index];
    const observed = input.observation.members.find(
      (value) => value.memberRef === member.defectRef,
    );
    if (
      frozen === undefined ||
      frozen.memberRef !== member.defectRef ||
      observed === undefined ||
      observed.phase !== "investigation" ||
      observed.defectRef !== member.defectRef ||
      observed.defectRevision !== member.defectRevision ||
      observed.hypothesisRef !== member.hypothesisRef ||
      observed.hypothesisRevision !== member.hypothesisRevision ||
      !/^defects:D\d+$/u.test(member.defectRef) ||
      !/^hypothesis:H\d+$/u.test(member.hypothesisRef) ||
      member.statement.trim() === "" ||
      member.branchContext.trim() === "" ||
      !Array.isArray(member.leads) ||
      member.leads.some((lead) => typeof lead !== "string")
    ) {
      throw new Error(
        "investigation plan differs from its ordered frozen defect/hypothesis members",
      );
    }
  });
  const payload = {
    kind: "cq-investigation-cohort-plan" as const,
    version: 1 as const,
    definition: input.definition,
    members: input.members,
    explorer: input.explorer,
    prober: input.prober,
  };
  return structuredClone({ ...payload, planDigest: digest(payload) });
}
function bindingFor(
  plan: InvestigationCohortPlanV1,
  memberIndex: number,
  explorer: InvestigationConsumedReceiptV1 | null,
): InvestigationDispatchBindingV1 {
  const member = plan.members[memberIndex];
  if (member === undefined) throw new Error("investigation member index is outside the plan");
  const role = explorer === null ? plan.explorer : plan.prober;
  if (
    explorer !== null &&
    (explorer.output.probeRequest === undefined || explorer.output.lean !== "insufficient")
  ) {
    throw new Error("prober dispatch lacks the exact explorer probe request");
  }
  const input: DispatchJSONValue = {
    defectId: member.defectRef.slice("defects:".length),
    hypothesisId: member.hypothesisRef.slice("hypothesis:".length),
    statement: member.statement,
    branchContext: member.branchContext,
    leads: [...member.leads],
    ...(explorer === null ? {} : { probeRequest: { ...explorer.output.probeRequest! } }),
  };
  const payload = {
    definitionDigest: plan.definition.definitionDigest,
    planDigest: plan.planDigest,
    memberIndex,
    member,
    role,
    input,
    inputDigest: dispatchPayloadDigest(input),
    explorerReceiptDigest: explorer === null ? null : explorer.receiptDigest,
  };
  return { ...payload, bindingDigest: digest(payload) };
}
export function createInvestigationPreparedDispatchV1(input: {
  readonly binding: InvestigationDispatchBindingV1;
  readonly handle: DispatchHandle;
  readonly expectedChild: InvestigationPreparedDispatchV1["expectedChild"];
  readonly provenance: DispatchPromptProvenance;
}): InvestigationPreparedDispatchV1 {
  const result = { ...structuredClone(input), preparedDigest: digest(input) };
  validatePrepared(result, input.binding);
  return result;
}
function validatePrepared(
  prepared: InvestigationPreparedDispatchV1,
  binding: InvestigationDispatchBindingV1,
): void {
  closed(
    prepared,
    ["binding", "handle", "expectedChild", "provenance", "preparedDigest"],
    "investigation dispatch",
  );
  closed(prepared.handle, ["attestationId", "generation"], "investigation handle");
  assertDispatchHandle(prepared.handle);
  const { preparedDigest, ...payload } = prepared;
  const role = binding.role;
  const provenance = {
    roleId: role.roleId,
    version: role.version,
    surface: role.surface,
    promptDigest: role.promptDigest,
    catalogHash: role.catalogHash,
    inputDigest: binding.inputDigest,
  };
  if (
    !same(prepared.binding, binding) ||
    !same(prepared.provenance, provenance) ||
    preparedDigest !== digest(payload) ||
    prepared.expectedChild.childId.trim() === "" ||
    prepared.expectedChild.runId.trim() === ""
  ) {
    throw new InvestigationBindingError(
      "investigation dispatch substituted its role, member, generation, or input binding",
    );
  }
}

class IssuedInvestigationResultV1 {
  readonly #receipt: InvestigationConsumedReceiptV1;
  constructor(receipt: InvestigationConsumedReceiptV1) {
    this.#receipt = structuredClone(receipt);
  }
  receipt(): InvestigationConsumedReceiptV1 {
    return structuredClone(this.#receipt);
  }
}
export type AuthorizedInvestigationResultV1 = IssuedInvestigationResultV1;
export class InvestigationDispatchAuthenticatorV1 {
  constructor(private readonly store: Pick<AttestationStore, "read" | "namespace">) {}
  authenticate(prepared: InvestigationPreparedDispatchV1): AuthorizedInvestigationResultV1 {
    validatePrepared(prepared, prepared.binding);
    const row = this.store.read(prepared.handle);
    if (
      row === undefined ||
      row.kind !== "envelope" ||
      row.state !== "consumed" ||
      row.attestationId !== prepared.handle.attestationId ||
      row.generation !== prepared.handle.generation ||
      !same(row.namespace, this.store.namespace) ||
      !same(row.promptProvenance, prepared.provenance) ||
      !same(row.expectedChild, prepared.expectedChild) ||
      !same(row.input, prepared.binding.input) ||
      row.nativeCompletion === undefined ||
      row.nativeCompletion.kind !== "native-completion" ||
      !["trusted-parent", "trusted-extension"].includes(row.nativeCompletion.actor) ||
      !Number.isFinite(Date.parse(row.nativeCompletion.completedAt)) ||
      row.nativeCompletion.childId !== prepared.expectedChild.childId ||
      row.nativeCompletion.runId !== prepared.expectedChild.runId ||
      row.output === undefined ||
      row.outputDigest !== dispatchPayloadDigest(row.output) ||
      row.consumedAt === undefined ||
      row.terminalDigest === undefined ||
      row.terminalAt !== row.consumedAt
    ) {
      throw new InvestigationBindingError(
        "investigation requires its exact consumed native dispatch and stored output",
      );
    }
    if (
      row.terminalDigest !==
      dispatchPayloadDigest({
        terminalKind: "consumed",
        outputDigest: row.outputDigest,
        childId: row.nativeCompletion.childId,
        runId: row.nativeCompletion.runId,
        completedAt: row.nativeCompletion.completedAt,
      })
    ) {
      throw new InvestigationBindingError(
        "investigation consumed terminal digest differs from its completed result bytes",
      );
    }
    if (!validateAgainstSchema(sidecar(prepared.binding.role.roleId).outputSchema, row.output).ok) {
      throw new InvestigationBindingError("investigation result violates the existing role schema");
    }
    const output = row.output as unknown as InvestigationEvidenceV1;
    if (
      `hypothesis:${output.hypothesisId}` !== prepared.binding.member.hypothesisRef ||
      (output.probeRequest !== undefined && output.lean !== "insufficient") ||
      new Set(output.evidence.map((item) => item.n)).size !== output.evidence.length
    ) {
      throw new InvestigationBindingError(
        "investigation result substituted its hypothesis or evidence numbering",
      );
    }
    const payload = {
      prepared,
      output,
      outputDigest: row.outputDigest,
      consumedAt: row.consumedAt,
      terminalDigest: row.terminalDigest,
    };
    return new IssuedInvestigationResultV1({ ...payload, receiptDigest: digest(payload) });
  }
}

export interface InvestigationCitationSourceV1 {
  readonly citation: string;
  readonly text: string;
  readonly sourceDigest: string;
}
export interface InvestigationCohortHostV1 {
  assertCurrent(plan: InvestigationCohortPlanV1): Promise<void>;
  prepare(binding: InvestigationDispatchBindingV1): Promise<InvestigationPreparedDispatchV1>;
  execute(prepared: InvestigationPreparedDispatchV1): Promise<void>;
  authenticate(
    prepared: InvestigationPreparedDispatchV1,
  ): Promise<AuthorizedInvestigationResultV1 | null>;
  resolveCitation(
    prepared: InvestigationPreparedDispatchV1,
    evidence: InvestigationEvidenceItemV1,
  ): Promise<InvestigationCitationSourceV1>;
  adjudicate(
    member: InvestigationMemberPlanV1,
    results: readonly InvestigationConsumedReceiptV1[],
    citations: readonly InvestigationValidatedCitationV1[],
  ): Promise<InvestigationMemberAdjudicationV1 | null>;
  validateCorrectionBoundary(
    plan: InvestigationCohortPlanV1,
    causes: readonly InvestigationConfirmedCauseReceiptV1[],
    implementationAtomDigest: string,
  ): Promise<void>;
}

function validateReceipt(
  receipt: InvestigationConsumedReceiptV1,
  prepared: InvestigationPreparedDispatchV1,
): void {
  closed(
    receipt,
    ["prepared", "output", "outputDigest", "consumedAt", "terminalDigest", "receiptDigest"],
    "investigation receipt",
  );
  const { receiptDigest, ...payload } = receipt;
  if (
    !same(receipt.prepared, prepared) ||
    receiptDigest !== digest(payload) ||
    receipt.outputDigest !==
      dispatchPayloadDigest(receipt.output as unknown as DispatchJSONValue) ||
    !validateAgainstSchema(sidecar(prepared.binding.role.roleId).outputSchema, receipt.output).ok ||
    `hypothesis:${receipt.output.hypothesisId}` !== prepared.binding.member.hypothesisRef
  ) {
    throw new Error("investigation consumed receipt differs from its dispatch");
  }
}
function causeReceipt(
  plan: InvestigationCohortPlanV1,
  index: number,
  member: InvestigationMemberRunV1,
): InvestigationConfirmedCauseReceiptV1 | null {
  const adjudication = member.adjudication;
  if (adjudication === null || adjudication.verdict !== "confirmed") return null;
  const planned = plan.members[index]!;
  assertDigest(adjudication.causeDigest);
  assertDigest(adjudication.correctionBoundaryDigest);
  if (
    adjudication.rationale.trim() === "" ||
    adjudication.implementationAtomDigests.length === 0 ||
    member.citations.length === 0
  ) {
    throw new Error("confirmed cause requires validated citations and a correction boundary");
  }
  adjudication.implementationAtomDigests.forEach(assertDigest);
  const payload = {
    definitionDigest: plan.definition.definitionDigest,
    planDigest: plan.planDigest,
    memberIndex: index,
    defectRef: planned.defectRef,
    defectRevision: planned.defectRevision,
    hypothesisRef: planned.hypothesisRef,
    hypothesisRevision: planned.hypothesisRevision,
    resultReceiptDigests: [member.explorerResult, member.proberResult].flatMap((result) =>
      result === null ? [] : [result.receiptDigest],
    ),
    citationDigest: digest(member.citations),
    adjudicationDigest: digest(adjudication),
    causeDigest: adjudication.causeDigest,
    correctionBoundaryDigest: adjudication.correctionBoundaryDigest,
    implementationAtomDigests: adjudication.implementationAtomDigests,
  };
  return { ...payload, receiptDigest: digest(payload) };
}
export function validateInvestigationCohortRunV1(run: InvestigationCohortRunV1): void {
  closed(
    run,
    [
      "kind",
      "version",
      "plan",
      "sequence",
      "priorRunDigest",
      "members",
      "state",
      "split",
      "implementationAtomDigest",
      "runDigest",
    ],
    "investigation run",
  );
  closed(
    run.plan,
    ["kind", "version", "definition", "members", "explorer", "prober", "planDigest"],
    "investigation plan",
  );
  const { runDigest, ...payload } = run;
  const { planDigest, ...planPayload } = run.plan;
  if (
    run.kind !== "cq-investigation-cohort-run" ||
    run.version !== 1 ||
    digest(payload) !== runDigest ||
    run.plan.kind !== "cq-investigation-cohort-plan" ||
    run.plan.version !== 1 ||
    digest(planPayload) !== planDigest ||
    !Number.isSafeInteger(run.sequence) ||
    run.sequence < 0 ||
    (run.sequence === 0) !== (run.priorRunDigest === null) ||
    !["running", "awaiting-evidence", "correction-ready", "split"].includes(run.state) ||
    !Array.isArray(run.members) ||
    run.members.length !== run.plan.members.length
  )
    throw new Error("invalid investigation run identity");
  validateRole(run.plan.explorer, "investigate-explorer");
  validateRole(run.plan.prober, "investigate-prober");
  const handles: string[] = [];
  run.members.forEach((member, index) => {
    closed(
      member,
      [
        "explorer",
        "explorerResult",
        "prober",
        "proberResult",
        "citations",
        "adjudication",
        "confirmedCause",
      ],
      "investigation member run",
    );
    if (member.explorer !== null) {
      validatePrepared(member.explorer, bindingFor(run.plan, index, null));
      handles.push(digest(member.explorer.handle));
    }
    if (member.explorerResult !== null) {
      if (member.explorer === null)
        throw new Error("investigation result lacks its prepared explorer");
      validateReceipt(member.explorerResult, member.explorer);
    }
    if (member.prober !== null) {
      if (member.explorerResult === null)
        throw new Error("investigation probe lacks a consumed explorer");
      validatePrepared(member.prober, bindingFor(run.plan, index, member.explorerResult));
      handles.push(digest(member.prober.handle));
    }
    if (member.proberResult !== null) {
      if (member.prober === null) throw new Error("investigation result lacks its prepared prober");
      validateReceipt(member.proberResult, member.prober);
    }
    if (
      member.adjudication !== null &&
      (member.explorerResult === null ||
        (member.explorerResult.output.probeRequest !== undefined && member.proberResult === null))
    ) {
      throw new Error("investigation adjudication omits required member results");
    }
    if (!Array.isArray(member.citations))
      throw new Error("investigation citations must be an array");
    for (const citation of member.citations) {
      closed(
        citation,
        ["evidenceNumber", "citation", "excerptDigest", "sourceDigest"],
        "validated investigation citation",
      );
      assertDigest(citation.excerptDigest);
      assertDigest(citation.sourceDigest);
      if (
        !Number.isSafeInteger(citation.evidenceNumber) ||
        citation.evidenceNumber < 1 ||
        typeof citation.citation !== "string"
      )
        throw new Error("invalid investigation citation identity");
    }
    if (member.adjudication !== null) {
      closed(
        member.adjudication,
        [
          "verdict",
          "rationale",
          "causeDigest",
          "correctionBoundaryDigest",
          "implementationAtomDigests",
        ],
        "investigation adjudication",
      );
      if (
        !["confirmed", "wrong", "uncertain"].includes(member.adjudication.verdict) ||
        typeof member.adjudication.rationale !== "string" ||
        member.adjudication.rationale.trim() === "" ||
        !Array.isArray(member.adjudication.implementationAtomDigests)
      )
        throw new Error("invalid investigation adjudication");
    } else if (member.citations.length > 0 && (member.explorerResult === null ||
      (member.explorerResult.output.probeRequest !== undefined && member.proberResult === null)))
      throw new Error("investigation citations lack complete consumed evidence");
    if (!same(member.confirmedCause, causeReceipt(run.plan, index, member)))
      throw new Error("investigation copied or substituted a member cause receipt");
  });
  if (new Set(handles).size !== handles.length)
    throw new Error("investigation reused a prepared result across members");
  if ((run.state === "split") !== (run.split !== null))
    throw new Error("investigation split state lacks its durable reason");
  if (run.split !== null) {
    closed(run.split, ["reason", "memberRef", "detail"], "investigation split");
    if (
      ![
        "contradiction",
        "stale-binding",
        "invalid-citation",
        "non-shared-cause",
        "incompatible-correction-boundary",
      ].includes(run.split.reason) ||
      (run.split.memberRef !== null &&
        !run.plan.members.some((member) => member.defectRef === run.split!.memberRef)) ||
      typeof run.split.detail !== "string" ||
      run.split.detail.trim() === ""
    )
      throw new Error("invalid investigation split reason");
  }
  if (run.state === "correction-ready") {
    const causes = run.members.map((member) => member.confirmedCause);
    if (
      causes.length === 0 ||
      causes.some(
        (cause) =>
          cause === null ||
          cause.causeDigest !== causes[0]!.causeDigest ||
          cause.correctionBoundaryDigest !== causes[0]!.correctionBoundaryDigest ||
          !cause.implementationAtomDigests.includes(run.implementationAtomDigest!),
      )
    ) {
      throw new Error(
        "investigation correction lacks separate confirmed causes and one common implementation atom",
      );
    }
    assertDigest(run.implementationAtomDigest);
  } else if (run.implementationAtomDigest !== null)
    throw new Error("unconfirmed investigation cannot admit correction");
}

class IssuedInvestigationRunV1 {
  readonly #run: InvestigationCohortRunV1;
  constructor(run: InvestigationCohortRunV1) {
    this.#run = structuredClone(run);
  }
  run(): InvestigationCohortRunV1 {
    return structuredClone(this.#run);
  }
}
export type AuthorizedInvestigationRunV1 = IssuedInvestigationRunV1;
export function readAuthorizedInvestigationRunV1(
  value: AuthorizedInvestigationRunV1,
): InvestigationCohortRunV1 {
  if (!(value instanceof IssuedInvestigationRunV1))
    throw new Error("investigation storage requires runner-authenticated evidence");
  return value.run();
}
function nextRun(
  run: InvestigationCohortRunV1,
  change: Partial<
    Pick<InvestigationCohortRunV1, "members" | "state" | "split" | "implementationAtomDigest">
  >,
): InvestigationCohortRunV1 {
  const { runDigest, ...prior } = run;
  const payload = { ...prior, ...change, sequence: run.sequence + 1, priorRunDigest: runDigest };
  const result = { ...payload, runDigest: digest(payload) };
  validateInvestigationCohortRunV1(result);
  return result;
}
function startRun(plan: InvestigationCohortPlanV1): InvestigationCohortRunV1 {
  const payload = {
    kind: "cq-investigation-cohort-run" as const,
    version: 1 as const,
    plan,
    sequence: 0,
    priorRunDigest: null,
    members: plan.members.map(() => ({
      explorer: null,
      explorerResult: null,
      prober: null,
      proberResult: null,
      citations: [],
      adjudication: null,
      confirmedCause: null,
    })),
    state: "running" as const,
    split: null,
    implementationAtomDigest: null,
  };
  return { ...payload, runDigest: digest(payload) };
}

export class InvestigationCohortRunnerV1 {
  constructor(
    private readonly store: WorkCohortStore,
    private readonly host: InvestigationCohortHostV1,
  ) {}

  private async reauthenticate(run: InvestigationCohortRunV1): Promise<void> {
    validateInvestigationCohortRunV1(run);
    await this.host.assertCurrent(run.plan);
    for (const member of run.members) {
      for (const receipt of [member.explorerResult, member.proberResult]) {
        if (receipt === null) continue;
        const fresh = await this.host.authenticate(receipt.prepared);
        if (!(fresh instanceof IssuedInvestigationResultV1) || !same(fresh.receipt(), receipt)) {
          throw new InvestigationBindingError(
            "investigation resume lost its exact consumed dispatch",
          );
        }
      }
      if (member.adjudication !== null || member.citations.length > 0) {
        const results = [member.explorerResult, member.proberResult].filter(
          (value) => value !== null,
        );
        const citations = await this.validateCitations(results);
        const index = run.members.indexOf(member);
        if (
          !same(citations, member.citations) ||
          (member.adjudication !== null && !same(
            await this.host.adjudicate(run.plan.members[index]!, results, citations),
            member.adjudication,
          ))
        ) {
          throw new InvestigationBindingError(
            "investigation resume changed citation or member adjudication",
          );
        }
      }
    }
    if (run.state === "correction-ready") {
      await this.host.validateCorrectionBoundary(
        run.plan,
        run.members.map((member) => member.confirmedCause!),
        run.implementationAtomDigest!,
      );
    }
  }
  private async validateCitations(
    results: readonly InvestigationConsumedReceiptV1[],
  ): Promise<InvestigationValidatedCitationV1[]> {
    const citations: InvestigationValidatedCitationV1[] = [];
    for (const result of results)
      for (const evidence of result.output.evidence) {
        const observed = await this.host.resolveCitation(result.prepared, evidence);
        assertDigest(observed.sourceDigest);
        if (observed.citation !== evidence.citation || observed.text !== evidence.excerpt)
          throw new InvestigationCitationError(
            "investigation citation excerpt differs from reopened source",
          );
        citations.push({
          evidenceNumber: evidence.n,
          citation: evidence.citation,
          excerptDigest: digest(evidence.excerpt),
          sourceDigest: observed.sourceDigest,
        });
      }
    return citations;
  }
  async revalidateForResume(plan: InvestigationCohortPlanV1): Promise<void> {
    const run = (await this.store.snapshot()).portable.investigationRuns.findLast(
      (value) => value.plan.planDigest === plan.planDigest,
    ) ?? startRun(plan);
    await this.reauthenticate(run);
    await this.store.revalidateInvestigationForResume(new IssuedInvestigationRunV1(run));
  }
  async run(
    lease: WorkCohortLeaseV1,
    plan: InvestigationCohortPlanV1,
  ): Promise<InvestigationCohortRunV1> {
    if (lease.semanticSubject !== plan.planDigest)
      throw new Error("investigation lease belongs to another plan");
    await this.store.assertLiveAuthority(lease);
    let run = (await this.store.snapshot()).portable.investigationRuns.findLast(
      (value) => value.plan.planDigest === plan.planDigest,
    );
    const persist = async (next: InvestigationCohortRunV1): Promise<InvestigationCohortRunV1> => {
      if (next.state !== "split") await this.host.assertCurrent(plan);
      return this.store.recordInvestigationRun(
        lease,
        `investigation:${next.runDigest}`,
        new IssuedInvestigationRunV1(next),
      );
    };
    if (run === undefined) {
      await this.host.assertCurrent(plan);
      run = await persist(startRun(plan));
    }
    const split = async (
      reason: InvestigationSplitReasonV1,
      memberRef: string | null,
      detail: string,
    ) =>
      persist(
        nextRun(run!, {
          state: "split",
          split: { reason, memberRef, detail },
          implementationAtomDigest: null,
        }),
      );
    if (run.state === "split") return run;
    try {
      await this.reauthenticate(run);
      if (run.state === "correction-ready") return run;
      members: for (let index = 0; index < run.members.length; index++) {
        let member = run.members[index]!;
        if (member.adjudication !== null) continue;
        const update = async (change: Partial<InvestigationMemberRunV1>) => {
          member = { ...member, ...change };
          const members = [...run!.members];
          members[index] = member;
          run = await persist(nextRun(run!, { members, state: "running" }));
        };
        for (const role of ["explorer", "prober"] as const) {
          if (role === "prober" && member.explorerResult!.output.probeRequest === undefined) break;
          const resultKey = role === "explorer" ? "explorerResult" : "proberResult";
          if (member[resultKey] !== null) continue;
          if (member[role] === null) {
            await this.store.assertLiveAuthority(lease);
            await this.host.assertCurrent(plan);
            const binding = bindingFor(
              plan,
              index,
              role === "explorer" ? null : member.explorerResult,
            );
            const prepared = await this.host.prepare(binding);
            validatePrepared(prepared, binding);
            await update({ [role]: prepared });
          }
          await this.store.assertLiveAuthority(lease);
          await this.host.assertCurrent(plan);
          const prepared = member[role]!;
          let authenticated = await this.host.authenticate(prepared);
          if (authenticated === null) {
            await this.host.execute(prepared);
            authenticated = await this.host.authenticate(prepared);
          }
          await this.store.assertLiveAuthority(lease);
          await this.host.assertCurrent(plan);
          if (authenticated === null) continue members;
          if (!(authenticated instanceof IssuedInvestigationResultV1))
            throw new Error("investigation worker assertion is not consumed evidence");
          const receipt = authenticated.receipt();
          validateReceipt(receipt, prepared);
          await update({ [resultKey]: receipt });
        }
        const results = [member.explorerResult, member.proberResult].filter(
          (value) => value !== null,
        );
        let citations: InvestigationValidatedCitationV1[];
        try {
          citations = await this.validateCitations(results);
        } catch (error) {
          return split(
            "invalid-citation",
            plan.members[index]!.defectRef,
            error instanceof Error ? error.message : String(error),
          );
        }
        const adjudication = await this.host.adjudicate(plan.members[index]!, results, citations);
        if (adjudication === null) {
          if (!same(member.citations, citations)) await update({ citations });
          continue;
        }
        if (
          adjudication.verdict === "confirmed" &&
          results.some((result) => result.output.lean === "contradicts")
        ) {
          return split(
            "contradiction",
            plan.members[index]!.defectRef,
            "confirmed cause conflicts with consumed contradictory evidence",
          );
        }
        await update({
          citations,
          adjudication,
          confirmedCause: causeReceipt(plan, index, { ...member, citations, adjudication }),
        });
        if (adjudication.verdict === "wrong")
          return split("contradiction", plan.members[index]!.defectRef, adjudication.rationale);
      }
      const causes = run.members.map((member) => member.confirmedCause);
      if (causes.some((cause) => cause === null))
        return persist(nextRun(run, { state: "awaiting-evidence" }));
      const first = causes[0]!;
      if (causes.some((cause) => cause!.causeDigest !== first.causeDigest))
        return split(
          "non-shared-cause",
          null,
          "separate adjudications established different causes",
        );
      const atoms = first.implementationAtomDigests
        .filter((atom) => causes.every((cause) => cause!.implementationAtomDigests.includes(atom)))
        .sort();
      if (
        atoms.length === 0 ||
        causes.some((cause) => cause!.correctionBoundaryDigest !== first.correctionBoundaryDigest)
      ) {
        return split(
          "incompatible-correction-boundary",
          null,
          "separate causes lack one common implementation boundary",
        );
      }
      await this.reauthenticate(run);
      try {
        await this.host.validateCorrectionBoundary(
          plan,
          causes.map((cause) => cause!),
          atoms[0]!,
        );
      } catch (error) {
        return split(
          "incompatible-correction-boundary",
          null,
          error instanceof Error ? error.message : String(error),
        );
      }
      return persist(
        nextRun(run, { state: "correction-ready", implementationAtomDigest: atoms[0]! }),
      );
    } catch (error) {
      if (error instanceof InvestigationCitationError)
        return split("invalid-citation", null, error.message);
      if (!(error instanceof InvestigationBindingError)) throw error;
      return split("stale-binding", null, error.message);
    }
  }
}
