import { z } from "zod";
import type { DispatchPrepared } from "@cq/config";
import type { InvestigationCohortLaunchBindingV1 } from "@cq/process-control";
import { COHORT_ADMISSION_PLAN_SCHEMA } from "./workCohortAdvance.js";
import type { InvestigationCohortRunV1, InvestigationPreparedDispatchV1, InvestigationConfirmedCauseReceiptV1 } from "./workCohortInvestigation.js";
import type { CohortCommonBoundaryAtomV1, MemberCommonBoundaryAttestationV1 } from "./workCohort.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const defectRef = z.string().regex(/^defects:D\d+$/u);
const command = z.object({ argv: z.array(z.string().min(1)).min(1), cwd: z.string().min(1),
  environment: z.record(z.string(), z.string()),
}).strict();
const adjudication = z.object({ verdict: z.enum(["confirmed", "wrong", "uncertain"]),
  rationale: z.string().min(1), causeDigest: digest.nullable(), correctionBoundaryDigest: digest.nullable(),
  implementationAtomDigests: z.array(digest),
}).strict();
export const COHORT_INVESTIGATION_ADVANCE_SCHEMA = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("prepare"), admissionPlan: COHORT_ADMISSION_PLAN_SCHEMA,
    definitionDigest: digest, operationId: z.string().min(1).max(128),
    members: z.array(z.object({ defectRef, branchContext: z.string().min(1), leads: z.array(z.string()) }).strict()).min(1).max(256),
  }).strict(),
  z.object({ operation: z.literal("collect"), planDigest: digest }).strict(),
  z.object({ operation: z.literal("resume"), planDigest: digest }).strict(),
  z.object({ operation: z.literal("propose-correction"), planDigest: digest,
    proposal: COHORT_ADMISSION_PLAN_SCHEMA }).strict(),
  z.object({ operation: z.literal("adjudicate"), planDigest: digest,
    members: z.array(z.object({ defectRef, evidenceDigest: digest, adjudication }).strict()).min(1).max(256),
  }).strict(),
  z.object({ operation: z.literal("probe"), planDigest: digest, preparedDigest: digest,
    citation: z.string().min(1), command,
  }).strict(),
]);
export type CohortInvestigationAdvanceInputV1 = z.infer<typeof COHORT_INVESTIGATION_ADVANCE_SCHEMA>;
export interface InvestigationCorrectionCandidateV1 {
  readonly proposalDigest: string;
  readonly observationDigest: string;
  readonly atom: CohortCommonBoundaryAtomV1 & { readonly phase: "implementation" };
  readonly memberEvidence: readonly { readonly defectRef: string; readonly evidenceDigest: string }[];
  readonly applicability: readonly MemberCommonBoundaryAttestationV1[];
  readonly correctionBoundaryDigest: string;
}
export interface InvestigationCorrectionEligibilityV1 {
  readonly kind: "cq-investigation-correction-eligibility";
  readonly version: 1;
  readonly planDigest: string;
  readonly candidate: InvestigationCorrectionCandidateV1;
  readonly confirmedCauses: readonly InvestigationConfirmedCauseReceiptV1[];
  readonly receiptDigest: string;
}
export interface InvestigationProbeReceiptV1 {
  readonly preparedDigest: string;
  readonly citation: string;
  readonly command: Extract<CohortInvestigationAdvanceInputV1, { operation: "probe" }>["command"];
  readonly executionId: string;
  readonly outputDigest: string;
  readonly outputTail: string;
  readonly completeOutput: string | null;
  readonly capturedAt: string;
  readonly exitCode: number;
}
export interface CohortInvestigationAdvanceResultV1 {
  readonly planDigest: string;
  readonly state: "awaiting-launch" | "awaiting-adjudication" | "awaiting-evidence" | "correction-ready" | "split";
  readonly run: InvestigationCohortRunV1;
  readonly launches: readonly { readonly prepared: DispatchPrepared; readonly investigation: InvestigationPreparedDispatchV1;
    readonly nativeBinding: InvestigationCohortLaunchBindingV1 }[];
  readonly adjudicationRequests: readonly { readonly defectRef: string; readonly evidenceDigest: string }[];
  readonly probeEvidence: readonly InvestigationProbeReceiptV1[];
  readonly correctionCandidates: readonly InvestigationCorrectionCandidateV1[];
  readonly correctionEligibility: InvestigationCorrectionEligibilityV1 | null;
}
export interface CohortInvestigationAdvanceCapabilityV1 {
  advance(input: CohortInvestigationAdvanceInputV1): Promise<CohortInvestigationAdvanceResultV1>;
}
