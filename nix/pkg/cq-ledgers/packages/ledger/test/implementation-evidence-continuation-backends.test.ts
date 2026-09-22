import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  type DispatchJSONValue,
} from "@cq/config";
import {
  ImplementationEvidenceService,
  createFsImplementationEvidenceStore,
  createInMemoryImplementationEvidenceStore,
  implementationAuditManifestDigest,
  implementationAuditManifestSemanticDigest,
  type ImplementationCompletionRecord,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationEvidenceSnapshot,
  type ImplementationEvidenceStore,
  type ImplementationWorkerObservation,
  type PackagedImplementationAuditManifest,
} from "../src/index.js";

const FROM_HEAD = "a".repeat(40);
const REBASED_START = "d".repeat(40);
const DISPATCH_START = "e".repeat(40);
const REPOSITORY_HEAD = "b".repeat(40);
const MANIFEST_ID = "d347-implementation-evidence-activation-v2";
const TASK_REF = "tasks:T3003";
const COMPLETION_REF = `cq-implementation-completion:v1:${"3".repeat(64)}`;
const REQUIREMENT_REF =
  `cq-implementation-evidence-activation-requirement:v1:${"1".repeat(64)}`;
const ACTIVATION_REF = `cq-implementation-evidence-activation:v1:${"2".repeat(64)}`;
const WORKER_DISPATCH = { attestationId: `att_${"r".repeat(32)}`, generation: 1 } as const;
const COHORT = ["tasks:T3000"] as const;

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

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

const manifest: PackagedImplementationAuditManifest = {
  version: 1,
  manifestId: MANIFEST_ID,
  sourceDigest: "6".repeat(64),
  records: [
    {
      recordKey: `${MANIFEST_ID}:T3000`,
      taskRef: COHORT[0],
      ownerGoalRef: "goals:G176",
      finalizedManifest: "finalized-v2\n",
      historicalReview: null,
      baseCommit: "7".repeat(40),
      resultCommit: "9".repeat(40),
      repositoryHead: FROM_HEAD,
      diff: "diff-T3000",
      acceptance: { text: "accepted" },
      gateObservations: { gate: "green" },
      requiredObservations: ["task-authority"],
    },
  ],
  activation: {
    goalRef: "goals:G176",
    finalizedManifestDigest: "c".repeat(64),
    evidenceTaskKey: "t-evidence",
    auditTaskKey: "t-historical-evidence",
    activationTaskKey: "t-activate-evidence",
  },
};

const AUDIT_REF = `cq-implementation-audit:v1:${digest({
  manifestId: MANIFEST_ID,
  manifestDigest: implementationAuditManifestDigest(manifest),
  sourceDigest: manifest.sourceDigest,
  record: manifest.records[0],
  attemptRefs: [],
})}`;

function receipt(oldHead: string, newHead: string, operationId: string) {
  return {
    kind: "cq-git-change-receipt",
    version: 1,
    attestationId: WORKER_DISPATCH.attestationId,
    generation: WORKER_DISPATCH.generation,
    taskId: "T3003",
    operationId,
    requestDigest: "d".repeat(64),
    oldHead,
    newHead,
    tree: "e".repeat(40),
    objectOids: ["e".repeat(40), newHead],
    paths: ["feature.ts"],
    committedAt: "2026-09-16T18:00:00.000Z",
  } as const;
}

type ScenarioKind = "ordinary-correction" | "guarded-exact-tip" | "guarded-correction";

function workerResult(kind: ScenarioKind) {
  const dispatchStart = kind === "guarded-exact-tip" ? REPOSITORY_HEAD : DISPATCH_START;
  const receipts =
    kind === "guarded-exact-tip"
      ? []
      : kind === "guarded-correction"
        ? [
            receipt(REBASED_START, DISPATCH_START, "commit-guarded-initial"),
            receipt(DISPATCH_START, REPOSITORY_HEAD, "commit-guarded-correction"),
          ]
        : [
            receipt(FROM_HEAD, DISPATCH_START, "commit-ordinary-initial"),
            receipt(DISPATCH_START, REPOSITORY_HEAD, "commit-ordinary-correction"),
          ];
  return {
    taskId: "T3003",
    status: "pass",
    resultCommit: REPOSITORY_HEAD,
    branch: "implement/T3003",
    actualWorktreePath: "/repo/.claude/worktrees/T3003",
    filesTouched: ["feature.ts"],
    gitReceipts: receipts,
    ...(kind === "ordinary-correction"
      ? {}
      : {
          gitLineage: {
            kind: "guarded-rebase",
            guardedRebase: `cq-guarded-rebase:v1:${"a".repeat(64)}`,
            ontoCommit: FROM_HEAD,
            rebasedStartCommit:
              kind === "guarded-exact-tip" ? REPOSITORY_HEAD : REBASED_START,
            exactTip: kind === "guarded-exact-tip",
          },
        }),
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
      attestationId: WORKER_DISPATCH.attestationId,
      generation: WORKER_DISPATCH.generation,
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
      startingCommit: dispatchStart,
      resultCommit: REPOSITORY_HEAD,
      clean: true,
      command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
      gateExitCode: 0,
      passCount: 31,
      failCount: 0,
      gateDurationMs: 120,
      capturedAt: "2026-09-16T18:00:01.000Z",
      filesTouchedDigest: "4".repeat(64),
      gitReceiptsDigest: "5".repeat(64),
      mutationTableDigest: "6".repeat(64),
    },
    summary: "implemented",
  };
}

