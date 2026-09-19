import { describe, expect, test } from "bun:test";
import type { DispatchHandle, DispatchPrepared } from "@cq/config";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorksetEffectBroker,
  createStrictInMemoryWorksetEffectAdmissionProvider,
  type RegisteredLaunchBootstrapSpecification,
} from "@cq/process-control";
import {
  GOALS_LEDGER,
  InMemoryLedgerStore,
  ImplementationEvidenceService,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  canonicalImplementationCompletionMergeLine,
  createFsImplementationEvidenceStore,
  createInMemoryImplementationEvidenceStore,
  protectLedgerStoreWithImplementationEvidence,
  createLedgerMcpTools,
  createObserveOnlyWorksetInvocationAuthority,
  implementationCompletionMergeAdmissionProviderFromStore,
  recordProtectedImplementationCompletion,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationEvidenceStore,
  type ImplementationCandidateAuthorityReceipt,
  type ImplementationCandidateCompletionReservationBinding,
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function evidenceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function candidateAuthority(
  overrides: Partial<ImplementationCandidateAuthorityReceipt> = {},
): ImplementationCandidateAuthorityReceipt {
  return {
    kind: "cq-implementation-candidate-authority",
    version: 1,
    workerDispatch: WORKER,
    partitionKey: "cq-implementation-partition:v1:" + "1".repeat(64),
    enrollmentId: "cq-implementation-enrollment:v1:" + "2".repeat(64),
    attemptId: "cq-implementation-attempt:v1:" + "3".repeat(64),
    leaseHolderId: "protected-completion",
    leaseGeneration: 1,
    qualificationDigest: "4".repeat(64),
    taskRef: "tasks:T2345",
    taskDigest: "5".repeat(64),
    goalRef: "goals:G1",
    finalizedManifestDigest: "6".repeat(64),
    integrationRef: "refs/heads/main",
    repositoryId: "7".repeat(64),
    worktreePath: "/repo/.claude/worktrees/T2345",
    resultCommit: RESULT,
    resultTree: "8".repeat(40),
    gateCommand: "bun run check",
    packagedEnvironmentDigest: "9".repeat(64),
    managedWorktreeBindingDigest: "a".repeat(64),
    gitReceiptLineageDigest: "b".repeat(64),
    gateEvidenceDigest: "c".repeat(64),
    ...overrides,
  };
}

type ReserveCandidateAuthority = (
  receipt: ImplementationCandidateAuthorityReceipt,
  binding: ImplementationCandidateCompletionReservationBinding,
) => Promise<void>;

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

function approvedVerdict(resultCommit = RESULT) {
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
    resultCommitEvidence: { status: "verified", resultCommit, branchTip: resultCommit },
    baseAncestry: {
      status: "verified",
      relation: "descendant",
      baseCommit: BASE,
      resultCommit,
      mergeBase: BASE,
    },
  } as const;
}

