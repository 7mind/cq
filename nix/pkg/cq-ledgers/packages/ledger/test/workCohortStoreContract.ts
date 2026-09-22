import { expect, test } from "bun:test";
import { recordFixtureCohortAcceptance } from "./workCohortAcceptanceFixture.js";
import { createCohortActivityV1 } from "../src/workCohortActivity.js";
import { readCohortAdvanceStatusV1 } from "../src/workCohortAdvance.js";

import {
  CohortCandidateSealConflictError,
  constructCohortDecisionsV1,
  createCohortDefinitionIdentityV1,
  createCohortCandidateIntentV1,
  createPendingCohortCandidateAttemptV1,
  type G213CandidateAuthenticatorV1,
  type CohortAdmissionObservationV1,
  type CohortCandidateSealRequestV1,
  type CohortDefinitionIdentityV1,
  type CohortGitChangeReceiptV1,
  type CohortWholeDiffEntryV1,
  type PendingCohortCandidateAttemptV1,
  type StagedCohortCandidateAttemptV1,
} from "../src/workCohort.js";
import {
  WorkCohortG213HandoffV1,
  WorkCohortOperationConflictError,
  WorkCohortReservationConflictError,
  WorkCohortStaleAuthorityError,
  parseWorkCohortPortableStateV1,
  type WorkCohortStore,
} from "../src/workCohortStore.js";
import {
  commit,
  observationFor,
  receipt,
  sha256,
  resolveQualifiedCandidateAttempt,
} from "./workCohortFixture.js";

export interface StoreFixture {
  readonly observation: CohortAdmissionObservationV1;
  readonly definition: CohortDefinitionIdentityV1;
  readonly pending: PendingCohortCandidateAttemptV1;
  readonly staged: StagedCohortCandidateAttemptV1;
  readonly request: CohortCandidateSealRequestV1;
  readonly authenticator: G213CandidateAuthenticatorV1;
}

export async function workCohortStoreFixture(label = "first", generation = 1): Promise<StoreFixture> {
  const observation = await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }]);
  return workCohortStoreFixtureFromObservation(observation, label, generation);
}

export async function workCohortStoreFixtureFromObservation(
  observation: CohortAdmissionObservationV1, label: string, generation: number,
): Promise<StoreFixture> {
  const decision = constructCohortDecisionsV1(observation)[0]!;
  const definition = createCohortDefinitionIdentityV1({
    cohortId: "cohort:store-contract",
    decision,
    observation,
    prior: null,
  });
  const preparedDispatch = {
    attestationId: `att_${sha256(label)}`,
    generation,
    taskId: `T${generation}`,
    branch: `implement/T${generation}`,
    startingCommit: commit(`base-${label}`),
  };
  const pending = createPendingCohortCandidateAttemptV1(definition, preparedDispatch,
    createCohortCandidateIntentV1(definition, `candidate:${label}:${generation}`));
  const resultCommit = commit(`result-${label}`);
  const resultTree = commit(`tree-${label}`);
  const receipts: readonly CohortGitChangeReceiptV1[] = [
    receipt({
      base: preparedDispatch.startingCommit,
      result: resultCommit,
      tree: resultTree,
      operation: label,
    }),
  ];
  const wholeDiff: readonly CohortWholeDiffEntryV1[] = [
    { path: `src/${label}.ts`, mode: "100644", blobDigest: sha256(`blob-${label}`) },
  ];
  const authenticated = await resolveQualifiedCandidateAttempt({
    pending,
    resultCommit,
    resultTree,
    receipts,
    wholeDiff,
    attemptId: `attempt:${label}`,
  });
  const staged = authenticated.staged;
  return {
    observation,
    definition,
    pending,
    staged,
    authenticator: authenticated.authenticator,
    request: {
      definition,
      attempt: staged,
      baseCommit: preparedDispatch.startingCommit,
      resultCommit,
      resultTree,
      wholeDiff,
      gitReceipts: receipts,
    },
  };
}