function scenario(kind: ScenarioKind): {
  readonly snapshot: ImplementationEvidenceSnapshot;
  readonly observation: ImplementationWorkerObservation;
} {
  const result = workerResult(kind);
  const startingCommit =
    kind === "guarded-exact-tip"
      ? REPOSITORY_HEAD
      : kind === "guarded-correction"
        ? REBASED_START
        : DISPATCH_START;
  const manifestDigest = implementationAuditManifestDigest(manifest);
  const auditEvidenceFingerprint = digest({
    record: manifest.records[0],
    attemptRefs: [],
    manifestDigest,
  });
  const activationEvidenceFingerprint = digest({
    manifestId: MANIFEST_ID,
    manifestDigest,
    sourceDigest: manifest.sourceDigest,
    repositoryHead: FROM_HEAD,
    auditRefs: [AUDIT_REF],
    taskRefs: COHORT,
  });
  const completion = {
    version: 1 as const,
    completionRef: COMPLETION_REF,
    taskRef: TASK_REF,
    ownerGoalRef: "goals:G176",
    resultCommit: REPOSITORY_HEAD,
    repositoryHead: FROM_HEAD,
    baseCommit: FROM_HEAD,
    startingCommit,
    workerDispatch: WORKER_DISPATCH,
    workerResult: result,
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
    preparedAt: "2026-09-16T17:59:00.000Z",
    mergeStartedAt: "2026-09-16T18:00:00.000Z",
    mergedAt: "2026-09-16T18:00:01.000Z",
    recordedAt: "2026-09-16T18:00:02.000Z",
    recordOperationId: "record-t3003",
  };
  return {
    snapshot: {
      version: 2,
      cohortReviews: {},
      cohortCompletions: {},
      panels: {},
      attempts: {},
      completions: { [COMPLETION_REF]: completion },
      adoptions: {},
      auditPanels: {},
      auditAttempts: {},
      implementationAudits: {
        [AUDIT_REF]: {
          version: 1,
          auditRef: AUDIT_REF,
          manifestId: MANIFEST_ID,
          manifestDigest,
          recordKey: manifest.records[0]!.recordKey,
          taskRef: COHORT[0],
          ownerGoalRef: "goals:G176",
          finalizedManifest: "finalized-v2\n",
          historicalReview: null,
          baseCommit: manifest.records[0]!.baseCommit,
          resultCommit: manifest.records[0]!.resultCommit,
          repositoryHead: FROM_HEAD,
          sourceDigest: manifest.sourceDigest,
          evidenceFingerprint: auditEvidenceFingerprint,
          attemptRefs: [],
          terminalState: "approved",
          author: "parent",
          session: null,
          appliedAt: "2026-09-16T17:00:00.000Z",
        },
      },
      auditManifestApplications: {},
      activationRequirements: {
        [REQUIREMENT_REF]: {
          version: 1,
          requirementRef: REQUIREMENT_REF,
          manifestId: MANIFEST_ID,
          manifestDigest,
          sourceDigest: manifest.sourceDigest,
          semanticManifestDigest: implementationAuditManifestSemanticDigest(manifest),
          goalRef: "goals:G176",
          finalizedManifestDigest: manifest.activation!.finalizedManifestDigest,
          evidenceTaskRef: COHORT[0],
          auditTaskRef: COHORT[0],
          activationTaskRef: "tasks:T3002",
          boundaryCommit: FROM_HEAD,
          taskRefs: COHORT,
          state: "fulfilled",
          activationRef: ACTIVATION_REF,
          previousRequirementRef: null,
          continuationRef: null,
          operationId: "arm-v2",
          requestDigest: "a".repeat(64),
          author: "parent",
          session: null,
          armedAt: "2026-09-16T16:00:00.000Z",
          fulfilledAt: "2026-09-16T17:00:00.000Z",
        },
      },
      activations: {
        [ACTIVATION_REF]: {
          version: 1,
          activationRef: ACTIVATION_REF,
          requirementRef: REQUIREMENT_REF,
          manifestId: MANIFEST_ID,
          manifestDigest,
          repositoryHead: FROM_HEAD,
          evidenceFingerprint: activationEvidenceFingerprint,
          auditRefs: [AUDIT_REF],
          taskRefs: COHORT,
          author: "parent",
          session: null,
          activatedAt: "2026-09-16T17:00:00.000Z",
        },
      },
      activationContinuations: {},
      bootstraps: {},
    },
    observation: {
      state: "consumed",
      input: {
        startingCommit:
          kind === "guarded-exact-tip" ? REPOSITORY_HEAD : DISPATCH_START,
      },
      output: result,
    },
  };
}

