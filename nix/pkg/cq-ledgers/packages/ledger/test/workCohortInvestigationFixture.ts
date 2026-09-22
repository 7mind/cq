import {
  DISPATCH_OVERLAY_REGISTRY,
  InMemoryAttestationStore,
  confirmDispatchCompletion,
  prepareDispatch,
  storeDispatchResult,
  sequentialDispatchRandomBytes,
  type DispatchJSONValue,
  type DispatchPrepared,
} from "@cq/config";
import {
  constructCohortDecisionsV1,
  createCohortDefinitionIdentityV1,
  produceCohortAdmissionObservationV1,
  type CohortAdmissionObservationSourceV1,
} from "../src/workCohort.js";
import {
  InvestigationCohortRunnerV1,
  InvestigationDispatchAuthenticatorV1,
  InvestigationBindingError,
  createInvestigationCohortPlanV1,
  createInvestigationPreparedDispatchV1,
  type InvestigationCohortHostV1,
  type InvestigationCohortPlanV1,
  type InvestigationDispatchBindingV1,
  type InvestigationEvidenceV1,
  type InvestigationPreparedDispatchV1,
  type InvestigationRoleContractV1,
} from "../src/workCohortInvestigation.js";
import type { WorkCohortStore } from "../src/workCohortStore.js";
import { sha256, snapshotFor } from "./workCohortFixture.js";

