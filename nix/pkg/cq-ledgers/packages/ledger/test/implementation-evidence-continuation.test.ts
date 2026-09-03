import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND } from "@cq/config";
import {
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
  implementationAuditManifestDigest,
  implementationAuditManifestSemanticDigest,
  type ImplementationCompletionRecord,
  type ImplementationAuditRecord,
  type ImplementationEvidenceActivationContinuationRecord,
  type ImplementationEvidenceActivationRecord,
  type ImplementationEvidenceActivationRequirementRecord,
  type ImplementationEvidenceSnapshot,
  type PackagedImplementationAuditRecord,
  type PackagedImplementationAuditManifest,
} from "../src/index.js";

const FROM_HEAD = "a".repeat(40);
const CORRECTION_START = "e".repeat(40);
const REPOSITORY_HEAD = "b".repeat(40);
const SECOND_REPOSITORY_HEAD = "f".repeat(40);
const MANIFEST_ID = "d347-implementation-evidence-activation-v2";
const PRIOR_REQUIREMENT_REF = `cq-implementation-evidence-activation-requirement:v1:${"1".repeat(64)}`;
const PRIOR_ACTIVATION_REF = `cq-implementation-evidence-activation:v1:${"2".repeat(64)}`;
const COMPLETION_REF = `cq-implementation-completion:v1:${"3".repeat(64)}`;
const SECOND_COMPLETION_REF = `cq-implementation-completion:v1:${"4".repeat(64)}`;
const COHORT = ["tasks:T3000", "tasks:T3001"] as const;
const COMPLETED_TASK_REF = "tasks:T3003";
const SECOND_COMPLETED_TASK_REF = "tasks:T3004";

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function evidenceDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

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

function manifestAt(
  repositoryHead: string,
  sourceDigest: string,
): PackagedImplementationAuditManifest {
  return {
    ...manifest,
    sourceDigest,
    records: manifest.records.map((record) => ({ ...record, repositoryHead })),
  };
}

function implementationAuditRef(record: PackagedImplementationAuditRecord): string {
  return `cq-implementation-audit:v1:${evidenceDigest({
    manifestId: MANIFEST_ID,
    manifestDigest: implementationAuditManifestDigest(manifest),
    sourceDigest: manifest.sourceDigest,
    record,
    attemptRefs: [],
  })}`;
}

function implementationAuditEvidenceFingerprint(record: PackagedImplementationAuditRecord): string {
  return evidenceDigest({
    record,
    attemptRefs: [],
    manifestDigest: implementationAuditManifestDigest(manifest),
  });
}

const AUDIT_REFS = [
  implementationAuditRef(manifest.records[0]!),
  implementationAuditRef(manifest.records[1]!),
] as const;

function activationEvidenceFingerprint(): string {
  return evidenceDigest({
    manifestId: MANIFEST_ID,
    manifestDigest: implementationAuditManifestDigest(manifest),
    sourceDigest: manifest.sourceDigest,
    repositoryHead: FROM_HEAD,
    auditRefs: AUDIT_REFS,
    taskRefs: COHORT,
  });
}

function receipt(oldHead: string, newHead: string, operationId: string, taskId: string) {
  return {
    kind: "cq-git-change-receipt",
    version: 1,
    attestationId: `att_${"r".repeat(32)}`,
    generation: 1,
    taskId,
    operationId,
    requestDigest: "d".repeat(64),
    oldHead,
    newHead,
    tree: "e".repeat(40),
    objectOids: ["e".repeat(40), newHead],
    paths: ["feature.ts"],
    committedAt: "2026-08-29T20:00:00.000Z",
  } as const;
}

