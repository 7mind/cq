import { describe, expect, test } from "bun:test";
import {
  IMPLEMENTATION_BASE,
  IMPLEMENTATION_RESULT,
  createImplementationEvidenceFixture,
  prepareImplementationCompletion,
} from "./implementationEvidenceTestSupport.js";

describe("implementation completion races [Behavioral-Active Sociable-Atomic]", () => {
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
});
