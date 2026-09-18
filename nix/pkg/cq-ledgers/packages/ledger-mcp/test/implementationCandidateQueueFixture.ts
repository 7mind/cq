import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  discoverDispatchContinuationOn,
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
  readonly idempotencyKey?: string;
  readonly reprepareOf?: PreparedQueueCandidate;
  readonly withReceipt?: boolean;
  readonly resultCommit?: string;
  readonly resultTree?: string;
  readonly packagedEnvironmentDigest?: string;
  readonly gitEffectBinding?: DispatchGitEffectBinding;
  readonly guardedRebase?: {
    readonly guardedRebase: `cq-guarded-rebase:v1:${string}`;
    readonly requestDigest: string;
    readonly ontoCommit: string;
    readonly rebasedStartCommit: string;
    readonly resultTree: string;
  };
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
    const guarded = options.guardedRebase;
    const baseCommit =
      guarded?.ontoCommit ??
      prior?.binding.baseCommit ??
      options.gitEffectBinding?.baseCommit ??
      repeatedHex(sequence);
    const resultCommit =
      guarded?.rebasedStartCommit ?? options.resultCommit ?? repeatedHex(sequence + 1);
    const resultTree = guarded?.resultTree ?? options.resultTree ?? repeatedHex(sequence + 2);
    const expectedChild = {
      childId: `queue-child-${String(sequence)}`,
      runId: `queue-run-${String(sequence)}`,
    };
    const binding: DispatchGitEffectBinding =
      guarded !== undefined && prior !== undefined
        ? {
            ...prior.binding,
            guardedRebaseBridge: {
              guardedRebase: guarded.guardedRebase,
              operationId: `queue-guarded-rebase-${String(sequence)}`,
              requestDigest: guarded.requestDigest,
              oldResultCommit: prior.candidate.resultCommit,
              ontoCommit: guarded.ontoCommit,
              rebasedStartCommit: guarded.rebasedStartCommit,
              outcome: "clean",
              exactTip: true,
              finalizedAt: this.clock.peek(),
            },
          }
        : (prior?.binding ??
          options.gitEffectBinding ?? {
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
          });
    const input: DispatchJSONValue = {
      taskId: options.taskId,
      headline: "Queue one implementation candidate",
      description: "Exercise the ledger-MCP implementation queue adapter.",
      acceptance: "Queue state is durable and fenced.",
      worktreePath: binding.worktreePath,
      branch: binding.branch,
      baseCommit,
      round: prior?.prepared.generation ?? 0,
      startingCommit: guarded?.rebasedStartCommit ?? prior?.candidate.resultCommit ?? baseCommit,
      ...(prior === undefined ? {} : { priorResultCommit: prior.candidate.resultCommit }),
    };
    const priorState =
      prior === undefined
        ? undefined
        : await this.backend.transact({ kind: "handle", handle: prior.prepared }, (store) => {
            const row = store.read(prior.prepared);
            if (row === undefined) throw new Error("queue fixture prior dispatch disappeared");
            if (row.kind !== "envelope") {
              throw new Error("queue fixture prior dispatch was collapsed");
            }
            return row.state;
          });
    const continuation =
      prior === undefined || guarded !== undefined || priorState !== "consumed"
        ? undefined
        : await discoverDispatchContinuationOn(
            this.backend,
            {
              namespace: this.backend.namespace,
              actor: "trusted-parent",
              gitEffectBinding: binding,
              liveTip: prior.candidate.resultCommit,
            },
            { now: this.clock.now },
          );
    const outcome = await prepareDispatchOn(
      this.backend,
      {
        namespace: this.backend.namespace,
        roleId: "implement-worker",
        surface: "codex",
        input,
        idempotencyKey: options.idempotencyKey ?? `queue-${options.taskId}-${String(sequence)}`,
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
        ...(continuation === undefined
          ? {}
          : {
              continuationClaim: {
                continuationReference: continuation.continuationReference,
                actor: "trusted-parent" as const,
                liveTip: continuation.liveTip,
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
    const guarded = prepared.binding.guardedRebaseBridge;
    const gitReceipts: EnqueueImplementationCandidateRequest["gitReceipts"] =
      options.withReceipt === true
        ? [
            {
              kind: "cq-git-change-receipt",
              version: 1,
              attestationId: prepared.prepared.attestationId,
              generation: prepared.prepared.generation,
              taskId: prepared.binding.taskId,
              operationId: `queue-fixture-change-${String(prepared.prepared.generation)}`,
              requestDigest: "d".repeat(64),
              oldHead: prepared.binding.baseCommit,
              newHead: prepared.resultCommit,
              tree: prepared.resultTree,
              objectOids: [prepared.resultCommit, prepared.resultTree],
              paths: ["candidate.ts"],
              committedAt: this.clock.peek(),
            },
          ]
        : [];
    const output: DispatchJSONValue = {
      taskId: prepared.binding.taskId,
      status: "pass",
      resultCommit: prepared.resultCommit,
      branch: prepared.binding.branch,
      actualWorktreePath: prepared.binding.worktreePath,
      filesTouched: ["candidate.ts"],
      gitReceipts: gitReceipts as unknown as DispatchJSONValue,
      ...(guarded === undefined
        ? {}
        : {
            gitLineage: {
              kind: "guarded-rebase",
              guardedRebase: guarded.guardedRebase,
              ontoCommit: guarded.ontoCommit,
              rebasedStartCommit: guarded.rebasedStartCommit,
              exactTip: guarded.exactTip,
            },
          }),
      checkSummary: "targeted checks passed",
      baseVerification: {
        status: "verified",
        relation: "descendant",
        baseCommit: guarded?.ontoCommit ?? prepared.binding.baseCommit,
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
    const stagedRebaseSource =
      options.guardedRebase === undefined || options.reprepareOf === undefined
        ? undefined
        : await this.backend.transact(
            { kind: "handle", handle: options.reprepareOf.prepared },
            (store) => {
              const row = store.read(options.reprepareOf!.prepared);
              const source = row?.implementationQueue?.stagedRebaseSource;
              if (source === undefined) {
                throw new Error("guarded fixture source did not persist successor authority");
              }
              return {
                sourceReference: source.sourceReference,
                source: source.source,
                leaseGeneration: source.leaseGeneration,
                guardedRebase: source.guardedRebase,
                ontoCommit: source.ontoCommit,
                guardedRebaseJournalDigest: source.guardedRebaseJournalDigest,
              };
            },
          );
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
      observedBaseCommit: guarded?.ontoCommit ?? prepared.binding.baseCommit,
      resultCommit: prepared.resultCommit,
      resultTree: prepared.resultTree,
      gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
      packagedEnvironmentDigest: options.packagedEnvironmentDigest ?? "c".repeat(64),
      gitReceipts,
      gitEffectBinding: prepared.binding,
      stagedOutputDigest: stored.result.outputDigest,
      ...(stagedRebaseSource === undefined ? {} : { stagedRebaseSource }),
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
