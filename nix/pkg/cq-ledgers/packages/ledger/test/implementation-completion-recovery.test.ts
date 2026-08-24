import { describe, expect, test } from "bun:test";
import {
  IMPLEMENTATION_BASE,
  IMPLEMENTATION_RESULT,
  createImplementationEvidenceFixture,
  prepareImplementationCompletion,
} from "./implementationEvidenceTestSupport.js";

describe("implementation completion crash recovery [Behavioral-Active Sociable-Atomic]", () => {
  test("classifies pre-merge, moved-head, and post-merge restart states", async () => {
    const fixture = await createImplementationEvidenceFixture();
    const completion = await prepareImplementationCompletion(fixture);

    expect(
      await fixture.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: IMPLEMENTATION_BASE,
        operationId: "record-before-merge",
        author: "parent",
      }),
    ).toMatchObject({ status: "merge-required", completionRef: completion.completionRef });

    const unrelated = "c".repeat(40);
    fixture.setHead(unrelated);
    expect(
      await fixture.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: unrelated,
        operationId: "record-after-drift",
        author: "parent",
      }),
    ).toMatchObject({ status: "reprepare-required", completionRef: completion.completionRef });

    fixture.setHead(IMPLEMENTATION_BASE);
    await fixture.service.markMergeStarted(completion.completionRef, IMPLEMENTATION_BASE);
    fixture.setHead(IMPLEMENTATION_RESULT);
    expect(
      await fixture.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: IMPLEMENTATION_RESULT,
        operationId: "record-after-merge",
        author: "parent",
      }),
    ).toMatchObject({ status: "recorded", completionRef: completion.completionRef });
    expect(fixture.getLedgerWrites()).toBe(1);
  });
});
