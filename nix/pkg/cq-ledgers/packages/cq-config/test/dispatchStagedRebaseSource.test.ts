import { describe, expect, test } from "bun:test";
import {
  DISPATCH_OVERLAY_REGISTRY,
  DispatchAuthorizationError,
  DispatchStagedRebaseSourceError,
  FakeDispatchClock,
  IDEMPOTENCY_HORIZON_MS,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  TERMINAL_ENVELOPE_RETENTION_MS,
  acquireImplementationCandidateOn,
  claimParentGateOn,
  completeParentGateOn,
  confirmDispatchCompletionOn,
  enqueueImplementationCandidateOn,
  fetchDispatchInputOn,
  fetchDispatchResultOn,
  prepareDispatchOn,
  provenanceBindingOf,
  qualifyDispatchStagedCompletionOn,
  retireDispatchStagedRebaseSourceOn,
  sequentialDispatchRandomBytes,
  storeDispatchResultOn,
  sweepAttestationsOn,
  terminalizeImplementationCandidateOn,
  type AttestationNamespace,
  type DispatchGitChangeReceipt,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
  type DispatchPrepared,
  type EnqueueImplementationCandidateRequest,
  type GatePendingResultView,
  type ImplementationQueueControl,
  type NativeCompletionProof,
  type RetireDispatchStagedRebaseSourceRequest,
} from "@cq/config";

const namespace: AttestationNamespace = { backend: "xdg", projectKey: "staged-rebase-source" };
const clock = new FakeDispatchClock("2026-09-15T10:00:00.000Z");
const child = { childId: "codex-child-rebase", runId: "codex-run-rebase" } as const;
const baseCommit = "1".repeat(40);
const resultCommit = "2".repeat(40);
const resultTree = "3".repeat(40);
const ontoCommit = "4".repeat(40);
const binding: DispatchGitEffectBinding = {
  taskId: "T6518",
  handleToken: "managed-handle-staged-rebase",
  handleFingerprint: "5".repeat(64),
  repositoryRoot: "/repo",
  repositoryId: "6".repeat(64),
  commonDir: "/repo/.git",
  worktreePath: "/repo/.claude/worktrees/T6518",
  branch: "implement/T6518",
  ref: "refs/heads/implement/T6518",
  baseCommit,
};
const authority = {
  taskId: "T6518",
  goalRef: "goals:G6518",
  finalizedManifestDigest: "7".repeat(64),
} as const;
const packagedEnvironmentDigest = "8".repeat(64);
const guardedRebase = `cq-guarded-rebase:v1:${"9".repeat(64)}`;
const guardedRebaseJournalDigest = "a".repeat(64);
const randomBytesByBackend = new WeakMap<
  InMemoryAttestationBackend,
  ReturnType<typeof sequentialDispatchRandomBytes>
>();

function input(base: string, startingCommit: string, round: number): DispatchJSONValue {
  return {
    taskId: "T6518",
    headline: "Retire a staged rebase source",
    description: "Bind one staged candidate to one guarded successor.",
    acceptance: "Only the exact retired source allocates a successor.",
    worktreePath: binding.worktreePath,
    branch: binding.branch,
    baseCommit: base,
    round,
    startingCommit,
  };
}

function stagedOutput(
  commit: string,
  gitReceipts: readonly DispatchGitChangeReceipt[] = [],
): Readonly<Record<string, DispatchJSONValue>> {
  return {
    taskId: "T6518",
    status: "pass",
    resultCommit: commit,
    branch: binding.branch,
    actualWorktreePath: binding.worktreePath,
    filesTouched: ["packages/cq-config/src/dispatchImplementationQueue.ts"],
    gitReceipts,
    checkSummary: "focused checks passed",
    baseVerification: {
      status: "verified",
      relation: "descendant",
      baseCommit: commit === resultCommit ? baseCommit : ontoCommit,
      headCommit: commit,
    },
    summary: "candidate staged",
  };
}

