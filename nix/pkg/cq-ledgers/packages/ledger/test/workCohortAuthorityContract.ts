import { expect, test } from "bun:test";
import {
  assertCohortEffectEnvelopeV1, constructCohortDecisionsV1, createCohortCandidateIntentV1,
  createCohortEffectEnvelopeV1, type CohortEffectEnvelopeV1,
  createPendingCohortCandidateAttemptV1,
  createCohortDefinitionIdentityV1,
} from "../src/workCohort.js";
import type { WorkCohortStore } from "../src/workCohortStore.js";
import { observationFor, sha256 } from "./workCohortFixture.js";
import { workCohortStoreFixture } from "./workCohortStoreContract.js";

export function workCohortAuthorityContract(label: string, create: () => Promise<{
  readonly store: WorkCohortStore; readonly close: () => Promise<void>;
}>): void {
  async function fixture() {
    const prepared = await workCohortStoreFixture();
    const opened = await create();
    const { definition, observation, pending } = prepared;
    await opened.store.recordObservation("observation", observation);
    await opened.store.recordDecision("decision", constructCohortDecisionsV1(observation)[0]!);
    await opened.store.recordDefinition("definition", definition);
    await opened.store.recordCandidateIntent("intent", pending.intent);
    const reservation = { reservationId: "reservation:authority", cohortId: definition.cohortId,
      definitionDigest: definition.definitionDigest, memberRefs: definition.members.map((member) => member.memberRef) };
    await opened.store.transitionReservation("reserve", { ...reservation, transition: "reserved" });
    const envelope = createCohortEffectEnvelopeV1({ definition, observation, intent: pending.intent,
      evidenceSubject: null, executionEpoch: (await opened.store.snapshot()).runtime.executionEpoch });
    const lease = await opened.store.acquireLease({ holderId: "authority", semanticSubject: envelope.semanticSubject });
    return { ...opened, prepared, reservation, envelope, lease };
  }

  test(`${label}: pre-dispatch intent and closed all-member envelope require no allocated handle`, async () => {
    const f = await fixture();
    try {
      expect((await f.store.snapshot()).portable.candidateAttempts).toHaveLength(0);
      expect(f.envelope.memberAuthorities.map((member) => member.taskRef)).toEqual(["tasks:T1", "tasks:T2"]);
      expect(Object.hasOwn(f.envelope, "taskId")).toBe(false);
      await expect(f.store.assertLiveCohortAuthority(f.lease, f.envelope)).resolves.toBeUndefined();
      expect(await f.store.recordCandidateIntent("intent", f.prepared.pending.intent)).toEqual(f.prepared.pending.intent);
      expect((await f.store.snapshot()).portable.candidateIntents).toHaveLength(1);
    } finally { await f.close(); }
  });

  test(`${label}: mixed task arms, reordered members, omitted members, and substituted manifests reject`, async () => {
    const f = await fixture();
    try {
      const anchor = { ...f.envelope, taskId: "T1" };
      expect(() => assertCohortEffectEnvelopeV1(anchor)).toThrow("closed field set");
      const { kind, version, definitionGeneration, semanticDigest: _semanticDigest,
        definitionDigest: _definitionDigest, ...semantic } = f.envelope.definition;
      const invalidSemantic = { ...semantic, splitConditions: "reject" };
      const definitionPayload = { kind, version, definitionGeneration,
        ...invalidSemantic, semanticDigest: sha256(invalidSemantic) };
      const invalidDefinition = { ...definitionPayload, definitionDigest: sha256(definitionPayload) };
      const intentPayload = { kind: "cq-cohort-candidate-intent", version: 1,
        definitionDigest: invalidDefinition.definitionDigest, operationId: "malformed" };
      const invalidIntent = { ...intentPayload, intentDigest: sha256(intentPayload) };
      const { envelopeDigest: _originalDigest, ...envelopePayload } = f.envelope;
      const invalidPayload = { ...envelopePayload, definition: invalidDefinition, intent: invalidIntent,
        semanticSubject: sha256({ definitionDigest: invalidDefinition.definitionDigest,
          intentDigest: invalidIntent.intentDigest, memberSetDigest: f.envelope.memberSetDigest }) };
      const invalidEnvelope = { ...invalidPayload, envelopeDigest: sha256(invalidPayload) } as unknown as CohortEffectEnvelopeV1;
      expect(() => assertCohortEffectEnvelopeV1(invalidEnvelope)).toThrow("split conditions");
      expect(() => assertCohortEffectEnvelopeV1({ ...f.envelope,
        memberAuthorities: [...f.envelope.memberAuthorities].reverse() })).toThrow("substituted member");
      expect(() => assertCohortEffectEnvelopeV1({ ...f.envelope,
        memberAuthorities: f.envelope.memberAuthorities.slice(0, 1) })).toThrow("complete ordered member set");
      const memberAuthorities = f.envelope.memberAuthorities.map((member) => ({ ...member,
        finalizedManifestDigest: sha256("foreign manifest") }));
      const payload = { ...f.envelope, memberAuthorities, memberSetDigest: sha256(memberAuthorities) };
      if (payload.state !== "pre-seal") throw new Error("expected pre-seal fixture");
      payload.semanticSubject = sha256({ definitionDigest: payload.definition.definitionDigest,
        intentDigest: payload.intent.intentDigest, memberSetDigest: payload.memberSetDigest });
      const { envelopeDigest: _discarded, ...unsigned } = payload;
      const changed: CohortEffectEnvelopeV1 = { ...unsigned, envelopeDigest: sha256(unsigned) };
      assertCohortEffectEnvelopeV1(changed);
      await f.store.releaseLease(f.lease);
      const lease = await f.store.acquireLease({ holderId: "substituted", semanticSubject: changed.semanticSubject });
      await expect(f.store.assertLiveCohortAuthority(lease, changed)).rejects.toThrow("frozen member manifest");
    } finally { await f.close(); }
  });

  test(`${label}: renewed pre-seal epoch preserves identity and rejects old holders and replacement intents`, async () => {
    const f = await fixture();
    try {
      await f.store.beginNewExecutionEpoch();
      const renewed = createCohortEffectEnvelopeV1({ definition: f.prepared.definition,
        observation: f.prepared.observation, intent: f.prepared.pending.intent,
        evidenceSubject: null, executionEpoch: (await f.store.snapshot()).runtime.executionEpoch });
      expect(renewed.semanticSubject).toBe(f.envelope.semanticSubject);
      expect(renewed.envelopeDigest).not.toBe(f.envelope.envelopeDigest);
      const lease = await f.store.acquireLease({ holderId: "renewed", semanticSubject: renewed.semanticSubject });
      await expect(f.store.assertLiveCohortAuthority(f.lease, f.envelope)).rejects.toThrow("execution epoch");
      await expect(f.store.assertLiveCohortAuthority(lease, renewed)).resolves.toBeUndefined();
      await f.store.recordCandidateIntent("replacement", createCohortCandidateIntentV1(f.prepared.definition, "replacement"));
      await expect(f.store.assertLiveCohortAuthority(lease, renewed)).rejects.toThrow("durable definition and intent");
    } finally { await f.close(); }
  });

  test(`${label}: portable restore rejects intent-operation rebinding across definitions`, async () => {
    const f = await fixture();
    try {
      const other = createCohortDefinitionIdentityV1({ cohortId: "cohort:other", prior: null,
        observation: f.prepared.observation, decision: constructCohortDecisionsV1(f.prepared.observation)[0]! });
      await f.store.recordDefinition("other-definition", other);
      const intent = createCohortCandidateIntentV1(other, f.prepared.pending.intent.operationId);
      await expect(f.store.recordCandidateIntent("other-intent", intent)).rejects.toThrow("another definition");
      const before = (await f.store.snapshot()).portable;
      await expect(Promise.resolve().then(() => f.store.restorePortableState({ ...before, candidateIntents: [...before.candidateIntents, intent] })))
        .rejects.toThrow("intent operation");
      expect((await f.store.snapshot()).portable).toEqual(before);
    } finally { await f.close(); }
  });

  test(`${label}: current authority resolves its own observation when focused matrix is unchanged`, async () => {
    const f = await fixture();
    try {
      const observation = await observationFor([{ ref: "tasks:T1", authority: "new" }, { ref: "tasks:T2", authority: "new" }]);
      const decision = constructCohortDecisionsV1(observation)[0]!;
      const definition = createCohortDefinitionIdentityV1({ cohortId: f.prepared.definition.cohortId,
        prior: f.prepared.definition, observation, decision });
      expect(definition.acceptanceMatrixDigest).toBe(f.prepared.definition.acceptanceMatrixDigest);
      expect(definition.definitionGeneration).toBe(2);
      await f.store.recordObservation("observation:new", observation);
      await f.store.recordDecision("decision:new", decision);
      await f.store.recordDefinition("definition:new", definition);
      const intent = createCohortCandidateIntentV1(definition, "new-authority");
      await f.store.recordCandidateIntent("intent:new", intent);
      await f.store.transitionReservation("release", { ...f.reservation, transition: "released" });
      await f.store.transitionReservation("reserve:new", { ...f.reservation, definitionDigest: definition.definitionDigest, transition: "reserved" });
      await f.store.releaseLease(f.lease);
      const envelope = createCohortEffectEnvelopeV1({ definition, observation, intent, evidenceSubject: null,
        executionEpoch: f.envelope.executionEpoch });
      const lease = await f.store.acquireLease({ holderId: "new-authority", semanticSubject: envelope.semanticSubject });
      await expect(f.store.assertLiveCohortAuthority(lease, envelope)).resolves.toBeUndefined();
    } finally { await f.close(); }
  });

  test(`${label}: one candidate intent cannot bind competing dispatch handles`, async () => {
    const f = await fixture();
    try {
      await f.store.recordCandidateAttempt("pending", f.prepared.pending);
      const competing = createPendingCohortCandidateAttemptV1(f.prepared.definition,
        { ...f.prepared.pending.preparedDispatch, attestationId: `att_${sha256("competing")}` }, f.prepared.pending.intent);
      await expect(f.store.recordCandidateAttempt("competing", competing)).rejects.toThrow("another prepared dispatch");
      expect((await f.store.snapshot()).portable.candidateAttempts).toHaveLength(1);
    } finally { await f.close(); }
  });

  test(`${label}: superseded candidate intents cannot seal old qualified output`, async () => {
    const f = await fixture();
    try {
      await f.store.recordCandidateAttempt("pending", f.prepared.pending);
      await f.store.recordCandidateIntent("replacement", createCohortCandidateIntentV1(f.prepared.definition, "replacement"));
      await expect(f.store.sealCandidate("stale-seal", f.prepared.request)).rejects.toThrow("superseded candidate intent");
      expect((await f.store.snapshot()).portable.candidateSeals).toHaveLength(0);
    } finally { await f.close(); }
  });

  test(`${label}: reservation release and first seal revoke pre-seal mutations without rewriting lineage`, async () => {
    const f = await fixture();
    try {
      await f.store.recordCandidateAttempt("pending", f.prepared.pending);
      const sealed = await f.store.sealCandidate("seal", f.prepared.request);
      await expect(f.store.assertLiveCohortAuthority(f.lease, f.envelope)).rejects.toThrow("already sealed candidate");
      await f.store.releaseLease(f.lease);
      const envelope = createCohortEffectEnvelopeV1({ definition: f.prepared.definition,
        observation: f.prepared.observation, intent: f.prepared.pending.intent,
        evidenceSubject: sealed.evidenceSubject, executionEpoch: f.envelope.executionEpoch });
      const lease = await f.store.acquireLease({ holderId: "sealed", semanticSubject: envelope.semanticSubject });
      await expect(f.store.assertLiveCohortAuthority(lease, envelope)).resolves.toBeUndefined();
      await f.store.transitionReservation("release", { ...f.reservation, transition: "released" });
      await expect(f.store.assertLiveCohortAuthority(lease, envelope)).rejects.toThrow("all-member reservation");
      expect((await f.store.snapshot()).portable.receiptBridges[0]?.receipts).toEqual(f.prepared.request.gitReceipts);
    } finally { await f.close(); }
  });
}
