import { describe, expect, test } from "bun:test";
import { IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND } from "@cq/config";
import {
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
  implementationAuditManifestDigest,
  implementationAuditManifestSemanticDigest,
  type ImplementationCompletionRecord,
  type ImplementationEvidenceActivationContinuationRecord,
  type ImplementationEvidenceSnapshot,
  type PackagedImplementationAuditManifest,
} from "../src/index.js";

const FROM_HEAD = "a".repeat(40);
const REPOSITORY_HEAD = "b".repeat(40);
const MANIFEST_ID = "d347-implementation-evidence-activation-v2";
const PRIOR_REQUIREMENT_REF =
  `cq-implementation-evidence-activation-requirement:v1:${"1".repeat(64)}`;
const PRIOR_ACTIVATION_REF = `cq-implementation-evidence-activation:v1:${"2".repeat(64)}`;
const COMPLETION_REF = `cq-implementation-completion:v1:${"3".repeat(64)}`;
const AUDIT_REFS = [
  `cq-implementation-audit:v1:${"4".repeat(64)}`,
  `cq-implementation-audit:v1:${"5".repeat(64)}`,
] as const;
const COHORT = ["tasks:T3000", "tasks:T3001"] as const;
const COMPLETED_TASK_REF = "tasks:T3003";

const manifest: PackagedImplementationAuditManifest = {
  version: 1,
  manifestId: MANIFEST_ID,
  sourceDigest: "6".repeat(64),
  records: COHORT.map((taskRef, index) => ({
    recordKey: `${MANIFEST_ID}:${taskRef.slice("tasks:".length)}`,
    taskRef,
    ownerGoalRef: "goals:G176",
    finalizedManifest: "finalized-v2\n",
    historicalReview: null,
    baseCommit: (index === 0 ? "7" : "8").repeat(40),
    resultCommit: (index === 0 ? "9" : "d").repeat(40),
    repositoryHead: FROM_HEAD,
    diff: `diff-${taskRef}`,
    acceptance: { text: "accepted" },
    gateObservations: { gate: "green" },
    requiredObservations: ["task-authority"],
  })),
  activation: {
    goalRef: "goals:G176",
    finalizedManifestDigest: "c".repeat(64),
    evidenceTaskKey: "t-evidence",
    auditTaskKey: "t-historical-evidence",
    activationTaskKey: "t-activate-evidence",
  },
};

function receipt() {
  return {
    kind: "cq-git-change-receipt",
    version: 1,
    attestationId: `att_${"r".repeat(32)}`,
    generation: 1,
    taskId: "T3003",
    operationId: "commit-t3003",
    requestDigest: "d".repeat(64),
    oldHead: FROM_HEAD,
    newHead: REPOSITORY_HEAD,
    tree: "e".repeat(40),
    objectOids: ["e".repeat(40), REPOSITORY_HEAD],
    paths: ["feature.ts"],
    committedAt: "2026-08-29T20:00:00.000Z",
  } as const;
}

function workerResult() {
  return {
    taskId: "T3003",
    status: "pass",
    resultCommit: REPOSITORY_HEAD,
    branch: "implement/T3003",
    actualWorktreePath: "/repo/.claude/worktrees/T3003",
    filesTouched: ["feature.ts"],
    gitReceipts: [receipt()],
    checkSummary: "trusted gate delegated to result storage",
    baseVerification: {
      status: "verified",
      relation: "descendant",
      baseCommit: FROM_HEAD,
      headCommit: REPOSITORY_HEAD,
    },
    supervisedGateEvidence: {
      kind: "cq-supervised-gate-evidence",
      version: 1,
      attestationId: `att_${"r".repeat(32)}`,
      generation: 1,
      roleId: "implement-worker",
      roleVersion: 10,
      surface: "codex",
      promptDigest: "1".repeat(64),
      catalogHash: "2".repeat(64),
      inputDigest: "3".repeat(64),
      taskId: "T3003",
      worktreePath: "/repo/.claude/worktrees/T3003",
      branch: "implement/T3003",
      baseCommit: FROM_HEAD,
      startingCommit: FROM_HEAD,
      resultCommit: REPOSITORY_HEAD,
      clean: true,
      command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
      gateExitCode: 0,
      passCount: 31,
      failCount: 0,
      gateDurationMs: 120,
      capturedAt: "2026-08-29T20:00:01.000Z",
      filesTouchedDigest: "4".repeat(64),
      gitReceiptsDigest: "5".repeat(64),
      mutationTableDigest: "6".repeat(64),
    },
    summary: "implemented",
  };
}

