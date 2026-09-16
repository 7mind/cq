import { describe, expect, test } from "bun:test";

import {
  CohortCandidateSealConflictError,
  InMemoryCohortCandidateSealStoreV1,
  assertCohortLiveEffectCurrentV1,
  bindCohortLiveEffectV1,
  constructCohortDecisionsV1,
  createCohortDefinitionIdentityV1,
  createCohortEffectEnvelopeV1,
  createCohortEvidenceReceiptV1,
  createCohortEvidenceSubjectV1,
  createPendingCohortCandidateAttemptV1,
  isCohortEvidenceReceiptReusableV1,
  stageCohortCandidateAttemptV1,
} from "../src/workCohort.js";
import { commit, observationFor, qualifiedQueue, receipt, sha256 } from "./workCohortFixture.js";

async function identityFixture() {
  const observation = await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }]);
  const decision = constructCohortDecisionsV1(observation)[0]!;
  const definition = createCohortDefinitionIdentityV1({
    cohortId: "cohort:test",
    decision,
    observation,
    prior: null,
  });
  const dispatch = {
    attestationId: "att-test",
    generation: 1,
    taskId: "T-test",
    branch: "implement/T-test",
    startingCommit: commit("base"),
  };
  const base = dispatch.startingCommit;
  const result = commit("result");
  const tree = commit("result-tree");
  const receipts = [receipt({ base, result, tree })];
  const pending = createPendingCohortCandidateAttemptV1(definition, dispatch);
  const queue = qualifiedQueue({ taskId: dispatch.taskId, base, result, tree, receipts });
  const staged = stageCohortCandidateAttemptV1(pending, { preparedDispatch: dispatch, queue });
  return { observation, decision, definition, dispatch, base, result, tree, receipts, pending, staged };
}

