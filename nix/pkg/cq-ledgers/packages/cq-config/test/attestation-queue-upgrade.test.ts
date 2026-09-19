import { describe, expect, test } from "bun:test";
import {
  ATTESTATION_TABLE,
  DISPATCH_OVERLAY_REGISTRY,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  PostgresAttestationBackend,
  abortDispatchOn,
  attestationRowDigest,
  claimParentGateOn,
  completeParentGateOn,
  dispatchPayloadDigest,
  fetchDispatchInputOn,
  openAttestationPgPool,
  prepareDispatchOn,
  provenanceBindingOf,
  sequentialDispatchRandomBytes,
  storeDispatchResultOn,
  upgradeLiveImplementationQueueRows,
  type AttestationEnvelope,
  type AttestationBackend,
  type AttestationNamespace,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
  type DispatchPrepared,
  type EnqueueImplementationCandidateRequest,
  type GatePendingResultView,
} from "@cq/config";

const namespace: AttestationNamespace = { backend: "xdg", projectKey: "queue-upgrade" };
const store = new InMemoryAttestationStore(namespace);
const backend = new InMemoryAttestationBackend(store);
let instant = Date.parse("2026-09-19T08:00:00.000Z");
const now = () => new Date(instant).toISOString();
const PG_URL = process.env["CQ_TEST_PG_URL"];

if ((PG_URL === undefined || PG_URL.length === 0) && process.env["CQ_TEST_REQUIRE_PG"] === "1") {
  throw new Error("CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN");
}

interface StagedRow {
  readonly prepared: DispatchPrepared;
  readonly pending: GatePendingResultView;
  readonly binding: DispatchGitEffectBinding;
}

interface StageTarget {
  readonly backend: AttestationBackend;
  readonly namespace: AttestationNamespace;
  readonly now: () => string;
}

async function completeTrustedGreen(
  target: StageTarget,
  staged: StagedRow,
): Promise<DispatchJSONValue> {
  const parentGateCapability = staged.prepared.parentGateCapability;
  if (parentGateCapability === undefined) throw new Error("staged worker has no parent gate");
  const claimed = await claimParentGateOn(
    target.backend,
    { ...staged.prepared, parentGateCapability },
    { now: target.now },
  );
  if (claimed.state !== "gate-running") throw new Error("expected authenticated gate claim");
  const result = claimed.output as Readonly<Record<string, DispatchJSONValue>>;
  const resultCommit = result["resultCommit"];
  if (typeof resultCommit !== "string") throw new Error("staged worker result has no commit");
  const context = claimed.context;
  const supervisedGateEvidence = {
    kind: "cq-supervised-gate-evidence" as const,
    version: 1 as const,
    attestationId: context.attestationId,
    generation: context.generation,
    roleId: "implement-worker" as const,
    roleVersion: context.promptProvenance.version,
    surface: "codex" as const,
    promptDigest: context.promptProvenance.promptDigest,
    catalogHash: context.promptProvenance.catalogHash,
    inputDigest: context.promptProvenance.inputDigest,
    taskId: context.taskId,
    worktreePath: context.worktreePath,
    branch: context.branch,
    baseCommit: context.dispatchBaseCommit,
    startingCommit: context.startingCommit,
    resultCommit,
    clean: true as const,
    command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
    gateExitCode: 0 as const,
    passCount: 1,
    failCount: 0 as const,
    gateDurationMs: 1,
    capturedAt: target.now(),
    filesTouchedDigest: dispatchPayloadDigest(result["filesTouched"] ?? null),
    gitReceiptsDigest: dispatchPayloadDigest(result["gitReceipts"] ?? null),
    mutationTableDigest: dispatchPayloadDigest(result["mutationTable"] ?? null),
  };
  const completed = await completeParentGateOn(
    target.backend,
    {
      ...staged.prepared,
      parentGateCapability,
      gateEpoch: claimed.gateEpoch,
      output: { ...result, supervisedGateEvidence },
    },
    { now: target.now },
  );
  if (completed.state !== "result-stored") throw new Error("trusted gate did not store result");
  return supervisedGateEvidence as unknown as DispatchJSONValue;
}

