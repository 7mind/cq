import {
  assertCohortEffectEnvelopeV1,
  cohortValueDigestV1 as digest,
  type CohortEffectEnvelopeV1,
} from "@cq/process-control";

export function cohortQueueProductionIdentity(envelope: CohortEffectEnvelopeV1) {
  return {
    definition: envelope.definition,
    intent: envelope.intent,
    memberAuthorities: envelope.memberAuthorities,
    memberSetDigest: envelope.memberSetDigest,
  };
}

export function implementationQueueSubjectsMatch(
  left: unknown,
  right: unknown,
  historical: boolean,
): boolean {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  const a = left as Readonly<Record<string, unknown>>;
  const b = right as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(a, "cohort") || Object.hasOwn(b, "cohort")) {
    if (Object.hasOwn(a, "taskId") || Object.hasOwn(b, "taskId")) return false;
    const prior = a["cohort"] as CohortEffectEnvelopeV1;
    const next = b["cohort"] as CohortEffectEnvelopeV1;
    try {
      assertCohortEffectEnvelopeV1(prior);
      assertCohortEffectEnvelopeV1(next);
    } catch {
      return false;
    }
    if (!historical) return digest(prior) === digest(next);
    return (
      digest(cohortQueueProductionIdentity(prior)) ===
        digest(cohortQueueProductionIdentity(next)) &&
      (prior.state === "pre-seal" ||
        (next.state === "sealed" && digest(prior.evidenceSubject) === digest(next.evidenceSubject)))
    );
  }
  return typeof a["taskId"] === "string" && a["taskId"].length > 0 && a["taskId"] === b["taskId"];
}

export function implementationQueueAuthoritiesMatch(
  left: unknown,
  right: unknown,
  historical: boolean,
): boolean {
  if (!implementationQueueSubjectsMatch(left, right, historical)) return false;
  const a = left as Readonly<Record<string, unknown>>;
  const b = right as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(a, "cohort")) {
    return (
      !Object.hasOwn(a, "goalRef") &&
      !Object.hasOwn(b, "goalRef") &&
      !Object.hasOwn(a, "finalizedManifestDigest") &&
      !Object.hasOwn(b, "finalizedManifestDigest")
    );
  }
  return (
    typeof a["goalRef"] === "string" &&
    a["goalRef"].length > 0 &&
    a["goalRef"] === b["goalRef"] &&
    typeof a["finalizedManifestDigest"] === "string" &&
    a["finalizedManifestDigest"].length > 0 &&
    a["finalizedManifestDigest"] === b["finalizedManifestDigest"]
  );
}