function snapshot(): ImplementationEvidenceSnapshot {
  const manifestDigest = implementationAuditManifestDigest(manifest);
  const completion = {
    version: 1 as const,
    completionRef: COMPLETION_REF,
    taskRef: COMPLETED_TASK_REF,
    ownerGoalRef: "goals:G176",
    resultCommit: REPOSITORY_HEAD,
    repositoryHead: FROM_HEAD,
    baseCommit: FROM_HEAD,
    startingCommit: FROM_HEAD,
    workerDispatch: { attestationId: `att_${"r".repeat(32)}`, generation: 1 },
    workerResult: workerResult(),
    reviewAttemptRefs: [`cq-implementation-review-attempt:v1:${"7".repeat(64)}`],
    completion: "implemented T3003",
    logPaths: [".cq/logs/T3003.md"],
    finalizedManifest: "finalized-v2\n",
    verification: { ffOnly: true },
    mergeOperationId: "merge-t3003",
    evidenceFingerprint: "8".repeat(64),
    supersedesCompletionRef: null,
    state: "recorded" as const,
    reviewRef: "reviews:R3003",
    operationId: "prepare-t3003",
    requestDigest: "9".repeat(64),
    author: "parent",
    session: null,
    preparedAt: "2026-08-29T19:59:00.000Z",
    mergeStartedAt: "2026-08-29T20:00:00.000Z",
    mergedAt: "2026-08-29T20:00:01.000Z",
    recordedAt: "2026-08-29T20:00:02.000Z",
    recordOperationId: "record-t3003",
  };
  return {
    version: 1,
    panels: {},
    attempts: {},
    completions: { [COMPLETION_REF]: completion },
    auditPanels: {},
    auditAttempts: {},
    implementationAudits: Object.fromEntries(
      AUDIT_REFS.map((auditRef, index) => [
        auditRef,
        {
          version: 1,
          auditRef,
          manifestId: MANIFEST_ID,
          manifestDigest,
          recordKey: manifest.records[index]!.recordKey,
          taskRef: COHORT[index]!,
          ownerGoalRef: "goals:G176",
          finalizedManifest: "finalized-v2\n",
          historicalReview: null,
          baseCommit: manifest.records[index]!.baseCommit,
          resultCommit: manifest.records[index]!.resultCommit,
          repositoryHead: FROM_HEAD,
          sourceDigest: manifest.sourceDigest,
          evidenceFingerprint: String(index + 1).repeat(64),
          attemptRefs: [],
          terminalState: "approved",
          author: "parent",
          session: null,
          appliedAt: "2026-08-29T19:00:00.000Z",
        },
      ]),
    ),
    auditManifestApplications: {},
    activationRequirements: {
      [PRIOR_REQUIREMENT_REF]: {
        version: 1,
        requirementRef: PRIOR_REQUIREMENT_REF,
        manifestId: MANIFEST_ID,
        manifestDigest,
        sourceDigest: manifest.sourceDigest,
        semanticManifestDigest: implementationAuditManifestSemanticDigest(manifest),
        goalRef: "goals:G176",
        finalizedManifestDigest: manifest.activation!.finalizedManifestDigest,
        evidenceTaskRef: COHORT[0],
        auditTaskRef: COHORT[1],
        activationTaskRef: "tasks:T3002",
        boundaryCommit: FROM_HEAD,
        taskRefs: COHORT,
        state: "fulfilled",
        activationRef: PRIOR_ACTIVATION_REF,
        previousRequirementRef: null,
        continuationRef: null,
        operationId: "arm-v2",
        requestDigest: "a".repeat(64),
        author: "parent",
        session: null,
        armedAt: "2026-08-29T18:00:00.000Z",
        fulfilledAt: "2026-08-29T19:00:00.000Z",
      },
    },
    activations: {
      [PRIOR_ACTIVATION_REF]: {
        version: 1,
        activationRef: PRIOR_ACTIVATION_REF,
        requirementRef: PRIOR_REQUIREMENT_REF,
        manifestId: MANIFEST_ID,
        manifestDigest,
        repositoryHead: FROM_HEAD,
        evidenceFingerprint: "b".repeat(64),
        auditRefs: AUDIT_REFS,
        taskRefs: COHORT,
        author: "parent",
        session: null,
        activatedAt: "2026-08-29T19:00:00.000Z",
      },
    },
    activationContinuations: {},
    bootstraps: {},
  };
}

function fixture(initial = snapshot()) {
  const store = createInMemoryImplementationEvidenceStore(initial);
  const dependencies = {
    store,
    resolveReviewerRoster: () => [{
      alias: "native",
      harness: "codex",
      model: "frontier",
      provider: null,
      launch: "native",
      adapterId: "codex:native",
    }],
    nativeFallback: {
      alias: "native",
      harness: "codex",
      model: "frontier",
      provider: null,
      launch: "native",
      adapterId: "codex:native",
    },
    prepareNativeReview: async () => { throw new Error("unused"); },
    fetchNativeReview: async () => { throw new Error("unused"); },
    executeExternalReview: async () => { throw new Error("unused"); },
    fetchWorker: async () => { throw new Error("unused"); },
    readTaskAuthority: async () => ({
      taskRef: COMPLETED_TASK_REF,
      ownerGoalRef: "goals:G176",
      status: "done",
      finalizedManifest: "finalized-v2\n",
    }),
    repositoryHead: async () => REPOSITORY_HEAD,
    verifyImplementation: async () => { throw new Error("unused"); },
    recordLedgerCompletion: async () => { throw new Error("unused"); },
    readAuditManifest: async () => manifest,
    resolveActivationCohort: async () => ({
      finalizedManifestDigest: manifest.activation!.finalizedManifestDigest,
      evidenceTaskRef: COHORT[0],
      auditTaskRef: COHORT[1],
      activationTaskRef: "tasks:T3002",
      boundaryCommit: REPOSITORY_HEAD,
      taskRefs: [...COHORT, COMPLETED_TASK_REF],
    }),
    isCommitRetained: async () => true,
    readCompletionReview: async () => ({
      reviewRef: "reviews:R3003",
      status: "go-ahead",
      implementationEvidence: JSON.stringify({
        version: 1,
        completionRef: COMPLETION_REF,
        taskRef: COMPLETED_TASK_REF,
        resultCommit: REPOSITORY_HEAD,
        evidenceFingerprint: "8".repeat(64),
        reviewAttemptRefs: [`cq-implementation-review-attempt:v1:${"7".repeat(64)}`],
      }),
    }),
  } as never;
  const service = new ImplementationEvidenceService(dependencies);
  return {
    service,
    store,
    restart: () => new ImplementationEvidenceService(dependencies),
  };
}