function completion(): NativeCompletionProof {
  return {
    kind: "native-completion",
    actor: "trusted-parent",
    childId: child.childId,
    runId: child.runId,
    completedAt: "2026-09-15T10:01:00.000Z",
  };
}

async function prepare(
  backend: InMemoryAttestationBackend,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<DispatchPrepared> {
  let randomBytes = randomBytesByBackend.get(backend);
  if (randomBytes === undefined) {
    randomBytes = sequentialDispatchRandomBytes(6518);
    randomBytesByBackend.set(backend, randomBytes);
  }
  const outcome = await prepareDispatchOn(
    backend,
    {
      namespace,
      roleId: "implement-worker",
      surface: "codex",
      input: input(baseCommit, baseCommit, 0),
      idempotencyKey: "staged-rebase-source-1",
      timeoutMs: 600_000,
      registry: DISPATCH_OVERLAY_REGISTRY,
      promptDigest: "b".repeat(64),
      catalogHash: "c".repeat(64),
      expectedChild: child,
      gitEffectBinding: binding,
      ...overrides,
    },
    {
      mode: "manager-bound",
      now: clock.now,
      randomBytes,
      lineageFenceGuard: async () => null,
      withLineageLock: async (operation) => await operation(),
    },
  );
  if (!outcome.accepted) throw new Error(`prepare rejected: ${outcome.reason}`);
  await fetchDispatchInputOn(
    backend,
    {
      namespace,
      attestationId: outcome.prepared.attestationId,
      generation: outcome.prepared.generation,
      inputCapability: outcome.prepared.inputCapability,
    },
    { now: clock.now },
  );
  return outcome.prepared;
}

async function enqueue(
  backend: InMemoryAttestationBackend,
  prepared: DispatchPrepared,
  pending: GatePendingResultView,
  effectBinding: DispatchGitEffectBinding,
  commit: string,
  tree: string,
  observedBaseCommit: string,
  source?: EnqueueImplementationCandidateRequest["stagedRebaseSource"],
  gitReceipts: readonly DispatchGitChangeReceipt[] = [],
): Promise<ImplementationQueueControl> {
  return await enqueueImplementationCandidateOn(
    backend,
    {
      namespace,
      actor: "trusted-parent",
      attestationId: prepared.attestationId,
      generation: prepared.generation,
      repositoryId: binding.repositoryId,
      integrationRef: "refs/heads/main",
      authority,
      observedBaseCommit,
      resultCommit: commit,
      resultTree: tree,
      gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
      packagedEnvironmentDigest,
      gitReceipts,
      gitEffectBinding: effectBinding,
      stagedOutputDigest: pending.outputDigest,
      ...(source === undefined ? {} : { stagedRebaseSource: source }),
    },
    { now: clock.now },
  );
}

async function qualifiedAndLeased(withReceipt = false): Promise<{
  readonly backend: InMemoryAttestationBackend;
  readonly prepared: DispatchPrepared;
  readonly pending: GatePendingResultView;
  readonly queue: ImplementationQueueControl;
  readonly retirement: RetireDispatchStagedRebaseSourceRequest;
  readonly gitReceipts: readonly DispatchGitChangeReceipt[];
}> {
  const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
  const prepared = await prepare(backend);
  const gitReceipts: readonly DispatchGitChangeReceipt[] = withReceipt
    ? [
        {
          kind: "cq-git-change-receipt",
          version: 1,
          attestationId: prepared.attestationId,
          generation: prepared.generation,
          taskId: binding.taskId,
          operationId: "consumed-ordinary-result",
          requestDigest: "0".repeat(64),
          oldHead: baseCommit,
          newHead: resultCommit,
          tree: resultTree,
          objectOids: [resultCommit],
          paths: ["file.txt"],
          committedAt: clock.peek(),
        },
      ]
    : [];
  const stored = await storeDispatchResultOn(
    backend,
    {
      resultCapability: prepared.resultCapability,
      output: stagedOutput(resultCommit, gitReceipts),
    },
    { now: clock.now },
  );
  if (stored.state !== "gate-pending") throw new Error("expected gate-pending staging");
  const queue = await enqueue(
    backend,
    prepared,
    stored.result,
    binding,
    resultCommit,
    resultTree,
    baseCommit,
    undefined,
    gitReceipts,
  );
  await qualifyDispatchStagedCompletionOn(
    backend,
    {
      namespace,
      actor: "trusted-parent",
      attestationId: prepared.attestationId,
      generation: prepared.generation,
      partitionKey: queue.partition.partitionKey,
      enrollmentId: queue.enrollment.enrollmentId,
      attemptId: queue.attempt.attemptId,
      stagedOutputDigest: stored.result.outputDigest,
      expectedChild: child,
      expectedProvenance: provenanceBindingOf(prepared),
      nativeCompletion: completion(),
    },
    { now: clock.now },
  );
  const acquired = await acquireImplementationCandidateOn(
    backend,
    {
      namespace,
      actor: "trusted-parent",
      partitionKey: queue.partition.partitionKey,
      holderId: "parent-gate-rebase",
    },
    { now: clock.now },
  );
  if (acquired.state !== "leased") throw new Error("expected leased queue front");
  const retirement: RetireDispatchStagedRebaseSourceRequest = {
    namespace,
    actor: "trusted-parent",
    ...acquired.lease,
    expectedPartitionRevision: acquired.partitionRevision,
    stagedOutputDigest: stored.result.outputDigest,
    effectLock: {
      kind: "managed-worktree-effect-lock",
      bindingDigest: queue.attempt.managedWorktreeBindingDigest,
    },
    live: {
      clean: true,
      liveTip: resultCommit,
      resultCommit,
      resultTree,
      repositoryId: binding.repositoryId,
      worktreePath: binding.worktreePath,
      gitReceipts,
    },
    ontoCommit,
    guardedRebase,
    guardedRebaseJournalDigest,
  };
  return { backend, prepared, pending: stored.result, queue, retirement, gitReceipts };
}

describe("staged-rebase source retirement", () => {
  test("exact retirement is replay-safe, revokes old paths, and survives tombstone projection", async () => {
    const { backend, prepared, retirement } = await qualifiedAndLeased();
    const source = await retireDispatchStagedRebaseSourceOn(backend, retirement, {
      now: clock.now,
    });
    expect(
      await retireDispatchStagedRebaseSourceOn(backend, retirement, { now: clock.now }),
    ).toEqual(source);
    await expect(
      retireDispatchStagedRebaseSourceOn(
        backend,
        { ...retirement, ontoCommit: "d".repeat(40) },
        { now: clock.now },
      ),
    ).rejects.toThrow(DispatchStagedRebaseSourceError);
    await expect(
      claimParentGateOn(
        backend,
        {
          attestationId: prepared.attestationId,
          generation: prepared.generation,
          parentGateCapability: prepared.parentGateCapability!,
          queueLease: retirement,
        },
        { now: clock.now },
      ),
    ).rejects.toThrow(DispatchAuthorizationError);
    expect(
      await fetchDispatchResultOn(
        backend,
        {
          namespace,
          actor: "trusted-parent",
          attestationId: prepared.attestationId,
          generation: prepared.generation,
        },
        { now: clock.now },
      ),
    ).toMatchObject({ state: "aborted", reason: "staged-rebase" });

    clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
    await sweepAttestationsOn(backend, { now: clock.now });
    backend.rehydrate();
    expect(backend.storedRows()[0]).toMatchObject({
      kind: "tombstone",
      stagedRebaseSourceBinding: {
        sourceReference: source.sourceReference,
        serverBindingDigest: source.serverBindingDigest,
      },
      implementationQueue: {
        enrollmentId: retirement.enrollmentId,
        state: "staged-rebase-retired",
      },
    });
    clock.advance(IDEMPOTENCY_HORIZON_MS - TERMINAL_ENVELOPE_RETENTION_MS);
    await sweepAttestationsOn(backend, { now: clock.now });
    expect(backend.storedRows()).toHaveLength(0);
  });

  test("staged-rebase-retired queue control cannot be terminalized", async () => {
    const { backend, prepared, retirement } = await qualifiedAndLeased();
    const source = await retireDispatchStagedRebaseSourceOn(backend, retirement, {
      now: clock.now,
    });
    const retiredRow = await backend.transact({ kind: "namespace" }, (store) =>
      store.read(prepared),
    );
    if (retiredRow?.kind !== "envelope" || retiredRow.implementationQueue === undefined) {
      throw new Error("retired queue row missing");
    }

    await expect(
      terminalizeImplementationCandidateOn(
        backend,
        {
          namespace,
          actor: "trusted-parent",
          attestationId: prepared.attestationId,
          generation: prepared.generation,
          partitionKey: retiredRow.implementationQueue.partition.partitionKey,
          enrollmentId: retiredRow.implementationQueue.enrollment.enrollmentId,
          attemptId: retiredRow.implementationQueue.attempt.attemptId,
          expectedPartitionRevision: retiredRow.implementationQueue.partitionRevision,
          reason: "native-failure",
        },
        { now: clock.now },
      ),
    ).rejects.toMatchObject({ reason: "already-terminal" });
    expect(
      await fetchDispatchResultOn(
        backend,
        {
          namespace,
          actor: "trusted-parent",
          attestationId: prepared.attestationId,
          generation: prepared.generation,
        },
        { now: clock.now },
      ),
    ).toMatchObject({ state: "aborted", reason: "staged-rebase" });
    const afterConflict = await backend.transact({ kind: "namespace" }, (store) =>
      store.read(prepared),
    );
    expect(afterConflict).toMatchObject({
      implementationQueue: {
        state: "staged-rebase-retired",
        stagedRebaseSource: { serverBindingDigest: source.serverBindingDigest },
      },
    });
  });

  test("the retired source binds exactly one successor attempt to the original enrollment", async () => {
    const { backend, prepared, queue, retirement } = await qualifiedAndLeased();
    const source = await retireDispatchStagedRebaseSourceOn(backend, retirement, {
      now: clock.now,
    });
    clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
    await sweepAttestationsOn(backend, { now: clock.now });
    backend.rehydrate();
    expect(backend.storedRows()[0]?.kind).toBe("tombstone");
    const rebasedStartCommit = "d".repeat(40);
    const successorResult = "e".repeat(40);
    const successorTree = "f".repeat(40);
    const successorBinding: DispatchGitEffectBinding = {
      ...binding,
      guardedRebaseBridge: {
        guardedRebase,
        operationId: "staged-rebase-successor",
        requestDigest: guardedRebaseJournalDigest,
        oldResultCommit: resultCommit,
        ontoCommit,
        rebasedStartCommit,
        outcome: "clean",
        exactTip: true,
        finalizedAt: clock.peek(),
      },
    };
    const successor = await prepare(backend, {
      input: input(ontoCommit, rebasedStartCommit, 1),
      idempotencyKey: "staged-rebase-successor-2",
      reprepareOf: { attestationId: prepared.attestationId, generation: prepared.generation },
      gitEffectBinding: successorBinding,
    });
    const stored = await storeDispatchResultOn(
      backend,
      { resultCapability: successor.resultCapability, output: stagedOutput(successorResult) },
      { now: clock.now },
    );
    if (stored.state !== "gate-pending") throw new Error("expected successor staging");
    const sourceClaim = {
      sourceReference: source.sourceReference,
      source: source.source,
      leaseGeneration: source.leaseGeneration,
      guardedRebase: source.guardedRebase,
      ontoCommit: source.ontoCommit,
      guardedRebaseJournalDigest: source.guardedRebaseJournalDigest,
    };
    const successorQueue = await enqueue(
      backend,
      successor,
      stored.result,
      successorBinding,
      successorResult,
      successorTree,
      ontoCommit,
      sourceClaim,
    );
    expect(successorQueue.enrollment.enrollmentId).toBe(queue.enrollment.enrollmentId);
    expect(successorQueue.enrollment.admissionOrdinal).toBe(queue.enrollment.admissionOrdinal);
    backend.rehydrate();
    expect(
      await enqueue(
        backend,
        successor,
        stored.result,
        successorBinding,
        successorResult,
        successorTree,
        ontoCommit,
        sourceClaim,
      ),
    ).toEqual(successorQueue);
    await expect(
      enqueue(
        backend,
        successor,
        stored.result,
        successorBinding,
        successorResult,
        successorTree,
        ontoCommit,
        {
          ...sourceClaim,
          guardedRebaseJournalDigest: "0".repeat(64),
        },
      ),
    ).rejects.toThrow(DispatchStagedRebaseSourceError);
    const retired = backend.storedRows().find((row) => row.generation === prepared.generation);
    expect(retired).toMatchObject({
      stagedRebaseSourceBinding: {
        successor: {
          attestationId: successor.attestationId,
          generation: successor.generation,
        },
      },
    });
  });

  test("a consumed ordinary queue completion remains eligible for guarded continuation", async () => {
    const { backend, prepared, retirement, gitReceipts } = await qualifiedAndLeased(true);
    if (prepared.parentGateCapability === undefined) {
      throw new Error("managed worker omitted its parent gate capability");
    }
    const claimed = await claimParentGateOn(
      backend,
      {
        attestationId: prepared.attestationId,
        generation: prepared.generation,
        parentGateCapability: prepared.parentGateCapability,
        queueLease: retirement,
      },
      { now: clock.now },
    );
    if (claimed.state !== "gate-running") throw new Error("expected claimed parent gate");
    await completeParentGateOn(
      backend,
      {
        attestationId: prepared.attestationId,
        generation: prepared.generation,
        parentGateCapability: prepared.parentGateCapability,
        queueLease: retirement,
        gateEpoch: claimed.gateEpoch,
        output: {
          ...stagedOutput(resultCommit, gitReceipts),
          supervisedGateEvidence: {
            kind: "cq-supervised-gate-evidence",
            version: 1,
            attestationId: prepared.attestationId,
            generation: prepared.generation,
            roleId: "implement-worker",
            roleVersion: prepared.promptProvenance.version,
            surface: "codex",
            promptDigest: prepared.promptProvenance.promptDigest,
            catalogHash: prepared.promptProvenance.catalogHash,
            inputDigest: prepared.promptProvenance.inputDigest,
            taskId: binding.taskId,
            worktreePath: binding.worktreePath,
            branch: binding.branch,
            baseCommit,
            startingCommit: baseCommit,
            resultCommit,
            clean: true,
            command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
            gateExitCode: 0,
            passCount: 1,
            failCount: 0,
            gateDurationMs: 1,
            capturedAt: clock.now(),
            filesTouchedDigest: "d".repeat(64),
            gitReceiptsDigest: "e".repeat(64),
            mutationTableDigest: "f".repeat(64),
          },
        },
      },
      { now: clock.now },
    );
    await confirmDispatchCompletionOn(
      backend,
      {
        namespace,
        attestationId: prepared.attestationId,
        generation: prepared.generation,
        nativeCompletion: completion(),
        expectedProvenance: provenanceBindingOf(prepared),
        continuationContext: {
          liveTip: resultCommit,
          gitReceipts,
        },
      },
      { now: clock.now },
    );
    const consumed = await backend.transact({ kind: "namespace" }, (store) =>
      store.read(prepared),
    );
    expect(consumed).toMatchObject({
      state: "consumed",
      implementationQueue: {
        state: "leased",
        lease: {
          holderId: retirement.holderId,
          generation: retirement.leaseGeneration,
        },
        qualification: { qualificationDigest: expect.any(String) },
      },
    });
    backend.rehydrate();

    const rebasedStartCommit = "d".repeat(40);
    const successorBridge = {
      guardedRebase,
      operationId: "consumed-ordinary-guarded-successor",
      requestDigest: guardedRebaseJournalDigest,
      oldResultCommit: resultCommit,
      ontoCommit,
      rebasedStartCommit,
      outcome: "clean" as const,
      exactTip: true,
      finalizedAt: clock.peek(),
    };
    await expect(
      prepare(backend, {
        input: input(ontoCommit, rebasedStartCommit, 1),
        idempotencyKey: "consumed-ordinary-foreign-result",
        reprepareOf: { attestationId: prepared.attestationId, generation: prepared.generation },
        gitEffectBinding: {
          ...binding,
          guardedRebaseBridge: { ...successorBridge, oldResultCommit: baseCommit },
        },
      }),
    ).rejects.toThrow("not a retired implementation queue enrollment");
    await expect(
      prepare(backend, {
        input: input(ontoCommit, rebasedStartCommit, 1),
        idempotencyKey: "consumed-ordinary-foreign-manager",
        reprepareOf: { attestationId: prepared.attestationId, generation: prepared.generation },
        gitEffectBinding: {
          ...binding,
          repositoryId: "0".repeat(64),
          guardedRebaseBridge: successorBridge,
        },
      }),
    ).rejects.toThrow("not a retired implementation queue enrollment");
    const successor = await prepare(backend, {
      input: input(ontoCommit, rebasedStartCommit, 1),
      idempotencyKey: "consumed-ordinary-guarded-successor",
      reprepareOf: { attestationId: prepared.attestationId, generation: prepared.generation },
      gitEffectBinding: {
        ...binding,
        guardedRebaseBridge: successorBridge,
      },
    });
    expect(successor.generation).toBe(prepared.generation + 1);
    backend.rehydrate();
    const retiredSourceRow = backend
      .storedRows()
      .find(
        (row) =>
          row.attestationId === prepared.attestationId && row.generation === prepared.generation,
      );
    expect(retiredSourceRow).toMatchObject({
      state: "consumed",
      implementationQueue: {
        state: "staged-rebase-retired",
        terminal: { reason: "staged-rebase" },
        stagedRebaseSource: {
          successor: {
            attestationId: successor.attestationId,
            generation: successor.generation,
          },
        },
      },
    });
    if (
      retiredSourceRow?.implementationQueue === undefined ||
      !("attempt" in retiredSourceRow.implementationQueue) ||
      retiredSourceRow.implementationQueue.stagedRebaseSource === undefined
    ) {
      throw new Error("consumed source did not persist its guarded successor authority");
    }
    expect(retiredSourceRow.implementationQueue.lease).toBeUndefined();
    const retiredSource = retiredSourceRow.implementationQueue.stagedRebaseSource;
    await expect(
      prepare(backend, {
        input: input(ontoCommit, rebasedStartCommit, 1),
        idempotencyKey: "consumed-ordinary-second-successor",
        reprepareOf: { attestationId: prepared.attestationId, generation: prepared.generation },
        gitEffectBinding: {
          ...binding,
          guardedRebaseBridge: successorBridge,
        },
      }),
    ).rejects.toThrow("already allocated a successor");
    const successorBinding: DispatchGitEffectBinding = {
      ...binding,
      guardedRebaseBridge: successorBridge,
    };
    const successorStored = await storeDispatchResultOn(
      backend,
      {
        resultCapability: successor.resultCapability,
        output: stagedOutput(rebasedStartCommit),
      },
      { now: clock.now },
    );
    if (successorStored.state !== "gate-pending") {
      throw new Error("expected consumed ordinary successor staging");
    }
    const successorQueue = await enqueue(
      backend,
      successor,
      successorStored.result,
      successorBinding,
      rebasedStartCommit,
      "e".repeat(40),
      ontoCommit,
      {
        sourceReference: retiredSource.sourceReference,
        source: retiredSource.source,
        leaseGeneration: retiredSource.leaseGeneration,
        guardedRebase: retiredSource.guardedRebase,
        ontoCommit: retiredSource.ontoCommit,
        guardedRebaseJournalDigest: retiredSource.guardedRebaseJournalDigest,
      },
    );
    expect(successorQueue.enrollment.enrollmentId).toBe(retirement.enrollmentId);
    const successorQualification = await qualifyDispatchStagedCompletionOn(
      backend,
      {
        namespace,
        actor: "trusted-parent",
        attestationId: successor.attestationId,
        generation: successor.generation,
        partitionKey: successorQueue.partition.partitionKey,
        enrollmentId: successorQueue.enrollment.enrollmentId,
        attemptId: successorQueue.attempt.attemptId,
        stagedOutputDigest: successorStored.result.outputDigest,
        expectedChild: child,
        expectedProvenance: provenanceBindingOf(successor),
        nativeCompletion: completion(),
      },
      { now: clock.now },
    );
    expect(successorQualification).toMatchObject({ state: "qualified", replayed: false });
    const successorLease = await acquireImplementationCandidateOn(
      backend,
      {
        namespace,
        actor: "trusted-parent",
        partitionKey: successorQueue.partition.partitionKey,
        holderId: "parent-gate-guarded-successor",
      },
      { now: clock.now },
    );
    if (successorLease.state !== "leased") throw new Error("expected guarded successor lease");
    if (successor.parentGateCapability === undefined) {
      throw new Error("guarded successor omitted its parent gate capability");
    }
    const successorGate = await claimParentGateOn(
      backend,
      {
        attestationId: successor.attestationId,
        generation: successor.generation,
        parentGateCapability: successor.parentGateCapability,
        queueLease: successorLease.lease,
      },
      { now: clock.now },
    );
    if (successorGate.state !== "gate-running") {
      throw new Error("expected guarded successor parent gate");
    }
    await completeParentGateOn(
      backend,
      {
        attestationId: successor.attestationId,
        generation: successor.generation,
        parentGateCapability: successor.parentGateCapability,
        queueLease: successorLease.lease,
        gateEpoch: successorGate.gateEpoch,
        output: {
          ...stagedOutput(rebasedStartCommit),
          supervisedGateEvidence: {
            kind: "cq-supervised-gate-evidence",
            version: 1,
            attestationId: successor.attestationId,
            generation: successor.generation,
            roleId: "implement-worker",
            roleVersion: successor.promptProvenance.version,
            surface: "codex",
            promptDigest: successor.promptProvenance.promptDigest,
            catalogHash: successor.promptProvenance.catalogHash,
            inputDigest: successor.promptProvenance.inputDigest,
            taskId: binding.taskId,
            worktreePath: binding.worktreePath,
            branch: binding.branch,
            baseCommit: ontoCommit,
            startingCommit: rebasedStartCommit,
            resultCommit: rebasedStartCommit,
            clean: true,
            command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
            gateExitCode: 0,
            passCount: 1,
            failCount: 0,
            gateDurationMs: 1,
            capturedAt: clock.now(),
            filesTouchedDigest: "d".repeat(64),
            gitReceiptsDigest: "e".repeat(64),
            mutationTableDigest: "f".repeat(64),
          },
        },
      },
      { now: clock.now },
    );
    await confirmDispatchCompletionOn(
      backend,
      {
        namespace,
        attestationId: successor.attestationId,
        generation: successor.generation,
        nativeCompletion: completion(),
        expectedProvenance: provenanceBindingOf(successor),
        continuationContext: { liveTip: rebasedStartCommit, gitReceipts: [] },
      },
      { now: clock.now },
    );
    const consumedSuccessor = backend
      .storedRows()
      .find(
        (row) =>
          row.attestationId === successor.attestationId && row.generation === successor.generation,
      );
    if (consumedSuccessor?.dispatchContinuationBinding === undefined) {
      throw new Error("guarded successor omitted its ordinary continuation authority");
    }

    const correctionResult = "f".repeat(40);
    const correction = await prepare(backend, {
      input: input(ontoCommit, rebasedStartCommit, 2),
      idempotencyKey: "consumed-guarded-correction",
      reprepareOf: { attestationId: successor.attestationId, generation: successor.generation },
      gitEffectBinding: successorBinding,
      continuationClaim: {
        continuationReference:
          consumedSuccessor.dispatchContinuationBinding.continuationReference,
        actor: "trusted-parent",
        liveTip: rebasedStartCommit,
      },
    });
    const supersededSuccessor = backend
      .storedRows()
      .find(
        (row) =>
          row.attestationId === successor.attestationId && row.generation === successor.generation,
      );
    expect(supersededSuccessor).toMatchObject({
      state: "consumed",
      implementationQueue: {
        state: "terminal",
        terminal: { reason: "superseded" },
      },
    });
    if (
      supersededSuccessor?.implementationQueue !== undefined &&
      "lease" in supersededSuccessor.implementationQueue
    ) {
      throw new Error("ordinary correction left its predecessor lease live");
    }
    const correctionStored = await storeDispatchResultOn(
      backend,
      { resultCapability: correction.resultCapability, output: stagedOutput(correctionResult) },
      { now: clock.now },
    );
    if (correctionStored.state !== "gate-pending") {
      throw new Error("expected guarded correction staging");
    }
    const correctionQueue = await enqueue(
      backend,
      correction,
      correctionStored.result,
      successorBinding,
      correctionResult,
      "0".repeat(40),
      ontoCommit,
    );
    expect(correctionQueue.enrollment.enrollmentId).toBe(retirement.enrollmentId);
    expect(
      await qualifyDispatchStagedCompletionOn(
        backend,
        {
          namespace,
          actor: "trusted-parent",
          attestationId: correction.attestationId,
          generation: correction.generation,
          partitionKey: correctionQueue.partition.partitionKey,
          enrollmentId: correctionQueue.enrollment.enrollmentId,
          attemptId: correctionQueue.attempt.attemptId,
          stagedOutputDigest: correctionStored.result.outputDigest,
          expectedChild: child,
          expectedProvenance: provenanceBindingOf(correction),
          nativeCompletion: completion(),
        },
        { now: clock.now },
      ),
    ).toMatchObject({ state: "qualified", replayed: false });
  });

  // regression: T6518 review round 3 — enqueue claimed the source after prepare and store_result.
  test("successor allocation requires and atomically claims exact retired source authority", async () => {
    const { backend, prepared, retirement } = await qualifiedAndLeased();
    await retireDispatchStagedRebaseSourceOn(backend, retirement, { now: clock.now });
    const sourceHandle = {
      attestationId: prepared.attestationId,
      generation: prepared.generation,
    };
    await expect(
      prepare(backend, {
        input: input(ontoCommit, ontoCommit, 1),
        idempotencyKey: "staged-rebase-unbound-successor",
        reprepareOf: sourceHandle,
        gitEffectBinding: { ...binding, baseCommit: ontoCommit },
      }),
    ).rejects.toThrow(/retired staged-rebase source/);

    const rebasedStartCommit = "d".repeat(40);
    const successorBinding: DispatchGitEffectBinding = {
      ...binding,
      guardedRebaseBridge: {
        guardedRebase,
        operationId: "staged-rebase-prepare-claim",
        requestDigest: guardedRebaseJournalDigest,
        oldResultCommit: resultCommit,
        ontoCommit,
        rebasedStartCommit,
        outcome: "clean",
        exactTip: true,
        finalizedAt: clock.peek(),
      },
    };
    const successor = await prepare(backend, {
      input: input(ontoCommit, rebasedStartCommit, 1),
      idempotencyKey: "staged-rebase-claimed-successor",
      reprepareOf: sourceHandle,
      gitEffectBinding: successorBinding,
    });
    expect(successor.generation).toBe(prepared.generation + 1);
    await expect(
      prepare(backend, {
        input: input(ontoCommit, rebasedStartCommit, 1),
        idempotencyKey: "staged-rebase-second-successor",
        reprepareOf: sourceHandle,
        gitEffectBinding: successorBinding,
      }),
    ).rejects.toThrow(/already allocated a successor/);
  });
});
