import { describe, expect, test } from "bun:test";
import {
  GOALS_LEDGER,
  IMPLEMENTATION_COMPLETION_REVIEW_FIELD,
  InMemoryLedgerStore,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  recordProtectedImplementationCompletion,
} from "../src/index.js";
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
    expect(await fixture.service.recordCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: IMPLEMENTATION_RESULT,
      operationId: "record-after-merge",
      author: "parent",
    })).toMatchObject({
      status: "recorded",
      completionRef: completion.completionRef,
      reviewRef: "reviews:R2345",
    });
    expect(await fixture.service.recordCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: IMPLEMENTATION_RESULT,
      operationId: "record-historical-replay",
      author: "parent",
    })).toMatchObject({
      status: "existing",
      completionRef: completion.completionRef,
      reviewRef: "reviews:R2345",
    });
    expect(fixture.getLedgerWrites()).toBe(1);
  });

  test("recovers every exact old-head and exact result-head journal state", async () => {
    const preparedAtResult = await createImplementationEvidenceFixture();
    const preparedCompletion = await prepareImplementationCompletion(preparedAtResult);
    preparedAtResult.setHead(IMPLEMENTATION_RESULT);
    expect(
      await preparedAtResult.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: IMPLEMENTATION_RESULT,
        operationId: "record-prepared-at-result",
        author: "parent",
      }),
    ).toMatchObject({ status: "recorded", completionRef: preparedCompletion.completionRef });

    const mergeStartedAtOldHead = await createImplementationEvidenceFixture();
    const startedCompletion = await prepareImplementationCompletion(mergeStartedAtOldHead);
    await mergeStartedAtOldHead.service.markMergeStarted(
      startedCompletion.completionRef,
      IMPLEMENTATION_BASE,
    );
    expect(
      await mergeStartedAtOldHead.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: IMPLEMENTATION_BASE,
        operationId: "replay-started-at-old-head",
        author: "parent",
      }),
    ).toMatchObject({ status: "merge-required", completionRef: startedCompletion.completionRef });

    const mergedReplay = await createImplementationEvidenceFixture();
    const mergedCompletion = await prepareImplementationCompletion(mergedReplay);
    await mergedReplay.service.markMergeStarted(mergedCompletion.completionRef, IMPLEMENTATION_BASE);
    mergedReplay.setHead(IMPLEMENTATION_RESULT);
    await mergedReplay.service.markMerged(mergedCompletion.completionRef, IMPLEMENTATION_RESULT);
    await expect(
      mergedReplay.service.markMergeStarted(
        mergedCompletion.completionRef,
        IMPLEMENTATION_RESULT,
      ),
    ).resolves.toBeUndefined();
  });

  test("a cut after the ledger commit replays the bound review without allocator or domain writes", async () => {
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const milestone = await ledger.createMilestone({ title: "completion replay" });
    await ledger.createItem(GOALS_LEDGER, milestone.id, {
      id: "G1",
      status: "building",
      fields: { title: "goal", description: "goal" },
    });
    await ledger.createItem(TASKS_LEDGER, milestone.id, {
      id: "T2345",
      status: "wip",
      fields: { headline: "task", ledgerRefs: ["goals:G1"] },
    });
    let cutAfterLedgerCommit = true;
    let ledgerCalls = 0;
    const fixture = await createImplementationEvidenceFixture(undefined, {
      recordLedgerCompletion: async ({ task, completion, author, session }) => {
        ledgerCalls += 1;
        const result = await recordProtectedImplementationCompletion(
          ledger,
          task,
          completion,
          { author, ...(session === undefined ? {} : { session }) },
        );
        if (cutAfterLedgerCommit) {
          cutAfterLedgerCommit = false;
          throw new Error("injected cut after ledger commit");
        }
        return result;
      },
    });
    try {
      const prepared = await prepareImplementationCompletion(fixture, "prepare-cut-replay");
      await fixture.service.markMergeStarted(prepared.completionRef, IMPLEMENTATION_BASE);
      fixture.setHead(IMPLEMENTATION_RESULT);
      await fixture.service.markMerged(prepared.completionRef, IMPLEMENTATION_RESULT);
      const record = () => fixture.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: IMPLEMENTATION_RESULT,
        operationId: "record-cut-replay",
        author: "parent",
      });
      await expect(record()).rejects.toThrow("injected cut after ledger commit");
      expect((await fixture.store.snapshot()).completions[prepared.completionRef]?.state).toBe("recording");
      expect(ledger.fetchItem(TASKS_LEDGER, "T2345").fields[IMPLEMENTATION_COMPLETION_REVIEW_FIELD])
        .toBe("reviews:R1");
      expect(ledger.fetchItem(REVIEWS_LEDGER, "R1").status).toBe("go-ahead");
      const afterCut = JSON.stringify(ledger.enumerate().map((ledgerId) => ledger.fetch(ledgerId)));
      await expect(record()).resolves.toMatchObject({ status: "recorded", reviewRef: "reviews:R1" });
      expect(JSON.stringify(ledger.enumerate().map((ledgerId) => ledger.fetch(ledgerId)))).toBe(afterCut);
      await expect(record()).resolves.toMatchObject({ status: "existing", reviewRef: "reviews:R1" });
      expect(ledgerCalls).toBe(2);
    } finally {
      await ledger.dispose();
    }
  });
});
