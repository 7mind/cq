import { z } from "zod";
import type { DispatchPrepared } from "@cq/config";
import type { InvestigationCohortLaunchBindingV1 } from "@cq/process-control";
import { COHORT_ADMISSION_PLAN_SCHEMA } from "./workCohortAdvance.js";
import type { InvestigationCohortRunV1, InvestigationPreparedDispatchV1 } from "./workCohortInvestigation.js";

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
  z.object({ operation: z.literal("adjudicate"), planDigest: digest,
    members: z.array(z.object({ defectRef, evidenceDigest: digest, adjudication }).strict()).min(1).max(256),
  }).strict(),
  z.object({ operation: z.literal("probe"), planDigest: digest, preparedDigest: digest,
    citation: z.string().min(1), command,
  }).strict(),
]);
export type CohortInvestigationAdvanceInputV1 = z.infer<typeof COHORT_INVESTIGATION_ADVANCE_SCHEMA>;
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
}
export interface CohortInvestigationAdvanceCapabilityV1 {
  advance(input: CohortInvestigationAdvanceInputV1): Promise<CohortInvestigationAdvanceResultV1>;
}
