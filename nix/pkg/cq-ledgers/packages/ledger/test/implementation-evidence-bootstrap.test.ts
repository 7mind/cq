import { describe, expect, test } from "bun:test";
import {
  GOALS_LEDGER,
  InMemoryLedgerStore,
  ImplementationEvidenceService,
  TASKS_LEDGER,
  createInMemoryImplementationEvidenceStore,
  protectLedgerStoreWithImplementationEvidence,
} from "../src/index.js";

const EVIDENCE_COMMIT = "1".repeat(40);
const HISTORICAL_COMMIT = "2".repeat(40);
const MANIFEST_DIGEST = "3".repeat(64);
const WORKER_DISPATCH = { attestationId: "att_historical", generation: 1 } as const;
const REVIEWER = {
  alias: "native",
  harness: "codex",
  model: "frontier",
  provider: null,
  launch: "native",
  adapterId: "codex:native",
} as const;

function authority(
  historicalStatus: "planned" | "done",
  actionKey = "activate-implementation-evidence",
  historicalResultCommit = HISTORICAL_COMMIT,
) {
  return {
    goalRef: "goals:G176",
    finalizedManifestDigest: MANIFEST_DIGEST,
    mappings: {
      evidenceTaskRef: "tasks:T3000",
      historicalTaskRef: "tasks:T3001",
      activationTaskRef: "tasks:T3002",
    },
    evidenceTask: {
      taskRef: "tasks:T3000",
      status: "done",
      resultCommit: EVIDENCE_COMMIT,
      ready: false,
    },
    historicalTask: {
      taskRef: "tasks:T3001",
      status: historicalStatus,
      resultCommit: historicalStatus === "done" ? historicalResultCommit : null,
      ready: historicalStatus === "planned",
    },
    activationTask: {
      taskRef: "tasks:T3002",
      status: "planned",
      resultCommit: null,
      ready: historicalStatus === "done",
      actionKey,
    },
  };
}

function fixture(initialAuthority = authority("planned")) {
  let repositoryHead = EVIDENCE_COMMIT;
  let currentAuthority = initialAuthority;
  let materializations = 0;
  const store = createInMemoryImplementationEvidenceStore();
  const dependencies = {
    store,
    resolveReviewerRoster: () => [REVIEWER],
    nativeFallback: REVIEWER,
    prepareNativeReview: async ({ attemptRef }: { attemptRef: string }) => ({
      attestationId: `att_${attemptRef.slice(-12)}`,
      generation: 1,
      responseStoreNow: "2099-01-01T00:00:00.000Z",
      childCancelAt: "2099-01-01T00:01:00.000Z",
      launchDeadline: "2098-12-31T23:59:00.000Z",
      promptProvenance: {
        roleId: "implement-reviewer",
        version: 7,
        surface: "codex",
        promptDigest: "4".repeat(64),
        catalogHash: "5".repeat(64),
        inputDigest: "6".repeat(64),
      },
      inputCapability: { scope: "fetch-input", token: "input" },
      resultCapability: { scope: "store-result", token: "result" },
    }),
    fetchNativeReview: async (dispatch: { attestationId: string }) => ({
      state: "consumed",
      output: {
        taskId: "T3001",
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
          resultCommit: HISTORICAL_COMMIT,
          branchTip: HISTORICAL_COMMIT,
        },
        baseAncestry: {
          status: "verified",
          relation: "descendant",
          baseCommit: EVIDENCE_COMMIT,
          resultCommit: HISTORICAL_COMMIT,
          mergeBase: EVIDENCE_COMMIT,
        },
      },
      retainedAttestation: dispatch.attestationId,
    }),
    executeExternalReview: async () => {
      throw new Error("unused");
    },
    fetchWorker: async () => ({
      state: "consumed",
      input: { taskId: "T3001", baseCommit: EVIDENCE_COMMIT },
      output: {
        status: "pass",
        resultCommit: HISTORICAL_COMMIT,
        branch: "implement/T3001",
        actualWorktreePath: "/repo/.claude/worktrees/T3001",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit: EVIDENCE_COMMIT,
          headCommit: HISTORICAL_COMMIT,
        },
        gitReceipts: [{ oldHead: EVIDENCE_COMMIT, newHead: HISTORICAL_COMMIT }],
        filesTouched: ["historical.ts"],
        supervisedGateEvidence: { gateExitCode: 0, passCount: 1, failCount: 0 },
      },
    }),
    readTaskAuthority: async () => ({
      taskRef: "tasks:T3001",
      ownerGoalRef: "goals:G176",
      status: "wip",
      finalizedManifest: "manifest-v1\n",
    }),
    repositoryHead: async () => repositoryHead,
    verifyImplementation: async () => ({
      baseCommit: EVIDENCE_COMMIT,
      startingCommit: EVIDENCE_COMMIT,
      clean: true,
      ancestryVerified: true,
      receiptsVerified: true,
      acceptanceVerified: true,
      gateVerified: true,
      details: { cleanDiff: true, ffOnly: true },
    }),
    recordLedgerCompletion: async () => ({ reviewRef: "reviews:R3001" }),
    startupBuildCommit: EVIDENCE_COMMIT,
    implementationEvidenceProtocolVersion: 2,
    packagedManifestInventory: ["d347-implementation-evidence-activation-v1"],
    readBootstrapAuthority: async () => currentAuthority,
    materializeBootstrapActivationHandoff: async () => {
      materializations += 1;
      return {
        state: "created",
        actionRef: "operatorActions:OA3002",
        handoffRef: "handoffs:HO3002",
      };
    },
  } as never;
  const service = new ImplementationEvidenceService(dependencies);
  return {
    service,
    store,
    setRepositoryHead(value: string) {
      repositoryHead = value;
    },
    setAuthority(value: ReturnType<typeof authority>) {
      currentAuthority = value;
    },
    materializations: () => materializations,
    restart: () => new ImplementationEvidenceService(dependencies),
  };
}

