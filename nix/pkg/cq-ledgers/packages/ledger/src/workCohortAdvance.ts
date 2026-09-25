import type { CohortAdmissionPlanV1, CohortDecisionV1, CohortDefinitionIdentityV1,
  CohortEffectEnvelopeV1 } from "./workCohort.js";
import type { PrepareManagedCohortWorktreeResult, ReleaseManagedCohortWorktreeResult } from "./managedWorktree.js";
import { z } from "zod";
import type { WorkCohortStore } from "./workCohortStore.js";
import { cohortActivityCountersV1 } from "./workCohortActivity.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import { deriveWorksetPredicates } from "./store/predicates.js";
import { readCanonicalOwnership } from "./worksetOwnerEdges.js";
import { cohortValueDigestV1 as digest } from "./workCohort.js";
import type { DispatchHandle, ParentGateCapability } from "@cq/config";

export const COHORT_READY_BOUNDARY_LIMIT = 256;

export async function readCohortReadyBoundariesV1(store: LedgerStore) {
  const predicates = await deriveWorksetPredicates(store);
  const boundaries = new Map<string, { phase: "implementation" | "investigation"; ownerRef: string | null;
    members: { memberRef: string; revision: string }[] }>();
  for (const [ledgerId, phase, ids] of [
    ["tasks", "implementation", predicates.pImplement.items],
    ["defects", "investigation", predicates.pInvestigate.items],
  ] as const) for (const id of ids) {
    const item = store.fetchItem(ledgerId, id);
    const owner = readCanonicalOwnership(item);
    const ownerRef = phase === "implementation" && owner?.edgeKind === "finalized-manifest" ? owner.ownerRef : null;
    const key = `${phase}:${ownerRef ?? "workset"}`;
    const boundary = boundaries.get(key) ?? { phase, ownerRef, members: [] };
    const memberRef = `${ledgerId}:${id}`;
    boundary.members.push({ memberRef, revision: digest({ ref: memberRef, item }) });
    boundaries.set(key, boundary);
  }
  return [...boundaries.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, boundary]) => {
    const members = boundary.members.sort((left, right) => left.memberRef.localeCompare(right.memberRef));
    return { key, phase: boundary.phase, ownerRef: boundary.ownerRef,
      total: members.length, unexamined: Math.max(0, members.length - COHORT_READY_BOUNDARY_LIMIT),
      members: members.slice(0, COHORT_READY_BOUNDARY_LIMIT), boundaryDigest: digest({ key, members }) };
  });
}

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const boundarySchema = z.object({ identity: z.string().min(1), digest: digestSchema }).strict();
const witnessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirmed-cause"), causeDigest: digestSchema, receiptDigest: digestSchema }).strict(),
  z.object({ kind: z.literal("repository-node"), nodeKind: z.enum(["production-symbol", "versioned-contract", "generated-source"]),
    nodeIdentity: z.string().min(1), sourcePath: z.string().min(1), memberPath: z.array(z.string().min(1)).min(1) }).strict(),
]);
export const COHORT_ADMISSION_PLAN_SCHEMA = z.object({
  kind: z.literal("cq-cohort-admission-plan"), version: z.literal(1),
  members: z.array(z.object({ memberRef: z.string().regex(/^(?:tasks:T|defects:D)\d+$/u),
    investigationHypothesisRef: z.string().regex(/^hypothesis:H\d+$/u).optional(),
    boundaryCandidates: z.array(z.object({ witness: witnessSchema,
      sharedRegression: boundarySchema, canonicalFullGate: boundarySchema,
      reviewerClass: boundarySchema, deploymentClass: boundarySchema, finalizationClass: boundarySchema,
      splitConditions: z.array(z.string()), focusedCommand: z.object({ argv: z.array(z.string()).min(1),
        cwd: z.string().min(1), environment: z.record(z.string(), z.string()),
        provenance: z.object({ sourceRef: z.string().min(1), sourceRevision: digestSchema }).strict(),
      }).strict(),
    }).strict()).min(1),
  }).strict()).min(1).max(256),
}).strict();

export function parseCohortAdmissionPlanV1(value: unknown): CohortAdmissionPlanV1 {
  const plan = COHORT_ADMISSION_PLAN_SCHEMA.parse(value);
  return { kind: plan.kind, version: plan.version, members: plan.members.map(({ investigationHypothesisRef, ...member }) =>
    ({ ...member, ...(investigationHypothesisRef === undefined ? {} : { investigationHypothesisRef }) })) };
}

export async function readCohortAdvanceStatusV1(store: WorkCohortStore) {
  const { portable, runtime } = await store.snapshot();
  return {
    definitions: portable.definitions.map(({ cohortId, definitionGeneration, definitionDigest, phase, members }) =>
      ({ cohortId, definitionGeneration, definitionDigest, phase, memberRefs: members.map(({ memberRef }) => memberRef) })),
    resumeRequired: runtime.resumeRequired,
    counters: {
      ...cohortActivityCountersV1(portable),
      observations: portable.observations.length, admissions: portable.decisions.length,
      reservationTransitions: portable.reservationTransitions.length, definitions: portable.definitions.length,
      pendingAttempts: portable.candidateAttempts.filter(({ state }) => state === "pending").length,
      candidateSeals: portable.candidateSeals.length,
      focusedReceipts: portable.commandEvidence.filter(({ evidenceKind }) => evidenceKind === "focused").length,
      sharedRegressionReceipts: portable.commandEvidence.filter(({ evidenceKind }) => evidenceKind === "shared-regression").length,
      fullGateReceipts: portable.commandEvidence.filter(({ evidenceKind }) => evidenceKind === "full-gate").length,
      acceptedCandidates: portable.completionReceipts.length,
      completionHandoffs: portable.completionHandoffs.length,
      investigationRuns: portable.investigationRuns.length, splits: portable.splitLineage.length,
    },
  };
}

export interface CohortAdvanceObservationV1 {
  readonly observationDigest: string;
  readonly decisions: readonly CohortDecisionV1[];
  readonly definitions: readonly CohortDefinitionIdentityV1[];
}

export interface CohortStatusViewV1 {
  readonly executor: "local" | "unavailable";
  readonly status: Awaited<ReturnType<typeof readCohortAdvanceStatusV1>> | null;
  readonly readyBoundaries: Awaited<ReturnType<typeof readCohortReadyBoundariesV1>>;
}

export interface CohortAdvanceCapabilityV1 {
  observe(input: { readonly plan: CohortAdmissionPlanV1; readonly operationId: string }): Promise<CohortAdvanceObservationV1>;
  prepare(input: { readonly plan: CohortAdmissionPlanV1; readonly definitionDigest: string;
    readonly operationId: string }): Promise<{
      readonly cohort: CohortEffectEnvelopeV1;
      readonly worktree: PrepareManagedCohortWorktreeResult;
    }>;
  /**
   * D560: surrender every holding of a cohort preparation that will never
   * complete. Refuses when the preparation owns a seal, evidence subject or
   * receipt bridge, because that is a worker's protected output.
   */
  releaseAbandonedPreparation(input: { readonly definitionDigest: string; readonly intentDigest: string;
    readonly operationId: string }): Promise<ReleaseManagedCohortWorktreeResult>;
  resume(input: { readonly plan: CohortAdmissionPlanV1; readonly definitionDigest: string;
    readonly intentDigest: string; readonly operationId: string; readonly workerDispatch?: DispatchHandle }): Promise<{
      readonly cohort: CohortEffectEnvelopeV1;
      readonly worktree: PrepareManagedCohortWorktreeResult;
      readonly parentGateCapability?: ParentGateCapability;
    }>;
}
