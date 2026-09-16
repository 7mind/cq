import { describe, expect, test } from "bun:test";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationStore,
  DispatchTransportAdapterRegistry,
  enqueueImplementationCandidate,
  prepareDispatch,
  provenanceBindingOf,
  qualifyDispatchStagedCompletion,
  runPreparedDispatch,
  sequentialDispatchRandomBytes,
  type AttestationEnvelope,
  type AttestationNamespace,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
  type NativeCompletionProof,
} from "../src/index.js";

const namespace: AttestationNamespace = { backend: "xdg", projectKey: "queued-completion" };
const clock = new FakeDispatchClock("2026-09-16T09:00:00.000Z");
const baseCommit = "1".repeat(40);
const resultCommit = "2".repeat(40);
const expectedChild = { childId: "codex-process-child", runId: "codex-process-run" } as const;
const binding: DispatchGitEffectBinding = {
  taskId: "T6519",
  handleToken: "managed-handle-T6519",
  handleFingerprint: "3".repeat(64),
  repositoryRoot: "/repo",
  repositoryId: "4".repeat(64),
  commonDir: "/repo/.git",
  worktreePath: "/repo/.claude/worktrees/T6519",
  branch: "implement/T6519",
  ref: "refs/heads/implement/T6519",
  baseCommit,
};

const output: DispatchJSONValue = {
  taskId: "T6519",
  status: "pass",
  resultCommit,
  branch: binding.branch,
  actualWorktreePath: binding.worktreePath,
  filesTouched: ["candidate.ts"],
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

describe("Codex process queued completion [Behavioral-Active, Blackbox-Group]", () => {
  // specified: T6519 — staging plus native completion qualifies, but does not run the gate.
  test("returns a handle-only queued outcome after durable exact qualification", async () => {
    const store = new InMemoryAttestationStore(namespace);
    const deps = { store, now: clock.now };
    const preparedOutcome = prepareDispatch(
      {
        namespace,
        roleId: "implement-worker",
        surface: "codex",
        input: {
          taskId: "T6519",
          headline: "Queue native completion",
          description: "Qualify the staged bytes before coordinator admission.",
          acceptance: "No gate starts in the child transport.",
          worktreePath: binding.worktreePath,
          branch: binding.branch,
          baseCommit,
          round: 0,
          startingCommit: baseCommit,
        },
        idempotencyKey: "T6519-process-queued",
        timeoutMs: 600_000,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: "5".repeat(64),
        catalogHash: "6".repeat(64),
        expectedChild,
        gitEffectBinding: binding,
      },
      { store, now: clock.now, randomBytes: sequentialDispatchRandomBytes(6519) },
    );
    if (!preparedOutcome.accepted) throw new Error(preparedOutcome.detail);
    const prepared = preparedOutcome.prepared;
    const nativeCompletion: NativeCompletionProof = {
      kind: "native-completion",
      actor: "trusted-extension",
      childId: expectedChild.childId,
      runId: expectedChild.runId,
      completedAt: clock.now(),
    };
    const registry = new DispatchTransportAdapterRegistry([
      {
        id: "codex:process",
        targetHarness: "codex",
        transport: "process",
        launch: (context) => {
        context.child.materializeInput();
        const staged = context.child.storeResult(output);
        expect(staged.state).toBe("gate-pending");
        return {
          outcome: "completed",
          handle: { attestationId: prepared.attestationId, generation: prepared.generation },
          nativeCompletion,
          handleOnlyEnforcement: "structural",
        };
        },
      },
    ]);
    const request = {
      namespace,
      prepared,
      activeHarness: "claude",
      targetHarness: "codex",
      forceShellout: false,
      resolvedModel: { harness: "codex", model: "gpt-5.6-sol", provider: null, effort: "high" },
      qualifyStagedCompletion: async (observation: {
        readonly stagedOutputDigest: string;
        readonly nativeCompletion: NativeCompletionProof;
      }) => {
        const queue = enqueueImplementationCandidate(
          {
            namespace,
            actor: "trusted-extension",
            attestationId: prepared.attestationId,
            generation: prepared.generation,
            repositoryId: binding.repositoryId,
            integrationRef: "refs/heads/main",
            authority: {
              taskId: binding.taskId,
              goalRef: "goals:G211",
              finalizedManifestDigest: "7".repeat(64),
            },
            observedBaseCommit: baseCommit,
            resultCommit,
            resultTree: "8".repeat(40),
            gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
            packagedEnvironmentDigest: "9".repeat(64),
            gitReceipts: [],
            gitEffectBinding: binding,
            stagedOutputDigest: observation.stagedOutputDigest,
          },
          deps,
        );
        return qualifyDispatchStagedCompletion(
          {
            namespace,
            actor: "trusted-extension",
            attestationId: prepared.attestationId,
            generation: prepared.generation,
            partitionKey: queue.partition.partitionKey,
            enrollmentId: queue.enrollment.enrollmentId,
            attemptId: queue.attempt.attemptId,
            stagedOutputDigest: observation.stagedOutputDigest,
            expectedChild,
            expectedProvenance: provenanceBindingOf(prepared),
            nativeCompletion: observation.nativeCompletion,
          },
          deps,
        );
      },
    } as unknown as Parameters<typeof runPreparedDispatch>[0];

    const result = await runPreparedDispatch(request, registry, deps);

    expect(result).toEqual({
      outcome: "queued",
      route: {
        activeHarness: "claude",
        targetHarness: "codex",
        forceShellout: false,
        transport: "process",
        adapterId: "codex:process",
      },
      adapterId: "codex:process",
      handle: { attestationId: prepared.attestationId, generation: prepared.generation },
    });
    const row = store.read({
      attestationId: prepared.attestationId,
      generation: prepared.generation,
    }) as AttestationEnvelope;
    expect(row.state).toBe("gate-pending");
    expect(row.implementationQueue?.state).toBe("qualified");
    expect(row.stagedCompletionQualification?.nativeCompletion).toEqual(nativeCompletion);
  });
});