async function stage(
  taskId: string,
  seed: number,
  target: StageTarget = { backend, namespace, now },
): Promise<StagedRow> {
  const baseCommit = seed.toString(16).padStart(40, "0");
  const resultCommit = (seed + 1).toString(16).padStart(40, "0");
  const binding: DispatchGitEffectBinding = {
    taskId,
    handleToken: `managed-${taskId}`,
    handleFingerprint: seed.toString(16).padStart(64, "0"),
    repositoryRoot: "/repo",
    repositoryId: "a".repeat(64),
    commonDir: "/repo/.git",
    worktreePath: `/repo/.claude/worktrees/${taskId}`,
    branch: `implement/${taskId}`,
    ref: `refs/heads/implement/${taskId}`,
    baseCommit,
  };
  const input: DispatchJSONValue = {
    taskId,
    headline: `Upgrade ${taskId}`,
    description: "Legacy gate-pending queue row.",
    acceptance: "Adopt without inventing completion evidence.",
    worktreePath: binding.worktreePath,
    branch: binding.branch,
    baseCommit,
    round: 0,
    startingCommit: baseCommit,
  };
  const prepared = await prepareDispatchOn(
    target.backend,
    {
      namespace: target.namespace,
      roleId: "implement-worker",
      surface: "codex",
      input,
      idempotencyKey: `upgrade-${taskId}`,
      timeoutMs: 600_000,
      registry: DISPATCH_OVERLAY_REGISTRY,
      promptDigest: "b".repeat(64),
      catalogHash: "c".repeat(64),
      expectedChild: { childId: `child-${taskId}`, runId: `run-${taskId}` },
      gitEffectBinding: binding,
    },
    {
      mode: "manager-bound",
      now: target.now,
      randomBytes: sequentialDispatchRandomBytes(seed),
      lineageFenceGuard: async () => null,
      withLineageLock: async (operation) => await operation(),
    },
  );
  if (!prepared.accepted) throw new Error(prepared.detail);
  await fetchDispatchInputOn(
    target.backend,
    {
      namespace: target.namespace,
      ...prepared.prepared,
      inputCapability: prepared.prepared.inputCapability,
    },
    { now: target.now },
  );
  const stored = await storeDispatchResultOn(
    target.backend,
    {
      resultCapability: prepared.prepared.resultCapability,
      output: {
        taskId,
        status: "pass",
        resultCommit,
        branch: binding.branch,
        actualWorktreePath: binding.worktreePath,
        filesTouched: [],
        gitReceipts: [],
        checkSummary: "focused checks passed",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit,
          headCommit: resultCommit,
        },
        summary: "legacy staged candidate",
      },
    },
    { now: target.now },
  );
  if (stored.state !== "gate-pending")
    throw new Error(`expected gate-pending, got ${stored.state}`);
  return { prepared: prepared.prepared, pending: stored.result, binding };
}

function replaceRow(
  taskId: string,
  change: (row: AttestationEnvelope) => AttestationEnvelope,
): void {
  const row = store
    .rows()
    .find(
      (candidate): candidate is AttestationEnvelope =>
        candidate.kind === "envelope" && candidate.gitEffectBinding?.taskId === taskId,
    );
  if (row === undefined) throw new Error(`missing ${taskId}`);
  store.replace(row, Object.freeze(change(row)));
}

async function replaceTargetRow(
  target: StageTarget,
  taskId: string,
  change: (row: AttestationEnvelope) => AttestationEnvelope,
): Promise<void> {
  await target.backend.transact({ kind: "namespace" }, (attestations) => {
    const row = attestations
      .rows()
      .find(
        (candidate): candidate is AttestationEnvelope =>
          candidate.kind === "envelope" && candidate.gitEffectBinding?.taskId === taskId,
      );
    if (row === undefined) throw new Error(`missing ${taskId}`);
    attestations.replace(row, Object.freeze(change(row)));
  });
}

