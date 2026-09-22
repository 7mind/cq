import { afterEach, describe, expect, test } from "bun:test";
import {
  AttestationContractError,
  DISPATCH_OVERLAY_REGISTRY,
  ImplementationQueueConflictError,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  abortDispatchOn,
  attestationRowDigest,
  claimParentGateOn,
  completeParentGateOn,
  confirmDispatchCompletionOn,
  prepareDispatchOn,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
} from "@cq/config";
import {
  ImplementationCandidateQueueFixture,
  type PrepareQueueCandidateOptions,
} from "./implementationCandidateQueueFixture.js";

const namespace: AttestationNamespace = {
  backend: "xdg",
  projectKey: "ledger-mcp-implementation-queue",
};
const repositoryA = "d".repeat(64);
const repositoryB = "e".repeat(64);
const defaults = {
  repositoryId: repositoryA,
  integrationRef: "refs/heads/main",
  goalRef: "goals:G6518",
  finalizedManifestDigest: "f".repeat(64),
} as const;

function candidate(
  taskId: string,
  overrides: Partial<PrepareQueueCandidateOptions> = {},
): PrepareQueueCandidateOptions {
  return { ...defaults, taskId, ...overrides };
}

async function captureImplementationQueueConflict(
  operation: () => Promise<unknown>,
): Promise<ImplementationQueueConflictError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ImplementationQueueConflictError) return error;
    throw error;
  }
  throw new Error("expected an implementation queue conflict");
}

type DirectTerminalReason = Parameters<
  ImplementationCandidateQueueFixture["adapter"]["terminalize"]
>[0]["reason"];

// @ts-expect-error parent-lost requires the authoritative dispatch abort transition.
const parentLostDirectReason: DirectTerminalReason = "parent-lost";
// @ts-expect-error gate-rejected requires a claimed and completed supervised gate.
const gateRejectedDirectReason: DirectTerminalReason = "gate-rejected";
// @ts-expect-error operational-abstention belongs to the authoritative dispatch abort transition.
const operationalAbstentionDirectReason: DirectTerminalReason = "operational-abstention";
void [parentLostDirectReason, gateRejectedDirectReason, operationalAbstentionDirectReason];

