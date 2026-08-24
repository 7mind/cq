import { describe, expect, test } from "bun:test";
import type { DispatchHandle, DispatchPrepared } from "@cq/config";
import { createStrictInMemoryWorksetEffectAdmissionProvider } from "@cq/process-control";
import {
  GOALS_LEDGER,
  InMemoryLedgerStore,
  ImplementationEvidenceService,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  canonicalImplementationCompletionMergeLine,
  createInMemoryImplementationEvidenceStore,
  createLedgerMcpTools,
  createObserveOnlyWorksetInvocationAuthority,
  implementationCompletionMergeAdmissionProviderFromStore,
  recordProtectedImplementationCompletion,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationReviewerIdentity,
} from "../src/index.js";

const BASE = "a".repeat(40);
const RESULT = "b".repeat(40);
const WORKER: DispatchHandle = { attestationId: "att_worker", generation: 1 };
const reviewer: ImplementationReviewerIdentity = {
  alias: "native",
  harness: "codex",
  model: "frontier",
  provider: null,
  launch: "native",
  adapterId: "codex:native",
};

function prepared(attemptRef: string): DispatchPrepared {
  return {
    attestationId: `att_${attemptRef.slice(-12)}`,
    generation: 1,
    responseStoreNow: "2099-01-01T00:00:00.000Z",
    childCancelAt: "2099-01-01T00:01:00.000Z",
    launchDeadline: "2098-12-31T23:59:00.000Z",
    promptProvenance: {
      roleId: "implement-reviewer",
      version: 7,
      surface: "codex",
      promptDigest: "c".repeat(64),
      catalogHash: "d".repeat(64),
      inputDigest: "e".repeat(64),
    },
    inputCapability: { scope: "fetch-input", token: "input" },
    resultCapability: { scope: "store-result", token: "result" },
  };
}

function approvedVerdict() {
  return {
    taskId: "T2345",
    verdict: "approve",
    criticism: [],
    questions: [],
    defects: [],
    rationale: "measured",
    gateReRan: true,
    gateDurationMs: 100,
    resultCommitVerified: true,
    resultCommitEvidence: { status: "verified", resultCommit: RESULT, branchTip: RESULT },
    baseAncestry: {
      status: "verified",
      relation: "descendant",
      baseCommit: BASE,
      resultCommit: RESULT,
      mergeBase: BASE,
    },
  } as const;
}

async function fixture() {
  const evidence = createInMemoryImplementationEvidenceStore();
  let head = BASE;
  let ledgerWrites = 0;
  let verificationClean = true;
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store: evidence,
    reviewerRoster: [reviewer],
    nativeFallback: reviewer,
    now: () => "2026-08-24T00:00:00.000Z",
    prepareNativeReview: async ({ attemptRef }) => prepared(attemptRef),
    fetchNativeReview: async () => ({ state: "consumed", output: approvedVerdict() }),
    executeExternalReview: async () => {
      throw new Error("not configured");
    },
    fetchWorker: async () => ({
      state: "consumed",
      output: {
        status: "pass",
        resultCommit: RESULT,
        branch: "implement/T2345",
        actualWorktreePath: "/repo/.claude/worktrees/T2345",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit: BASE,
          headCommit: RESULT,
        },
        gitReceipts: [{ oldHead: BASE, newHead: RESULT }],
        filesTouched: ["feature.ts"],
        supervisedGateEvidence: { gateExitCode: 0, passCount: 1, failCount: 0 },
      },
    }),
    readTaskAuthority: async () => ({
      taskRef: "tasks:T2345",
      ownerGoalRef: "goals:G1",
      status: "wip",
      finalizedManifest: "manifest-v1\n",
    }),
    repositoryHead: async () => head,
    verifyImplementation: async () => ({
      baseCommit: BASE,
      startingCommit: BASE,
      clean: verificationClean,
      ancestryVerified: true,
      receiptsVerified: true,
      acceptanceVerified: true,
      gateVerified: true,
      details: { cleanDiff: true, ffOnly: true },
    }),
    recordLedgerCompletion: async () => {
      ledgerWrites += 1;
      return { reviewRef: "reviews:R2345" };
    },
  };
  const service = new ImplementationEvidenceService(dependencies);
  const panel = await service.prepareReviewPanel({
    taskRef: "tasks:T2345",
    resultCommit: RESULT,
    workerDispatch: WORKER,
    operationId: "panel",
    author: "parent",
  });
  const attemptRef = panel.attemptRefs[0]!;
  await service.prepareReviewAttempt({
    panelRef: panel.panelRef,
    attemptRef,
    operationId: "attempt",
    author: "parent",
  });
  await service.finalizeReviewAttempt({ attemptRef, operationId: "finalize", author: "parent" });
  return {
    service,
    evidence,
    attemptRef,
    getHead: () => head,
    setHead: (value: string) => {
      head = value;
    },
    setVerificationClean: (value: boolean) => {
      verificationClean = value;
    },
    getLedgerWrites: () => ledgerWrites,
  };
}

