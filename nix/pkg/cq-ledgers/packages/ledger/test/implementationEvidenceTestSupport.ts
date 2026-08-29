import type { DispatchHandle, DispatchPrepared } from "@cq/config";
import {
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationEvidenceStore,
  type ImplementationReviewerIdentity,
} from "../src/index.js";

export const IMPLEMENTATION_BASE = "a".repeat(40);
export const IMPLEMENTATION_RESULT = "b".repeat(40);
export const IMPLEMENTATION_WORKER: DispatchHandle = {
  attestationId: "att_worker",
  generation: 1,
};

const REVIEWER: ImplementationReviewerIdentity = {
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
    resultCommitEvidence: {
      status: "verified",
      resultCommit: IMPLEMENTATION_RESULT,
      branchTip: IMPLEMENTATION_RESULT,
    },
    baseAncestry: {
      status: "verified",
      relation: "descendant",
      baseCommit: IMPLEMENTATION_BASE,
      resultCommit: IMPLEMENTATION_RESULT,
      mergeBase: IMPLEMENTATION_BASE,
    },
  } as const;
}

export async function createImplementationEvidenceFixture(
  store: ImplementationEvidenceStore = createInMemoryImplementationEvidenceStore(),
) {
  let head = IMPLEMENTATION_BASE;
  let ledgerWrites = 0;
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store,
    resolveReviewerRoster: () => [REVIEWER],
    nativeFallback: REVIEWER,
    now: () => "2026-08-24T00:00:00.000Z",
    prepareNativeReview: async ({ attemptRef }) => prepared(attemptRef),
    fetchNativeReview: async (dispatch) => ({
      state: "consumed",
      output: approvedVerdict(),
      retainedAttestation: dispatch.attestationId,
    }),
    executeExternalReview: async () => {
      throw new Error("not configured");
    },
    fetchWorker: async () => ({
      state: "consumed",
      input: { taskId: "T2345", baseCommit: IMPLEMENTATION_BASE },
      output: {
        status: "pass",
        resultCommit: IMPLEMENTATION_RESULT,
        branch: "implement/T2345",
        actualWorktreePath: "/repo/.claude/worktrees/T2345",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit: IMPLEMENTATION_BASE,
          headCommit: IMPLEMENTATION_RESULT,
        },
        gitReceipts: [{ oldHead: IMPLEMENTATION_BASE, newHead: IMPLEMENTATION_RESULT }],
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
      baseCommit: IMPLEMENTATION_BASE,
      startingCommit: IMPLEMENTATION_BASE,
      clean: true,
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
    startupBuildCommit: IMPLEMENTATION_BASE,
    implementationEvidenceProtocolVersion: 2,
    packagedManifestInventory: ["d347-implementation-evidence-activation-v1"],
    readBootstrapAuthority: async () => ({
      goalRef: "goals:G176",
      finalizedManifestDigest: "f".repeat(64),
      mappings: {
        evidenceTaskRef: "tasks:T3000",
        historicalTaskRef: "tasks:T3001",
        activationTaskRef: "tasks:T3002",
      },
      evidenceTask: {
        taskRef: "tasks:T3000",
        status: "done",
        resultCommit: IMPLEMENTATION_BASE,
        ready: false,
      },
      historicalTask: {
        taskRef: "tasks:T3001",
        status: "planned",
        resultCommit: null,
        ready: true,
      },
      activationTask: {
        taskRef: "tasks:T3002",
        status: "planned",
        resultCommit: null,
        ready: false,
        actionKey: "activate-implementation-evidence",
      },
    }),
  };
  const service = new ImplementationEvidenceService(dependencies);
  const panel = await service.prepareReviewPanel({
    taskRef: "tasks:T2345",
    resultCommit: IMPLEMENTATION_RESULT,
    workerDispatch: IMPLEMENTATION_WORKER,
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
  await service.finalizeReviewAttempt({
    attemptRef,
    operationId: "finalize",
    author: "parent",
  });
  return {
    service,
    store,
    panel,
    attemptRef,
    getHead: () => head,
    setHead: (value: string) => {
      head = value;
    },
    getLedgerWrites: () => ledgerWrites,
  };
}

export async function prepareImplementationCompletion(
  fixture: Awaited<ReturnType<typeof createImplementationEvidenceFixture>>,
  operationId = "prepare-completion",
) {
  return await fixture.service.prepareCompletion({
    taskRef: "tasks:T2345",
    expectedRepositoryHead: IMPLEMENTATION_BASE,
    resultCommit: IMPLEMENTATION_RESULT,
    workerDispatch: IMPLEMENTATION_WORKER,
    reviewAttemptRefs: [fixture.attemptRef],
    completion: "implemented",
    logPaths: [".cq/logs/worker.md", ".cq/logs/reviewer.md"],
    mergeOperationId: "merge-t2345",
    operationId,
    author: "parent",
  });
}