async function fixture(
  evidence: ImplementationEvidenceStore = createInMemoryImplementationEvidenceStore(),
  options: {
    readonly reviewerRoster?: () => readonly ImplementationReviewerIdentity[];
    readonly resolveCandidateAuthority?: () => ImplementationCandidateAuthorityReceipt;
    readonly resultCommit?: string;
    readonly workerDispatch?: DispatchHandle;
    readonly recordLedgerCompletion?: ImplementationEvidenceServiceDependencies["recordLedgerCompletion"];
    readonly reserveCandidateAuthority?: ReserveCandidateAuthority;
    readonly releaseCandidateAuthority?: NonNullable<
      ImplementationEvidenceServiceDependencies["releaseCandidateAuthority"]
    >;
  } = {},
) {
  const resultCommit = options.resultCommit ?? RESULT;
  const workerDispatch = options.workerDispatch ?? WORKER;
  let head = BASE;
  let ledgerWrites = 0;
  let verificationClean = true;
  let candidateReservationCount = 0;
  let candidateReleaseCount = 0;
  const reserveCandidateAuthority: ReserveCandidateAuthority =
    options.reserveCandidateAuthority ??
    (async () => {
      candidateReservationCount += 1;
    });
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store: evidence,
    resolveReviewerRoster: options.reviewerRoster ?? (() => [reviewer]),
    nativeFallback: reviewer,
    now: () => "2026-08-24T00:00:00.000Z",
    prepareNativeReview: async ({ attemptRef }) => prepared(attemptRef),
    fetchNativeReview: async (dispatch) => ({
      state: "consumed",
      output: approvedVerdict(resultCommit),
      retainedAttestation: dispatch.attestationId,
    }),
    executeExternalReview: async () => {
      throw new Error("not configured");
    },
    fetchWorker: async () => ({
      state: "consumed",
      input: { taskId: "T2345", baseCommit: BASE },
      output: {
        status: "pass",
        resultCommit,
        branch: "implement/T2345",
        actualWorktreePath: "/repo/.claude/worktrees/T2345",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit: BASE,
          headCommit: resultCommit,
        },
        gitReceipts: [{ oldHead: BASE, newHead: RESULT }],
        filesTouched: ["feature.ts"],
        supervisedGateEvidence: { gateExitCode: 0, passCount: 1, failCount: 0 },
      },
    }),
    ...(options.resolveCandidateAuthority === undefined
      ? {}
      : {
          resolveCandidateAuthority: async () => options.resolveCandidateAuthority!(),
          releaseCandidateAuthority:
            options.releaseCandidateAuthority ??
            (async () => {
              candidateReleaseCount += 1;
            }),
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
    recordLedgerCompletion:
      options.recordLedgerCompletion ??
      (async () => {
        ledgerWrites += 1;
        return { reviewRef: "reviews:R2345" };
      }),
  };
  const service = new ImplementationEvidenceService(dependencies);
  const panel = await service.prepareReviewPanel({
    taskRef: "tasks:T2345",
    resultCommit,
    workerDispatch,
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
    getCandidateReservationCount: () => candidateReservationCount,
    getCandidateReleaseCount: () => candidateReleaseCount,
    reserveCandidateAuthority,
    resultCommit,
    workerDispatch,
    restart: () => new ImplementationEvidenceService(dependencies),
  };
}

async function journalEntryCount(path: string): Promise<number> {
  return (await readdir(path)).filter((name) => /^[0-9]{16}-[0-9a-f]{64}\.json$/u.test(name))
    .length;
}

function processExited(
  child: ChildProcess,
): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function ignoredBootstrap(specification: RegisteredLaunchBootstrapSpecification<StdioOptions>) {
  const child = spawn(specification.argv[0], specification.argv.slice(1), {
    cwd: specification.cwd,
    env: specification.env,
    detached: specification.detached,
    stdio: specification.stdio,
  });
  return {
    process: child,
    pid: child.pid,
    exited: processExited(child),
    outputDrained: Promise.resolve(),
    resultFromTargetOutcome: (outcome: {
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => outcome,
    terminate: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

describe("versioned protected implementation evidence [BG]", () => {
  // Regression origin: T6520 round 3 — candidate receipts extended the
  // fingerprint after old merged journals had already been authenticated.
  test("records and replays an exact old-format merged completion without weakening its fences [Behavioral-Active Blackbox-Group]", async () => {
    const original = await fixture();
    const completionInput = {
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [original.attemptRef],
      completion: "implemented",
      logPaths: [] as string[],
      mergeOperationId: "merge-old-format",
      operationId: "completion-old-format",
      author: "parent",
    } as const;
    const preparedCompletion = await original.service.prepareCompletion(completionInput);
    await original.service.markMergeStarted(preparedCompletion.completionRef, BASE);
    original.setHead(RESULT);
    await original.service.markMerged(preparedCompletion.completionRef, RESULT);
    const snapshot = await original.evidence.snapshot();
    const current = snapshot.completions[preparedCompletion.completionRef]!;
    const attempts = current.reviewAttemptRefs.map((ref) => snapshot.attempts[ref]!);
    const verification = {
      baseCommit: BASE,
      startingCommit: BASE,
      clean: true,
      ancestryVerified: true,
      receiptsVerified: true,
      acceptanceVerified: true,
      gateVerified: true,
      details: current.verification,
    };
    const legacyFingerprint = evidenceDigest({
      version: 1,
      taskRef: current.taskRef,
      ownerGoalRef: current.ownerGoalRef,
      finalizedManifest: current.finalizedManifest,
      repositoryHead: current.repositoryHead,
      resultCommit: current.resultCommit,
      baseCommit: current.baseCommit,
      startingCommit: current.startingCommit,
      workerDispatch: current.workerDispatch,
      workerResult: current.workerResult,
      reviewAttemptRefs: current.reviewAttemptRefs,
      attempts: attempts.map((attempt) => ({
        attemptRef: attempt.attemptRef,
        position: attempt.position,
        identity: attempt.identity,
        terminalState: attempt.terminalState,
        verdictDigest: attempt.verdictDigest,
        fallback: attempt.fallback,
        fallbackTrigger: attempt.fallbackTrigger,
        fallbackExclusions: attempt.fallbackExclusions,
        retainedAttestation: attempt.retainedAttestation ?? null,
      })),
      verification,
      completion: current.completion,
      logPaths: current.logPaths,
      mergeOperationId: current.mergeOperationId,
    });
    const legacyCompletionRef = `cq-implementation-completion:v1:${evidenceDigest({
      taskRef: current.taskRef,
      operationId: current.operationId,
      evidenceFingerprint: legacyFingerprint,
    })}`;
    const legacyRecord = {
      ...current,
      completionRef: legacyCompletionRef,
      evidenceFingerprint: legacyFingerprint,
      requestDigest: evidenceDigest({ ...completionInput, evidenceFingerprint: legacyFingerprint }),
      state: "merged" as const,
      mergeStartedAt: current.mergeStartedAt ?? "2026-08-24T00:00:00.000Z",
      mergedAt: current.mergedAt ?? "2026-08-24T00:00:00.000Z",
    };
    const legacySnapshot = {
      ...snapshot,
      completions: { [legacyCompletionRef]: legacyRecord },
    };

    const unrelated = await fixture(createInMemoryImplementationEvidenceStore(legacySnapshot));
    await expect(
      unrelated.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: BASE,
        operationId: "record-old-format-unrelated",
        author: "parent",
      }),
    ).rejects.toThrow("unrelated integration ref");

    const tamperedSnapshot = {
      ...legacySnapshot,
      completions: {
        [legacyCompletionRef]: { ...legacyRecord, evidenceFingerprint: "0".repeat(64) },
      },
    };
    const tampered = await fixture(createInMemoryImplementationEvidenceStore(tamperedSnapshot));
    tampered.setHead(RESULT);
    await expect(
      tampered.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: RESULT,
        operationId: "record-old-format-tampered",
        author: "parent",
      }),
    ).rejects.toThrow("evidence fingerprint changed before recording");

    const reopened = await fixture(createInMemoryImplementationEvidenceStore(legacySnapshot));
    reopened.setHead(RESULT);
    await expect(
      reopened.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: RESULT,
        operationId: "record-old-format",
        author: "parent",
      }),
    ).resolves.toMatchObject({ status: "recorded", completionRef: legacyCompletionRef });
    await expect(
      reopened.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: RESULT,
        operationId: "record-old-format-replay",
        author: "parent",
      }),
    ).resolves.toMatchObject({ status: "existing", completionRef: legacyCompletionRef });
    expect(reopened.getLedgerWrites()).toBe(1);
  });

  test("fences review and merge with the current candidate receipt, then recovers post-merge completion", async () => {
    let roster: readonly ImplementationReviewerIdentity[] = [reviewer];
    let authority = candidateAuthority();
    const f = await fixture(createInMemoryImplementationEvidenceStore(), {
      reviewerRoster: () => roster,
      resolveCandidateAuthority: () => authority,
    });
    const completionInput = {
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [f.attemptRef],
      completion: "implemented",
      logPaths: [] as string[],
      mergeOperationId: "merge-candidate-fence",
      operationId: "completion-candidate-fence",
      author: "parent",
    } as const;

    roster = [{ ...reviewer, model: "changed-reviewer" }];
    await expect(f.service.prepareCompletion(completionInput)).rejects.toThrow(
      "reviewer roster changed",
    );
    roster = [reviewer];
    for (const changed of [
      { leaseGeneration: 2 },
      { resultCommit: "c".repeat(40) },
      { resultTree: "d".repeat(40) },
      { gateCommand: "bun run changed-check" },
      { packagedEnvironmentDigest: "e".repeat(64) },
      { taskRef: "tasks:T9999" },
      { finalizedManifestDigest: "f".repeat(64) },
      { managedWorktreeBindingDigest: "d".repeat(64) },
    ] satisfies readonly Partial<ImplementationCandidateAuthorityReceipt>[]) {
      authority = candidateAuthority(changed);
      await expect(f.service.prepareCompletion(completionInput)).rejects.toThrow();
    }
    authority = candidateAuthority();
    const completion = await f.service.prepareCompletion(completionInput);
    const binding = {
      kind: "merge" as const,
      targetRef: "tasks:T2345",
      repositoryRoot: "/repo",
      commit: RESULT,
      completionRef: completion.completionRef,
      mergeOperationId: completionInput.mergeOperationId,
    };
    authority = candidateAuthority({ managedWorktreeBindingDigest: "d".repeat(64) });
    await expect(f.service.assertMergeAdmission(binding, BASE)).rejects.toThrow(
      "candidate authority changed",
    );
    authority = candidateAuthority();
    await expect(f.service.assertMergeAdmission(binding, BASE)).resolves.toMatchObject({
      completionRef: completion.completionRef,
      state: "prepared",
    });

    const underlying = createStrictInMemoryWorksetEffectAdmissionProvider();
    const provider = await implementationCompletionMergeAdmissionProviderFromStore({
      provider: underlying,
      store: f.evidence,
      binding,
      repositoryHead: async () => f.getHead(),
      authorizeCandidate: async (receipt) => {
        if (JSON.stringify(receipt) !== JSON.stringify(authority)) {
          throw new Error("candidate authority changed at merge authorization");
        }
      },
      reserveCandidate: f.reserveCandidateAuthority,
    });
    const admission = await provider.acquire({ kind: "merge", targetRef: "tasks:T2345" });
    await admission.registerProcessGroup({ pgid: 6520, leaderPid: 6520 });
    authority = candidateAuthority({ leaseGeneration: 3 });
    await expect(admission.shareWithGuardian({ pgid: 6520, leaderPid: 6520 })).rejects.toThrow(
      "candidate authority changed at merge authorization",
    );
    authority = candidateAuthority();
    await admission.shareWithGuardian({ pgid: 6520, leaderPid: 6520 });
    f.setHead(RESULT);
    await admission.markSettled();
    await admission.releaseAfterSettlement();
    authority = candidateAuthority({ leaseGeneration: 3 });
    await expect(
      f.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: RESULT,
        operationId: "record-candidate-fence",
        author: "parent",
      }),
    ).resolves.toMatchObject({ status: "recorded" });
    await expect(
      f.service.recordCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: RESULT,
        operationId: "record-candidate-fence-replay",
        author: "parent",
      }),
    ).resolves.toMatchObject({ status: "existing" });
    expect(f.getCandidateReleaseCount()).toBe(2);
    expect(f.getCandidateReservationCount()).toBe(2);
  });

  // regression: T6520 round 13 — code-identity gate counts belong at the
  // production coordinator boundary; this service case isolates review-only
  // roster and lease-authority invalidation.
  test("roster and lease refresh invalidate review evidence without changing candidate code identity [Behavioral-Active Blackbox-Group]", async () => {
    let roster: readonly ImplementationReviewerIdentity[] = [reviewer];
    let authority = candidateAuthority();
    const reviewOnly = await fixture(createInMemoryImplementationEvidenceStore(), {
      reviewerRoster: () => roster,
      resolveCandidateAuthority: () => authority,
    });
    const reviewOnlyInput = {
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [reviewOnly.attemptRef],
      completion: "review-only refresh",
      logPaths: [] as string[],
      mergeOperationId: "merge-review-only-refresh",
      operationId: "completion-review-only-refresh",
      author: "parent",
    } as const;
    roster = [{ ...reviewer, model: "replacement-reviewer" }];
    await expect(reviewOnly.service.prepareCompletion(reviewOnlyInput)).rejects.toThrow(
      "reviewer roster changed",
    );
    authority = candidateAuthority({ leaseGeneration: 2 });
    const refreshed = await fixture(createInMemoryImplementationEvidenceStore(), {
      reviewerRoster: () => roster,
      resolveCandidateAuthority: () => authority,
    });
    await expect(
      refreshed.service.prepareCompletion({
        ...reviewOnlyInput,
        reviewAttemptRefs: [refreshed.attemptRef],
        mergeOperationId: "merge-refreshed-review",
        operationId: "completion-refreshed-review",
      }),
    ).resolves.toMatchObject({ status: "prepared", resultCommit: RESULT });
  });

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
    const provider = await implementationCompletionMergeAdmissionProviderFromStore({
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

  test("every protected handoff cut restart-converges to one ledger completion and one queue release [Behavioral-Active Blackbox-Group]", async () => {
    for (const cut of [
      "before-merge-launch",
      "after-completion-reservation",
      "after-merge-launch",
      "after-ref-advancement",
      "after-merged-persistence",
      "after-ledger-recording",
      "after-evidence-finalization",
      "after-queue-release",
    ] as const) {
      const durableStore = createInMemoryImplementationEvidenceStore();
      let injectEvidenceFinalization = false;
      let evidenceFinalizationMutations = 0;
      const evidence: ImplementationEvidenceStore = new Proxy(durableStore, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (typeof property === "symbol" && typeof value === "function") {
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(value, target, args);
              if (injectEvidenceFinalization) {
                evidenceFinalizationMutations += 1;
                if (evidenceFinalizationMutations === 2) {
                  injectEvidenceFinalization = false;
                  throw new Error("injected fault after evidence finalization");
                }
              }
              return result;
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const ledgerEffects = new Map<string, string>();
      const reservationEffects = new Map<string, string>();
      const releaseEffects = new Map<string, string>();
      let failAfterReservation = cut === "after-completion-reservation";
      let failAfterLedgerRecording = cut === "after-ledger-recording";
      let failAfterQueueRelease = cut === "after-queue-release";
      const f = await fixture(evidence, {
        resolveCandidateAuthority: () => candidateAuthority(),
        reserveCandidateAuthority: async (receipt, binding) => {
          const requestDigest = evidenceDigest({ receipt, binding });
          const prior = reservationEffects.get(binding.operationId);
          if (prior !== undefined && prior !== requestDigest) {
            throw new Error("reservation operation id was reused with different authority");
          }
          reservationEffects.set(binding.operationId, requestDigest);
          if (failAfterReservation) {
            failAfterReservation = false;
            throw new Error("injected fault after completion reservation");
          }
        },
        recordLedgerCompletion: async ({ completion: current }) => {
          if (current.recordOperationId === null) {
            throw new Error("recording completion omitted its durable operation id");
          }
          const requestDigest = evidenceDigest({
            taskRef: current.taskRef,
            resultCommit: current.resultCommit,
            evidenceFingerprint: current.evidenceFingerprint,
          });
          const prior = ledgerEffects.get(current.recordOperationId);
          if (prior !== undefined && prior !== requestDigest) {
            throw new Error("ledger operation id was reused with a different completion");
          }
          ledgerEffects.set(current.recordOperationId, requestDigest);
          if (failAfterLedgerRecording) {
            failAfterLedgerRecording = false;
            throw new Error("injected fault after ledger recording");
          }
          return { reviewRef: "reviews:R2345" };
        },
        releaseCandidateAuthority: async (receipt, binding) => {
          const requestDigest = evidenceDigest({ receipt, binding });
          const prior = releaseEffects.get(binding.operationId);
          if (prior !== undefined && prior !== requestDigest) {
            throw new Error("release operation id was reused with different authority");
          }
          releaseEffects.set(binding.operationId, requestDigest);
          if (failAfterQueueRelease) {
            failAfterQueueRelease = false;
            throw new Error("injected fault after queue release");
          }
        },
      });
      const completion = await f.service.prepareCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: BASE,
        resultCommit: RESULT,
        workerDispatch: WORKER,
        reviewAttemptRefs: [f.attemptRef],
        completion: `implemented after ${cut}`,
        logPaths: [],
        mergeOperationId: `merge-${cut}`,
        operationId: `completion-${cut}`,
        author: "parent",
      });
      const binding = {
        kind: "merge" as const,
        targetRef: "tasks:T2345",
        repositoryRoot: "/repo",
        commit: RESULT,
        completionRef: completion.completionRef,
        mergeOperationId: `merge-${cut}`,
      };
      const reservationBinding = {
        operationId: `completion-${cut}`,
        completionRef: completion.completionRef,
        mergeOperationId: `merge-${cut}`,
        taskRef: "tasks:T2345",
        resultCommit: RESULT,
      } as const;

      let recovered = f.restart();
      if (cut === "after-merge-launch") {
        await recovered.markMergeStarted(completion.completionRef, BASE);
        recovered = f.restart();
      }
      if (
        cut === "before-merge-launch" ||
        cut === "after-completion-reservation" ||
        cut === "after-merge-launch"
      ) {
        const underlying = createStrictInMemoryWorksetEffectAdmissionProvider();
        const prepareProvider = () =>
          implementationCompletionMergeAdmissionProviderFromStore({
            provider: underlying,
            store: evidence,
            binding,
            repositoryHead: async () => f.getHead(),
            authorizeCandidate: async (receipt) => {
              expect(receipt).toEqual(candidateAuthority());
            },
            reserveCandidate: f.reserveCandidateAuthority,
          });
        if (cut === "after-completion-reservation") {
          await expect(prepareProvider()).rejects.toThrow(
            "injected fault after completion reservation",
          );
          recovered = f.restart();
        }
        const provider = await prepareProvider();
        const admission = await provider.acquire({ kind: "merge", targetRef: "tasks:T2345" });
        await admission.registerProcessGroup({ pgid: 6520, leaderPid: 6520 });
        await admission.shareWithGuardian({ pgid: 6520, leaderPid: 6520 });
        f.setHead(RESULT);
        await admission.markSettled();
        await admission.releaseAfterSettlement();
        expect(underlying.activeAdmissionCount()).toBe(0);
        recovered = f.restart();
      } else {
        await f.reserveCandidateAuthority(candidateAuthority(), reservationBinding);
        await recovered.markMergeStarted(completion.completionRef, BASE);
        f.setHead(RESULT);
        if (cut !== "after-ref-advancement") {
          await recovered.markMerged(completion.completionRef, RESULT);
        }
        recovered = f.restart();
      }

      if (cut === "after-evidence-finalization") injectEvidenceFinalization = true;
      const record = () =>
        recovered.recordCompletion({
          taskRef: "tasks:T2345",
          expectedRepositoryHead: RESULT,
          operationId: `record-${cut}`,
          author: "parent",
        });
      if (
        cut === "after-ledger-recording" ||
        cut === "after-evidence-finalization" ||
        cut === "after-queue-release"
      ) {
        await expect(record()).rejects.toThrow(
          `injected fault ${
            cut === "after-ledger-recording"
              ? "after ledger recording"
              : cut === "after-evidence-finalization"
                ? "after evidence finalization"
                : "after queue release"
          }`,
        );
        recovered = f.restart();
      }
      await expect(record()).resolves.toMatchObject({
        status: expect.stringMatching(/recorded|existing/),
      });
      await expect(record()).resolves.toMatchObject({ status: "existing" });
      expect([...ledgerEffects.keys()], cut).toEqual([`record-${cut}`]);
      expect([...reservationEffects.keys()], cut).toEqual([`completion-${cut}`]);
      expect([...releaseEffects.keys()], cut).toEqual([`completion-${cut}`]);
      expect((await evidence.snapshot()).completions[completion.completionRef]).toMatchObject({
        state: "recorded",
        reviewRef: "reviews:R2345",
      });
    }
  });

  // Regression origin: H354 retained a merge-started completion after guardian
  // sharing failed; replay must not append an identical durable snapshot.
  test("retries the exact retained merge-started completion without a redundant journal append", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-h354-merge-replay-"));
    const journal = join(root, "journal");
    try {
      const f = await fixture(createFsImplementationEvidenceStore({ path: journal }));
      const completion = await f.service.prepareCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: BASE,
        resultCommit: RESULT,
        workerDispatch: WORKER,
        reviewAttemptRefs: [f.attemptRef],
        completion: "implemented",
        logPaths: [],
        mergeOperationId: "merge-retained-retry",
        operationId: "completion-retained-retry",
        author: "parent",
      });
      const binding = {
        kind: "merge" as const,
        targetRef: "tasks:T2345",
        repositoryRoot: "/repo",
        commit: RESULT,
        completionRef: completion.completionRef,
        mergeOperationId: "merge-retained-retry",
      };

      const rejectedUnderlying = createStrictInMemoryWorksetEffectAdmissionProvider();
      const rejectedProvider = await implementationCompletionMergeAdmissionProviderFromStore({
        provider: {
          acquire: async (input) => {
            const underlying = await rejectedUnderlying.acquire(input);
            return {
              ...underlying,
              shareWithGuardian: async () => {
                throw new Error("controlled guardian share failure");
              },
            };
          },
        },
        store: f.evidence,
        binding,
        repositoryHead: async () => f.getHead(),
      });
      const rejected = await rejectedProvider.acquire({
        kind: "merge",
        targetRef: "tasks:T2345",
      });
      await rejected.registerProcessGroup({ pgid: 321, leaderPid: 321 });
      await expect(rejected.shareWithGuardian({ pgid: 321, leaderPid: 321 })).rejects.toThrow(
        "controlled guardian share failure",
      );
      expect((await f.evidence.snapshot()).completions[completion.completionRef]!.state).toBe(
        "merge-started",
      );
      await expect(f.service.mergeAcknowledgement(completion.completionRef)).rejects.toThrow(
        "not durably merged",
      );
      await rejected.markSettled();
      await rejected.releaseAfterSettlement();
      expect(rejectedUnderlying.activeAdmissionCount()).toBe(0);
      const retainedEntryCount = await journalEntryCount(journal);

      const retryUnderlying = createStrictInMemoryWorksetEffectAdmissionProvider();
      const retryProvider = await implementationCompletionMergeAdmissionProviderFromStore({
        provider: retryUnderlying,
        store: f.evidence,
        binding,
        repositoryHead: async () => f.getHead(),
      });
      const retry = await retryProvider.acquire({ kind: "merge", targetRef: "tasks:T2345" });
      await retry.registerProcessGroup({ pgid: 322, leaderPid: 322 });
      await retry.shareWithGuardian({ pgid: 322, leaderPid: 322 });
      expect(await journalEntryCount(journal)).toBe(retainedEntryCount);
      f.setHead(RESULT);
      await retry.markSettled();
      await retry.releaseAfterSettlement();
      expect(retryUnderlying.activeAdmissionCount()).toBe(0);
      expect(
        (await f.service.mergeAcknowledgement(completion.completionRef)).mergeOperationId,
      ).toBe("merge-retained-retry");

      await expect(
        implementationCompletionMergeAdmissionProviderFromStore({
          provider: createStrictInMemoryWorksetEffectAdmissionProvider(),
          store: f.evidence,
          binding: { ...binding, mergeOperationId: "merge-foreign-operation" },
          repositoryHead: async () => f.getHead(),
        }),
      ).rejects.toThrow("merge coordinates do not match");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prevalidates a retained merge journal before the bounded real-process launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-retained-merge-prevalidation-"));
    try {
      const f = await fixture();
      const completion = await f.service.prepareCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: BASE,
        resultCommit: RESULT,
        workerDispatch: WORKER,
        reviewAttemptRefs: [f.attemptRef],
        completion: "implemented",
        logPaths: [],
        mergeOperationId: "merge-prevalidated-retained",
        operationId: "completion-prevalidated-retained",
        author: "parent",
      });
      await f.service.markMergeStarted(completion.completionRef, BASE);
      let delayedSnapshots = 0;
      const ordering: string[] = [];
      const delayedEvidence: ImplementationEvidenceStore = new Proxy(f.evidence, {
        get(target, property) {
          if (property === "snapshot") {
            return async () => {
              delayedSnapshots += 1;
              ordering.push(`snapshot-${String(delayedSnapshots)}-start`);
              if (delayedSnapshots === 1) await Bun.sleep(120);
              const snapshot = await target.snapshot();
              ordering.push(`snapshot-${String(delayedSnapshots)}-end`);
              return snapshot;
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const underlying = createStrictInMemoryWorksetEffectAdmissionProvider();
      const provider = await implementationCompletionMergeAdmissionProviderFromStore({
        provider: {
          acquire: async (input) => {
            ordering.push("admission-start");
            const admission = await underlying.acquire(input);
            ordering.push("admission-held");
            return admission;
          },
        },
        store: delayedEvidence,
        binding: {
          kind: "merge",
          targetRef: "tasks:T2345",
          repositoryRoot: root,
          commit: RESULT,
          completionRef: completion.completionRef,
          mergeOperationId: "merge-prevalidated-retained",
        },
        repositoryHead: async () => f.getHead(),
      });
      const marker = join(root, "target-ran");
      const broker = new WorksetEffectBroker({ provider });
      const launched = await broker.launch({
        kind: "merge",
        targetRef: "tasks:T2345",
        argv: [
          process.execPath,
          "-e",
          `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n')`,
        ],
        cwd: root,
        env: process.env,
        stdio: "ignore" as const,
        launchDeadlineMs: Date.now() + 1_000,
        launchBootstrap: (specification) => {
          ordering.push("bootstrap-launched");
          return ignoredBootstrap(specification);
        },
      });
      await launched.exited;

      expect(await Bun.file(marker).text()).toBe("ran\n");
      expect(delayedSnapshots).toBe(2);
      expect(ordering).toEqual([
        "snapshot-1-start",
        "snapshot-1-end",
        "admission-start",
        "admission-held",
        "bootstrap-launched",
        "snapshot-2-start",
        "snapshot-2-end",
      ]);
      expect(underlying.activeAdmissionCount()).toBe(0);

      const expiredUnderlying = createStrictInMemoryWorksetEffectAdmissionProvider();
      const expiredBroker = new WorksetEffectBroker({ provider: expiredUnderlying });
      let expiredBootstrapLaunches = 0;
      await expect(
        expiredBroker.launch({
          kind: "merge",
          targetRef: "tasks:T2345",
          argv: [process.execPath, "-e", ""],
          cwd: root,
          env: process.env,
          stdio: "ignore" as const,
          launchDeadlineMs: Date.now() + 50,
          beforeLaunch: () => new Promise<never>(() => {}),
          launchBootstrap: (specification) => {
            expiredBootstrapLaunches += 1;
            return ignoredBootstrap(specification);
          },
        }),
      ).rejects.toThrow(
        "launch/admission deadline expired during pre-launch coordinate validation",
      );
      expect(expiredBootstrapLaunches).toBe(0);
      expect(expiredUnderlying.events()).toEqual(["admission-acquired", "admission-abandoned"]);
      expect(expiredUnderlying.activeAdmissionCount()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("H354 completes delayed durable merge-started preparation before bounded real-process launch [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-h354-slow-journal-"));
    try {
      const f = await fixture();
      const completion = await f.service.prepareCompletion({
        taskRef: "tasks:T2345",
        expectedRepositoryHead: BASE,
        resultCommit: RESULT,
        workerDispatch: WORKER,
        reviewAttemptRefs: [f.attemptRef],
        completion: "implemented",
        logPaths: [],
        mergeOperationId: "merge-slow-journal",
        operationId: "completion-slow-journal",
        author: "parent",
      });
      let durableWrites = 0;
      const durableWriteStarted = Promise.withResolvers<void>();
      const allowDurableWrite = Promise.withResolvers<void>();
      const ordering: string[] = [];
      const slowEvidence: ImplementationEvidenceStore = new Proxy(f.evidence, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (typeof property === "symbol" && typeof value === "function") {
            return async (...args: unknown[]) => {
              durableWrites += 1;
              ordering.push(`durable-write-${String(durableWrites)}-start`);
              if (durableWrites === 1) {
                durableWriteStarted.resolve();
                await allowDurableWrite.promise;
              }
              const result = await Reflect.apply(value, target, args);
              ordering.push(`durable-write-${String(durableWrites)}-end`);
              return result;
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const underlying = createStrictInMemoryWorksetEffectAdmissionProvider();
      const providerPreparation = implementationCompletionMergeAdmissionProviderFromStore({
        provider: {
          acquire: async (input) => {
            ordering.push("admission-start");
            const admission = await underlying.acquire(input);
            ordering.push("admission-held");
            return admission;
          },
        },
        store: slowEvidence,
        binding: {
          kind: "merge",
          targetRef: "tasks:T2345",
          repositoryRoot: root,
          commit: RESULT,
          completionRef: completion.completionRef,
          mergeOperationId: "merge-slow-journal",
        },
        repositoryHead: async () => f.getHead(),
      });
      await durableWriteStarted.promise;
      expect(ordering).toEqual(["durable-write-1-start"]);
      allowDurableWrite.resolve();
      const provider = await providerPreparation;
      const marker = join(root, "target-ran");
      const broker = new WorksetEffectBroker({
        provider,
        settlement: { termGraceMs: 0, killGraceMs: 1_000, pollIntervalMs: 2 },
      });
      let bootstrapLaunches = 0;
      const launched = await broker.launch({
        kind: "merge",
        targetRef: "tasks:T2345",
        argv: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
        cwd: root,
        env: process.env,
        stdio: "ignore" as const,
        launchDeadlineMs: Date.now() + 1_000,
        launchBootstrap: (specification) => {
          ordering.push("bootstrap-launched");
          bootstrapLaunches += 1;
          return ignoredBootstrap(specification);
        },
      });
      await launched.exited;

      expect(await Bun.file(marker).text()).toBe("ran");
      expect(durableWrites).toBe(1);
      expect(bootstrapLaunches).toBe(1);
      expect(ordering).toEqual([
        "durable-write-1-start",
        "durable-write-1-end",
        "admission-start",
        "admission-held",
        "bootstrap-launched",
      ]);
      expect(underlying.activeAdmissionCount()).toBe(0);
      await expect(f.service.mergeAcknowledgement(completion.completionRef)).rejects.toThrow(
        "not durably merged",
      );
      expect((await f.evidence.snapshot()).completions[completion.completionRef]!.state).toBe(
        "merge-started",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a repository-head CAS change after durable merge-started preparation", async () => {
    const f = await fixture();
    const completion = await f.service.prepareCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [f.attemptRef],
      completion: "implemented",
      logPaths: [],
      mergeOperationId: "merge-head-cas",
      operationId: "completion-head-cas",
      author: "parent",
    });
    const underlying = createStrictInMemoryWorksetEffectAdmissionProvider();
    let reads = 0;
    const provider = await implementationCompletionMergeAdmissionProviderFromStore({
      provider: underlying,
      store: f.evidence,
      binding: {
        kind: "merge",
        targetRef: "tasks:T2345",
        repositoryRoot: "/repo",
        commit: RESULT,
        completionRef: completion.completionRef,
        mergeOperationId: "merge-head-cas",
      },
      repositoryHead: async () => {
        reads += 1;
        return reads === 3 ? "c".repeat(40) : BASE;
      },
    });
    const admission = await provider.acquire({ kind: "merge", targetRef: "tasks:T2345" });
    await admission.registerProcessGroup({ pgid: 654, leaderPid: 654 });
    await expect(admission.shareWithGuardian({ pgid: 654, leaderPid: 654 })).rejects.toThrow(
      "repository HEAD changed after durable merge-started preparation",
    );
    expect(underlying.events()).not.toContain("guardian-shared");
    await admission.markSettled();
    await admission.releaseAfterSettlement();
    expect(underlying.activeAdmissionCount()).toBe(0);
  });

  test("rejects a repository-head CAS change during durable preparation before admission", async () => {
    const f = await fixture();
    const completion = await f.service.prepareCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [f.attemptRef],
      completion: "implemented",
      logPaths: [],
      mergeOperationId: "merge-prevalidation-head-cas",
      operationId: "completion-prevalidation-head-cas",
      author: "parent",
    });
    const underlying = createStrictInMemoryWorksetEffectAdmissionProvider();
    let reads = 0;
    await expect(
      implementationCompletionMergeAdmissionProviderFromStore({
        provider: underlying,
        store: f.evidence,
        binding: {
          kind: "merge",
          targetRef: "tasks:T2345",
          repositoryRoot: "/repo",
          commit: RESULT,
          completionRef: completion.completionRef,
          mergeOperationId: "merge-prevalidation-head-cas",
        },
        repositoryHead: async () => {
          reads += 1;
          return reads === 2 ? "c".repeat(40) : BASE;
        },
      }),
    ).rejects.toThrow("repository HEAD changed during durable merge-started preparation");
    expect((await f.evidence.snapshot()).completions[completion.completionRef]!.state).toBe(
      "merge-started",
    );
    expect(underlying.events()).toEqual([]);
    expect(underlying.activeAdmissionCount()).toBe(0);
  });

  test("recovers an already-at-result HEAD and acknowledges only its durable merged state", async () => {
    const f = await fixture();
    const completion = await f.service.prepareCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [f.attemptRef],
      completion: "implemented",
      logPaths: [],
      mergeOperationId: "merge-already-result",
      operationId: "completion-already-result",
      author: "parent",
    });
    f.setHead(RESULT);
    await expect(f.service.mergeAcknowledgement(completion.completionRef)).rejects.toThrow(
      "not durably merged",
    );
    const underlying = createStrictInMemoryWorksetEffectAdmissionProvider();
    const provider = await implementationCompletionMergeAdmissionProviderFromStore({
      provider: underlying,
      store: f.evidence,
      binding: {
        kind: "merge",
        targetRef: "tasks:T2345",
        repositoryRoot: "/repo",
        commit: RESULT,
        completionRef: completion.completionRef,
        mergeOperationId: "merge-already-result",
      },
      repositoryHead: async () => f.getHead(),
    });
    const admission = await provider.acquire({ kind: "merge", targetRef: "tasks:T2345" });
    await admission.registerProcessGroup({ pgid: 777, leaderPid: 777 });
    await admission.shareWithGuardian({ pgid: 777, leaderPid: 777 });
    expect((await f.evidence.snapshot()).completions[completion.completionRef]!.state).toBe(
      "merged",
    );
    await admission.markSettled();
    await admission.releaseAfterSettlement();
    expect(await f.service.mergeAcknowledgement(completion.completionRef)).toMatchObject({
      completionRef: completion.completionRef,
      mergeOperationId: "merge-already-result",
      repositoryHead: RESULT,
    });
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

    const rawLedger = new InMemoryLedgerStore();
    await rawLedger.init();
    const ledger = protectLedgerStoreWithImplementationEvidence(rawLedger, f.evidence);
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
    await expect(ledger.updateItem(TASKS_LEDGER, "T2345", { status: "abandoned" })).rejects.toThrow(
      "protected implementation evidence",
    );
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
    ).toEqual({ reviewRef: "reviews:R1" });
    expect(ledger.fetchItem(TASKS_LEDGER, "T2345")).toMatchObject({
      status: "done",
      fields: { resultCommit: RESULT, completion: "implemented" },
    });
    expect(ledger.fetchItem(REVIEWS_LEDGER, "R1").fields["implementationEvidence"]).toContain(
      preparedCompletion.completionRef,
    );
    await expect(
      ledger.updateItem(REVIEWS_LEDGER, "R1", {
        fields: { summary: "forged replacement" },
      }),
    ).rejects.toThrow("protected implementation evidence");
    await expect(
      ledger.updateItem(TASKS_LEDGER, "T2345", {
        fields: { completion: "forged replacement" },
      }),
    ).rejects.toThrow("protected implementation evidence");
  });

  test("settles the underlying merge admission when the ff-only process leaves HEAD unchanged", async () => {
    const f = await fixture();
    const completion = await f.service.prepareCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: BASE,
      resultCommit: RESULT,
      workerDispatch: WORKER,
      reviewAttemptRefs: [f.attemptRef],
      completion: "implemented",
      logPaths: [],
      mergeOperationId: "merge-settlement-failure",
      operationId: "completion-settlement-failure",
      author: "parent",
    });
    const provider = await implementationCompletionMergeAdmissionProviderFromStore({
      provider: createStrictInMemoryWorksetEffectAdmissionProvider(),
      store: f.evidence,
      binding: {
        kind: "merge",
        targetRef: "tasks:T2345",
        repositoryRoot: "/repo",
        commit: RESULT,
        completionRef: completion.completionRef,
        mergeOperationId: "merge-settlement-failure",
      },
      repositoryHead: async () => f.getHead(),
    });
    const admission = await provider.acquire({ kind: "merge", targetRef: "tasks:T2345" });
    await admission.registerProcessGroup({ pgid: 456, leaderPid: 456 });
    await admission.shareWithGuardian({ pgid: 456, leaderPid: 456 });
    await expect(admission.markSettled()).resolves.toBeUndefined();
    await admission.releaseAfterSettlement();
    expect((await f.evidence.snapshot()).completions[completion.completionRef]!.state).toBe(
      "merge-started",
    );
  });

  test("a done task missing its required replay binding fails without allocating a review", async () => {
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
    ).rejects.toThrow("missing its terminal implementation review binding");
    expect(() => ledger.fetchItem(REVIEWS_LEDGER, "R1")).toThrow();
  });
});