describe("cohort candidate identity", () => {
  test("seals one G213 attempt atomically without advancing definition generation", async () => {
    const fixture = await identityFixture();
    const store = new InMemoryCohortCandidateSealStoreV1();
    const request = {
      definition: fixture.definition,
      attempt: fixture.staged,
      baseCommit: fixture.base,
      resultCommit: fixture.result,
      resultTree: fixture.tree,
      wholeDiff: [
        { path: "src/result.ts", mode: "100644" as const, blobDigest: sha256("result blob") },
      ],
      gitReceipts: fixture.receipts,
    };
    const first = store.seal(request);
    const replay = store.seal(request);

    expect(first.state).toBe("sealed");
    expect(replay.state).toBe("existing");
    expect(replay.seal).toEqual(first.seal);
    expect(fixture.definition.definitionGeneration).toBe(1);
  });

  test("rejects altered seal closure, base, result tree, and whole diff", async () => {
    const fixture = await identityFixture();
    const store = new InMemoryCohortCandidateSealStoreV1();
    const request = {
      definition: fixture.definition,
      attempt: fixture.staged,
      baseCommit: fixture.base,
      resultCommit: fixture.result,
      resultTree: fixture.tree,
      wholeDiff: [
        { path: "src/result.ts", mode: "100644" as const, blobDigest: sha256("result blob") },
      ],
      gitReceipts: fixture.receipts,
    };
    store.seal(request);

    expect(() => store.seal({ ...request, baseCommit: commit("other-base") })).toThrow(
      CohortCandidateSealConflictError,
    );
    expect(() =>
      store.seal({
        ...request,
        wholeDiff: [{ ...request.wholeDiff[0]!, blobDigest: sha256("altered") }],
      }),
    ).toThrow("altered candidate seal replay");
    expect(() => store.seal({ ...request, resultTree: commit("other-tree") })).toThrow(
      CohortCandidateSealConflictError,
    );
    expect(() => store.seal({ ...request, gitReceipts: [] })).toThrow(
      CohortCandidateSealConflictError,
    );
  });

  test("unchanged restart preserves semantic bytes, renews epoch, and reuses receipts", async () => {
    const fixture = await identityFixture();
    const sameDefinition = createCohortDefinitionIdentityV1({
      cohortId: fixture.definition.cohortId,
      decision: fixture.decision,
      observation: fixture.observation,
      prior: fixture.definition,
    });
    const seal = new InMemoryCohortCandidateSealStoreV1().seal({
      definition: fixture.definition,
      attempt: fixture.staged,
      baseCommit: fixture.base,
      resultCommit: fixture.result,
      resultTree: fixture.tree,
      wholeDiff: [
        { path: "src/result.ts", mode: "100644", blobDigest: sha256("result blob") },
      ],
      gitReceipts: fixture.receipts,
    }).seal;
    const subject = createCohortEvidenceSubjectV1(fixture.definition, seal);
    const firstEnvelope = createCohortEffectEnvelopeV1({
      definition: fixture.definition,
      attempt: fixture.staged,
      evidenceSubject: subject,
      executionEpoch: "epoch:1",
    });
    const priorHolder = bindCohortLiveEffectV1(firstEnvelope, "gate-holder");
    const receipt = createCohortEvidenceReceiptV1({
      evidenceSubject: subject,
      definition: fixture.definition,
      authorizingExecutionEpoch: "epoch:1",
    });
    const restarted = createCohortEffectEnvelopeV1({
      definition: sameDefinition,
      attempt: fixture.staged,
      evidenceSubject: subject,
      executionEpoch: "epoch:2",
    });

    expect(sameDefinition).toBe(fixture.definition);
    expect(() => assertCohortLiveEffectCurrentV1(restarted, priorHolder)).toThrow(
      "fenced by another semantic subject or execution epoch",
    );
    expect(
      isCohortEvidenceReceiptReusableV1({
        receipt,
        evidenceSubject: subject,
        definition: sameDefinition,
      }),
    ).toBe(true);
  });

  test("changed candidate creates a new seal and subject while retaining prior lineage", async () => {
    const fixture = await identityFixture();
    const store = new InMemoryCohortCandidateSealStoreV1();
    const firstSeal = store.seal({
      definition: fixture.definition,
      attempt: fixture.staged,
      baseCommit: fixture.base,
      resultCommit: fixture.result,
      resultTree: fixture.tree,
      wholeDiff: [
        { path: "src/result.ts", mode: "100644", blobDigest: sha256("one") },
      ],
      gitReceipts: fixture.receipts,
    }).seal;
    const nextResult = commit("next-result");
    const nextTree = commit("next-tree");
    const nextReceipts = [receipt({ base: fixture.base, result: nextResult, tree: nextTree, operation: "next" })];
    const nextQueue = qualifiedQueue({
      taskId: fixture.dispatch.taskId,
      base: fixture.base,
      result: nextResult,
      tree: nextTree,
      receipts: nextReceipts,
      attempt: "attempt:next",
    });
    const nextPending = createPendingCohortCandidateAttemptV1(fixture.definition, {
      ...fixture.dispatch,
      generation: 2,
    });
    const nextAttempt = stageCohortCandidateAttemptV1(nextPending, {
      preparedDispatch: { ...fixture.dispatch, generation: 2 },
      queue: nextQueue,
    });
    const nextSeal = store.seal({
      definition: fixture.definition,
      attempt: nextAttempt,
      baseCommit: fixture.base,
      resultCommit: nextResult,
      resultTree: nextTree,
      wholeDiff: [
        { path: "src/result.ts", mode: "100644", blobDigest: sha256("two") },
      ],
      gitReceipts: nextReceipts,
    }).seal;
    const firstSubject = createCohortEvidenceSubjectV1(fixture.definition, firstSeal);
    const nextSubject = createCohortEvidenceSubjectV1(fixture.definition, nextSeal);

    expect(nextSubject.evidenceSubjectDigest).not.toBe(firstSubject.evidenceSubjectDigest);
    expect(store.read(fixture.staged.candidateAttemptDigest)).toEqual(firstSeal);
  });

  test("cannot substitute a dispatch or allocate an independent G213 identity", async () => {
    const fixture = await identityFixture();
    expect(() =>
      stageCohortCandidateAttemptV1(fixture.pending, {
        preparedDispatch: { ...fixture.dispatch, generation: 2 },
        queue: qualifiedQueue({
          taskId: fixture.dispatch.taskId,
          base: fixture.base,
          result: fixture.result,
          tree: fixture.tree,
          receipts: fixture.receipts,
        }),
      }),
    ).toThrow("substituted the prepared dispatch");
  });

  test("semantic changes advance the definition generation", async () => {
    const fixture = await identityFixture();
    const variants = [
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }, { ref: "tasks:T3" }]),
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2", authority: "changed" }]),
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2", atoms: [{ witness: "changed" }] }]),
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2", atoms: [{ command: "changed" }] }]),
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }], {
        environment: "changed",
      }),
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }], {
        repository: {
          repositoryId: "repository:test",
          headCommit: commit("changed-head"),
          treeOid: commit("changed-tree"),
        },
      }),
    ];

    for (const observation of variants) {
      const decision = constructCohortDecisionsV1(observation)[0]!;
      const changed = createCohortDefinitionIdentityV1({
        cohortId: fixture.definition.cohortId,
        decision,
        observation,
        prior: fixture.definition,
      });
      expect(changed.definitionGeneration).toBe(2);
      expect(changed.definitionDigest).not.toBe(fixture.definition.definitionDigest);
    }
  });
});