export const INVESTIGATION_NOW = "2026-09-22T12:00:00.000Z";
export function investigationRole(
  roleId: InvestigationRoleContractV1["roleId"],
): InvestigationRoleContractV1 {
  return {
    roleId,
    version: 2,
    surface: "claude",
    promptDigest: sha256(roleId),
    catalogHash: sha256("catalog"),
    schemaDigest: sha256(`${roleId}:schema`),
  };
}
export async function investigationPlanFixture(store: WorkCohortStore): Promise<{
  readonly plan: InvestigationCohortPlanV1;
  readonly source: CohortAdmissionObservationSourceV1;
}> {
  const raw = snapshotFor(
    [
      { ref: "defects:D1", phase: "investigation" },
      { ref: "defects:D2", phase: "investigation" },
    ],
    {},
  );
  const snapshot = {
    ...raw,
    members: raw.members.map((member, index) => {
      if (member.phase !== "investigation")
        throw new Error("fixture requires investigation members");
      return {
        ...member,
        defectRef: member.memberRef,
        defectRevision: member.memberRevision,
        hypothesisRef: `hypothesis:H${index + 1}`,
        hypothesisRevision: sha256(`hypothesis:${index}`),
      };
    }),
  };
  const source = { resolveExactSnapshot: async () => snapshot };
  const observation = await produceCohortAdmissionObservationV1(
    { memberRefs: snapshot.members.map((member) => member.memberRef) },
    source,
  );
  const decision = constructCohortDecisionsV1(observation)[0]!;
  const definition = createCohortDefinitionIdentityV1({
    cohortId: "cohort:investigation-contract",
    decision,
    observation,
    prior: null,
  });
  await store.recordObservation("investigation-observation", observation);
  await store.recordDecision("investigation-decision", decision);
  await store.recordDefinition("investigation-definition", definition);
  const plan = createInvestigationCohortPlanV1({
    definition,
    observation,
    explorer: investigationRole("investigate-explorer"),
    prober: investigationRole("investigate-prober"),
    members: snapshot.members.map((member) => ({
      defectRef: member.defectRef,
      defectRevision: member.defectRevision,
      hypothesisRef: member.hypothesisRef,
      hypothesisRevision: member.hypothesisRevision,
      statement: "The shared contract violates the boundary",
      branchContext: "Inspect this member's exact causal path",
      leads: [],
    })),
  });
  return { plan, source };
}
export class ManualInvestigationHost implements InvestigationCohortHostV1 {
  readonly attestations = new InMemoryAttestationStore({
    backend: "xdg",
    projectKey: "cohort-investigation",
  });
  readonly randomBytes = sequentialDispatchRandomBytes();
  readonly prepared = new Map<string, DispatchPrepared>();
  readonly executions: InvestigationDispatchBindingV1[] = [];
  probe = false;
  stale = false;
  invalidCitation = false;
  contradictory = false;
  uncertain = false;
  distinctCause = false;
  distinctBoundary = false;
  distinctAtom = false;
  inapplicableAtom = false;
  interruptAfterExecution: number | null = null;
  outputOverride: InvestigationEvidenceV1 | null = null;
  async assertCurrent(_plan: InvestigationCohortPlanV1): Promise<void> {
    if (this.stale) throw new InvestigationBindingError("test observed a changed member revision");
  }
  async prepare(binding: InvestigationDispatchBindingV1): Promise<InvestigationPreparedDispatchV1> {
    const expectedChild = {
      childId: `child:${binding.bindingDigest}`,
      runId: `run:${binding.bindingDigest}`,
    };
    const role = binding.role;
    const outcome = prepareDispatch(
      {
        namespace: this.attestations.namespace,
        roleId: role.roleId,
        surface: role.surface,
        input: binding.input,
        idempotencyKey: binding.bindingDigest,
        timeoutMs: 60_000,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: role.promptDigest,
        catalogHash: role.catalogHash,
        expectedChild,
      },
      { store: this.attestations, now: () => INVESTIGATION_NOW, randomBytes: this.randomBytes },
    );
    if (!outcome.accepted) throw new Error(JSON.stringify(outcome));
    const prepared = createInvestigationPreparedDispatchV1({
      binding,
      handle: outcome.handle,
      expectedChild,
      provenance: outcome.prepared.promptProvenance,
    });
    this.prepared.set(prepared.preparedDigest, outcome.prepared);
    return prepared;
  }
  output(binding: InvestigationDispatchBindingV1): InvestigationEvidenceV1 {
    if (this.outputOverride !== null) return this.outputOverride;
    const probe = this.probe && binding.role.roleId === "investigate-explorer";
    return {
      hypothesisId: binding.member.hypothesisRef.slice("hypothesis:".length),
      evidence: [
        {
          n: 1,
          citation: `src/member-${binding.memberIndex}.ts:1-3`,
          excerpt: "first\nsecond\nthird",
          relevance: "Shows the member's causal chain",
        },
      ],
      lean: probe
        ? "insufficient"
        : this.contradictory && binding.memberIndex === 1
          ? "contradicts"
          : "supports",
      ...(probe
        ? {
            probeRequest: {
              what: `bun test member-${binding.memberIndex}`,
              why: "Execution distinguishes the causal branch",
            },
          }
        : {}),
    };
  }
  async execute(prepared: InvestigationPreparedDispatchV1): Promise<void> {
    const launch = this.prepared.get(prepared.preparedDigest);
    if (launch === undefined) throw new Error("fixture has no prepared capabilities");
    this.executions.push(prepared.binding);
    storeDispatchResult(
      {
        resultCapability: launch.resultCapability,
        output: this.output(prepared.binding) as unknown as DispatchJSONValue,
      },
      { store: this.attestations, now: () => INVESTIGATION_NOW },
    );
    confirmDispatchCompletion(
      {
        namespace: this.attestations.namespace,
        ...prepared.handle,
        nativeCompletion: {
          kind: "native-completion",
          actor: "trusted-parent",
          ...prepared.expectedChild,
          completedAt: INVESTIGATION_NOW,
        },
        expectedProvenance: prepared.provenance,
      },
      { store: this.attestations, now: () => INVESTIGATION_NOW },
    );
    if (this.interruptAfterExecution === this.executions.length)
      throw new Error("simulated crash after consumed dispatch");
  }
  async authenticate(prepared: InvestigationPreparedDispatchV1) {
    const row = this.attestations.read(prepared.handle);
    if (row?.kind === "envelope" && row.state === "prepared") return null;
    return new InvestigationDispatchAuthenticatorV1(this.attestations).authenticate(prepared);
  }
  async resolveCitation(
    _prepared: InvestigationPreparedDispatchV1,
    evidence: Parameters<InvestigationCohortHostV1["resolveCitation"]>[1],
  ) {
    return {
      citation: evidence.citation,
      text: this.invalidCitation ? "not the cited source" : evidence.excerpt,
      sourceDigest: sha256(evidence.citation),
    };
  }
  async adjudicate(member: Parameters<InvestigationCohortHostV1["adjudicate"]>[0]) {
    const suffix = member.defectRef === "defects:D2" ? "different" : "shared";
    return {
      verdict: this.uncertain ? ("uncertain" as const) : ("confirmed" as const),
      rationale: "Validated member-specific causal chain",
      causeDigest: sha256(this.distinctCause ? suffix : "shared"),
      correctionBoundaryDigest: sha256(this.distinctBoundary ? suffix : "shared"),
      implementationAtomDigests: [sha256(this.distinctAtom ? suffix : "shared")],
    };
  }
  async validateCorrectionBoundary(
    _plan: InvestigationCohortPlanV1,
    causes: Parameters<InvestigationCohortHostV1["validateCorrectionBoundary"]>[1],
    atom: string,
  ): Promise<void> {
    if (this.inapplicableAtom || causes.length !== 2 || atom !== sha256("shared")) {
      throw new InvestigationBindingError(
        "implementation producer rejected common-atom applicability",
      );
    }
  }
}
export async function investigationRunnerFixture(store: WorkCohortStore) {
  const { plan } = await investigationPlanFixture(store);
  const host = new ManualInvestigationHost();
  const runner = new InvestigationCohortRunnerV1(store, host);
  const lease = await store.acquireLease({
    holderId: "investigator",
    semanticSubject: plan.planDigest,
  });
  return { plan, host, runner, lease };
}
