import type { PlanPublishedManifest } from "./planLifecycle.js";

export interface HistoricalImplementationAuditRule {
  readonly defectRef: string;
  readonly finalizedManifestDigest: string;
}

export interface HistoricalImplementationSourceObservation {
  readonly taskRef: string;
  readonly status: string;
  readonly resultCommit: string | null;
  readonly ownLedgerRef: string;
  readonly ownerRefs: readonly string[];
  readonly ownerEdgeRef: string;
  readonly finalizedManifestDigest: string;
}

export interface HistoricalImplementationFixtureExpectation {
  readonly manifestId: string;
  readonly rule: HistoricalImplementationAuditRule;
  readonly expectedTaskRefs: readonly string[];
  readonly reviewRefs: Readonly<Record<string, string>>;
  readonly abstentionReviewRefs: readonly string[];
  readonly excludedExternalEffects: Readonly<Record<string, string>>;
  readonly requiredResultCommits: Readonly<Record<string, string>>;
}

const FULL_SHA = /^[0-9a-f]{40}$/u;
const TASK_REF = /^tasks:T[0-9]+$/u;

/**
 * Derive the qualifying Git cohort from active plus advertised archive
 * observations. Expected fixture task ids are deliberately not consulted.
 */
export function deriveHistoricalImplementationAuditTaskRefs(
  observations: readonly HistoricalImplementationSourceObservation[],
  rule: HistoricalImplementationAuditRule,
): readonly string[] {
  const selected = new Map<string, HistoricalImplementationSourceObservation>();
  for (const observation of observations) {
    if (
      !TASK_REF.test(observation.taskRef) ||
      observation.status !== "done" ||
      observation.resultCommit === null ||
      !FULL_SHA.test(observation.resultCommit) ||
      observation.ownLedgerRef !== observation.taskRef ||
      observation.ownerRefs.length !== 1 ||
      observation.ownerRefs[0] !== rule.defectRef ||
      observation.ownerEdgeRef !== rule.defectRef ||
      observation.finalizedManifestDigest !== rule.finalizedManifestDigest
    )
      continue;
    if (selected.has(observation.taskRef))
      throw new Error(`duplicate active/archive authority for ${observation.taskRef}`);
    selected.set(observation.taskRef, observation);
  }
  return [...selected.keys()].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

export const HISTORICAL_IMPLEMENTATION_FIXTURES = {
  D303: {
    manifestId: "d303-historical-implementation-evidence-v1",
    rule: { defectRef: "defects:D303", finalizedManifestDigest: "3".repeat(64) },
    expectedTaskRefs: ["tasks:T2096", "tasks:T2109", "tasks:T2110"],
    reviewRefs: {
      "tasks:T2096": "reviews:R1376",
      "tasks:T2109": "reviews:R1419",
      "tasks:T2110": "reviews:R1420",
    },
    abstentionReviewRefs: ["reviews:R1419"],
    excludedExternalEffects: {},
    requiredResultCommits: {
      "tasks:T2096": "a828a90fd0813d28f5f142a2ed80d2709533d0da",
      "tasks:T2109": "09731511f5388b9aa0f3a69105bec07da490c3d1",
      "tasks:T2110": "b53097724281441c55524c9a54a21a750124ebde",
    },
  },
  D340: {
    manifestId: "d340-historical-implementation-evidence-v1",
    rule: { defectRef: "defects:D340", finalizedManifestDigest: "4".repeat(64) },
    expectedTaskRefs: [
      "tasks:T2144",
      "tasks:T2145",
      "tasks:T2146",
      "tasks:T2147",
      "tasks:T2151",
    ],
    reviewRefs: {},
    abstentionReviewRefs: [],
    excludedExternalEffects: {},
    requiredResultCommits: {
      "tasks:T2151": "5dee782ebd6a0b2c743286c0f19752801944bac5",
    },
  },
  D343: {
    manifestId: "d343-historical-implementation-evidence-v1",
    rule: { defectRef: "defects:D343", finalizedManifestDigest: "5".repeat(64) },
    expectedTaskRefs: ["tasks:T2228"],
    reviewRefs: { "tasks:T2228": "reviews:R1413" },
    abstentionReviewRefs: [],
    excludedExternalEffects: { "tasks:T2229": "operatorActions:OA2229" },
    requiredResultCommits: {
      "tasks:T2228": "271d9e6e6230012784e7667b6b02ee76b33cc94e",
    },
  },
} as const satisfies Readonly<Record<string, HistoricalImplementationFixtureExpectation>>;

export const D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE = {
  manifestId: "d347-implementation-evidence-activation-v1",
  goalRef: "goals:G176",
  evidenceTaskKey: "t-evidence",
  auditTaskKey: "t-historical-evidence",
  activationTaskKey: "t-activate-evidence",
} as const;

export function resolveImplementationEvidenceActivationTaskMappings(
  manifest: PlanPublishedManifest,
  rule: Pick<
    typeof D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
    "evidenceTaskKey" | "auditTaskKey" | "activationTaskKey"
  >,
): { readonly evidenceTaskRef: string; readonly auditTaskRef: string; readonly activationTaskRef: string } {
  const mapping = new Map(manifest.tasks.map(({ key, id }) => [key, id]));
  const evidenceTaskId = mapping.get(rule.evidenceTaskKey);
  const auditTaskId = mapping.get(rule.auditTaskKey);
  const activationTaskId = mapping.get(rule.activationTaskKey);
  if (evidenceTaskId === undefined || auditTaskId === undefined || activationTaskId === undefined)
    throw new Error("finalized manifest omits an implementation evidence bootstrap mapping");
  return {
    evidenceTaskRef: `tasks:${evidenceTaskId}`,
    auditTaskRef: `tasks:${auditTaskId}`,
    activationTaskRef: `tasks:${activationTaskId}`,
  };
}