describe("ledger-MCP implementation candidate queue", () => {
  const backends: InMemoryAttestationBackend[] = [];

  function fixture(): ImplementationCandidateQueueFixture {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    backends.push(backend);
    return new ImplementationCandidateQueueFixture(backend);
  }

  afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.close();
  });

  test("native completion cannot qualify a candidate before result storage", async () => {
    const subject = fixture();
    const stored = await subject.stage(candidate("T6518"));
    const unstored = await subject.prepareOnly(candidate("T6519"));

    await expect(
      subject.adapter.qualifyNativeCompletion({
        candidate: {
          ...stored.candidate,
          attestationId: unstored.prepared.attestationId,
          generation: unstored.prepared.generation,
        },
        expectedChild: unstored.expectedChild,
        expectedProvenance: stored.qualification.expectedProvenance,
        nativeCompletion: {
          ...stored.qualification.nativeCompletion,
          childId: unstored.expectedChild.childId,
          runId: unstored.expectedChild.runId,
        },
      }),
    ).rejects.toThrow("only a gate-pending staged result");

    const qualified = await subject.adapter.qualifyNativeCompletion({
      candidate: stored.candidate,
      ...stored.qualification,
    });
    expect(qualified.queue.state).toBe("qualified");
    expect(qualified.qualification.state).toBe("qualified");
  });

  test("FIFO is strict inside one partition while independent partitions lease concurrently", async () => {
    const subject = fixture();
    const first = await subject.stage(candidate("T6518"));
    const second = await subject.stage(candidate("T6519"));
    const independent = await subject.stage(candidate("T6520", { repositoryId: repositoryB }));
    const firstQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: first.candidate,
      ...first.qualification,
    });
    const secondQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: second.candidate,
      ...second.qualification,
    });
    const independentQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: independent.candidate,
      ...independent.qualification,
    });

    expect(firstQualified.queue.enrollment.admissionOrdinal).toBe(1);
    expect(secondQualified.queue.enrollment.admissionOrdinal).toBe(2);
    expect(independentQualified.queue.enrollment.admissionOrdinal).toBe(1);
    const firstLease = await subject.adapter.acquire({
      partitionKey: firstQualified.queue.partition.partitionKey,
      holderId: "integration-main",
    });
    const independentLease = await subject.adapter.acquire({
      partitionKey: independentQualified.queue.partition.partitionKey,
      holderId: "integration-other-repository",
    });
    expect(firstLease).toMatchObject({
      state: "leased",
      lease: { attestationId: first.prepared.attestationId },
    });
    expect(independentLease).toMatchObject({
      state: "leased",
      lease: { attestationId: independent.prepared.attestationId },
    });
    if (firstLease.state !== "leased") throw new Error("expected first FIFO lease");
    await subject.adapter.release({
      ...firstLease.lease,
      expectedPartitionRevision: firstLease.partitionRevision,
      detail: { gate: "complete" },
    });
    expect(
      await subject.adapter.acquire({
        partitionKey: firstQualified.queue.partition.partitionKey,
        holderId: "integration-main-next",
      }),
    ).toMatchObject({
      state: "leased",
      lease: { attestationId: second.prepared.attestationId },
    });
  });

  // regression: T6520 round 19 — final merge authorization left the live
  // queue lease transferable before the protected ref settled.
  test("a replay-safe completion reservation fences every competing lease transition until exact release [Behavioral-Active Blackbox-Group]", async () => {
    const subject = fixture();
    const staged = await subject.stage(candidate("T6520", { withReceipt: true }));
    const qualified = await subject.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const acquired = await subject.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "completion-holder",
    });
    if (acquired.state !== "leased") throw new Error("expected completion lease");
    if (qualified.queue.qualification === undefined) {
      throw new Error("qualified candidate lost its qualification");
    }
    const binding = {
      operationId: "completion-reservation",
      completionRef: `cq-implementation-completion:v1:${"1".repeat(64)}`,
      mergeOperationId: "completion-merge",
      taskRef: "tasks:T6520",
      resultCommit: staged.candidate.resultCommit,
    } as const;
    const request = {
      ...acquired.lease,
      expectedPartitionRevision: acquired.partitionRevision,
      qualificationDigest: qualified.queue.qualification.qualificationDigest,
      ...binding,
    } as const;
    await expect(
      subject.adapter.reserveCompletion({
        ...request,
        operationId: "invalid operation id",
      }),
    ).rejects.toThrow(AttestationContractError);
    await expect(
      subject.adapter.reserveCompletion({
        ...request,
        qualificationDigest: "not-a-digest",
      }),
    ).rejects.toThrow(AttestationContractError);
    for (const changed of [
      { qualificationDigest: "9".repeat(64) },
      { taskRef: "tasks:T9999" },
      { resultCommit: "8".repeat(40) },
    ] as const) {
      await expect(
        subject.adapter.reserveCompletion({ ...request, ...changed }),
      ).rejects.toMatchObject({ reason: "binding-mismatch" });
    }
    const reservation = await subject.adapter.reserveCompletion(request);
    const reserved = await subject.adapter.inspectLease(acquired.lease);
    expect(reserved.completionReservation).toEqual(reservation);
    expect(
      await subject.adapter.reserveCompletion({
        ...request,
        expectedPartitionRevision: reserved.partitionRevision,
      }),
    ).toEqual(reservation);

    await expect(
      subject.adapter.reserveCompletion({
        ...request,
        expectedPartitionRevision: reserved.partitionRevision,
        operationId: "different-completion-reservation",
      }),
    ).rejects.toMatchObject({ reason: "completion-reserved" });
    await expect(
      subject.adapter.reserveCompletion({
        ...request,
        expectedPartitionRevision: reserved.partitionRevision,
        holderId: "losing-holder",
      }),
    ).rejects.toThrow("exact live lease generation");
    for (const transition of [
      subject.adapter.park.bind(subject.adapter),
      subject.adapter.yield.bind(subject.adapter),
      subject.adapter.release.bind(subject.adapter),
    ]) {
      await expect(
        transition({
          ...acquired.lease,
          expectedPartitionRevision: reserved.partitionRevision,
        }),
      ).rejects.toMatchObject({ reason: "completion-reserved" });
    }
    await expect(
      subject.adapter.recover({
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
        partitionKey: acquired.lease.partitionKey,
        enrollmentId: acquired.lease.enrollmentId,
        attemptId: acquired.lease.attemptId,
        staleLeaseGeneration: acquired.lease.leaseGeneration,
        expectedPartitionRevision: reserved.partitionRevision,
      }),
    ).rejects.toMatchObject({ reason: "completion-reserved" });
    await expect(
      subject.adapter.terminalize({
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
        partitionKey: acquired.lease.partitionKey,
        enrollmentId: acquired.lease.enrollmentId,
        attemptId: acquired.lease.attemptId,
        expectedPartitionRevision: reserved.partitionRevision,
        reason: "cancelled",
      }),
    ).rejects.toMatchObject({ reason: "completion-reserved" });
    await expect(
      subject.adapter.retireStagedRebaseSource({
        ...acquired.lease,
        expectedPartitionRevision: reserved.partitionRevision,
        stagedOutputDigest: staged.candidate.stagedOutputDigest,
        effectLock: {
          kind: "managed-worktree-effect-lock",
          bindingDigest: qualified.queue.attempt.managedWorktreeBindingDigest,
        },
        live: {
          clean: true,
          liveTip: staged.candidate.resultCommit,
          resultCommit: staged.candidate.resultCommit,
          resultTree: staged.candidate.resultTree,
          repositoryId: staged.candidate.repositoryId,
          worktreePath: staged.binding.worktreePath,
          gitReceipts: staged.candidate.gitReceipts,
        },
        ontoCommit: "f".repeat(40),
        guardedRebase: `cq-guarded-rebase:v1:${"2".repeat(64)}`,
        guardedRebaseJournalDigest: "3".repeat(64),
      }),
    ).rejects.toMatchObject({ reason: "completion-reserved" });
    await expect(
      subject.adapter.releaseCompletion({
        ...acquired.lease,
        expectedPartitionRevision: reserved.partitionRevision,
        ...binding,
        operationId: "different-completion-reservation",
      }),
    ).rejects.toMatchObject({ reason: "completion-reserved" });

    const released = await subject.adapter.releaseCompletion({
      ...acquired.lease,
      expectedPartitionRevision: reserved.partitionRevision,
      ...binding,
      detail: { operation: "protected-completion", ...binding },
    });
    expect(released.state).toBe("released");
    expect(released.completionReservation).toBeUndefined();
  });

  test("one active task/goal/manifest enrollment refuses a duplicate attempt", async () => {
    const subject = fixture();
    const first = await subject.stage(candidate("T6518"));
    const duplicate = await subject.stage(candidate("T6518"));
    await subject.adapter.qualifyNativeCompletion({
      candidate: first.candidate,
      ...first.qualification,
    });

    await expect(
      subject.adapter.qualifyNativeCompletion({
        candidate: duplicate.candidate,
        ...duplicate.qualification,
      }),
    ).rejects.toThrow(ImplementationQueueConflictError);
    const duplicateRow = await subject.backend.transact({ kind: "namespace" }, (store) =>
      store.read(duplicate.prepared),
    );
    expect(duplicateRow?.implementationQueue).toBeUndefined();
  });

  // regression: T6518 review round 3 — terminal enrollment was treated as reusable authority.
  test("cancelled enrollment authority cannot be resurrected", async () => {
    const subject = fixture();
    const first = await subject.stage(candidate("T6518", { withReceipt: true }));
    const qualified = await subject.adapter.qualifyNativeCompletion({
      candidate: first.candidate,
      ...first.qualification,
    });
    await subject.adapter.terminalize({
      attestationId: first.prepared.attestationId,
      generation: first.prepared.generation,
      partitionKey: qualified.queue.partition.partitionKey,
      enrollmentId: qualified.queue.enrollment.enrollmentId,
      attemptId: qualified.queue.attempt.attemptId,
      expectedPartitionRevision: qualified.queue.partitionRevision,
      reason: "cancelled",
    });
    const resurrected = await subject.stage(candidate("T6518"));

    const rejection = await captureImplementationQueueConflict(() =>
      subject.adapter.qualifyNativeCompletion({
        candidate: resurrected.candidate,
        ...resurrected.qualification,
      }),
    );
    expect(rejection.message).toContain(
      "[qualification-refusal:v1 reason=no-intermediate scope=different-attestation " +
        `source-generation=${String(first.prepared.generation)} source-state=terminal ` +
        `source-terminal=cancelled target-generation=${String(resurrected.prepared.generation)} ` +
        "intermediate-count=0 bound-intermediate-count=0 admitted-first-hop-count=0 " +
        "first-intermediate-generation=none first-intermediate-state=none " +
        "first-intermediate-terminal=none first-admitted-generation=none]",
    );
    const receipt = first.candidate.gitReceipts[0];
    if (receipt === undefined)
      throw new Error("receipt-bearing diagnostic fixture lost its receipt");
    for (const forbidden of [
      first.binding.handleToken,
      first.binding.handleFingerprint,
      first.binding.repositoryRoot,
      first.binding.commonDir,
      first.binding.worktreePath,
      receipt.requestDigest,
      receipt.tree,
      ...receipt.objectOids,
    ]) {
      expect(rejection.message).not.toContain(forbidden);
    }
  });

  test("cancelled enrollment authority cannot be resurrected by a later generation of the same attestation", async () => {
    const subject = fixture();
    const first = await subject.stage(candidate("T6518"));
    const qualified = await subject.adapter.qualifyNativeCompletion({
      candidate: first.candidate,
      ...first.qualification,
    });
    await subject.adapter.terminalize({
      attestationId: first.prepared.attestationId,
      generation: first.prepared.generation,
      partitionKey: qualified.queue.partition.partitionKey,
      enrollmentId: qualified.queue.enrollment.enrollmentId,
      attemptId: qualified.queue.attempt.attemptId,
      expectedPartitionRevision: qualified.queue.partitionRevision,
      reason: "cancelled",
    });
    const resurrected = await subject.stage(
      candidate("T6518", {
        reprepareOf: first,
      }),
    );

    expect(resurrected.prepared).toMatchObject({
      attestationId: first.prepared.attestationId,
      generation: first.prepared.generation + 1,
    });
    const rejection = await captureImplementationQueueConflict(() =>
      subject.adapter.qualifyNativeCompletion({
        candidate: resurrected.candidate,
        ...resurrected.qualification,
      }),
    );
    expect(rejection.message).toContain(
      "[qualification-refusal:v1 reason=no-intermediate scope=same-attestation " +
        `source-generation=${String(first.prepared.generation)} source-state=terminal ` +
        `source-terminal=cancelled target-generation=${String(resurrected.prepared.generation)} ` +
        "intermediate-count=0 bound-intermediate-count=0 admitted-first-hop-count=0 " +
        "first-intermediate-generation=none first-intermediate-state=none " +
        "first-intermediate-terminal=none first-admitted-generation=none]",
    );
  });

  // regression: tasks:T6573 — qualification refusals expose only bounded ancestry diagnostics.
  test("a composed enrollment refusal identifies its first rejected ancestry relation", async () => {
    const subject = fixture();
    const exactTipBinding: DispatchGitEffectBinding = {
      taskId: "T6518",
      handleToken: "diagnostic-manager-token",
      handleFingerprint: "4".repeat(64),
      repositoryRoot: "/diagnostic-repository",
      repositoryId: repositoryA,
      commonDir: "/diagnostic-repository/.git",
      worktreePath: "/diagnostic-repository/.claude/worktrees/T6518",
      branch: "implement/T6518",
      ref: "refs/heads/implement/T6518",
      baseCommit: "4".repeat(40),
    };
    const first = await subject.stage(
      candidate("T6518", {
        gitEffectBinding: exactTipBinding,
        resultCommit: exactTipBinding.baseCommit,
      }),
    );
    const firstQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: first.candidate,
      ...first.qualification,
    });
    const firstLease = await subject.adapter.acquire({
      partitionKey: firstQualified.queue.partition.partitionKey,
      holderId: "diagnostic-first-gate",
    });
    if (firstLease.state !== "leased") throw new Error("expected first diagnostic lease");
    if (first.prepared.parentGateCapability === undefined) {
      throw new Error("diagnostic source omitted parent gate capability");
    }
    const claimed = await claimParentGateOn(
      subject.backend,
      {
        attestationId: first.prepared.attestationId,
        generation: first.prepared.generation,
        parentGateCapability: first.prepared.parentGateCapability,
        queueLease: firstLease.lease,
      },
      { now: subject.clock.now },
    );
    if (claimed.state !== "gate-running") throw new Error("expected diagnostic gate claim");
    await completeParentGateOn(
      subject.backend,
      {
        attestationId: first.prepared.attestationId,
        generation: first.prepared.generation,
        parentGateCapability: first.prepared.parentGateCapability,
        queueLease: firstLease.lease,
        gateEpoch: claimed.gateEpoch,
        output: {
          ...(claimed.output as Readonly<Record<string, DispatchJSONValue>>),
          supervisedGateEvidence: {
            kind: "cq-supervised-gate-evidence",
            version: 1,
            attestationId: first.prepared.attestationId,
            generation: first.prepared.generation,
            roleId: "implement-worker",
            roleVersion: first.prepared.promptProvenance.version,
            surface: "codex",
            promptDigest: first.prepared.promptProvenance.promptDigest,
            catalogHash: first.prepared.promptProvenance.catalogHash,
            inputDigest: first.prepared.promptProvenance.inputDigest,
            taskId: first.binding.taskId,
            worktreePath: first.binding.worktreePath,
            branch: first.binding.branch,
            baseCommit: first.binding.baseCommit,
            startingCommit: first.binding.baseCommit,
            resultCommit: first.candidate.resultCommit,
            clean: true,
            command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
            gateExitCode: 0,
            passCount: 1,
            failCount: 0,
            gateDurationMs: 1,
            capturedAt: subject.clock.now(),
            filesTouchedDigest: "1".repeat(64),
            gitReceiptsDigest: "2".repeat(64),
            mutationTableDigest: "3".repeat(64),
          },
        },
      },
      { now: subject.clock.now },
    );
    await confirmDispatchCompletionOn(
      subject.backend,
      {
        namespace,
        attestationId: first.prepared.attestationId,
        generation: first.prepared.generation,
        nativeCompletion: first.qualification.nativeCompletion,
        expectedProvenance: first.qualification.expectedProvenance,
        continuationContext: {
          liveTip: first.candidate.resultCommit,
          gitReceipts: [],
        },
      },
      { now: subject.clock.now },
    );

    const intermediate = await subject.stage(candidate("T6518", { reprepareOf: first }));
    const intermediateQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: intermediate.candidate,
      ...intermediate.qualification,
    });
    await subject.adapter.terminalize({
      attestationId: intermediate.prepared.attestationId,
      generation: intermediate.prepared.generation,
      partitionKey: intermediateQualified.queue.partition.partitionKey,
      enrollmentId: intermediateQualified.queue.enrollment.enrollmentId,
      attemptId: intermediateQualified.queue.attempt.attemptId,
      expectedPartitionRevision: intermediateQualified.queue.partitionRevision,
      reason: "cancelled",
    });
    const rejected = await subject.stage(candidate("T6518", { reprepareOf: intermediate }));

    const rejection = await captureImplementationQueueConflict(() =>
      subject.adapter.qualifyNativeCompletion({
        candidate: rejected.candidate,
        ...rejected.qualification,
      }),
    );
    expect(rejection.message).toContain(
      "[qualification-refusal:v1 reason=first-hop-rejected scope=same-attestation " +
        `source-generation=${String(first.prepared.generation)} source-state=terminal ` +
        `source-terminal=superseded target-generation=${String(rejected.prepared.generation)} ` +
        "intermediate-count=1 bound-intermediate-count=1 admitted-first-hop-count=0 " +
        `first-intermediate-generation=${String(intermediate.prepared.generation)} ` +
        "first-intermediate-state=terminal first-intermediate-terminal=cancelled " +
        "first-admitted-generation=none]",
    );
    for (const forbidden of [
      exactTipBinding.handleToken,
      exactTipBinding.handleFingerprint,
      exactTipBinding.repositoryRoot,
      exactTipBinding.commonDir,
      exactTipBinding.worktreePath,
    ]) {
      expect(rejection.message).not.toContain(forbidden);
    }
  });

  for (const terminalReason of [
    "cancelled",
    "native-failure",
    "foreign-completion",
    "mismatched-completion",
    "superseded",
  ] as const) {
    test(`${terminalReason} terminalization is immutable and exact replay does not advance the partition`, async () => {
      const subject = fixture();
      const staged = await subject.stage(candidate("T6518"));
      const qualified = await subject.adapter.qualifyNativeCompletion({
        candidate: staged.candidate,
        ...staged.qualification,
      });
      const request = {
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
        partitionKey: qualified.queue.partition.partitionKey,
        enrollmentId: qualified.queue.enrollment.enrollmentId,
        attemptId: qualified.queue.attempt.attemptId,
        expectedPartitionRevision: qualified.queue.partitionRevision,
        reason: terminalReason,
        detail: { terminalReason },
      } as const;
      await expect(
        subject.adapter.terminalize({
          ...request,
          expectedPartitionRevision: request.expectedPartitionRevision - 1,
        }),
      ).rejects.toMatchObject({ reason: "partition-revision" });

      const first = await subject.adapter.terminalize(request);
      const terminalRow = await subject.backend.transact({ kind: "namespace" }, (store) =>
        store.read(staged.prepared),
      );
      if (terminalRow === undefined) throw new Error("terminal queue row missing");
      const terminalDigest = attestationRowDigest(terminalRow);
      expect(terminalRow.implementationQueue).toMatchObject({
        state: "terminal",
        terminal: { reason: terminalReason },
      });

      expect(await subject.adapter.terminalize(request)).toEqual(first);
      const afterReplay = await subject.backend.transact({ kind: "namespace" }, (store) =>
        store.read(staged.prepared),
      );
      if (afterReplay === undefined) throw new Error("replayed queue row missing");
      expect(attestationRowDigest(afterReplay)).toBe(terminalDigest);

      const alteredReason = terminalReason === "cancelled" ? "native-failure" : "cancelled";
      await expect(
        subject.adapter.terminalize({
          ...request,
          expectedPartitionRevision: terminalRow.implementationQueue!.partitionRevision,
          reason: alteredReason,
        }),
      ).rejects.toMatchObject({ reason: "already-terminal" });
      const afterConflict = await subject.backend.transact({ kind: "namespace" }, (store) =>
        store.read(staged.prepared),
      );
      if (afterConflict === undefined) throw new Error("conflicted queue row missing");
      expect(attestationRowDigest(afterConflict)).toBe(terminalDigest);
    });
  }

  for (const protectedReason of [
    "parent-lost",
    "gate-rejected",
    "operational-abstention",
  ] as const) {
    // regression: T6518 review round 9 — stored abort provenance widened this command's domain.
    test(`${protectedReason} cannot bypass its authoritative transition through direct terminalization`, async () => {
      const subject = fixture();
      const staged = await subject.stage(candidate("T6518"));
      const qualified = await subject.adapter.qualifyNativeCompletion({
        candidate: staged.candidate,
        ...staged.qualification,
      });
      const before = await subject.backend.transact({ kind: "namespace" }, (store) =>
        store.read(staged.prepared),
      );
      if (before === undefined) throw new Error("qualified queue row missing");
      const beforeDigest = attestationRowDigest(before);

      await expect(
        subject.adapter.terminalize({
          attestationId: staged.prepared.attestationId,
          generation: staged.prepared.generation,
          partitionKey: qualified.queue.partition.partitionKey,
          enrollmentId: qualified.queue.enrollment.enrollmentId,
          attemptId: qualified.queue.attempt.attemptId,
          expectedPartitionRevision: qualified.queue.partitionRevision,
          reason: protectedReason as unknown as DirectTerminalReason,
        }),
      ).rejects.toThrow(AttestationContractError);

      const after = await subject.backend.transact({ kind: "namespace" }, (store) =>
        store.read(staged.prepared),
      );
      if (after === undefined) throw new Error("refused queue row missing");
      expect(attestationRowDigest(after)).toBe(beforeDigest);
      expect(after).toMatchObject({
        state: "gate-pending",
        implementationQueue: { state: "qualified" },
      });
    });
  }

  test("released queue control cannot be terminalized", async () => {
    const subject = fixture();
    const staged = await subject.stage(candidate("T6518"));
    const qualified = await subject.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const acquired = await subject.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "released-terminalization",
    });
    if (acquired.state !== "leased") throw new Error("expected a leased candidate");
    const released = await subject.adapter.release({
      ...acquired.lease,
      expectedPartitionRevision: acquired.partitionRevision,
    });
    const releasedRow = await subject.backend.transact({ kind: "namespace" }, (store) =>
      store.read(staged.prepared),
    );
    if (releasedRow === undefined) throw new Error("released queue row missing");
    const releasedDigest = attestationRowDigest(releasedRow);

    await expect(
      subject.adapter.terminalize({
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
        partitionKey: released.partition.partitionKey,
        enrollmentId: released.enrollment.enrollmentId,
        attemptId: released.attempt.attemptId,
        expectedPartitionRevision: released.partitionRevision,
        reason: "cancelled",
      }),
    ).rejects.toMatchObject({ reason: "already-terminal" });
    const afterConflict = await subject.backend.transact({ kind: "namespace" }, (store) =>
      store.read(staged.prepared),
    );
    if (afterConflict === undefined) throw new Error("released queue row disappeared");
    expect(attestationRowDigest(afterConflict)).toBe(releasedDigest);
  });

  for (const reason of ["cancelled", "parent-lost"] as const) {
    test(`${reason} queued source cannot use an ordinary guarded-rebase bridge`, async () => {
      const subject = fixture();
      const first = await subject.stage(candidate("T6518"));
      const qualified = await subject.adapter.qualifyNativeCompletion({
        candidate: first.candidate,
        ...first.qualification,
      });
      if (reason === "cancelled") {
        await subject.adapter.terminalize({
          attestationId: first.prepared.attestationId,
          generation: first.prepared.generation,
          partitionKey: qualified.queue.partition.partitionKey,
          enrollmentId: qualified.queue.enrollment.enrollmentId,
          attemptId: qualified.queue.attempt.attemptId,
          expectedPartitionRevision: qualified.queue.partitionRevision,
          reason,
        });
      } else {
        await abortDispatchOn(
          subject.backend,
          {
            namespace,
            actor: "trusted-parent",
            attestationId: first.prepared.attestationId,
            generation: first.prepared.generation,
            reason,
            recoveryContext: { liveTip: first.binding.baseCommit, gitReceipts: [] },
          },
          { now: subject.clock.now },
        );
      }
      const ontoCommit = "a".repeat(40);
      const rebasedStartCommit = "b".repeat(40);
      const successorBinding: DispatchGitEffectBinding = {
        ...first.binding,
        baseCommit: ontoCommit,
        guardedRebaseBridge: {
          guardedRebase: `cq-guarded-rebase:v1:${"c".repeat(64)}`,
          operationId: `terminal-queue-${reason}-bridge`,
          requestDigest: "d".repeat(64),
          oldResultCommit: first.candidate.resultCommit,
          ontoCommit,
          rebasedStartCommit,
          outcome: "clean",
          exactTip: true,
          finalizedAt: subject.clock.peek(),
        },
      };

      await expect(
        prepareDispatchOn(
          subject.backend,
          {
            namespace,
            roleId: "implement-worker",
            surface: "codex",
            input: {
              taskId: first.binding.taskId,
              headline: "Reject a terminal queue bridge",
              description: "A terminal queue enrollment lacks staged-rebase retirement authority.",
              acceptance: "Only a retired queue source can allocate a guarded-rebase successor.",
              worktreePath: first.binding.worktreePath,
              branch: first.binding.branch,
              baseCommit: ontoCommit,
              round: first.prepared.generation,
              startingCommit: rebasedStartCommit,
              validationIntent: "final",
              priorResultCommit: first.candidate.resultCommit,
            },
            idempotencyKey: `terminal-queue-${reason}-successor`,
            timeoutMs: 600_000,
            registry: DISPATCH_OVERLAY_REGISTRY,
            promptDigest: "a".repeat(64),
            catalogHash: "b".repeat(64),
            expectedChild: {
              childId: `queue-${reason}-successor-child`,
              runId: `queue-${reason}-successor-run`,
            },
            reprepareOf: {
              attestationId: first.prepared.attestationId,
              generation: first.prepared.generation,
            },
            gitEffectBinding: successorBinding,
          },
          {
            mode: "manager-bound",
            now: subject.clock.now,
            randomBytes: sequentialDispatchRandomBytes(reason === "cancelled" ? 7000 : 7100),
            lineageFenceGuard: async () => null,
            withLineageLock: async (operation) => await operation(),
          },
        ),
      ).rejects.toThrow("not a retired implementation queue enrollment");
    });
  }

  // regression: T6518 review round 3 — a lower-revision row could hide a terminal mutation.
  test("terminal dispatch mutations advance the partition-wide revision", async () => {
    const subject = fixture();
    const first = await subject.stage(candidate("T6518"));
    const second = await subject.stage(candidate("T6519"));
    await subject.adapter.qualifyNativeCompletion({
      candidate: first.candidate,
      ...first.qualification,
    });
    const secondQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: second.candidate,
      ...second.qualification,
    });
    await abortDispatchOn(
      subject.backend,
      {
        namespace,
        actor: "trusted-parent",
        attestationId: first.prepared.attestationId,
        generation: first.prepared.generation,
        reason: "cancelled",
      },
      { now: subject.clock.now },
    );

    await expect(
      subject.adapter.acquire({
        partitionKey: secondQualified.queue.partition.partitionKey,
        holderId: "stale-partition-observer",
        expectedPartitionRevision: secondQualified.queue.partitionRevision,
      }),
    ).rejects.toThrow(/partition revision/);
  });

  // regression: T6518 review round 3 — confirmation also advanced only its stale row revision.
  test("confirmed dispatch mutations advance the partition-wide revision", async () => {
    const subject = fixture();
    const first = await subject.stage(candidate("T6518"));
    const firstQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: first.candidate,
      ...first.qualification,
    });
    const firstLease = await subject.adapter.acquire({
      partitionKey: firstQualified.queue.partition.partitionKey,
      holderId: "confirm-partition-revision",
    });
    if (firstLease.state !== "leased") throw new Error("expected first candidate lease");
    const second = await subject.stage(candidate("T6519"));
    const secondQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: second.candidate,
      ...second.qualification,
    });
    if (first.prepared.parentGateCapability === undefined) {
      throw new Error("managed Codex worker omitted parent gate capability");
    }
    const claimed = await claimParentGateOn(
      subject.backend,
      {
        attestationId: first.prepared.attestationId,
        generation: first.prepared.generation,
        parentGateCapability: first.prepared.parentGateCapability,
        queueLease: firstLease.lease,
      },
      { now: subject.clock.now },
    );
    if (claimed.state !== "gate-running") throw new Error("expected claimed parent gate");
    await completeParentGateOn(
      subject.backend,
      {
        attestationId: first.prepared.attestationId,
        generation: first.prepared.generation,
        parentGateCapability: first.prepared.parentGateCapability,
        queueLease: firstLease.lease,
        gateEpoch: claimed.gateEpoch,
        output: {
          ...(claimed.output as Readonly<Record<string, DispatchJSONValue>>),
          supervisedGateEvidence: {
            kind: "cq-supervised-gate-evidence",
            version: 1,
            attestationId: first.prepared.attestationId,
            generation: first.prepared.generation,
            roleId: "implement-worker",
            roleVersion: first.prepared.promptProvenance.version,
            surface: "codex",
            promptDigest: first.prepared.promptProvenance.promptDigest,
            catalogHash: first.prepared.promptProvenance.catalogHash,
            inputDigest: first.prepared.promptProvenance.inputDigest,
            taskId: first.binding.taskId,
            worktreePath: first.binding.worktreePath,
            branch: first.binding.branch,
            baseCommit: first.binding.baseCommit,
            startingCommit: first.binding.baseCommit,
            resultCommit: first.candidate.resultCommit,
            clean: true,
            command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
            gateExitCode: 0,
            passCount: 1,
            failCount: 0,
            gateDurationMs: 1,
            capturedAt: subject.clock.now(),
            filesTouchedDigest: "1".repeat(64),
            gitReceiptsDigest: "2".repeat(64),
            mutationTableDigest: "3".repeat(64),
          },
        },
      },
      { now: subject.clock.now },
    );
    await confirmDispatchCompletionOn(
      subject.backend,
      {
        namespace,
        attestationId: first.prepared.attestationId,
        generation: first.prepared.generation,
        nativeCompletion: first.qualification.nativeCompletion,
        expectedProvenance: first.qualification.expectedProvenance,
        continuationContext: {
          liveTip: first.binding.baseCommit,
          gitReceipts: [],
        },
      },
      { now: subject.clock.now },
    );

    await expect(
      subject.adapter.acquire({
        partitionKey: secondQualified.queue.partition.partitionKey,
        holderId: "stale-confirm-observer",
        expectedPartitionRevision: secondQualified.queue.partitionRevision,
      }),
    ).rejects.toThrow(/partition revision/);
  });

  // regression: T6518 review round 3 — state checks ran before exact replay checks.
  test("exact qualification replay remains idempotent after the gate starts", async () => {
    const subject = fixture();
    const staged = await subject.stage(candidate("T6518"));
    const qualified = await subject.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const acquired = await subject.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "qualification-replay-gate",
    });
    if (acquired.state !== "leased") throw new Error("expected qualified candidate lease");
    if (staged.prepared.parentGateCapability === undefined) {
      throw new Error("managed Codex worker omitted parent gate capability");
    }
    await claimParentGateOn(
      subject.backend,
      {
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
        parentGateCapability: staged.prepared.parentGateCapability,
        queueLease: acquired.lease,
      },
      { now: subject.clock.now },
    );

    const replay = await subject.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    expect(replay).toMatchObject({
      queue: { state: "leased" },
      qualification: { state: "qualified", replayed: true },
    });
  });

  test("park, yield, resume, cancellation, and stale lease generations are explicit", async () => {
    const subject = fixture();
    const staged = await subject.stage(candidate("T6518"));
    const qualified = await subject.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const acquired = await subject.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "integration-transition",
    });
    if (acquired.state !== "leased") throw new Error("expected transition lease");
    const parked = await subject.adapter.park({
      ...acquired.lease,
      expectedPartitionRevision: acquired.partitionRevision,
    });
    expect(parked.state).toBe("parked");
    expect(
      await subject.adapter.acquire({
        partitionKey: qualified.queue.partition.partitionKey,
        holderId: "blocked-behind-parked-front",
      }),
    ).toMatchObject({ state: "empty" });
    const resumed = await subject.adapter.resume({
      ...acquired.lease,
      expectedPartitionRevision: parked.partitionRevision,
    });
    const reacquired = await subject.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "integration-transition-resumed",
      expectedPartitionRevision: resumed.partitionRevision,
    });
    if (reacquired.state !== "leased") throw new Error("expected resumed lease");
    expect(reacquired.lease.leaseGeneration).toBe(acquired.lease.leaseGeneration + 1);
    await expect(
      subject.adapter.yield({
        ...acquired.lease,
        expectedPartitionRevision: reacquired.partitionRevision,
      }),
    ).rejects.toThrow("exact live lease generation");
    const yielded = await subject.adapter.yield({
      ...reacquired.lease,
      expectedPartitionRevision: reacquired.partitionRevision,
    });
    const cancelled = await subject.adapter.terminalize({
      attestationId: staged.prepared.attestationId,
      generation: staged.prepared.generation,
      partitionKey: yielded.partition.partitionKey,
      enrollmentId: yielded.enrollment.enrollmentId,
      attemptId: yielded.attempt.attemptId,
      expectedPartitionRevision: yielded.partitionRevision,
      reason: "cancelled",
    });
    expect(cancelled).toMatchObject({ state: "aborted", reason: "cancelled" });
  });
});