const request = {
  goalRef: "goals:G176",
  manifestId: MANIFEST_ID,
  priorRequirementRef: REQUIREMENT_REF,
  completedTaskRef: TASK_REF,
  completionRef: COMPLETION_REF,
  expectedFromHead: FROM_HEAD,
  expectedRepositoryHead: REPOSITORY_HEAD,
  operationId: "continue-after-t3003",
  author: "parent",
} as const;

interface BackendInstance {
  readonly store: ImplementationEvidenceStore;
  readonly reopen: () => Promise<ImplementationEvidenceStore>;
}

type BackendFactory = (initial: ImplementationEvidenceSnapshot) => Promise<BackendInstance>;

type MutableSnapshot = ImplementationEvidenceSnapshot & {
  completions: Record<string, ImplementationCompletionRecord>;
};

function withWorkerResult(
  initial: ImplementationEvidenceSnapshot,
  workerResult: DispatchJSONValue,
): ImplementationEvidenceSnapshot {
  const snapshot = structuredClone(initial) as MutableSnapshot;
  snapshot.completions[COMPLETION_REF] = {
    ...snapshot.completions[COMPLETION_REF]!,
    workerResult,
  };
  return snapshot;
}

function service(
  store: ImplementationEvidenceStore,
  initial: ImplementationEvidenceSnapshot,
  observation: ImplementationWorkerObservation,
  options: { readonly staleAuthority?: boolean } = {},
): ImplementationEvidenceService {
  const completion = initial.completions[COMPLETION_REF]!;
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store,
    resolveReviewerRoster: () => [],
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
    fetchNativeReview: async () => ({ state: "missing" }),
    executeExternalReview: async () => {
      throw new Error("unused");
    },
    fetchWorker: async (dispatch) =>
      dispatch.attestationId === WORKER_DISPATCH.attestationId &&
      dispatch.generation === WORKER_DISPATCH.generation
        ? observation
        : { state: "missing" },
    readTaskAuthority: async (taskRef) => ({
      taskRef,
      ownerGoalRef: "goals:G176",
      status: options.staleAuthority && taskRef === TASK_REF ? "wip" : "done",
      finalizedManifest: "finalized-v2\n",
    }),
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
      auditTaskRef: COHORT[0],
      activationTaskRef: "tasks:T3002",
      boundaryCommit: REPOSITORY_HEAD,
      taskRefs: [...COHORT, TASK_REF],
    }),
    isCommitRetained: async () => true,
    readCompletionReview: async () => ({
      reviewRef: completion.reviewRef!,
      status: "go-ahead",
      implementationEvidence: JSON.stringify({
        version: 1,
        completionRef: completion.completionRef,
        taskRef: completion.taskRef,
        resultCommit: completion.resultCommit,
        evidenceFingerprint: completion.evidenceFingerprint,
        reviewAttemptRefs: completion.reviewAttemptRefs,
      }),
    }),
  };
  return new ImplementationEvidenceService(dependencies);
}

async function expectAccepted(factory: BackendFactory, kind: ScenarioKind): Promise<void> {
  const sample = scenario(kind);
  const backend = await factory(sample.snapshot);
  const first = await service(
    backend.store,
    sample.snapshot,
    sample.observation,
  ).continueEvidenceActivation(request);
  expect(first).toMatchObject({
    status: "continued",
    completionRef: COMPLETION_REF,
    fromHead: FROM_HEAD,
    repositoryHead: REPOSITORY_HEAD,
  });
  const reopened = await backend.reopen();
  await expect(
    service(reopened, sample.snapshot, sample.observation).continueEvidenceActivation(request),
  ).resolves.toEqual({ ...first, status: "existing" });
  await expect(
    service(reopened, sample.snapshot, sample.observation).evidenceActivationStatus({
      goalRef: "goals:G176",
      manifestId: MANIFEST_ID,
      expectedRepositoryHead: REPOSITORY_HEAD,
    }),
  ).resolves.toMatchObject({ status: "active", repositoryHead: REPOSITORY_HEAD });
}

async function expectRejected(
  factory: BackendFactory,
  sample: ReturnType<typeof scenario>,
  observation: ImplementationWorkerObservation,
  message: string,
  options: { readonly staleAuthority?: boolean } = {},
): Promise<void> {
  const backend = await factory(sample.snapshot);
  await expect(
    service(backend.store, sample.snapshot, observation, options).continueEvidenceActivation(
      request,
    ),
  ).rejects.toThrow(message);
  expect(Object.keys((await backend.store.snapshot()).activationContinuations)).toHaveLength(0);
}