describe("versioned protected implementation evidence [BG]", () => {
  test("binds complete ordered review evidence before merge and records after durable merge", async () => {
    const f = await fixture();
    const completion = await f.service.prepareCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [f.attemptRef],
      completion: "implemented",
      logPaths: [".cq/logs/worker.md", ".cq/logs/reviewer.md"],
      mergeOperationId: "merge-t2345",
      operationId: "prepare-completion",
      author: "parent",
    });
    expect(Object.keys(completion).sort()).toEqual([
      "completionRef",
      "evidenceFingerprint",
      "repositoryHead",
      "resultCommit",
      "status",
      "taskRef",
    ]);

    const underlying = createStrictInMemoryWorksetEffectAdmissionProvider();
    const binding = {
      kind: "merge" as const,
      targetRef: "tasks:T2345",
      repositoryRoot: "/repo",
      commit: RESULT,
      completionRef: completion.completionRef,
      mergeOperationId: "merge-t2345",
    };
    const provider = implementationCompletionMergeAdmissionProviderFromStore({
      provider: underlying,
      store: f.evidence,
      binding,
      repositoryHead: async () => f.getHead(),
    });
    const admission = await provider.acquire({ kind: "merge", targetRef: "tasks:T2345" });
    await admission.registerProcessGroup({ pgid: 123, leaderPid: 123 });
    await admission.shareWithGuardian({ pgid: 123, leaderPid: 123 });
    expect((await f.evidence.snapshot()).completions[completion.completionRef]!.state).toBe(
      "merge-started",
    );
    f.setHead(RESULT);
    await admission.markSettled();
    expect((await f.evidence.snapshot()).completions[completion.completionRef]!.state).toBe(
      "merged",
    );
    await admission.releaseAfterSettlement();

    const acknowledgement = await f.service.mergeAcknowledgement(completion.completionRef);
    expect(canonicalImplementationCompletionMergeLine(acknowledgement)).toBe(
      `CQ_IMPLEMENTATION_COMPLETION_MERGE=${JSON.stringify(acknowledgement)}`,
    );
    expect(
      (
        await f.service.recordCompletion({
          taskRef: "tasks:T2345",
          expectedRepositoryHead: RESULT,
          operationId: "record",
          author: "parent",
        })
      ).status,
    ).toBe("recorded");
    expect(
      (
        await f.service.recordCompletion({
          taskRef: "tasks:T2345",
          expectedRepositoryHead: RESULT,
          operationId: "record-replay",
          author: "parent",
        })
      ).status,
    ).toBe("existing");
    expect(f.getLedgerWrites()).toBe(1);
  });

  test("rejects omitted, duplicated, reordered, and foreign attempt evidence without a journal", async () => {
    const f = await fixture();
    for (const refs of [
      [],
      [f.attemptRef, f.attemptRef],
      ["cq-implementation-review-attempt:v1:" + "f".repeat(64)],
    ]) {
      await expect(
        f.service.prepareCompletion({
          taskRef: "tasks:T2345",
          expectedRepositoryHead: BASE,
          resultCommit: RESULT,
          workerDispatch: WORKER,
          reviewAttemptRefs: refs,
          completion: "implemented",
          logPaths: [],
          mergeOperationId: `merge-${refs.length}`,
          operationId: `completion-${refs.length}-${refs[0]?.slice(-1) ?? "empty"}`,
          author: "parent",
        }),
      ).rejects.toThrow();
    }
    expect(Object.keys((await f.evidence.snapshot()).completions)).toHaveLength(0);
  });

  test("revalidates trusted implementation observations immediately before recording", async () => {
    const f = await fixture();
    const completion = await f.service.prepareCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [f.attemptRef],
      completion: "implemented",
      logPaths: [],
      mergeOperationId: "merge-revalidate",
      operationId: "completion-revalidate",
      author: "parent",
    });
    await f.service.markMergeStarted(completion.completionRef, BASE);
    f.setHead(RESULT);
    await f.service.markMerged(completion.completionRef, RESULT);
    f.setVerificationClean(false);
    await expect(
      f.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: RESULT,
        operationId: "record-revalidate",
        author: "parent",
      }),
    ).rejects.toThrow("verification changed");
    expect(f.getLedgerWrites()).toBe(0);
  });

  test("generic writes cannot terminalize an active Git-producing implementation task", async () => {
    const f = await fixture();
    const preparedCompletion = await f.service.prepareCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [f.attemptRef],
      completion: "implemented",
      logPaths: [".cq/logs/worker.md"],
      mergeOperationId: "merge-protected",
      operationId: "completion-protected",
      author: "parent",
    });
    await f.service.markMergeStarted(preparedCompletion.completionRef, BASE);
    f.setHead(RESULT);
    await f.service.markMerged(preparedCompletion.completionRef, RESULT);
    const completion = (await f.evidence.snapshot()).completions[preparedCompletion.completionRef]!;

    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const milestone = await ledger.createMilestone({ title: "protected completion" });
    await ledger.createItem(GOALS_LEDGER, milestone.id, {
      id: "G1",
      status: "building",
      fields: { title: "goal", description: "goal" },
    });
    await ledger.createItem(TASKS_LEDGER, milestone.id, {
      id: "T2345",
      status: "planned",
      fields: { headline: "task" },
    });
    await ledger.updateItem(TASKS_LEDGER, "T2345", { status: "wip" });
    await expect(
      ledger.updateItem(TASKS_LEDGER, "T2345", {
        status: "done",
        fields: { resultCommit: RESULT, completion: "direct forged completion" },
      }),
    ).rejects.toThrow("protected implementation evidence");
    expect(
      await ledger.createItem(TASKS_LEDGER, milestone.id, {
        id: "T2346",
        status: "planned",
        fields: { headline: "legacy seed", resultCommit: RESULT },
      }),
    ).toMatchObject({ id: "T2346", status: "planned" });
    const genericTools = createLedgerMcpTools(
      ledger,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      "full",
      undefined,
      createObserveOnlyWorksetInvocationAuthority(),
      f.service,
    );
    const genericUpdate = genericTools.find((tool) => tool.name === "update_item");
    if (genericUpdate === undefined) throw new Error("update_item tool is absent");
    await genericUpdate.handler(
      {
        ledger_id: TASKS_LEDGER,
        item_id: "T2346",
        status: "done",
        fields: { completion: "legacy seed" },
      } as never,
      null,
    );
    await expect(
      genericUpdate.handler(
        {
          ledger_id: TASKS_LEDGER,
          item_id: "T2345",
          status: "done",
          fields: { resultCommit: RESULT, completion: "forged" },
        } as never,
        null,
      ),
    ).rejects.toThrow("protected implementation evidence");
    await expect(
      ledger.createItem(REVIEWS_LEDGER, milestone.id, {
        status: "go-ahead",
        fields: { implementationEvidence: "{}" },
      }),
    ).rejects.toThrow("implementationEvidence may be attached only");

    expect(
      await recordProtectedImplementationCompletion(
        ledger,
        {
          taskRef: "tasks:T2345",
          ownerGoalRef: "goals:G1",
          status: "wip",
          finalizedManifest: "manifest-v1\n",
        },
        completion,
        { author: "parent" },
      ),
    ).toEqual({ reviewRef: "reviews:R2345" });
    expect(ledger.fetchItem(TASKS_LEDGER, "T2345")).toMatchObject({
      status: "done",
      fields: { resultCommit: RESULT, completion: "implemented" },
    });
    expect(ledger.fetchItem(REVIEWS_LEDGER, "R2345").fields["implementationEvidence"]).toContain(
      preparedCompletion.completionRef,
    );
    await expect(
      ledger.updateItem(REVIEWS_LEDGER, "R2345", {
        fields: { summary: "forged replacement" },
      }),
    ).rejects.toThrow("protected implementation evidence");
    await expect(
      ledger.updateItem(TASKS_LEDGER, "T2345", {
        fields: { completion: "forged replacement" },
      }),
    ).rejects.toThrow("protected implementation evidence");
  });

  test("rolls back the terminal review when the paired task transition fails", async () => {
    const f = await fixture();
    const preparedCompletion = await f.service.prepareCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [f.attemptRef],
      completion: "implemented",
      logPaths: [],
      mergeOperationId: "merge-atomic-ledger",
      operationId: "completion-atomic-ledger",
      author: "parent",
    });
    await f.service.markMergeStarted(preparedCompletion.completionRef, BASE);
    f.setHead(RESULT);
    await f.service.markMerged(preparedCompletion.completionRef, RESULT);
    const completion = (await f.evidence.snapshot()).completions[preparedCompletion.completionRef]!;
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const milestone = await ledger.createMilestone({ title: "atomic completion" });
    await ledger.createItem(GOALS_LEDGER, milestone.id, {
      id: "G1",
      status: "building",
      fields: { title: "goal", description: "goal" },
    });
    await ledger.createItem(TASKS_LEDGER, milestone.id, {
      id: "T2345",
      status: "done",
      fields: { headline: "task", resultCommit: BASE },
    });
    await expect(
      recordProtectedImplementationCompletion(
        ledger,
        {
          taskRef: "tasks:T2345",
          ownerGoalRef: "goals:G1",
          status: "wip",
          finalizedManifest: "manifest-v1\n",
        },
        completion,
        { author: "parent" },
      ),
    ).rejects.toThrow("different resultCommit");
    expect(() => ledger.fetchItem(REVIEWS_LEDGER, "R2345")).toThrow();
  });
});