type Fixture = ReturnType<typeof fixture>;

async function admitHistoricalTask(state: Fixture) {
  return await state.service.advanceEvidenceBootstrap({
    goalRef: "goals:G176",
    finalizedManifestDigest: MANIFEST_DIGEST,
    expectedRepositoryHead: EVIDENCE_COMMIT,
    expectedPhase: "historical-dispatch",
    operationId: "bootstrap-historical",
    author: "parent",
  });
}

async function recordProtectedHistoricalCompletion(state: Fixture): Promise<void> {
  const panel = await state.service.prepareReviewPanel({
    taskRef: "tasks:T3001",
    resultCommit: HISTORICAL_COMMIT,
    workerDispatch: WORKER_DISPATCH,
    operationId: "historical-panel",
    author: "parent",
  });
  const attemptRef = panel.attemptRefs[0]!;
  await state.service.prepareReviewAttempt({
    panelRef: panel.panelRef,
    attemptRef,
    operationId: "historical-attempt",
    author: "parent",
  });
  await state.service.finalizeReviewAttempt({
    attemptRef,
    operationId: "historical-finalize",
    author: "parent",
  });
  const completion = await state.service.prepareCompletion({
    taskRef: "tasks:T3001",
    expectedRepositoryHead: EVIDENCE_COMMIT,
    resultCommit: HISTORICAL_COMMIT,
    workerDispatch: WORKER_DISPATCH,
    reviewAttemptRefs: [attemptRef],
    completion: "implemented",
    logPaths: [],
    mergeOperationId: "historical-merge",
    operationId: "historical-completion",
    author: "parent",
  });
  await state.service.markMergeStarted(completion.completionRef, EVIDENCE_COMMIT);
  state.setRepositoryHead(HISTORICAL_COMMIT);
  await state.service.markMerged(completion.completionRef, HISTORICAL_COMMIT);
  state.setAuthority(authority("done"));
  await state.service.recordCompletion({
    taskRef: "tasks:T3001",
    expectedRepositoryHead: HISTORICAL_COMMIT,
    operationId: "historical-recording",
    author: "parent",
  });
}