function rolloutCandidate(
  row: AttestationEnvelope,
  taskId: string,
): Omit<
  EnqueueImplementationCandidateRequest,
  "namespace" | "actor" | "attestationId" | "generation" | "rollout" | "expectedLegacyRowDigest"
> {
  return {
    repositoryId: row.gitEffectBinding!.repositoryId,
    integrationRef: "refs/heads/main",
    authority: {
      taskId,
      goalRef: "goals:G213",
      finalizedManifestDigest: "d".repeat(64),
    },
    observedBaseCommit: row.gitEffectBinding!.baseCommit,
    resultCommit: (row.output as Readonly<Record<string, DispatchJSONValue>>)[
      "resultCommit"
    ] as string,
    resultTree: "e".repeat(40),
    gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
    packagedEnvironmentDigest: "f".repeat(64),
    gitReceipts: [],
    gitEffectBinding: row.gitEffectBinding!,
    stagedOutputDigest: row.gateSubmittedOutputDigest!,
  };
}

describe("live attestation queue rollout [Behavioral-Active Blackbox-Group]", () => {
  test("orders adoption, protects worktrees, and never invents qualification", async () => {
    const unqualified = await stage("T65211", 101);
    instant += 1_000;
    const uncertain = await stage("T65212", 102);
    replaceRow("T65212", (row) => ({
      ...row,
      state: "gate-running",
      gateClaimedAt: now(),
      gateEpoch: 1,
    }));
    instant += 1_000;
    const qualified = await stage("T65213", 103);
    instant += 1_000;
    await stage("T65214", 104);

    const protectedTasks: string[] = [];
    const summary = await upgradeLiveImplementationQueueRows({
      backend,
      now,
      withProtectedManagedWorktree: async (binding, operation) => {
        protectedTasks.push(binding.taskId);
        return { state: "protected", value: await operation() };
      },
      resolve: async (row) => {
        const taskId = row.gitEffectBinding!.taskId;
        if (taskId === "T65214") {
          return { state: "incompatible" as const, detail: { reason: "legacy-output-shape" } };
        }
        const output = row.output as Readonly<Record<string, DispatchJSONValue>>;
        const candidate: Omit<
          EnqueueImplementationCandidateRequest,
          "namespace" | "actor" | "attestationId" | "generation" | "rollout"
        > = {
          repositoryId: row.gitEffectBinding!.repositoryId,
          integrationRef: "refs/heads/main",
          authority: {
            taskId,
            goalRef: "goals:G213",
            finalizedManifestDigest: "d".repeat(64),
          },
          observedBaseCommit: row.gitEffectBinding!.baseCommit,
          resultCommit: output["resultCommit"] as string,
          resultTree: "e".repeat(40),
          gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
          packagedEnvironmentDigest: "f".repeat(64),
          gitReceipts: [],
          gitEffectBinding: row.gitEffectBinding!,
          stagedOutputDigest: row.gateSubmittedOutputDigest!,
        };
        return taskId !== "T65213"
          ? { state: "compatible" as const, candidate }
          : {
              state: "compatible" as const,
              candidate,
              completion: {
                stagedOutputDigest: qualified.pending.outputDigest,
                expectedChild: row.expectedChild,
                expectedProvenance: provenanceBindingOf(qualified.prepared),
                nativeCompletion: {
                  kind: "native-completion" as const,
                  actor: "trusted-parent" as const,
                  childId: row.expectedChild.childId,
                  runId: row.expectedChild.runId,
                  completedAt: now(),
                },
              },
            };
      },
    });

    expect(summary).toMatchObject({
      contract: "g213-t4",
      version: 1,
      considered: 4,
      adoptedUnqualified: 1,
      adoptedQualified: 1,
      adoptedCompletedGreen: 0,
      parkedIncompatible: 1,
      executionUncertain: 1,
    });
    expect(summary.orderedHandles).toEqual([
      `${unqualified.prepared.attestationId}#1`,
      `${uncertain.prepared.attestationId}#1`,
      `${qualified.prepared.attestationId}#1`,
      `${store.rows().find((row) => row.kind === "envelope" && row.gitEffectBinding?.taskId === "T65214")!.attestationId}#1`,
    ]);
    expect(protectedTasks).toEqual(["T65211", "T65212", "T65213", "T65214"]);

    const byTask = new Map(
      store
        .rows()
        .flatMap((row) =>
          row.kind === "envelope" && row.gitEffectBinding !== undefined
            ? [[row.gitEffectBinding.taskId, row] as const]
            : [],
        ),
    );
    expect(byTask.get("T65211")?.implementationQueue?.state).toBe("enqueued");
    expect(byTask.get("T65211")?.stagedCompletionQualification).toBeUndefined();
    expect(byTask.get("T65213")?.implementationQueue?.state).toBe("qualified");
    expect(byTask.get("T65213")?.implementationQueueRollout?.disposition).toBe("adopted-qualified");
    expect(byTask.get("T65212")?.implementationQueue).toBeUndefined();
    expect(byTask.get("T65212")?.implementationQueueRollout?.disposition).toBe(
      "execution-uncertain",
    );
    expect(byTask.get("T65214")?.implementationQueueRollout?.disposition).toBe(
      "parked-incompatible",
    );
    expect(byTask.get("T65214")?.implementationQueueRollout?.diagnosticArtifact).toEqual({
      kind: "cq-implementation-queue-rollout-diagnostic",
      version: 1,
      detail: { reason: "legacy-output-shape" },
    });
  });

  test("accepts completed green evidence only when every durable binding is exact", async () => {
    instant += 1_000;
    const trusted = await stage("T65215", 105);
    const supervisedGateEvidence = await completeTrustedGreen({ backend, namespace, now }, trusted);
    const completed = store
      .rows()
      .find(
        (row): row is AttestationEnvelope =>
          row.kind === "envelope" && row.gitEffectBinding?.taskId === "T65215",
      )!;

    const summary = await upgradeLiveImplementationQueueRows({
      backend,
      now,
      withProtectedManagedWorktree: async (_binding, operation) => ({
        state: "protected",
        value: await operation(),
      }),
      resolve: async (row) => ({
        state: "completed-green",
        evidence: {
          outputDigest: row.outputDigest!,
          resultCommit: (row.output as Readonly<Record<string, DispatchJSONValue>>)[
            "resultCommit"
          ] as string,
          managedWorktreeBindingDigest: dispatchPayloadDigest(
            row.gitEffectBinding as unknown as DispatchJSONValue,
          ),
          supervisedGateEvidenceDigest: dispatchPayloadDigest(
            supervisedGateEvidence as unknown as DispatchJSONValue,
          ),
        },
      }),
    });
    expect(summary.adoptedCompletedGreen).toBe(1);
    const migrated = store.read(completed)! as AttestationEnvelope;
    expect(migrated.implementationQueue).toBeUndefined();
    expect(migrated.implementationQueueRollout?.disposition).toBe("adopted-completed-green");

    instant += 1_000;
    const mismatchedStage = await stage("T65217", 107);
    const mismatchedGateEvidence = await completeTrustedGreen(
      { backend, namespace, now },
      mismatchedStage,
    );
    const mismatched = store
      .rows()
      .find(
        (row): row is AttestationEnvelope =>
          row.kind === "envelope" && row.gitEffectBinding?.taskId === "T65217",
      )!;
    const mismatchSummary = await upgradeLiveImplementationQueueRows({
      backend,
      now,
      withProtectedManagedWorktree: async (_binding, operation) => ({
        state: "protected",
        value: await operation(),
      }),
      resolve: async (row) => ({
        state: "completed-green",
        evidence: {
          outputDigest: row.outputDigest!,
          resultCommit: "0".repeat(40),
          managedWorktreeBindingDigest: dispatchPayloadDigest(
            row.gitEffectBinding as unknown as DispatchJSONValue,
          ),
          supervisedGateEvidenceDigest: dispatchPayloadDigest(mismatchedGateEvidence),
        },
      }),
    });
    expect(mismatchSummary).toMatchObject({
      adoptedCompletedGreen: 0,
      parkedIncompatible: 1,
    });
    expect(
      (store.read(mismatched) as AttestationEnvelope).implementationQueueRollout,
    ).toMatchObject({
      disposition: "parked-incompatible",
      diagnosticArtifact: {
        detail: { reason: "completed-green-evidence-binding-mismatch" },
      },
    });
  });

  test("keeps an inexact recovered completion unqualified", async () => {
    instant += 1_000;
    const staged = await stage("T65218", 108);
    const summary = await upgradeLiveImplementationQueueRows({
      backend,
      now,
      withProtectedManagedWorktree: async (_binding, operation) => ({
        state: "protected",
        value: await operation(),
      }),
      resolve: async (row) => ({
        state: "compatible" as const,
        candidate: {
          repositoryId: row.gitEffectBinding!.repositoryId,
          integrationRef: "refs/heads/main",
          authority: {
            taskId: "T65218",
            goalRef: "goals:G213",
            finalizedManifestDigest: "d".repeat(64),
          },
          observedBaseCommit: row.gitEffectBinding!.baseCommit,
          resultCommit: (row.output as Readonly<Record<string, DispatchJSONValue>>)[
            "resultCommit"
          ] as string,
          resultTree: "e".repeat(40),
          gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
          packagedEnvironmentDigest: "f".repeat(64),
          gitReceipts: [],
          gitEffectBinding: row.gitEffectBinding!,
          stagedOutputDigest: row.gateSubmittedOutputDigest!,
        },
        completion: {
          stagedOutputDigest: "0".repeat(64),
          expectedChild: row.expectedChild,
          expectedProvenance: provenanceBindingOf(staged.prepared),
          nativeCompletion: {
            kind: "native-completion" as const,
            actor: "trusted-parent" as const,
            childId: row.expectedChild.childId,
            runId: row.expectedChild.runId,
            completedAt: now(),
          },
        },
      }),
    });

    expect(summary).toMatchObject({ adoptedUnqualified: 1, adoptedQualified: 0 });
    const migrated = store.read(staged.prepared) as AttestationEnvelope;
    expect(migrated.implementationQueue?.state).toBe("enqueued");
    expect(migrated.stagedCompletionQualification).toBeUndefined();
  });

  test("fences a legacy row changed during asynchronous resolution", async () => {
    instant += 1_000;
    const staged = await stage("T65219", 109);
    let releaseResolution!: () => void;
    const resolutionReleased = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let markResolutionStarted!: () => void;
    const resolutionStarted = new Promise<void>((resolve) => {
      markResolutionStarted = resolve;
    });
    const upgrading = upgradeLiveImplementationQueueRows({
      backend,
      now,
      withProtectedManagedWorktree: async (_binding, operation) => ({
        state: "protected",
        value: await operation(),
      }),
      resolve: async (row) => {
        markResolutionStarted();
        await resolutionReleased;
        return {
          state: "compatible" as const,
          candidate: {
            repositoryId: row.gitEffectBinding!.repositoryId,
            integrationRef: "refs/heads/main",
            authority: {
              taskId: "T65219",
              goalRef: "goals:G213",
              finalizedManifestDigest: "d".repeat(64),
            },
            observedBaseCommit: row.gitEffectBinding!.baseCommit,
            resultCommit: (row.output as Readonly<Record<string, DispatchJSONValue>>)[
              "resultCommit"
            ] as string,
            resultTree: "e".repeat(40),
            gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
            packagedEnvironmentDigest: "f".repeat(64),
            gitReceipts: [],
            gitEffectBinding: row.gitEffectBinding!,
            stagedOutputDigest: row.gateSubmittedOutputDigest!,
          },
        };
      },
    });
    await resolutionStarted;
    instant += 1_000;
    replaceRow("T65219", (row) => ({ ...row, gateSubmittedAt: now() }));
    releaseResolution();

    await expect(upgrading).rejects.toThrow("changed during rollout");
    const persisted = store.read(staged.prepared) as AttestationEnvelope;
    expect(persisted.implementationQueue).toBeUndefined();
    expect(persisted.implementationQueueRollout).toBeUndefined();
  });

  test.skipIf(PG_URL === undefined)(
    "persists the full disposition matrix and skipped terminal states across PostgreSQL reopen",
    async () => {
      const pgNamespace: AttestationNamespace = {
        backend: "postgres",
        projectKey: `queue-upgrade-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
      };
      const pool = openAttestationPgPool(PG_URL!);
      const pgBackend = await PostgresAttestationBackend.open({
        namespace: pgNamespace,
        pool,
      });
      let pgInstant = Date.parse("2026-09-19T08:30:00.000Z");
      const pgNow = () => new Date(pgInstant++).toISOString();
      const target = { backend: pgBackend, namespace: pgNamespace, now: pgNow };
      let reopened: PostgresAttestationBackend | undefined;
      try {
        const unqualified = await stage("T65216", 106, target);
        const qualified = await stage("T65220", 120, target);
        const running = await stage("T65221", 121, target);
        await replaceTargetRow(target, "T65221", (row) => ({
          ...row,
          state: "gate-running",
          gateClaimedAt: pgNow(),
          gateEpoch: 1,
        }));
        const completed = await stage("T65222", 122, target);
        const supervisedGateEvidence = await completeTrustedGreen(target, completed);
        const incompatible = await stage("T65223", 123, target);
        const prepared = await stage("T65224", 124, target);
        await replaceTargetRow(target, "T65224", (row) => ({ ...row, state: "prepared" }));
        const consumed = await stage("T65225", 125, target);
        await replaceTargetRow(target, "T65225", (row) => ({
          ...row,
          state: "consumed",
          consumedAt: pgNow(),
          terminalAt: pgNow(),
        }));
        const aborted = await stage("T65226", 126, target);
        await abortDispatchOn(
          pgBackend,
          {
            namespace: pgNamespace,
            actor: "trusted-parent",
            attestationId: aborted.prepared.attestationId,
            generation: aborted.prepared.generation,
            reason: "cancelled",
          },
          { now: pgNow },
        );
        const ignoredBefore = await pgBackend.transact(
          { kind: "namespace" },
          (attestations) =>
            new Map(
              attestations
                .rows()
                .filter(
                  (row): row is AttestationEnvelope =>
                    row.kind === "envelope" &&
                    ["T65224", "T65225", "T65226"].includes(row.gitEffectBinding?.taskId ?? ""),
                )
                .map((row) => [row.gitEffectBinding!.taskId, attestationRowDigest(row)] as const),
            ),
        );
        const protectedTasks: string[] = [];
        const summary = await upgradeLiveImplementationQueueRows({
          backend: pgBackend,
          now: pgNow,
          withProtectedManagedWorktree: async (binding, operation) => {
            protectedTasks.push(binding.taskId);
            return { state: "protected", value: await operation() };
          },
          resolve: async (row) => {
            const taskId = row.gitEffectBinding!.taskId;
            if (taskId === "T65223") {
              return { state: "incompatible" as const, detail: { reason: "legacy-shape" } };
            }
            if (taskId === "T65222") {
              return {
                state: "completed-green" as const,
                evidence: {
                  outputDigest: row.outputDigest!,
                  resultCommit: (row.output as Readonly<Record<string, DispatchJSONValue>>)[
                    "resultCommit"
                  ] as string,
                  managedWorktreeBindingDigest: dispatchPayloadDigest(
                    row.gitEffectBinding as unknown as DispatchJSONValue,
                  ),
                  supervisedGateEvidenceDigest: dispatchPayloadDigest(supervisedGateEvidence),
                },
              };
            }
            return {
              state: "compatible" as const,
              candidate: rolloutCandidate(row, taskId),
              ...(taskId !== "T65220"
                ? {}
                : {
                    completion: {
                      stagedOutputDigest: qualified.pending.outputDigest,
                      expectedChild: row.expectedChild,
                      expectedProvenance: provenanceBindingOf(qualified.prepared),
                      nativeCompletion: {
                        kind: "native-completion" as const,
                        actor: "trusted-parent" as const,
                        childId: row.expectedChild.childId,
                        runId: row.expectedChild.runId,
                        completedAt: pgNow(),
                      },
                    },
                  }),
            };
          },
        });

        expect(summary).toMatchObject({
          contract: "g213-t4",
          considered: 5,
          adoptedUnqualified: 1,
          adoptedQualified: 1,
          adoptedCompletedGreen: 1,
          parkedIncompatible: 1,
          executionUncertain: 1,
        });
        expect(protectedTasks).toEqual(["T65216", "T65220", "T65221", "T65222", "T65223"]);
        expect(summary.orderedHandles).toHaveLength(5);

        await pgBackend.close();
        reopened = await PostgresAttestationBackend.open({ namespace: pgNamespace, pool });
        const byTask = new Map(
          (await reopened.storedRows()).flatMap((row) =>
            row.kind === "envelope" && row.gitEffectBinding !== undefined
              ? [[row.gitEffectBinding.taskId, row] as const]
              : [],
          ),
        );
        expect(byTask.get("T65216")?.implementationQueue?.state).toBe("enqueued");
        expect(byTask.get("T65220")?.implementationQueue?.state).toBe("qualified");
        expect(byTask.get("T65221")?.implementationQueueRollout?.disposition).toBe(
          "execution-uncertain",
        );
        expect(byTask.get("T65222")?.implementationQueueRollout?.disposition).toBe(
          "adopted-completed-green",
        );
        expect(byTask.get("T65223")?.implementationQueueRollout?.disposition).toBe(
          "parked-incompatible",
        );
        for (const taskId of ["T65224", "T65225", "T65226"]) {
          const row = byTask.get(taskId);
          if (row === undefined) throw new Error(`missing ignored row ${taskId}`);
          const expectedDigest = ignoredBefore.get(taskId);
          if (expectedDigest === undefined) throw new Error(`missing ignored digest ${taskId}`);
          expect(attestationRowDigest(row)).toBe(expectedDigest);
          expect(row.implementationQueue).toBeUndefined();
          expect(row.implementationQueueRollout).toBeUndefined();
        }
        expect(byTask.get("T65224")?.state).toBe("prepared");
        expect(byTask.get("T65225")?.state).toBe("consumed");
        expect(byTask.get("T65226")?.state).toBe("aborted");
        expect(unqualified.binding.taskId).toBe("T65216");
        expect(running.binding.taskId).toBe("T65221");
        expect(completed.binding.taskId).toBe("T65222");
        expect(incompatible.binding.taskId).toBe("T65223");
        expect(prepared.binding.taskId).toBe("T65224");
        expect(consumed.binding.taskId).toBe("T65225");
      } finally {
        await pool`
          DELETE FROM ${pool(ATTESTATION_TABLE)}
           WHERE backend = ${pgNamespace.backend} AND project_key = ${pgNamespace.projectKey}
        `.catch(() => undefined);
        await reopened?.close().catch(() => undefined);
        await pgBackend.close().catch(() => undefined);
        await pool.close().catch(() => undefined);
      }
    },
  );
});
