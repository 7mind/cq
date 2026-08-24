import { describe, expect, test } from "bun:test";
import {
  createInMemoryImplementationEvidenceStore,
  markImplementationCompletionMergeStarted,
} from "../src/index.js";
import {
  IMPLEMENTATION_BASE,
  IMPLEMENTATION_RESULT,
  createImplementationEvidenceFixture,
  prepareImplementationCompletion,
} from "./implementationEvidenceTestSupport.js";

describe("implementation completion races [Behavioral-Active Sociable-Atomic]", () => {
  test("requires a rebased result and fresh review set to supersede a prepared journal", async () => {
    const fixture = await createImplementationEvidenceFixture();
    const completion = await prepareImplementationCompletion(fixture);
    await expect(
      fixture.service.prepareCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: IMPLEMENTATION_BASE,
        resultCommit: IMPLEMENTATION_RESULT,
        workerDispatch: { attestationId: "att_worker", generation: 1 },
        reviewAttemptRefs: [fixture.attemptRef],
        completion: "unchanged replacement",
        logPaths: [],
        mergeOperationId: "merge-unchanged-replacement",
        supersedesCompletionRef: completion.completionRef,
        operationId: "replace-without-rebase",
        author: "parent",
      }),
    ).rejects.toThrow("rebased result");
  });

  test("prevents supersession after merge launch and admits one recording operation", async () => {
    const fixture = await createImplementationEvidenceFixture();
    const completion = await prepareImplementationCompletion(fixture);
    await fixture.service.markMergeStarted(completion.completionRef, IMPLEMENTATION_BASE);

    await expect(
      fixture.service.prepareCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: IMPLEMENTATION_BASE,
        resultCommit: IMPLEMENTATION_RESULT,
        workerDispatch: { attestationId: "att_worker", generation: 1 },
        reviewAttemptRefs: [fixture.attemptRef],
        completion: "replacement",
        logPaths: [],
        mergeOperationId: "merge-replacement",
        supersedesCompletionRef: completion.completionRef,
        operationId: "replace-after-launch",
        author: "parent",
      }),
    ).rejects.toThrow("unmerged prepared journal");

    fixture.setHead(IMPLEMENTATION_RESULT);
    await fixture.service.markMerged(completion.completionRef, IMPLEMENTATION_RESULT);
    const first = fixture.service.recordCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: IMPLEMENTATION_RESULT,
      operationId: "record-winner",
      author: "parent",
    });
    const second = fixture.service.recordCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: IMPLEMENTATION_RESULT,
      operationId: "record-loser",
      author: "parent",
    });
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(fixture.getLedgerWrites()).toBe(1);
  });

  test("atomically admits only one repository-wide merge-started authority", async () => {
    const fixture = await createImplementationEvidenceFixture();
    const first = await prepareImplementationCompletion(fixture);
    const snapshot = await fixture.store.snapshot();
    const firstRecord = snapshot.completions[first.completionRef]!;
    const secondRef = `cq-implementation-completion:v1:${"d".repeat(64)}`;
    const store = createInMemoryImplementationEvidenceStore({
      ...snapshot,
      completions: {
        ...snapshot.completions,
        [secondRef]: {
          ...firstRecord,
          completionRef: secondRef,
          taskRef: "tasks:T2346",
          operationId: "prepare-second",
          requestDigest: "e".repeat(64),
          mergeOperationId: "merge-second",
        },
      },
    });
    const settled = await Promise.allSettled([
      markImplementationCompletionMergeStarted(store, first.completionRef, IMPLEMENTATION_BASE),
      markImplementationCompletionMergeStarted(store, secondRef, IMPLEMENTATION_BASE),
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(
      Object.values((await store.snapshot()).completions).filter(
        (entry) => entry.state === "merge-started",
      ),
    ).toHaveLength(1);
  });
});
