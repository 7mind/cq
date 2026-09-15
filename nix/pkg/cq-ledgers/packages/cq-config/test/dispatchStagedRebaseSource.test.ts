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
  type AttestationNamespace,
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

function stagedOutput(commit: string): DispatchJSONValue {
  return {
    taskId: "T6518",
    status: "pass",
    resultCommit: commit,
    branch: binding.branch,
    actualWorktreePath: binding.worktreePath,
    filesTouched: ["packages/cq-config/src/dispatchImplementationQueue.ts"],
    gitReceipts: [],
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
      randomBytes: sequentialDispatchRandomBytes(6518),
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
  source?: EnqueueImplementationCandidateRequest["stagedRebaseSource"],
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
      observedBaseCommit: effectBinding.baseCommit,
      resultCommit: commit,
      resultTree: tree,
      gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
      packagedEnvironmentDigest,
      gitReceipts: [],
      gitEffectBinding: effectBinding,
      stagedOutputDigest: pending.outputDigest,
      ...(source === undefined ? {} : { stagedRebaseSource: source }),
    },
    { now: clock.now },
  );
}

async function qualifiedAndLeased(): Promise<{
  readonly backend: InMemoryAttestationBackend;
  readonly prepared: DispatchPrepared;
  readonly pending: GatePendingResultView;
  readonly queue: ImplementationQueueControl;
  readonly retirement: RetireDispatchStagedRebaseSourceRequest;
}> {
  const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
  const prepared = await prepare(backend);
  const stored = await storeDispatchResultOn(
    backend,
    { resultCapability: prepared.resultCapability, output: stagedOutput(resultCommit) },
    { now: clock.now },
  );
  if (stored.state !== "gate-pending") throw new Error("expected gate-pending staging");
  const queue = await enqueue(backend, prepared, stored.result, binding, resultCommit, resultTree);
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
      gitReceipts: [],
    },
    ontoCommit,
    guardedRebase,
    guardedRebaseJournalDigest,
  };
  return { backend, prepared, pending: stored.result, queue, retirement };
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
      baseCommit: ontoCommit,
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
        sourceClaim,
      ),
    ).toEqual(successorQueue);
    await expect(
      enqueue(backend, successor, stored.result, successorBinding, successorResult, successorTree, {
        ...sourceClaim,
        guardedRebaseJournalDigest: "0".repeat(64),
      }),
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
    ).rejects.toThrow(DispatchStagedRebaseSourceError);

    const rebasedStartCommit = "d".repeat(40);
    const successorBinding: DispatchGitEffectBinding = {
      ...binding,
      baseCommit: ontoCommit,
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
