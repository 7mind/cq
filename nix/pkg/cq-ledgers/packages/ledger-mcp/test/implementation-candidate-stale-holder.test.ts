import { describe, expect, test } from "bun:test";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  claimQualifiedParentGateOn,
  enqueueImplementationCandidateOn,
} from "@cq/config";
import { ImplementationCandidateQueueFixture } from "./implementationCandidateQueueFixture.js";

const namespace = { backend: "xdg" as const, projectKey: "candidate-stale-holder" };

describe("implementation candidate stale-holder fencing [Behavioral-Active, Blackbox-Group]", () => {
  test("only the current resumed lease generation can attach gate evidence", async () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const staged = await fixture.stage({
      taskId: "T6520",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "b".repeat(64),
    });
    const qualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const first = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "pre-restart-holder",
    });
    if (first.state !== "leased") throw new Error("expected first candidate lease");
    const parked = await fixture.adapter.park({
      ...first.lease,
      expectedPartitionRevision: first.partitionRevision,
      detail: { reason: "execution-uncertain" },
    });
    const resumed = await fixture.adapter.resume({
      ...first.lease,
      expectedPartitionRevision: parked.partitionRevision,
      detail: { reason: "operator-resume" },
    });
    const successor = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "post-restart-holder",
      expectedPartitionRevision: resumed.partitionRevision,
    });
    if (successor.state !== "leased") throw new Error("expected resumed candidate lease");
    expect(successor.lease.leaseGeneration).toBe(first.lease.leaseGeneration + 1);

    await expect(
      claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: first.lease },
        { now: fixture.clock.now },
      ),
    ).rejects.toThrow("exact current implementation queue lease");
    await expect(fixture.adapter.inspectLease(first.lease)).rejects.toThrow("stale");
    await expect(
      claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: successor.lease },
        { now: fixture.clock.now },
      ),
    ).resolves.toMatchObject({ state: "gate-running" });
  });

  test("unqualified and staged-rebase-retired rows remain ineligible after durable replay", async () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const staged = await fixture.stage({
      taskId: "T6520",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "b".repeat(64),
    });
    const enqueued = await enqueueImplementationCandidateOn(
      backend,
      { namespace, actor: "trusted-parent", ...staged.candidate },
      { now: fixture.clock.now },
    );
    const neverQualifiedLease = {
      attestationId: staged.prepared.attestationId,
      generation: staged.prepared.generation,
      partitionKey: enqueued.partition.partitionKey,
      enrollmentId: enqueued.enrollment.enrollmentId,
      attemptId: enqueued.attempt.attemptId,
      holderId: "unqualified-holder",
      leaseGeneration: 1,
    } as const;
    expect(
      await fixture.adapter.acquire({
        partitionKey: enqueued.partition.partitionKey,
        holderId: neverQualifiedLease.holderId,
      }),
    ).toMatchObject({ state: "blocked", frontState: "enqueued" });
    await expect(
      claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: neverQualifiedLease },
        { now: fixture.clock.now },
      ),
    ).rejects.toThrow("exactly qualified staged completion");

    const qualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const acquired = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "pre-rebase-holder",
    });
    if (acquired.state !== "leased") throw new Error("expected qualified source lease");
    const source = await fixture.adapter.retireStagedRebaseSource({
      ...acquired.lease,
      expectedPartitionRevision: acquired.partitionRevision,
      stagedOutputDigest: staged.candidate.stagedOutputDigest,
      effectLock: {
        kind: "managed-worktree-effect-lock",
        bindingDigest: qualified.queue.attempt.managedWorktreeBindingDigest,
      },
      live: {
        clean: true,
        liveTip: qualified.queue.attempt.resultCommit,
        resultCommit: qualified.queue.attempt.resultCommit,
        resultTree: qualified.queue.attempt.resultTree,
        repositoryId: qualified.queue.attempt.repositoryId,
        worktreePath: qualified.queue.attempt.worktreePath,
        gitReceipts: qualified.queue.attempt.gitReceipts,
      },
      ontoCommit: "f".repeat(40),
      guardedRebase: `cq-guarded-rebase:v1:${"c".repeat(64)}`,
      guardedRebaseJournalDigest: "d".repeat(64),
    });
    backend.rehydrate();
    expect(backend.storedRows()[0]).toMatchObject({
      state: "aborted",
      implementationQueue: {
        state: "staged-rebase-retired",
        stagedRebaseSource: { sourceReference: source.sourceReference },
      },
    });
    await expect(
      claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: acquired.lease },
        { now: fixture.clock.now },
      ),
    ).rejects.toThrow();
  });
});