function workerResultAt(
  startingCommit: string,
  gitReceipts: readonly ReturnType<typeof receipt>[],
) {
  return {
    taskId: "T3003",
    status: "pass",
    resultCommit: REPOSITORY_HEAD,
    branch: "implement/T3003",
    actualWorktreePath: "/repo/.claude/worktrees/T3003",
    filesTouched: ["feature.ts"],
    gitReceipts,
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
      startingCommit,
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

function workerResult() {
  return workerResultAt(FROM_HEAD, [receipt(FROM_HEAD, REPOSITORY_HEAD, "commit-t3003", "T3003")]);
}

function guardedExactTipWorkerResult() {
  return {
    ...workerResultAt(REPOSITORY_HEAD, []),
    gitLineage: {
      kind: "guarded-rebase",
      guardedRebase: `cq-guarded-rebase:v1:${"a".repeat(64)}`,
      ontoCommit: FROM_HEAD,
      rebasedStartCommit: REPOSITORY_HEAD,
      exactTip: true,
    },
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
          evidenceFingerprint: implementationAuditEvidenceFingerprint(manifest.records[index]!),
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
        evidenceFingerprint: activationEvidenceFingerprint(),
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

function fixture(
  initial = snapshot(),
  faultInjector?: (boundary: string) => Promise<void>,
  isCommitRetained: (input: {
    repositoryHead: string;
    resultCommit: string;
  }) => Promise<boolean> = async () => true,
  taskAuthority: {
    readonly ownerGoalRef: string;
    readonly finalizedManifest: string;
    readonly activationTaskRefs: readonly string[];
  } = {
    ownerGoalRef: "goals:G176",
    finalizedManifest: "finalized-v2\n",
    activationTaskRefs: [...COHORT, COMPLETED_TASK_REF],
  },
) {
  const store = createInMemoryImplementationEvidenceStore(initial);
  const dependencies = {
    store,
    resolveReviewerRoster: () => [
      {
        alias: "native",
        harness: "codex",
        model: "frontier",
        provider: null,
        launch: "native",
        adapterId: "codex:native",
      },
    ],
    nativeFallback: {
      alias: "native",
      harness: "codex",
      model: "frontier",
      provider: null,
      launch: "native",
      adapterId: "codex:native",
    },
    prepareNativeReview: async () => {
      throw new Error("unused");
    },
    fetchNativeReview: async () => {
      throw new Error("unused");
    },
    executeExternalReview: async () => {
      throw new Error("unused");
    },
    fetchWorker: async () => {
      throw new Error("unused");
    },
    readTaskAuthority: async (taskRef: string) =>
      COHORT.includes(taskRef as (typeof COHORT)[number])
        ? {
            taskRef,
            ownerGoalRef: "goals:G176",
            status: "done",
            finalizedManifest: "finalized-v2\n",
          }
        : {
            taskRef,
            ownerGoalRef: taskAuthority.ownerGoalRef,
            status: "done",
            finalizedManifest: taskAuthority.finalizedManifest,
          },
    repositoryHead: async () => REPOSITORY_HEAD,
    verifyImplementation: async () => {
      throw new Error("unused");
    },
    recordLedgerCompletion: async () => {
      throw new Error("unused");
    },
    readAuditManifest: async () => manifest,
    resolveActivationCohort: async () => ({
      finalizedManifestDigest: manifest.activation!.finalizedManifestDigest,
      evidenceTaskRef: COHORT[0],
      auditTaskRef: COHORT[1],
      activationTaskRef: "tasks:T3002",
      boundaryCommit: REPOSITORY_HEAD,
      taskRefs: taskAuthority.activationTaskRefs,
    }),
    isCommitRetained,
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
    faultInjector,
  } as never;
  const service = new ImplementationEvidenceService(dependencies);
  return {
    service,
    store,
    restart: () => new ImplementationEvidenceService(dependencies),
  };
}

function fixtureAt(
  initial: ImplementationEvidenceSnapshot,
  currentManifest: PackagedImplementationAuditManifest,
  currentRepositoryHead: string,
  _currentCompletedTaskRef: string,
  currentTaskRefs: readonly string[],
) {
  const store = createInMemoryImplementationEvidenceStore(initial);
  const dependencies = {
    store,
    resolveReviewerRoster: () => [
      {
        alias: "native",
        harness: "codex",
        model: "frontier",
        provider: null,
        launch: "native",
        adapterId: "codex:native",
      },
    ],
    nativeFallback: {
      alias: "native",
      harness: "codex",
      model: "frontier",
      provider: null,
      launch: "native",
      adapterId: "codex:native",
    },
    prepareNativeReview: async () => {
      throw new Error("unused");
    },
    fetchNativeReview: async () => {
      throw new Error("unused");
    },
    executeExternalReview: async () => {
      throw new Error("unused");
    },
    fetchWorker: async () => {
      throw new Error("unused");
    },
    readTaskAuthority: async (taskRef: string) => {
      if (COHORT.includes(taskRef as (typeof COHORT)[number]))
        return {
          taskRef,
          ownerGoalRef: "goals:G176",
          status: "done",
          finalizedManifest: "finalized-v2\n",
        };
      const completion = Object.values(initial.completions).find(
        (candidate) => candidate.taskRef === taskRef,
      );
      if (completion === undefined)
        throw new Error(`test task authority is absent for ${taskRef}`);
      return {
        taskRef,
        ownerGoalRef: completion.ownerGoalRef,
        status: "done",
        finalizedManifest: completion.finalizedManifest,
      };
    },
    repositoryHead: async () => currentRepositoryHead,
    verifyImplementation: async () => {
      throw new Error("unused");
    },
    recordLedgerCompletion: async () => {
      throw new Error("unused");
    },
    readAuditManifest: async () => currentManifest,
    resolveActivationCohort: async () => ({
      finalizedManifestDigest: currentManifest.activation!.finalizedManifestDigest,
      evidenceTaskRef: COHORT[0],
      auditTaskRef: COHORT[1],
      activationTaskRef: "tasks:T3002",
      boundaryCommit: currentRepositoryHead,
      taskRefs: currentTaskRefs,
    }),
    isCommitRetained: async () => true,
    readCompletionReview: async (reviewRef: string) => {
      const matches = Object.values(initial.completions).filter(
        (completion) => completion.reviewRef === reviewRef,
      );
      if (matches.length !== 1) throw new Error("test completion review is ambiguous");
      const completion = matches[0]!;
      return {
        reviewRef,
        status: "go-ahead" as const,
        implementationEvidence: JSON.stringify({
          version: 1,
          completionRef: completion.completionRef,
          taskRef: completion.taskRef,
          resultCommit: completion.resultCommit,
          evidenceFingerprint: completion.evidenceFingerprint,
          reviewAttemptRefs: completion.reviewAttemptRefs,
        }),
      };
    },
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
  implementationAudits: Record<string, ImplementationAuditRecord>;
  activations: Record<string, ImplementationEvidenceActivationRecord>;
  activationRequirements: Record<string, ImplementationEvidenceActivationRequirementRecord>;
  activationContinuations: Record<string, ImplementationEvidenceActivationContinuationRecord>;
};

function mutableSnapshot(): MutableSnapshot {
  return structuredClone(snapshot()) as MutableSnapshot;
}

const CROSS_GOAL_TASK_AUTHORITY = {
  ownerGoalRef: "goals:G183",
  finalizedManifest: "g183-finalized\n",
  activationTaskRefs: COHORT,
} as const;

function crossGoalSnapshot(): MutableSnapshot {
  const initial = mutableSnapshot();
  initial.completions[COMPLETION_REF] = {
    ...initial.completions[COMPLETION_REF]!,
    ownerGoalRef: CROSS_GOAL_TASK_AUTHORITY.ownerGoalRef,
    finalizedManifest: CROSS_GOAL_TASK_AUTHORITY.finalizedManifest,
    startingCommit: REPOSITORY_HEAD,
    workerResult: guardedExactTipWorkerResult(),
  };
  return initial;
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
    expect(
      (await state.store.snapshot()).activationRequirements[PRIOR_REQUIREMENT_REF],
    ).toBeDefined();
  });

  // regression: D441 — the global activation must advance through another goal's guarded exact tip.
  test("continues global authority through a cross-goal guarded exact-tip completion", async () => {
    const state = fixture(
      crossGoalSnapshot(),
      undefined,
      async () => true,
      CROSS_GOAL_TASK_AUTHORITY,
    );

    let continued;
    try {
      continued = await state.service.continueEvidenceActivation(request);
    } catch (error) {
      throw new Error(`D441 reproduction rejected: ${String(error)}`);
    }
    expect(continued).toMatchObject({
      status: "continued",
      taskRef: COMPLETED_TASK_REF,
      fromHead: FROM_HEAD,
      repositoryHead: REPOSITORY_HEAD,
    });
  });

  test("rejects cross-goal authority and guarded-lineage substitutions", async () => {
    const mismatchedOwner = crossGoalSnapshot();
    mismatchedOwner.completions[COMPLETION_REF] = {
      ...mismatchedOwner.completions[COMPLETION_REF]!,
      ownerGoalRef: "goals:G199",
    };
    await expect(
      fixture(
        mismatchedOwner,
        undefined,
        async () => true,
        CROSS_GOAL_TASK_AUTHORITY,
      ).service.continueEvidenceActivation(request),
    ).rejects.toThrow("protected completion does not bind the prior activation head transition");

    const mismatchedManifest = crossGoalSnapshot();
    mismatchedManifest.completions[COMPLETION_REF] = {
      ...mismatchedManifest.completions[COMPLETION_REF]!,
      finalizedManifest: "substituted-finalized-manifest\n",
    };
    await expect(
      fixture(
        mismatchedManifest,
        undefined,
        async () => true,
        CROSS_GOAL_TASK_AUTHORITY,
      ).service.continueEvidenceActivation(request),
    ).rejects.toThrow("protected completion does not bind the prior activation head transition");

    const substitutedLineage = crossGoalSnapshot();
    const guarded = guardedExactTipWorkerResult();
    substitutedLineage.completions[COMPLETION_REF] = {
      ...substitutedLineage.completions[COMPLETION_REF]!,
      workerResult: {
        ...guarded,
        gitLineage: { ...guarded.gitLineage, ontoCommit: "0".repeat(40) },
      },
    };
    await expect(
      fixture(
        substitutedLineage,
        undefined,
        async () => true,
        CROSS_GOAL_TASK_AUTHORITY,
      ).service.continueEvidenceActivation(request),
    ).rejects.toThrow("protected completion guarded lineage is invalid");

    const missingLineage = crossGoalSnapshot();
    missingLineage.completions[COMPLETION_REF] = {
      ...missingLineage.completions[COMPLETION_REF]!,
      workerResult: workerResultAt(REPOSITORY_HEAD, []),
    };
    await expect(
      fixture(
        missingLineage,
        undefined,
        async () => true,
        CROSS_GOAL_TASK_AUTHORITY,
      ).service.continueEvidenceActivation(request),
    ).rejects.toThrow("protected completion lacks a result receipt chain");
  });

  // regression: round 6 rejected a second distinct protected completion after the first append.
  test("extends cumulative authority through two sequential protected completions", async () => {
    const firstManifest = manifestAt(REPOSITORY_HEAD, "5".repeat(64));
    const firstState = fixtureAt(snapshot(), firstManifest, REPOSITORY_HEAD, COMPLETED_TASK_REF, [
      ...COHORT,
      COMPLETED_TASK_REF,
    ]);
    const first = await firstState.service.continueEvidenceActivation(request);
    expect(
      await firstState.service.evidenceActivationStatus({
        goalRef: "goals:G176",
        manifestId: MANIFEST_ID,
        expectedRepositoryHead: REPOSITORY_HEAD,
      }),
    ).toMatchObject({
      status: "active",
      requirementRef: first.requirementRef,
      repositoryHead: REPOSITORY_HEAD,
      taskRefs: [...COHORT, COMPLETED_TASK_REF],
    });

    const secondInitial = structuredClone(await firstState.store.snapshot()) as MutableSnapshot;
    const priorCompletion = secondInitial.completions[COMPLETION_REF]!;
    const secondWorkerResult = {
      ...workerResultAt(REPOSITORY_HEAD, [
        receipt(REPOSITORY_HEAD, SECOND_REPOSITORY_HEAD, "commit-t3004", "T3004"),
      ]),
      taskId: "T3004",
      resultCommit: SECOND_REPOSITORY_HEAD,
      branch: "implement/T3004",
      baseVerification: {
        status: "verified" as const,
        relation: "descendant" as const,
        baseCommit: REPOSITORY_HEAD,
        headCommit: SECOND_REPOSITORY_HEAD,
      },
      supervisedGateEvidence: {
        ...workerResultAt(REPOSITORY_HEAD, []).supervisedGateEvidence,
        taskId: "T3004",
        branch: "implement/T3004",
        baseCommit: REPOSITORY_HEAD,
        startingCommit: REPOSITORY_HEAD,
        resultCommit: SECOND_REPOSITORY_HEAD,
      },
    };
    secondInitial.completions[SECOND_COMPLETION_REF] = {
      ...priorCompletion,
      completionRef: SECOND_COMPLETION_REF,
      taskRef: SECOND_COMPLETED_TASK_REF,
      resultCommit: SECOND_REPOSITORY_HEAD,
      repositoryHead: REPOSITORY_HEAD,
      baseCommit: REPOSITORY_HEAD,
      startingCommit: REPOSITORY_HEAD,
      workerResult: secondWorkerResult,
      reviewAttemptRefs: [`cq-implementation-review-attempt:v1:${"6".repeat(64)}`],
      completion: "implemented T3004",
      logPaths: [".cq/logs/T3004.md"],
      evidenceFingerprint: "9".repeat(64),
      reviewRef: "reviews:R3004",
      operationId: "prepare-t3004",
      requestDigest: "0".repeat(64),
      mergeOperationId: "merge-t3004",
      recordOperationId: "record-t3004",
    };
    const secondManifest = manifestAt(SECOND_REPOSITORY_HEAD, "4".repeat(64));
    const secondRequest = {
      ...request,
      priorRequirementRef: first.requirementRef,
      completedTaskRef: SECOND_COMPLETED_TASK_REF,
      completionRef: SECOND_COMPLETION_REF,
      expectedFromHead: REPOSITORY_HEAD,
      expectedRepositoryHead: SECOND_REPOSITORY_HEAD,
      operationId: "continue-after-t3004",
    };
    const secondTaskRefs = [...COHORT, COMPLETED_TASK_REF, SECOND_COMPLETED_TASK_REF];
    const continueSecond = (initial: ImplementationEvidenceSnapshot) =>
      fixtureAt(
        initial,
        secondManifest,
        SECOND_REPOSITORY_HEAD,
        SECOND_COMPLETED_TASK_REF,
        secondTaskRefs,
      ).service.continueEvidenceActivation(secondRequest);
    const tampered = structuredClone(secondInitial) as MutableSnapshot;
    tampered.activations[first.activationRef] = {
      ...tampered.activations[first.activationRef]!,
      evidenceFingerprint: "f".repeat(64),
    };
    await expect(continueSecond(tampered)).rejects.toThrow(
      "prior v2 activation evidence fingerprint is inconsistent",
    );

    const brokenLink = structuredClone(secondInitial) as MutableSnapshot;
    brokenLink.activationContinuations[first.continuationRef] = {
      ...brokenLink.activationContinuations[first.continuationRef]!,
      previousContinuationRef: `cq-implementation-evidence-activation-continuation:v1:${"0".repeat(64)}`,
    };
    await expect(continueSecond(brokenLink)).rejects.toThrow(
      "prior v2 activation continuation chain is malformed",
    );

    const brokenTaskChain = structuredClone(secondInitial) as MutableSnapshot;
    const forgedTaskRefs = [...COHORT, "tasks:T3999"];
    brokenTaskChain.activationRequirements[first.requirementRef] = {
      ...brokenTaskChain.activationRequirements[first.requirementRef]!,
      taskRefs: forgedTaskRefs,
    };
    const firstActivation = brokenTaskChain.activations[first.activationRef]!;
    brokenTaskChain.activations[first.activationRef] = {
      ...firstActivation,
      taskRefs: forgedTaskRefs,
      evidenceFingerprint: evidenceDigest({
        manifestId: MANIFEST_ID,
        manifestDigest: implementationAuditManifestDigest(firstManifest),
        sourceDigest: firstManifest.sourceDigest,
        repositoryHead: REPOSITORY_HEAD,
        auditRefs: firstActivation.auditRefs,
        taskRefs: forgedTaskRefs,
      }),
    };
    await expect(continueSecond(brokenTaskChain)).rejects.toThrow(
      "prior v2 activation continuation task chain is malformed",
    );

    const changedSemantics = structuredClone(secondInitial) as MutableSnapshot;
    changedSemantics.activationRequirements[first.requirementRef] = {
      ...changedSemantics.activationRequirements[first.requirementRef]!,
      activationTaskRef: "tasks:T3999",
    };
    await expect(continueSecond(changedSemantics)).rejects.toThrow(
      "prior v2 activation continuation semantics changed",
    );

    const changedManifestBinding = structuredClone(secondInitial) as MutableSnapshot;
    const changedSourceDigest = "0".repeat(64);
    changedManifestBinding.activationRequirements[first.requirementRef] = {
      ...changedManifestBinding.activationRequirements[first.requirementRef]!,
      sourceDigest: changedSourceDigest,
    };
    const changedManifestActivation = changedManifestBinding.activations[first.activationRef]!;
    changedManifestBinding.activations[first.activationRef] = {
      ...changedManifestActivation,
      evidenceFingerprint: evidenceDigest({
        manifestId: MANIFEST_ID,
        manifestDigest: changedManifestActivation.manifestDigest,
        sourceDigest: changedSourceDigest,
        repositoryHead: REPOSITORY_HEAD,
        auditRefs: changedManifestActivation.auditRefs,
        taskRefs: changedManifestActivation.taskRefs,
      }),
    };
    await expect(continueSecond(changedManifestBinding)).rejects.toThrow(
      "prior v2 activation manifest bindings are inconsistent",
    );

    const secondState = fixtureAt(
      secondInitial,
      secondManifest,
      SECOND_REPOSITORY_HEAD,
      SECOND_COMPLETED_TASK_REF,
      secondTaskRefs,
    );
    const second = await secondState.service.continueEvidenceActivation(secondRequest);
    expect(second).toMatchObject({
      status: "continued",
      previousRequirementRef: first.requirementRef,
      taskRef: SECOND_COMPLETED_TASK_REF,
      completionRef: SECOND_COMPLETION_REF,
      fromHead: REPOSITORY_HEAD,
      repositoryHead: SECOND_REPOSITORY_HEAD,
    });
    expect(
      await secondState.service.evidenceActivationStatus({
        goalRef: "goals:G176",
        manifestId: MANIFEST_ID,
        expectedRepositoryHead: SECOND_REPOSITORY_HEAD,
      }),
    ).toMatchObject({
      status: "active",
      requirementRef: second.requirementRef,
      repositoryHead: SECOND_REPOSITORY_HEAD,
      taskRefs: [...COHORT, COMPLETED_TASK_REF, SECOND_COMPLETED_TASK_REF],
    });
    expect(
      (await secondState.store.snapshot()).activationContinuations[second.continuationRef],
    ).toMatchObject({
      previousContinuationRef: first.continuationRef,
      previousRequirementRef: first.requirementRef,
      requirementRef: second.requirementRef,
    });
    expect(await secondState.restart().continueEvidenceActivation(secondRequest)).toEqual({
      ...second,
      status: "existing",
    });
  });

  test("fences replay to the full request", async () => {
    const { service } = fixture();
    await service.continueEvidenceActivation(request);
    await expect(
      service.continueEvidenceActivation({ ...request, completedTaskRef: "tasks:T3004" }),
    ).rejects.toThrow("operation_id");
  });

  test("rolls back a failed append and retry survives restart", async () => {
    let fail = true;
    const state = fixture(snapshot(), async (boundary) => {
      if (fail && boundary === "before-activation-continuation-write") {
        throw new Error("injected continuation failure");
      }
    });
    await expect(state.service.continueEvidenceActivation(request)).rejects.toThrow(
      "injected continuation failure",
    );
    expect(Object.keys((await state.store.snapshot()).activationContinuations)).toHaveLength(0);

    fail = false;
    const continued = await state.service.continueEvidenceActivation(request);
    expect(continued.status).toBe("continued");
    expect(await state.restart().continueEvidenceActivation(request)).toEqual({
      ...continued,
      status: "existing",
    });
  });

  test("authenticates a correction-round starting commit through receipts and ancestry", async () => {
    const corrected = mutableSnapshot();
    corrected.completions[COMPLETION_REF] = {
      ...corrected.completions[COMPLETION_REF]!,
      startingCommit: CORRECTION_START,
      workerResult: workerResultAt(CORRECTION_START, [
        receipt(FROM_HEAD, CORRECTION_START, "commit-t3003-initial", "T3003"),
        receipt(CORRECTION_START, REPOSITORY_HEAD, "commit-t3003-correction", "T3003"),
      ]),
    };
    const ancestryChecks: Array<{ repositoryHead: string; resultCommit: string }> = [];
    const continued = await fixture(corrected, undefined, async (input) => {
      ancestryChecks.push(input);
      return true;
    }).service.continueEvidenceActivation(request);
    expect(continued.status).toBe("continued");
    expect(ancestryChecks).toContainEqual({
      repositoryHead: CORRECTION_START,
      resultCommit: FROM_HEAD,
    });
    expect(ancestryChecks).toContainEqual({
      repositoryHead: REPOSITORY_HEAD,
      resultCommit: CORRECTION_START,
    });

    const missingLineage = structuredClone(corrected) as MutableSnapshot;
    missingLineage.completions[COMPLETION_REF] = {
      ...missingLineage.completions[COMPLETION_REF]!,
      workerResult: workerResultAt(CORRECTION_START, [
        receipt(FROM_HEAD, REPOSITORY_HEAD, "commit-t3003-squashed", "T3003"),
      ]),
    };
    await expect(
      fixture(missingLineage).service.continueEvidenceActivation(request),
    ).rejects.toThrow("starting commit is absent from the result receipt lineage");

    await expect(
      fixture(
        corrected,
        undefined,
        async ({ repositoryHead, resultCommit }) =>
          !(repositoryHead === CORRECTION_START && resultCommit === FROM_HEAD),
      ).service.continueEvidenceActivation(request),
    ).rejects.toThrow("starting commit is not retained on the protected transition");
  });

  test("rejects altered prior activation and corresponding audit fingerprints", async () => {
    const alteredActivation = mutableSnapshot();
    alteredActivation.activations[PRIOR_ACTIVATION_REF] = {
      ...alteredActivation.activations[PRIOR_ACTIVATION_REF]!,
      evidenceFingerprint: "f".repeat(64),
    };
    await expect(
      fixture(alteredActivation).service.continueEvidenceActivation(request),
    ).rejects.toThrow("prior v2 activation evidence fingerprint is inconsistent");

    const alteredAudit = mutableSnapshot();
    alteredAudit.implementationAudits[AUDIT_REFS[0]] = {
      ...alteredAudit.implementationAudits[AUDIT_REFS[0]]!,
      evidenceFingerprint: "f".repeat(64),
    };
    await expect(fixture(alteredAudit).service.continueEvidenceActivation(request)).rejects.toThrow(
      "prior v2 activation ordered audit set is incomplete or unauthenticated",
    );

    const alteredManifestBinding = mutableSnapshot();
    const alteredManifestDigest = "f".repeat(64);
    alteredManifestBinding.activationRequirements[PRIOR_REQUIREMENT_REF] = {
      ...alteredManifestBinding.activationRequirements[PRIOR_REQUIREMENT_REF]!,
      manifestDigest: alteredManifestDigest,
    };
    alteredManifestBinding.activations[PRIOR_ACTIVATION_REF] = {
      ...alteredManifestBinding.activations[PRIOR_ACTIVATION_REF]!,
      manifestDigest: alteredManifestDigest,
      evidenceFingerprint: evidenceDigest({
        manifestId: MANIFEST_ID,
        manifestDigest: alteredManifestDigest,
        sourceDigest: manifest.sourceDigest,
        repositoryHead: FROM_HEAD,
        auditRefs: AUDIT_REFS,
        taskRefs: COHORT,
      }),
    };
    await expect(
      fixture(alteredManifestBinding).service.continueEvidenceActivation(request),
    ).rejects.toThrow("prior v2 activation manifest bindings are inconsistent");
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

    const malformedStart = mutableSnapshot();
    malformedStart.completions[COMPLETION_REF] = {
      ...malformedStart.completions[COMPLETION_REF]!,
      startingCommit: "not-a-full-sha",
    };
    await expect(
      fixture(malformedStart).service.continueEvidenceActivation(request),
    ).rejects.toThrow("prior activation head transition");

    const mismatchedCorrectionGate = mutableSnapshot();
    const correctionResult = workerResultAt(CORRECTION_START, [
      receipt(FROM_HEAD, CORRECTION_START, "commit-t3003-initial", "T3003"),
      receipt(CORRECTION_START, REPOSITORY_HEAD, "commit-t3003-correction", "T3003"),
    ]);
    mismatchedCorrectionGate.completions[COMPLETION_REF] = {
      ...mismatchedCorrectionGate.completions[COMPLETION_REF]!,
      startingCommit: CORRECTION_START,
      workerResult: {
        ...correctionResult,
        supervisedGateEvidence: {
          ...correctionResult.supervisedGateEvidence,
          startingCommit: FROM_HEAD,
        },
      },
    };
    await expect(
      fixture(mismatchedCorrectionGate).service.continueEvidenceActivation(request),
    ).rejects.toThrow("runner-owned green gate");

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
