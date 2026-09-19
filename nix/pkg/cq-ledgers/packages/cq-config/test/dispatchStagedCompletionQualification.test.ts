import { describe, expect, test } from "bun:test";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  claimParentGateOn,
  enqueueImplementationCandidateOn,
  fetchDispatchInputOn,
  prepareDispatchOn,
  provenanceBindingOf,
  qualifyDispatchStagedCompletionOn,
  sequentialDispatchRandomBytes,
  storeDispatchResultOn,
  type AttestationEnvelope,
  type AttestationNamespace,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
  type DispatchPrepared,
  type GatePendingResultView,
  type ImplementationQueueControl,
  type NativeCompletionProof,
} from "@cq/config";

const namespace: AttestationNamespace = { backend: "xdg", projectKey: "qualification-repro" };
const clock = new FakeDispatchClock("2026-09-15T09:00:00.000Z");
const expectedChild = { childId: "codex-child-T6518", runId: "codex-run-T6518" } as const;
const baseCommit = "1".repeat(40);
const resultCommit = "2".repeat(40);
const binding: DispatchGitEffectBinding = {
  taskId: "T6518",
  handleToken: "managed-handle-T6518",
  handleFingerprint: "3".repeat(64),
  repositoryRoot: "/repo",
  repositoryId: "4".repeat(64),
  commonDir: "/repo/.git",
  worktreePath: "/repo/.claude/worktrees/T6518",
  branch: "implement/T6518",
  ref: "refs/heads/implement/T6518",
  baseCommit,
};

const input: DispatchJSONValue = {
  taskId: "T6518",
  headline: "Queue staged candidates",
  description: "Reproduction for persisted staged-completion qualification.",
  acceptance: "An unqualified staged row cannot start a gate.",
  worktreePath: binding.worktreePath,
  branch: binding.branch,
  baseCommit,
  round: 0,
  startingCommit: baseCommit,
  validationIntent: "final",
};

const stagedOutput: DispatchJSONValue = {
  taskId: "T6518",
  status: "pass",
  resultCommit,
  branch: binding.branch,
  actualWorktreePath: binding.worktreePath,
  filesTouched: ["packages/cq-config/src/dispatchAttestation.ts"],
  gitReceipts: [],
  checkSummary: "focused checks passed",
  baseVerification: {
    status: "verified",
    relation: "descendant",
    baseCommit,
    headCommit: resultCommit,
  },
  summary: "candidate staged",
};

const nativeCompletion: NativeCompletionProof = {
  kind: "native-completion",
  actor: "trusted-parent",
  childId: expectedChild.childId,
  runId: expectedChild.runId,
  completedAt: "2026-09-15T09:01:00.000Z",
};

async function staged(): Promise<{
  readonly backend: InMemoryAttestationBackend;
  readonly prepared: DispatchPrepared;
  readonly pending: GatePendingResultView;
}> {
  const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
  const outcome = await prepareDispatchOn(
    backend,
    {
      namespace,
      roleId: "implement-worker",
      surface: "codex",
      input,
      idempotencyKey: "T6518-qualification-repro",
      timeoutMs: 600_000,
      registry: DISPATCH_OVERLAY_REGISTRY,
      promptDigest: "5".repeat(64),
      catalogHash: "6".repeat(64),
      expectedChild,
      gitEffectBinding: binding,
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
    { namespace, ...outcome.prepared, inputCapability: outcome.prepared.inputCapability },
    { now: clock.now },
  );
  const stored = await storeDispatchResultOn(
    backend,
    { resultCapability: outcome.prepared.resultCapability, output: stagedOutput },
    { now: clock.now },
  );
  expect(stored.state).toBe("gate-pending");
  if (stored.state !== "gate-pending") throw new Error("expected gate-pending result");
  return { backend, prepared: outcome.prepared, pending: stored.result };
}

async function enrolled(): Promise<{
  readonly backend: InMemoryAttestationBackend;
  readonly prepared: DispatchPrepared;
  readonly pending: GatePendingResultView;
  readonly queue: ImplementationQueueControl;
}> {
  const candidate = await staged();
  const queue = await enqueueImplementationCandidateOn(
    candidate.backend,
    {
      namespace,
      actor: "trusted-parent",
      attestationId: candidate.prepared.attestationId,
      generation: candidate.prepared.generation,
      repositoryId: binding.repositoryId,
      integrationRef: "refs/heads/main",
      authority: {
        taskId: "T6518",
        goalRef: "goals:G6518",
        finalizedManifestDigest: "7".repeat(64),
      },
      observedBaseCommit: baseCommit,
      resultCommit,
      resultTree: "8".repeat(40),
      gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
      packagedEnvironmentDigest: "9".repeat(64),
      gitReceipts: [],
      gitEffectBinding: binding,
      stagedOutputDigest: candidate.pending.outputDigest,
    },
    { now: clock.now },
  );
  return { ...candidate, queue };
}

describe("staged completion qualification", () => {
  // regression: T6518 — pre-change gate-pending rows were directly runnable.
  test("stale-base gate-pending conflict is refused before the attempt is qualified", async () => {
    const { backend, prepared } = await enrolled();
    await expect(
      claimParentGateOn(
        backend,
        {
          attestationId: prepared.attestationId,
          generation: prepared.generation,
          parentGateCapability: prepared.parentGateCapability!,
        },
        { now: clock.now },
      ),
    ).rejects.toThrow(/qualified staged completion/);
  });

  // regression: T6518 — no durable row bound the native observation to staged bytes.
  test("staged-completion qualification is persisted before any gate can start", async () => {
    const { backend, prepared, pending, queue } = await enrolled();
    const qualified = await qualifyDispatchStagedCompletionOn(
      backend,
      {
        namespace,
        actor: "trusted-parent",
        attestationId: prepared.attestationId,
        generation: prepared.generation,
        partitionKey: queue.partition.partitionKey,
        enrollmentId: queue.enrollment.enrollmentId,
        attemptId: queue.attempt.attemptId,
        stagedOutputDigest: pending.outputDigest,
        expectedChild,
        expectedProvenance: provenanceBindingOf(prepared),
        nativeCompletion,
      },
      { now: clock.now },
    );
    expect(qualified.state).toBe("qualified");
    const row = backend.storedRows()[0] as AttestationEnvelope;
    expect(row).toEqual(
      expect.objectContaining({
        stagedCompletionQualification: expect.objectContaining({
          outputDigest: expect.any(String),
          expectedProvenance: provenanceBindingOf(prepared),
          nativeCompletion,
        }),
      }),
    );
  });
});
