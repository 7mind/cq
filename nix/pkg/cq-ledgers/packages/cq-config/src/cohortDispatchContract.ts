import { assertCohortEffectEnvelopeV1, cohortValueDigestV1, type CohortEffectEnvelopeV1 } from "@cq/process-control";

export function dispatchRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertMemberSequence(value: unknown, cohort: CohortEffectEnvelopeV1): void {
  if (!Array.isArray(value) || value.length !== cohort.definition.members.length ||
      value.some((member: unknown, index) => !dispatchRecord(member) || member["memberRef"] !== cohort.definition.members[index]!.memberRef)) {
    throw new Error("cohort role payload must preserve the complete ordered member set");
  }
}

export function assertCohortDispatchInput(input: unknown): void {
  if (!dispatchRecord(input) || !Object.hasOwn(input, "cohort")) return;
  const cohort = input["cohort"] as CohortEffectEnvelopeV1;
  assertCohortEffectEnvelopeV1(cohort);
  if (Object.hasOwn(input, "taskId")) throw new Error("cohort dispatch cannot carry an anchor task");
  assertMemberSequence(input["members"], cohort);
  if (input["branch"] !== `implement/cohort-${cohort.intent.intentDigest}`) throw new Error("cohort branch differs from candidate intent");
  const gate = input["supervisedGateEvidence"];
  if (gate !== undefined && (!dispatchRecord(gate) || cohort.state !== "sealed" ||
      cohortValueDigestV1(gate["evidenceSubject"]) !== cohortValueDigestV1(cohort.evidenceSubject))) {
    throw new Error("cohort review gate differs from the sealed evidence subject");
  }
}

export function assertCohortDispatchOutput(input: unknown, output: unknown): void {
  const prepared = dispatchRecord(input) ? input["cohort"] : undefined;
  const reported = dispatchRecord(output) ? output["cohort"] : undefined;
  if (prepared === undefined && reported === undefined) return;
  if (prepared === undefined || reported === undefined || !dispatchRecord(output) ||
      Object.hasOwn(output, "taskId") || cohortValueDigestV1(prepared) !== cohortValueDigestV1(reported)) {
    throw new Error("cohort result differs from the complete prepared effect envelope");
  }
  const cohort = reported as CohortEffectEnvelopeV1;
  assertCohortEffectEnvelopeV1(cohort);
  assertMemberSequence(output["memberObservations"], cohort);
  if (Object.hasOwn(output, "branch") && output["branch"] !== `implement/cohort-${cohort.intent.intentDigest}`) {
    throw new Error("cohort result branch differs from candidate intent");
  }
}