async function continuationContract(factory: BackendFactory): Promise<void> {
  await expectAccepted(factory, "ordinary-correction");
  await expectAccepted(factory, "guarded-exact-tip");
  await expectAccepted(factory, "guarded-correction");

  const guarded = scenario("guarded-correction");
  const guardedInput = guarded.observation.input;
  const guardedOutput = guarded.observation.output;
  if (guardedInput === undefined || guardedOutput === undefined)
    throw new Error("guarded test observation is incomplete");
  await expectRejected(factory, guarded, { state: "missing" }, "dispatch is absent or changed");
  await expectRejected(
    factory,
    guarded,
    { state: "consumed", output: guardedOutput },
    "dispatch is absent or changed",
  );
  await expectRejected(
    factory,
    guarded,
    { state: "consumed", input: guardedInput },
    "dispatch is absent or changed",
  );
  await expectRejected(
    factory,
    guarded,
    {
      ...guarded.observation,
      output: { ...(guardedOutput as Record<string, DispatchJSONValue>), summary: "changed" },
    },
    "dispatch is absent or changed",
  );
  await expectRejected(
    factory,
    guarded,
    { ...guarded.observation, input: { startingCommit: "not-a-full-sha" } },
    "malformed starting commit",
  );

  for (const gateStart of [FROM_HEAD, REBASED_START]) {
    const altered = scenario("guarded-correction");
    const result = structuredClone(
      altered.snapshot.completions[COMPLETION_REF]!.workerResult,
    ) as Record<string, DispatchJSONValue>;
    result["supervisedGateEvidence"] = {
      ...(result["supervisedGateEvidence"] as Record<string, DispatchJSONValue>),
      startingCommit: gateStart,
    };
    const snapshot = withWorkerResult(altered.snapshot, result);
    await expectRejected(
      factory,
      { snapshot, observation: altered.observation },
      { ...altered.observation, output: result },
      "runner-owned green gate evidence",
    );
  }

  for (const newHead of ["0".repeat(40), "malformed"]) {
    const altered = scenario("guarded-correction");
    const result = structuredClone(
      altered.snapshot.completions[COMPLETION_REF]!.workerResult,
    ) as Record<string, DispatchJSONValue>;
    const receipts = structuredClone(result["gitReceipts"]) as Array<
      Record<string, DispatchJSONValue>
    >;
    receipts[0] = { ...receipts[0], newHead };
    result["gitReceipts"] = receipts;
    const snapshot = withWorkerResult(altered.snapshot, result);
    await expectRejected(
      factory,
      { snapshot, observation: altered.observation },
      { ...altered.observation, output: result },
      "result receipt chain is not contiguous",
    );
  }

  const ungated = scenario("guarded-correction");
  const resultWithoutGate: Record<string, DispatchJSONValue> = {
    ...(ungated.snapshot.completions[COMPLETION_REF]!.workerResult as Record<
      string,
      DispatchJSONValue
    >),
  };
  delete resultWithoutGate["supervisedGateEvidence"];
  const ungatedSnapshot = withWorkerResult(ungated.snapshot, resultWithoutGate);
  await expectRejected(
    factory,
    { snapshot: ungatedSnapshot, observation: ungated.observation },
    { ...ungated.observation, output: resultWithoutGate },
    "runner-owned green gate evidence",
  );
  await expectRejected(
    factory,
    guarded,
    guarded.observation,
    "does not retain exact finalized-manifest authority",
    { staleAuthority: true },
  );
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("implementation evidence continuation backend contract [Blackbox-Atomic]", () => {
  test("runs the shared continuation contract against the in-memory dummy", async () => {
    await continuationContract(async (initial) => {
      const store = createInMemoryImplementationEvidenceStore(initial);
      return { store, reopen: async () => store };
    });
  });

  test("runs the shared continuation contract against the reopened filesystem journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-continuation-backends-"));
    temporaryRoots.push(root);
    let sequence = 0;
    await continuationContract(async (initial) => {
      sequence += 1;
      const path = join(root, String(sequence), "journal");
      const payload = {
        kind: "cq-implementation-evidence-journal-entry",
        version: 1,
        sequence: 1,
        priorDigest: null,
        snapshot: initial,
      } as const;
      const entryDigest = digest(payload);
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, `0000000000000001-${entryDigest}.json`),
        `${JSON.stringify({ ...payload, digest: entryDigest })}\n`,
        "utf8",
      );
      const store = createFsImplementationEvidenceStore({ path });
      return { store, reopen: async () => createFsImplementationEvidenceStore({ path }) };
    });
  });
});