export async function prepareWorkCohortStore(
  store: WorkCohortStore,
  fixture: StoreFixture,
): Promise<void> {
  const observation = fixture.observation;
  const decision = constructCohortDecisionsV1(observation)[0]!;
  await store.recordObservation("observe", observation);
  await store.recordDecision("decide", decision);
  await store.recordDefinition("define", fixture.definition);
  await store.recordCandidateIntent("intent", fixture.pending.intent);
  await store.recordCandidateAttempt("pending", fixture.pending);
}

export function workCohortStoreContract(
  label: string,
  create: () => Promise<{ readonly store: WorkCohortStore; readonly close: () => Promise<void> }>,
): void {
  test(`${label}: measured activity survives restore and exact replay without minting acceptance`, async () => {
    const opened = await create();
    const restored = await create();
    try {
      const activity = createCohortActivityV1({ semanticSubject: "diagnostic-subject",
        executionEpoch: (await opened.store.snapshot()).runtime.executionEpoch,
        executions: [{ purpose: "focused", executionId: "actual-run-one" }],
        measurements: [{ measurement: "focusedDeduplications", value: 2 }] });
      await opened.store.recordActivity(activity);
      const before = await opened.store.snapshot();
      await opened.store.recordActivity(activity);
      expect(await opened.store.snapshot()).toEqual(before);
      await expect(opened.store.recordActivity({ ...activity, measurements: [] })).rejects.toThrow("exact measurements");
      const portable = parseWorkCohortPortableStateV1(await opened.store.exportPortableState());
      expect(() => parseWorkCohortPortableStateV1(JSON.stringify({ ...portable,
        activity: [...portable.activity, activity] }))).toThrow("repeats an event identity");
      await restored.store.restorePortableState(portable);
      expect((await readCohortAdvanceStatusV1(restored.store)).counters).toMatchObject({
        focusedExecutions: 1, focusedDeduplications: 2, acceptedCandidates: 0, primaryFinalizations: 0,
      });
      expect((await restored.store.snapshot()).portable.commandEvidence).toEqual([]);
    } finally { await opened.close(); await restored.close(); }
  });

  test(`${label}: exact seal replay is idempotent and altered replay conflicts`, async () => {
    const fixture = await workCohortStoreFixture();
    const opened = await create();
    try {
      await prepareWorkCohortStore(opened.store, fixture);
      await expect(
        opened.store.sealCandidate("seal:substituted-g213", {
          ...fixture.request,
          attempt: { ...fixture.staged, g213: { ...fixture.staged.g213 } },
        }),
      ).rejects.toBeInstanceOf(CohortCandidateSealConflictError);
      const sealed = await opened.store.sealCandidate("seal", fixture.request);
      expect(await opened.store.sealCandidate("seal", fixture.request)).toEqual(sealed);
      await expect(
        opened.store.sealCandidate("seal", {
          ...fixture.request,
          resultTree: commit("substituted-tree"),
        }),
      ).rejects.toBeInstanceOf(WorkCohortOperationConflictError);

      const snapshot = await opened.store.snapshot();
      expect(snapshot.portable.candidateSeals).toHaveLength(1);
      expect(snapshot.portable.evidenceSubjects).toHaveLength(1);
      expect(snapshot.portable.receiptBridges).toHaveLength(1);
      expect(snapshot.portable.g213Acknowledgements).toHaveLength(1);
    } finally {
      await opened.close();
    }
  });

  test(`${label}: G213 handoff crash replay seals and acknowledges one exact attempt`, async () => {
    const fixture = await workCohortStoreFixture("handoff", 1);
    const opened = await create();
    const input = {
      pending: fixture.pending,
      g213Handle: {
        attestationId: fixture.pending.preparedDispatch.attestationId,
        generation: fixture.pending.preparedDispatch.generation,
      },
      definition: fixture.request.definition,
      baseCommit: fixture.request.baseCommit,
      resultCommit: fixture.request.resultCommit,
      resultTree: fixture.request.resultTree,
      wholeDiff: fixture.request.wholeDiff,
      gitReceipts: fixture.request.gitReceipts,
    };
    try {
      await prepareWorkCohortStore(opened.store, fixture);
      const afterQualificationCrash = new WorkCohortG213HandoffV1({
        store: opened.store,
        authenticator: fixture.authenticator,
        hooks: {
          afterQualification: () => {
            throw new Error("injected crash after G213 qualification");
          },
          afterCohortSeal: () => undefined,
        },
      });
      await expect(
        afterQualificationCrash.sealCandidate("seal:handoff", input),
      ).rejects.toThrow("injected crash after G213 qualification");
      expect((await opened.store.snapshot()).portable.candidateSeals).toHaveLength(0);

      const afterSealCrash = new WorkCohortG213HandoffV1({
        store: opened.store,
        authenticator: fixture.authenticator,
        hooks: {
          afterQualification: () => undefined,
          afterCohortSeal: () => {
            throw new Error("injected crash after cohort seal");
          },
        },
      });
      await expect(afterSealCrash.sealCandidate("seal:handoff", input)).rejects.toThrow(
        "injected crash after cohort seal",
      );
      const durable = (await opened.store.snapshot()).portable;
      expect(durable.candidateSeals).toHaveLength(1);
      expect(durable.g213Acknowledgements).toHaveLength(1);

      const resumed = new WorkCohortG213HandoffV1({
        store: opened.store,
        authenticator: fixture.authenticator,
      });
      const replay = await resumed.sealCandidate("seal:handoff", input);
      expect(replay.seal).toEqual(durable.candidateSeals[0]!);
      expect((await opened.store.snapshot()).portable.candidateAttempts).toHaveLength(2);
      await expect(
        resumed.sealCandidate("seal:substituted-handle", {
          ...input,
          g213Handle: { ...input.g213Handle, generation: input.g213Handle.generation + 1 },
        }),
      ).rejects.toThrow("no matching G213 candidate");
    } finally {
      await opened.close();
    }
  });

  test(`${label}: reservations serialize and member transitions reject stale state`, async () => {
    const fixture = await workCohortStoreFixture();
    const opened = await create();
    try {
      await prepareWorkCohortStore(opened.store, fixture);
      const reserve = (reservationId: string) =>
        opened.store.transitionReservation(`reserve:${reservationId}`, {
          reservationId,
          cohortId: fixture.definition.cohortId,
          definitionDigest: fixture.definition.definitionDigest,
          memberRefs: fixture.definition.members.map((member) => member.memberRef),
          transition: "reserved",
        });
      const results = await Promise.allSettled([reserve("one"), reserve("two")]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")[0]?.reason).toBeInstanceOf(
        WorkCohortReservationConflictError,
      );
      await opened.store.transitionMember("member:reserved", {
        cohortId: fixture.definition.cohortId,
        definitionDigest: fixture.definition.definitionDigest,
        memberRef: fixture.definition.members[0]!.memberRef,
        from: "planned",
        to: "reserved",
      });
      await expect(
        opened.store.transitionMember("member:stale", {
          cohortId: fixture.definition.cohortId,
          definitionDigest: fixture.definition.definitionDigest,
          memberRef: fixture.definition.members[0]!.memberRef,
          from: "planned",
          to: "running",
        }),
      ).rejects.toBeInstanceOf(WorkCohortOperationConflictError);
    } finally {
      await opened.close();
    }
  });

  test(`${label}: overlapping members serialize across cohorts and foreign membership is rejected`, async () => {
    const fixture = await workCohortStoreFixture();
    const observation = await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }]);
    const decision = constructCohortDecisionsV1(observation)[0]!;
    const overlapping = createCohortDefinitionIdentityV1({
      cohortId: "cohort:overlapping",
      decision,
      observation,
      prior: null,
    });
    const opened = await create();
    try {
      await prepareWorkCohortStore(opened.store, fixture);
      await opened.store.recordDefinition("define:overlapping", overlapping);
      const memberRefs = fixture.definition.members.map((member) => member.memberRef);
      await opened.store.transitionReservation("reserve:first", {
        reservationId: "reservation:first",
        cohortId: fixture.definition.cohortId,
        definitionDigest: fixture.definition.definitionDigest,
        memberRefs,
        transition: "reserved",
      });
      await expect(
        opened.store.transitionReservation("reserve:overlapping", {
          reservationId: "reservation:overlapping",
          cohortId: overlapping.cohortId,
          definitionDigest: overlapping.definitionDigest,
          memberRefs: overlapping.members.map((member) => member.memberRef),
          transition: "reserved",
        }),
      ).rejects.toBeInstanceOf(WorkCohortReservationConflictError);
      await expect(
        opened.store.transitionReservation("reserve:foreign", {
          reservationId: "reservation:foreign",
          cohortId: fixture.definition.cohortId,
          definitionDigest: fixture.definition.definitionDigest,
          memberRefs: ["tasks:foreign"],
          transition: "reserved",
        }),
      ).rejects.toThrow("exact definition membership");
      await expect(
        opened.store.transitionMember("member:foreign", {
          cohortId: fixture.definition.cohortId,
          definitionDigest: fixture.definition.definitionDigest,
          memberRef: "tasks:foreign",
          from: "planned",
          to: "running",
        }),
      ).rejects.toThrow("exact definition membership");
      await opened.store.transitionReservation("release:first", {
        reservationId: "reservation:first",
        cohortId: fixture.definition.cohortId,
        definitionDigest: fixture.definition.definitionDigest,
        memberRefs,
        transition: "released",
      });
      await expect(
        opened.store.transitionReservation("reserve:overlapping:after-release", {
          reservationId: "reservation:overlapping",
          cohortId: overlapping.cohortId,
          definitionDigest: overlapping.definitionDigest,
          memberRefs: overlapping.members.map((member) => member.memberRef),
          transition: "reserved",
        }),
      ).resolves.toMatchObject({ reservationId: "reservation:overlapping" });
    } finally {
      await opened.close();
    }
  });

  test(`${label}: portable restore retains history and revokes old runtime authority`, async () => {
    const fixture = await workCohortStoreFixture();
    const source = await create();
    const restored = await create();
    try {
      await prepareWorkCohortStore(source.store, fixture);
      const sealed = await source.store.sealCandidate("seal", fixture.request);
      const oldLease = await source.store.acquireLease({
        holderId: "holder:old",
        semanticSubject: sealed.evidenceSubject.evidenceSubjectDigest,
      });
      const before = await source.store.snapshot();
      await restored.store.restorePortableState(before.portable);
      const after = await restored.store.snapshot();
      expect(after.portable).toEqual(before.portable);
      expect(after.runtime.executionEpoch).not.toBe(before.runtime.executionEpoch);
      expect(after.runtime.lease).toBeNull();
      await expect(restored.store.assertLiveAuthority(oldLease)).rejects.toBeInstanceOf(
        WorkCohortStaleAuthorityError,
      );
      await expect(
        restored.store.acquireLease({
          holderId: "holder:before-revalidation",
          semanticSubject: sealed.evidenceSubject.evidenceSubjectDigest,
        }),
      ).rejects.toBeInstanceOf(WorkCohortStaleAuthorityError);
      await restored.store.revalidateForResume({
        definitionDigest: fixture.definition.definitionDigest,
        sealDigest: sealed.seal.sealDigest,
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        acceptanceMatrixDigest: fixture.definition.acceptanceMatrixDigest,
        environmentDigest: fixture.definition.environment.environmentDigest,
        receiptBridgeDigest: sealed.receiptBridge.bridgeDigest,
      });
      const resumedLease = await restored.store.acquireLease({
        holderId: "holder:after-revalidation",
        semanticSubject: sealed.evidenceSubject.evidenceSubjectDigest,
      });
      await expect(restored.store.assertLiveAuthority(resumedLease)).resolves.toBeUndefined();
    } finally {
      await source.close();
      await restored.close();
    }
  });

  test(`${label}: replacement candidates append history and invalidate prior acceptance`, async () => {
    const first = await workCohortStoreFixture("first", 1);
    const secondBase = await workCohortStoreFixture("second", 2);
    const secondPending = createPendingCohortCandidateAttemptV1(
      first.definition,
      secondBase.pending.preparedDispatch,
      createCohortCandidateIntentV1(first.definition, "replacement-candidate"),
    );
    const secondAuthenticated = await resolveQualifiedCandidateAttempt({
      pending: secondPending,
      resultCommit: secondBase.request.resultCommit,
      resultTree: secondBase.request.resultTree,
      receipts: secondBase.request.gitReceipts,
      wholeDiff: secondBase.request.wholeDiff,
      attemptId: "attempt:second",
    });
    const second: StoreFixture = {
      ...secondBase,
      definition: first.definition,
      pending: secondPending,
      staged: secondAuthenticated.staged,
      authenticator: secondAuthenticated.authenticator,
      request: {
        ...secondBase.request,
        definition: first.definition,
        attempt: secondAuthenticated.staged,
      },
    };
    const opened = await create();
    try {
      await prepareWorkCohortStore(opened.store, first);
      const firstSeal = await opened.store.sealCandidate("seal:first", first.request);
      const oldLease = await opened.store.acquireLease({
        holderId: "holder:first",
        semanticSubject: firstSeal.evidenceSubject.evidenceSubjectDigest,
      });
      for (const kind of ["focused", "shared-regression", "full-gate"] as const) {
        const probe = await opened.store.recordProbe(`probe:first:${kind}`, {
          evidenceSubjectDigest: firstSeal.evidenceSubject.evidenceSubjectDigest,
          probeKind: kind,
          probeEpoch: 1,
          commandDigest: sha256(`${kind} command`),
        });
        await opened.store.recordCommandEvidence(`evidence:first:${kind}`, {
          evidenceSubjectDigest: firstSeal.evidenceSubject.evidenceSubjectDigest,
          acceptanceMatrixDigest: first.definition.acceptanceMatrixDigest,
          probeDigest: probe.probeDigest,
          evidenceKind: kind,
          passed: true,
          receiptDigest: sha256(`${kind} receipt`),
        });
      }
      await opened.store.recordCandidateIntent("intent:second", second.pending.intent);
      await opened.store.recordCandidateAttempt("pending:second", second.pending);
      const secondSeal = await opened.store.sealCandidate("seal:second", second.request);
      const state = (await opened.store.snapshot()).portable;
      expect(state.candidateSeals).toHaveLength(2);
      expect(state.evidenceSubjects).toContainEqual(firstSeal.evidenceSubject);
      expect(state.evidenceSubjects).toContainEqual(secondSeal.evidenceSubject);
      expect(
        state.acceptanceTransitions.find(
          (transition) =>
            transition.evidenceSubjectDigest === firstSeal.evidenceSubject.evidenceSubjectDigest &&
            !transition.eligible,
        ),
      ).toBeDefined();
      await expect(
        opened.store.finalize("finalize:superseded", {
          definitionDigest: first.definition.definitionDigest,
          evidenceSubjectDigest: firstSeal.evidenceSubject.evidenceSubjectDigest,
        }),
      ).rejects.toBeInstanceOf(WorkCohortStaleAuthorityError);
      await expect(opened.store.assertLiveAuthority(oldLease)).rejects.toBeInstanceOf(
        WorkCohortStaleAuthorityError,
      );
      await expect(opened.store.releaseLease(oldLease)).resolves.toBeUndefined();
      const replacementLease = await opened.store.acquireLease({
        holderId: "holder:second",
        semanticSubject: secondSeal.evidenceSubject.evidenceSubjectDigest,
      });
      await expect(opened.store.assertLiveAuthority(replacementLease)).resolves.toBeUndefined();
      await opened.store.beginNewExecutionEpoch();
      await expect(
        opened.store.revalidateForResume({
          definitionDigest: first.definition.definitionDigest,
          sealDigest: firstSeal.seal.sealDigest,
          evidenceSubjectDigest: firstSeal.evidenceSubject.evidenceSubjectDigest,
          acceptanceMatrixDigest: first.definition.acceptanceMatrixDigest,
          environmentDigest: first.definition.environment.environmentDigest,
          receiptBridgeDigest: firstSeal.receiptBridge.bridgeDigest,
        }),
      ).rejects.toBeInstanceOf(WorkCohortStaleAuthorityError);
    } finally {
      await opened.close();
    }
  });

  test(`${label}: unprotected passed flags cannot finalize a cohort`, async () => {
    const fixture = await workCohortStoreFixture();
    const opened = await create();
    try {
      await prepareWorkCohortStore(opened.store, fixture);
      const sealed = await opened.store.sealCandidate("seal", fixture.request);
      for (const kind of ["focused", "shared-regression", "full-gate"] as const) {
        const probe = await opened.store.recordProbe(`probe:${kind}`, {
          evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
          probeKind: kind, probeEpoch: 1, commandDigest: sha256(`${kind} command`),
        });
        await opened.store.recordCommandEvidence(`evidence:${kind}`, {
          evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
          acceptanceMatrixDigest: fixture.definition.acceptanceMatrixDigest,
          probeDigest: probe.probeDigest, evidenceKind: kind, passed: true,
          receiptDigest: sha256(`${kind} claim`),
        });
      }
      await expect(opened.store.finalize("finalize:unprotected", {
        definitionDigest: fixture.definition.definitionDigest,
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
      })).rejects.toThrow("runner-owned");
    } finally {
      await opened.close();
    }
  });

  test(`${label}: semantic changes advance generation, retain split lineage, and finalization binds exact evidence`, async () => {
    const fixture = await workCohortStoreFixture();
    const opened = await create();
    try {
      await prepareWorkCohortStore(opened.store, fixture);
      const sealed = await opened.store.sealCandidate("seal", fixture.request);
      const changedObservation = await observationFor(
        [{ ref: "tasks:T1" }, { ref: "tasks:T2" }],
        { environment: "changed" },
      );
      const changedDecision = constructCohortDecisionsV1(changedObservation)[0]!;
      const changedDefinition = createCohortDefinitionIdentityV1({
        cohortId: fixture.definition.cohortId,
        decision: changedDecision,
        observation: changedObservation,
        prior: fixture.definition,
      });
      const focused = await opened.store.recordProbe("probe:focused", {
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        probeKind: "focused",
        probeEpoch: 1,
        commandDigest: sha256("focused command"),
      });
      await opened.store.recordCommandEvidence("evidence:focused", {
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        acceptanceMatrixDigest: fixture.definition.acceptanceMatrixDigest,
        probeDigest: focused.probeDigest,
        evidenceKind: "focused",
        passed: true,
        receiptDigest: sha256("focused receipt"),
      });
      await expect(
        opened.store.finalize("finalize:early", {
          definitionDigest: fixture.definition.definitionDigest,
          evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        }),
      ).rejects.toThrow("runner-owned green evidence");
      const shared = await opened.store.recordProbe("probe:shared", {
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        probeKind: "shared-regression",
        probeEpoch: 1,
        commandDigest: sha256("shared command"),
      });
      await opened.store.recordCommandEvidence("evidence:shared", {
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        acceptanceMatrixDigest: fixture.definition.acceptanceMatrixDigest,
        probeDigest: shared.probeDigest,
        evidenceKind: "shared-regression",
        passed: true,
        receiptDigest: sha256("shared receipt"),
      });
      await recordFixtureCohortAcceptance(opened.store, sealed.evidenceSubject.evidenceSubjectDigest);
      const completion = await opened.store.finalize("finalize", {
        definitionDigest: fixture.definition.definitionDigest,
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
      });
      expect(completion.sealDigest).toBe(sealed.seal.sealDigest);
      await opened.store.recordObservation("observe:changed", changedObservation);
      await opened.store.recordDecision("decide:changed", changedDecision);
      await opened.store.recordDefinition("define:changed", changedDefinition);
      expect(changedDefinition.definitionGeneration).toBe(
        fixture.definition.definitionGeneration + 1,
      );
      const split = await opened.store.recordSplit("split", {
        parentDefinitionDigest: fixture.definition.definitionDigest,
        childDefinitionDigests: [changedDefinition.definitionDigest],
        reason: "environment identity changed",
      });
      expect(split.childDefinitionDigests).toEqual([changedDefinition.definitionDigest]);
      await expect(
        opened.store.finalize("finalize", {
          definitionDigest: fixture.definition.definitionDigest,
          evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        }),
      ).rejects.toBeInstanceOf(WorkCohortStaleAuthorityError);
    } finally {
      await opened.close();
    }
  });
}
