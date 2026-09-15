import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  fetchDispatchInputOn,
  prepareDispatchOn,
  provenanceBindingOf,
  sequentialDispatchRandomBytes,
  storeDispatchResultOn,
  type AttestationBackend,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
  type DispatchPrepared,
  type EnqueueImplementationCandidateRequest,
  type NativeChildIdentity,
} from "@cq/config";
import {
  ImplementationCandidateQueueAdapter,
  type QualifyNativeImplementationCandidateRequest,
} from "../src/implementationCandidateQueue.js";

export interface PreparedQueueCandidate {
  readonly prepared: DispatchPrepared;
  readonly binding: DispatchGitEffectBinding;
  readonly expectedChild: NativeChildIdentity;
  readonly candidate: QualifyNativeImplementationCandidateRequest["candidate"];
  readonly qualification: Omit<QualifyNativeImplementationCandidateRequest, "candidate">;
}

export interface PrepareQueueCandidateOptions {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly integrationRef: string;
  readonly goalRef: string;
  readonly finalizedManifestDigest: string;
  readonly reprepareOf?: PreparedQueueCandidate;
}

interface PreparedOnly {
  readonly prepared: DispatchPrepared;
  readonly binding: DispatchGitEffectBinding;
  readonly expectedChild: NativeChildIdentity;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly integrationRef: string;
  readonly goalRef: string;
  readonly finalizedManifestDigest: string;
}

function repeatedHex(value: number): string {
  return (value % 16).toString(16).repeat(40);
}

export class ImplementationCandidateQueueFixture {
  readonly backend: AttestationBackend;
  readonly clock: FakeDispatchClock;
  readonly adapter: ImplementationCandidateQueueAdapter;
  private readonly randomBytes = sequentialDispatchRandomBytes(6518);
  private sequence = 1;

  constructor(backend: AttestationBackend) {
    this.backend = backend;
    this.clock = new FakeDispatchClock("2026-09-15T12:00:00.000Z");
    this.adapter = new ImplementationCandidateQueueAdapter({
      backend,
      actor: "trusted-parent",
      now: this.clock.now,
    });
  }

  async prepareOnly(options: PrepareQueueCandidateOptions): Promise<PreparedOnly> {
    const sequence = this.sequence++;
    const prior = options.reprepareOf;
    const baseCommit = prior?.binding.baseCommit ?? repeatedHex(sequence);
    const resultCommit = repeatedHex(sequence + 1);
    const resultTree = repeatedHex(sequence + 2);
    const expectedChild = {
      childId: `queue-child-${String(sequence)}`,
      runId: `queue-run-${String(sequence)}`,
    };
    const binding: DispatchGitEffectBinding =
      prior?.binding ??
      {
        taskId: options.taskId,
        handleToken: `queue-worktree-${String(sequence)}`,
        handleFingerprint: (sequence % 16).toString(16).repeat(64),
        repositoryRoot: `/repo-${options.repositoryId.slice(0, 8)}`,
        repositoryId: options.repositoryId,
        commonDir: `/repo-${options.repositoryId.slice(0, 8)}/.git`,
        worktreePath: `/repo-${options.repositoryId.slice(0, 8)}/.claude/worktrees/${options.taskId}-${String(sequence)}`,
        branch: `implement/${options.taskId}`,
        ref: `refs/heads/implement/${options.taskId}`,
        baseCommit,
      };
    const input: DispatchJSONValue = {
      taskId: options.taskId,
      headline: "Queue one implementation candidate",
      description: "Exercise the ledger-MCP implementation queue adapter.",
      acceptance: "Queue state is durable and fenced.",
      worktreePath: binding.worktreePath,
      branch: binding.branch,
      baseCommit,
      round: prior?.prepared.generation ?? 0,
      startingCommit: prior?.candidate.resultCommit ?? baseCommit,
      ...(prior === undefined ? {} : { priorResultCommit: prior.candidate.resultCommit }),
    };
    const outcome = await prepareDispatchOn(
      this.backend,
      {
        namespace: this.backend.namespace,
        roleId: "implement-worker",
        surface: "codex",
        input,
        idempotencyKey: `queue-${options.taskId}-${String(sequence)}`,
        timeoutMs: 600_000,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: "a".repeat(64),
        catalogHash: "b".repeat(64),
        expectedChild,
        gitEffectBinding: binding,
        ...(prior === undefined
          ? {}
          : {
              reprepareOf: {
                attestationId: prior.prepared.attestationId,
                generation: prior.prepared.generation,
              },
            }),
      },
      {
        mode: "manager-bound",
        now: this.clock.now,
        randomBytes: this.randomBytes,
        lineageFenceGuard: async () => null,
        withLineageLock: async (operation) => await operation(),
      },
    );
    if (!outcome.accepted) throw new Error(`queue fixture prepare rejected: ${outcome.reason}`);
    await fetchDispatchInputOn(
      this.backend,
      {
        namespace: this.backend.namespace,
        attestationId: outcome.prepared.attestationId,
        generation: outcome.prepared.generation,
        inputCapability: outcome.prepared.inputCapability,
      },
      { now: this.clock.now },
    );
    return {
      prepared: outcome.prepared,
      binding,
      expectedChild,
      resultCommit,
      resultTree,
      integrationRef: options.integrationRef,
      goalRef: options.goalRef,
      finalizedManifestDigest: options.finalizedManifestDigest,
    };
  }

  async stage(options: PrepareQueueCandidateOptions): Promise<PreparedQueueCandidate> {
    const prepared = await this.prepareOnly(options);
    const output: DispatchJSONValue = {
      taskId: prepared.binding.taskId,
      status: "pass",
      resultCommit: prepared.resultCommit,
      branch: prepared.binding.branch,
      actualWorktreePath: prepared.binding.worktreePath,
      filesTouched: ["candidate.ts"],
      gitReceipts: [],
      checkSummary: "targeted checks passed",
      baseVerification: {
        status: "verified",
        relation: "descendant",
        baseCommit: prepared.binding.baseCommit,
        headCommit: prepared.resultCommit,
      },
      summary: "candidate staged",
    };
    const stored = await storeDispatchResultOn(
      this.backend,
      { resultCapability: prepared.prepared.resultCapability, output },
      { now: this.clock.now },
    );
    if (stored.state !== "gate-pending") throw new Error("expected gate-pending staging");
    const candidate: Omit<EnqueueImplementationCandidateRequest, "namespace" | "actor"> = {
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      repositoryId: prepared.binding.repositoryId,
      integrationRef: prepared.integrationRef,
      authority: {
        taskId: prepared.binding.taskId,
        goalRef: prepared.goalRef,
        finalizedManifestDigest: prepared.finalizedManifestDigest,
      },
      observedBaseCommit: prepared.binding.baseCommit,
      resultCommit: prepared.resultCommit,
      resultTree: prepared.resultTree,
      gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
      packagedEnvironmentDigest: "c".repeat(64),
      gitReceipts: [],
      gitEffectBinding: prepared.binding,
      stagedOutputDigest: stored.result.outputDigest,
    };
    return {
      prepared: prepared.prepared,
      binding: prepared.binding,
      expectedChild: prepared.expectedChild,
      candidate,
      qualification: {
        expectedChild: prepared.expectedChild,
        expectedProvenance: provenanceBindingOf(prepared.prepared),
        nativeCompletion: {
          kind: "native-completion",
          actor: "trusted-parent",
          childId: prepared.expectedChild.childId,
          runId: prepared.expectedChild.runId,
          completedAt: this.clock.now(),
        },
      },
    };
  }
}