describe("implementation evidence bootstrap [BG]", () => {
  test("admits only the fresh historical task and exact-replays one opaque reference", async () => {
    const { service } = fixture();
    const input = {
      goalRef: "goals:G176",
      finalizedManifestDigest: MANIFEST_DIGEST,
      expectedRepositoryHead: EVIDENCE_COMMIT,
      expectedPhase: "historical-dispatch" as const,
      operationId: "bootstrap-historical",
      author: "parent",
    };
    const first = await service.advanceEvidenceBootstrap(input);
    expect(first).toMatchObject({
      status: "admitted",
      taskRefs: ["tasks:T3001"],
      expectedServiceCommit: EVIDENCE_COMMIT,
    });
    expect(first.bootstrapRef).toMatch(/^cq-implementation-evidence-bootstrap:v1:[0-9a-f]{64}$/);
    expect(await service.advanceEvidenceBootstrap(input)).toEqual({ ...first, status: "existing" });
    await expect(
      service.advanceEvidenceBootstrap({ ...input, expectedRepositoryHead: HISTORICAL_COMMIT }),
    ).rejects.toThrow("operation_id");
  });

  test("activation handoff uses protected task authority without loading a packaged registry", async () => {
    const state = fixture();
    await admitHistoricalTask(state);
    await recordProtectedHistoricalCompletion(state);
    const input = {
      goalRef: "goals:G176",
      finalizedManifestDigest: MANIFEST_DIGEST,
      expectedRepositoryHead: HISTORICAL_COMMIT,
      expectedPhase: "activation-handoff" as const,
      operationId: "bootstrap-activation",
      author: "parent",
    };
    const first = await state.service.advanceEvidenceBootstrap(input);
    expect(first).toMatchObject({
      status: "operator-action-required",
      actionRef: "operatorActions:OA3002",
      handoffRef: "handoffs:HO3002",
      activationTaskRef: "tasks:T3002",
      expectedServiceCommit: HISTORICAL_COMMIT,
    });
    expect(state.materializations()).toBe(1);
    expect(await state.restart().advanceEvidenceBootstrap(input)).toEqual({
      ...first,
      status: "existing",
    });
    expect(state.materializations()).toBe(1);
  });

  test("bootstrap admission protects the historical task from generic terminal writes", async () => {
    const state = fixture();
    await admitHistoricalTask(state);
    const rawLedger = new InMemoryLedgerStore();
    await rawLedger.init();
    const milestone = await rawLedger.createMilestone({ title: "bootstrap protection" });
    await rawLedger.createItem(GOALS_LEDGER, milestone.id, {
      id: "G176",
      status: "building",
      fields: { title: "goal", description: "goal" },
    });
    await rawLedger.createItem(TASKS_LEDGER, milestone.id, {
      id: "T3001",
      status: "wip",
      fields: { headline: "historical evidence" },
    });
    const ledger = protectLedgerStoreWithImplementationEvidence(rawLedger, state.store);
    const attempts = await Promise.allSettled([
      ledger.updateItem(TASKS_LEDGER, "T3001", {
        status: "done",
        fields: { resultCommit: HISTORICAL_COMMIT, completion: "forged" },
      }),
      state.service.assertGenericTaskTerminalizationAllowed("tasks:T3001"),
    ]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        expect(String(attempt.reason)).toContain("protected implementation evidence");
      }
    }
    expect(rawLedger.fetchItem(TASKS_LEDGER, "T3001").status).toBe("wip");
  });

  test("activation handoff requires a distinct protected historical completion", async () => {
    const absent = fixture();
    await admitHistoricalTask(absent);
    absent.setAuthority(authority("done"));
    absent.setRepositoryHead(HISTORICAL_COMMIT);
    await expect(
      absent.service.advanceEvidenceBootstrap({
        goalRef: "goals:G176",
        finalizedManifestDigest: MANIFEST_DIGEST,
        expectedRepositoryHead: HISTORICAL_COMMIT,
        expectedPhase: "activation-handoff",
        operationId: "activation-without-completion",
        author: "parent",
      }),
    ).rejects.toThrow("protected completion");
    expect(absent.materializations()).toBe(0);

    const unchanged = fixture();
    await admitHistoricalTask(unchanged);
    unchanged.setAuthority(authority("done", "activate-implementation-evidence", EVIDENCE_COMMIT));
    await expect(
      unchanged.service.advanceEvidenceBootstrap({
        goalRef: "goals:G176",
        finalizedManifestDigest: MANIFEST_DIGEST,
        expectedRepositoryHead: EVIDENCE_COMMIT,
        expectedPhase: "activation-handoff",
        operationId: "activation-without-distinct-result",
        author: "parent",
      }),
    ).rejects.toThrow("distinct");
    expect(unchanged.materializations()).toBe(0);
  });

  test("rejects premature and obsolete activation envelopes before materialization", async () => {
    const premature = fixture();
    premature.setRepositoryHead(HISTORICAL_COMMIT);
    const input = {
      goalRef: "goals:G176",
      finalizedManifestDigest: MANIFEST_DIGEST,
      expectedRepositoryHead: HISTORICAL_COMMIT,
      expectedPhase: "activation-handoff" as const,
      operationId: "premature",
      author: "parent",
    };
    await expect(premature.service.advanceEvidenceBootstrap(input)).rejects.toThrow("historical");
    expect(premature.materializations()).toBe(0);

    const obsolete = fixture(authority("done", "activate-evidence-implementation"));
    obsolete.setRepositoryHead(HISTORICAL_COMMIT);
    await expect(
      obsolete.service.advanceEvidenceBootstrap({ ...input, operationId: "obsolete" }),
    ).rejects.toThrow("activate-implementation-evidence");
    expect(obsolete.materializations()).toBe(0);
  });
});