type MutableSnapshot = ImplementationEvidenceSnapshot & {
  completions: Record<string, ImplementationCompletionRecord>;
  activationContinuations: Record<string, ImplementationEvidenceActivationContinuationRecord>;
};

function mutableSnapshot(): MutableSnapshot {
  return structuredClone(snapshot()) as MutableSnapshot;
}

const request = {
  goalRef: "goals:G176",
  manifestId: MANIFEST_ID,
  priorRequirementRef: PRIOR_REQUIREMENT_REF,
  completedTaskRef: COMPLETED_TASK_REF,
  completionRef: COMPLETION_REF,
  expectedFromHead: FROM_HEAD,
  expectedRepositoryHead: REPOSITORY_HEAD,
  operationId: "continue-after-t3003",
  author: "parent",
} as const;

describe("implementation evidence activation continuation [BG]", () => {
  test("appends and restart-replays one fulfilled requirement at the protected merged head", async () => {
    const state = fixture();
    const first = await state.service.continueEvidenceActivation(request);
    expect(first).toMatchObject({
      status: "continued",
      previousRequirementRef: PRIOR_REQUIREMENT_REF,
      taskRef: COMPLETED_TASK_REF,
      completionRef: COMPLETION_REF,
      fromHead: FROM_HEAD,
      repositoryHead: REPOSITORY_HEAD,
    });
    expect(first.requirementRef).not.toBe(PRIOR_REQUIREMENT_REF);
    expect(await state.restart().continueEvidenceActivation(request)).toEqual({
      ...first,
      status: "existing",
    });
    expect((await state.store.snapshot()).activationRequirements[PRIOR_REQUIREMENT_REF]).toBeDefined();
  });

  test("fences replay to the full request", async () => {
    const { service } = fixture();
    await service.continueEvidenceActivation(request);
    await expect(
      service.continueEvidenceActivation({ ...request, completedTaskRef: "tasks:T3004" }),
    ).rejects.toThrow("operation_id");
  });

  test("rejects a head skip, an unobserved gate, and completion reuse", async () => {
    const skipped = mutableSnapshot();
    skipped.completions[COMPLETION_REF] = {
      ...skipped.completions[COMPLETION_REF]!,
      repositoryHead: "0".repeat(40),
    };
    await expect(fixture(skipped).service.continueEvidenceActivation(request)).rejects.toThrow(
      "prior activation head",
    );

    const ungated = mutableSnapshot();
    const { supervisedGateEvidence: _gate, ...workerWithoutGate } = workerResult();
    ungated.completions[COMPLETION_REF] = {
      ...ungated.completions[COMPLETION_REF]!,
      workerResult: workerWithoutGate,
    };
    await expect(fixture(ungated).service.continueEvidenceActivation(request)).rejects.toThrow(
      "runner-owned green gate",
    );

    const reused = mutableSnapshot();
    reused.activationContinuations = {
      [`cq-implementation-evidence-activation-continuation:v1:${"f".repeat(64)}`]: {
        version: 1,
        continuationRef: `cq-implementation-evidence-activation-continuation:v1:${"f".repeat(64)}`,
        previousContinuationRef: null,
        previousRequirementRef: PRIOR_REQUIREMENT_REF,
        requirementRef: `cq-implementation-evidence-activation-requirement:v1:${"e".repeat(64)}`,
        activationRef: `cq-implementation-evidence-activation:v1:${"d".repeat(64)}`,
        taskRef: "tasks:T2999",
        completionRef: COMPLETION_REF,
        fromHead: "0".repeat(40),
        repositoryHead: FROM_HEAD,
        operationId: "prior-continuation",
        requestDigest: "c".repeat(64),
        author: "parent",
        session: null,
        continuedAt: "2026-08-29T17:00:00.000Z",
      },
    };
    await expect(fixture(reused).service.continueEvidenceActivation(request)).rejects.toThrow(
      "completion is already bound",
    );
  });
});
