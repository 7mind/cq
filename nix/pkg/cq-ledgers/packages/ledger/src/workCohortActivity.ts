import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cohortValueDigestV1 as digest } from "./workCohort.js";
import type { WorkCohortPortableStateV1 } from "./workCohortStore.js";

export const COHORT_ACTIVITY_MEASUREMENTS_V1 = [
  "focusedDeduplications", "sharedReuses", "persistedEvidenceReuses", "sharedRejections", "evidenceRejections",
  "acceptanceFailures", "reviewReuses", "reviewRejections", "executionEpochRenewals", "executionEpochRejections",
  "acceptanceFinalizationAttempts", "primaryFinalizationAttempts", "deploymentProbeReuses",
  "focusedAttempts", "sharedAttempts", "fullGateAttempts",
] as const;
const payloadSchema = z.object({ kind: z.literal("cq-cohort-activity"), version: z.literal(1),
  activityId: z.string().min(1), semanticSubject: z.string().min(1), executionEpoch: z.string().min(1),
  executions: z.array(z.object({ purpose: z.enum(["focused", "shared-regression", "full-gate", "review"]), executionId: z.string().min(1) }).strict()),
  measurements: z.array(z.object({ measurement: z.enum(COHORT_ACTIVITY_MEASUREMENTS_V1), value: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()),
}).strict();
const activitySchema = payloadSchema.extend({ activityDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type CohortActivityV1 = z.infer<typeof activitySchema>;
export type CohortActivityMeasurementV1 = typeof COHORT_ACTIVITY_MEASUREMENTS_V1[number];

export function createCohortActivityV1(input: Pick<CohortActivityV1, "semanticSubject" | "executionEpoch" | "executions" | "measurements">): CohortActivityV1 {
  const payload = payloadSchema.parse({ kind: "cq-cohort-activity", version: 1, activityId: randomUUID(), ...input });
  return parseCohortActivityV1({ ...payload, activityDigest: digest(payload) });
}
export function parseCohortActivityV1(input: unknown): CohortActivityV1 {
  const value = activitySchema.parse(input);
  const { activityDigest, ...payload } = value;
  if (digest(payload) !== activityDigest || new Set(value.measurements.map((entry) => entry.measurement)).size !== value.measurements.length)
    throw new Error("cohort activity has changed its exact measurements");
  return value;
}

export function cohortActivityCountersV1(state: WorkCohortPortableStateV1) {
  const totals = Object.fromEntries(COHORT_ACTIVITY_MEASUREMENTS_V1.map((measurement) => [measurement, 0])) as Record<CohortActivityMeasurementV1, number>;
  const focused = new Set<string>();
  const shared = new Set<string>();
  const gates = new Set<string>();
  const reviews = new Set<string>();
  const executionKey = (subject: string, executionId: string) => JSON.stringify([subject, executionId]);
  const executions = { focused, "shared-regression": shared, "full-gate": gates, review: reviews };
  for (const activity of state.activity) {
    for (const entry of activity.measurements) {
      totals[entry.measurement] += entry.value;
      if (!Number.isSafeInteger(totals[entry.measurement])) throw new Error("cohort activity counter overflow");
    }
    for (const execution of activity.executions) executions[execution.purpose].add(executionKey(activity.semanticSubject, execution.executionId));
  }
  for (const evidence of state.commandEvidence) {
    if (evidence.execution === null) continue;
    executions[evidence.execution.purpose].add(executionKey(evidence.evidenceSubjectDigest, evidence.execution.outcome.executionId));
  }
  for (const key of focused) shared.delete(key);
  const deployments = new Set<string>();
  const probes = new Set<string>();
  const failedProbes = new Set<string>();
  const archived = new Set<string>();
  const milestones = new Set<string>();
  const recordedBatches = new Set<string>();
  for (const handoff of state.completionHandoffs) {
    if (handoff.deployment !== null) deployments.add(JSON.stringify([handoff.sealDigest, handoff.deployment.probeEpoch]));
    for (const probe of handoff.probes) { probes.add(probe.receiptDigest); if (!probe.passed) failedProbes.add(probe.receiptDigest); }
    if (handoff.ledgerResult !== null) {
      recordedBatches.add(handoff.batchDigest);
      for (const ref of handoff.ledgerResult.archivedRefs) archived.add(JSON.stringify([handoff.batchDigest, ref]));
      for (const id of handoff.ledgerResult.archivedMilestoneIds) milestones.add(JSON.stringify([handoff.batchDigest, id]));
    }
  }
  return { ...totals, focusedExecutions: focused.size, sharedExecutions: shared.size,
    fullGateExecutions: gates.size, authenticatedReviews: reviews.size,
    evidencePreservations: totals.persistedEvidenceReuses,
    definitionGenerations: state.definitions.length,
    candidateAttempts: new Set(state.candidateAttempts.map((attempt) => attempt.pendingAttemptDigest)).size,
    candidateReplacements: state.acceptanceTransitions.filter((transition) => !transition.eligible && transition.replacementEvidenceSubjectDigest !== null).length,
    deploymentEpochs: deployments.size, deploymentProbeExecutions: probes.size, deploymentProbeRejections: failedProbes.size,
    itemSweeps: archived.size, milestoneArchives: milestones.size, primaryFinalizations: recordedBatches.size,
    finalizationAttempts: totals.acceptanceFinalizationAttempts + totals.primaryFinalizationAttempts,
  };
}
