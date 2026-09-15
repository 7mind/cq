import { describe, expect, test } from "bun:test";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  claimParentGateOn,
  fetchDispatchInputOn,
  prepareDispatchOn,
  provenanceBindingOf,
  sequentialDispatchRandomBytes,
  storeDispatchResultOn,
  type AttestationEnvelope,
  type AttestationNamespace,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
  type DispatchPrepared,
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
  return { backend, prepared: outcome.prepared };
}

describe("staged completion qualification", () => {
  // regression: T6518 — pre-change gate-pending rows were directly runnable.
  test("stale-base gate-pending conflict is refused before the attempt is qualified", async () => {
    const { backend, prepared } = await staged();
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
    const { backend, prepared } = await staged();
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
