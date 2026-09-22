import { cohortValueDigestV1, createCohortCandidateIntentV1, type CohortEffectEnvelopeV1 } from "@cq/process-control";

export function cohortRoleEnvelope(): CohortEffectEnvelopeV1 {
  const members = ["T701", "T702"].map((taskId) => ({ memberRef: `tasks:${taskId}`,
    memberRevision: cohortValueDigestV1(taskId), authorityRef: "goals:G191", authorityRevision: "a".repeat(64) }));
  const semantic = { cohortId: "role-contract", phase: "implementation" as const, members,
    selectedAtomDigest: "b".repeat(64), acceptanceMatrixDigest: "c".repeat(64),
    repository: { repositoryId: "d".repeat(64), headCommit: "1".repeat(40), treeOid: "2".repeat(40) },
    environment: { environmentDigest: "e".repeat(64) }, splitConditions: ["member authority changed"] };
  const definitionPayload = { kind: "cq-cohort-definition-identity" as const, version: 1 as const,
    definitionGeneration: 1, ...semantic, semanticDigest: cohortValueDigestV1(semantic) };
  const definition = { ...definitionPayload, definitionDigest: cohortValueDigestV1(definitionPayload) };
  const intent = createCohortCandidateIntentV1(definition, "role-contract-candidate");
  const memberAuthorities = members.map((member) => ({ taskRef: member.memberRef, taskRevision: member.memberRevision,
    goalRef: member.authorityRef, finalizedManifestDigest: "f".repeat(64), authorityRevision: member.authorityRevision }));
  const memberSetDigest = cohortValueDigestV1(memberAuthorities);
  const payload = { kind: "cq-cohort-effect-envelope" as const, version: 1 as const, state: "pre-seal" as const,
    definition, intent, memberAuthorities, memberSetDigest,
    semanticSubject: cohortValueDigestV1({ definitionDigest: definition.definitionDigest, intentDigest: intent.intentDigest, memberSetDigest }),
    executionEpoch: "role-epoch-1" };
  return { ...payload, envelopeDigest: cohortValueDigestV1(payload) };
}

export function cohortRoleMembers(envelope: CohortEffectEnvelopeV1) {
  return envelope.definition.members.map((member) => ({ memberRef: member.memberRef,
    headline: `Implement ${member.memberRef}`, description: "Shared correction", acceptance: "Focused contract passes" }));
}

export function sealedCohortRoleEnvelope(): CohortEffectEnvelopeV1 & { readonly state: "sealed" } {
  const { envelopeDigest: _digest, ...preseal } = cohortRoleEnvelope();
  const subject = { kind: "cq-cohort-evidence-subject" as const, version: 1 as const,
    definitionDigest: preseal.definition.definitionDigest, sealDigest: "5".repeat(64) };
  const evidenceSubject = { ...subject, evidenceSubjectDigest: cohortValueDigestV1(subject) };
  const payload = { ...preseal, state: "sealed" as const, evidenceSubject, semanticSubject: evidenceSubject.evidenceSubjectDigest };
  return { ...payload, envelopeDigest: cohortValueDigestV1(payload) };
}
