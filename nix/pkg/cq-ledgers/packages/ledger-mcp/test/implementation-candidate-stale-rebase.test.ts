import { describe, expect, test } from "bun:test";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  enqueueImplementationCandidateOn,
} from "@cq/config";
import {
  ImplementationCandidateCoordinator,
  type ImplementationCandidateCoordinatorOperations,
} from "../src/implementationCandidateQueue.js";
import { ImplementationCandidateQueueFixture } from "./implementationCandidateQueueFixture.js";

const namespace = { backend: "xdg" as const, projectKey: "stale-rebase" };

describe("implementation candidate stale-base routing [Behavioral-Active, Blackbox-Group]", () => {
  // regression: T6519 — a process restart after the finalized Git effect must recover from durable state.
  test("a retired finalized source is reconstructed before any trailing front is acquired", async () => {
    const fixture = new ImplementationCandidateQueueFixture(
      new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace)),
    );
    const staged = await fixture.stage({
      taskId: "T6519",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "b".repeat(64),
    });
    const qualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const sourceReference = `cq-staged-rebase-source:v1:${"d".repeat(64)}`;
    const guardedRebase = `cq-guarded-rebase:v1:${"c".repeat(64)}`;
    const ontoCommit = "f".repeat(40);
    const source = Object.freeze({
      kind: "cq-staged-rebase-source-binding" as const,
      version: 1 as const,
      sourceReference,
      source: {
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
      },
      partitionKey: qualified.queue.partition.partitionKey,
      enrollmentId: qualified.queue.enrollment.enrollmentId,
      attemptId: qualified.queue.attempt.attemptId,
      leaseGeneration: 1,
      stagedOutputDigest: staged.candidate.stagedOutputDigest,
      sourceResultCommit: qualified.queue.attempt.resultCommit,
      sourceResultTree: qualified.queue.attempt.resultTree,
      gitReceiptLineageDigest: qualified.queue.attempt.gitReceiptLineageDigest,
      repositoryId: qualified.queue.attempt.repositoryId,
      worktreePath: qualified.queue.attempt.worktreePath,
      ontoCommit,
      guardedRebase,
      guardedRebaseJournalDigest: "e".repeat(64),
      retiredAt: "2026-09-15T12:00:01.000Z",
      serverBindingDigest: "f".repeat(64),
    });
    const control = Object.freeze({
      ...qualified.queue,
      state: "staged-rebase-retired" as const,
      stagedRebaseSource: source,
    });
    let acquireCalls = 0;
    let reconciliationCalls = 0;
    const queue = {
      inspectPendingStagedRebase: async () => ({ control, source }),
      acquire: async () => {
        acquireCalls += 1;
        return {
          state: "empty" as const,
          partitionKey: qualified.queue.partition.partitionKey,
          partitionRevision: control.partitionRevision,
        };
      },
    } as unknown as ConstructorParameters<typeof ImplementationCandidateCoordinator>[0];
    const operations = {
      reconcileRetiredSource: async () => {
        reconciliationCalls += 1;
        return {
          state: "successor-queued" as const,
          successor: { attestationId: staged.prepared.attestationId, generation: 2 },
        };
      },
    } as unknown as ImplementationCandidateCoordinatorOperations;
    const coordinator = new ImplementationCandidateCoordinator(queue, operations);

    const outcome = await coordinator.run({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "restart-coordinator",
    });

    expect(outcome).toEqual({
      state: "successor-queued",
      source: source.source,
      successor: { attestationId: staged.prepared.attestationId, generation: 2 },
    });
    expect(reconciliationCalls).toBe(1);
    expect(acquireCalls).toBe(0);

    const later = await fixture.stage({
      taskId: "T6520",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "c".repeat(64),
    });
    const laterQualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: later.candidate,
      ...later.qualification,
    });
    const laterLease = Object.freeze({
      attestationId: later.prepared.attestationId,
      generation: later.prepared.generation,
      partitionKey: laterQualified.queue.partition.partitionKey,
      enrollmentId: laterQualified.queue.enrollment.enrollmentId,
      attemptId: laterQualified.queue.attempt.attemptId,
      holderId: "restart-conflict-coordinator",
      leaseGeneration: 1,
    });
    let conflictParked = false;
    let conflictParkCalls = 0;
    let laterGateCalls = 0;
    const conflictedQueue = {
      inspectPendingStagedRebase: async (
        _partitionKey: string,
        disposition: "undisposed" | "conflict-pending" = "undisposed",
      ) =>
        disposition === "conflict-pending"
          ? conflictParked
            ? { control, source }
            : undefined
          : conflictParked
            ? undefined
            : { control, source },
      parkRetiredStagedRebaseConflict: async () => {
        conflictParkCalls += 1;
        conflictParked = true;
        return {
          ...control,
          partitionRevision: control.partitionRevision + 1,
          stagedRebaseDisposition: {
            kind: "cq-staged-rebase-disposition" as const,
            version: 1 as const,
            state: "conflict-pending" as const,
            dispositionAt: "2026-09-15T12:00:02.000Z",
            detailsDigest: "a".repeat(64),
          },
        };
      },
      acquire: async () => {
        acquireCalls += 1;
        if (acquireCalls > 1) {
          return {
            state: "empty" as const,
            partitionKey: laterQualified.queue.partition.partitionKey,
            partitionRevision: control.partitionRevision + 2,
          };
        }
        return {
          state: "leased" as const,
          lease: laterLease,
          partitionRevision: control.partitionRevision + 2,
          replayed: false,
        };
      },
      inspectLease: async () => ({
        ...laterQualified.queue,
        state: "leased" as const,
        partitionRevision: control.partitionRevision + 2,
        leaseGeneration: laterLease.leaseGeneration,
        lease: {
          holderId: laterLease.holderId,
          generation: laterLease.leaseGeneration,
          acquiredAt: "2026-09-15T12:00:03.000Z",
        },
      }),
    } as unknown as ConstructorParameters<typeof ImplementationCandidateCoordinator>[0];
    const conflicted = new ImplementationCandidateCoordinator(conflictedQueue, {
      reconcileRetiredSource: async () => ({ state: "conflict-pending" as const }),
      observeProtectedHead: async (laterControl: typeof laterQualified.queue) =>
        laterControl.attempt.observedBaseCommit,
      finalizeQualifiedFront: async () => {
        laterGateCalls += 1;
      },
      confirmQualifiedFront: async () => undefined,
    } as unknown as ImplementationCandidateCoordinatorOperations);
    expect(
      await conflicted.run({
        partitionKey: qualified.queue.partition.partitionKey,
        holderId: "restart-conflict-coordinator",
      }),
    ).toEqual({
      state: "blocked",
      partitionKey: source.partitionKey,
      partitionRevision: control.partitionRevision + 1,
      front: source.source,
      frontState: "staged-rebase-retired",
      sourceReference,
    });
    expect(conflictParkCalls).toBe(1);
    expect(acquireCalls).toBe(0);

    expect(
      await conflicted.run({
        partitionKey: qualified.queue.partition.partitionKey,
        holderId: "restart-conflict-coordinator",
      }),
    ).toEqual({
      state: "completed",
      handle: {
        attestationId: later.prepared.attestationId,
        generation: later.prepared.generation,
      },
    });
    expect(acquireCalls).toBe(1);
    expect(laterGateCalls).toBe(1);

    expect(
      await conflicted.run({
        partitionKey: qualified.queue.partition.partitionKey,
        holderId: "restart-conflict-coordinator",
      }),
    ).toEqual({
      state: "blocked",
      partitionKey: source.partitionKey,
      partitionRevision: control.partitionRevision + 1,
      front: source.source,
      frontState: "staged-rebase-retired",
      sourceReference,
    });
    expect(acquireCalls).toBe(2);
    expect(conflictParkCalls).toBe(2);
  });

  // regression: T6519 — a staged row with no durable completion proof must not block forever.
  test("an expired unqualified front terminalizes before the next qualified enrollment leases", async () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const first = await fixture.stage({
      taskId: "T6519",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "b".repeat(64),
    });
    const firstQueue = await enqueueImplementationCandidateOn(
      backend,
      { namespace, actor: "trusted-parent", ...first.candidate },
      { now: fixture.clock.now },
    );
    fixture.clock.advance(300_001);
    const second = await fixture.stage({
      taskId: "T6520",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "c".repeat(64),
    });
    const secondQualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: second.candidate,
      ...second.qualification,
    });
    fixture.clock.advance(900_000);

    const acquired = await fixture.adapter.acquire({
      partitionKey: firstQueue.partition.partitionKey,
      holderId: "completion-unobserved-recovery",
    });

    expect(acquired).toMatchObject({
      state: "leased",
      lease: {
        attestationId: second.prepared.attestationId,
        generation: second.prepared.generation,
        enrollmentId: secondQualified.queue.enrollment.enrollmentId,
      },
    });
    expect(
      backend
        .storedRows()
        .find(
          (row) =>
            row.attestationId === first.prepared.attestationId &&
            row.generation === first.prepared.generation,
        ),
    ).toMatchObject({
      state: "aborted",
      abortReason: "native-failure",
      implementationQueue: {
        state: "terminal",
        terminal: { reason: "completion-unobserved" },
      },
    });
  });

  test("a genuinely late native proof is refused at the qualification boundary", async () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const staged = await fixture.stage({
      taskId: "T6521",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "d".repeat(64),
    });
    await enqueueImplementationCandidateOn(
      backend,
      { namespace, actor: "trusted-parent", ...staged.candidate },
      { now: fixture.clock.now },
    );
    fixture.clock.advance(300_001);

    const late = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });

    expect(late.qualification).toMatchObject({
      state: "aborted",
      result: { reason: "native-failure" },
    });
    expect(late.queue).toMatchObject({
      state: "terminal",
      terminal: { reason: "completion-unobserved" },
    });
  });

  // specified: T6519 — no gate is allowed before the retired source is rebased and succeeded.
  test("stale qualified front retires, broker-rebases, and prepares one successor without a gate", async () => {
    const fixture = new ImplementationCandidateQueueFixture(
      new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace)),
    );
    const staged = await fixture.stage({
      taskId: "T6519",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "b".repeat(64),
    });
    const qualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const protectedHead = "f".repeat(40);
    const events: string[] = [];
    let gateCalls = 0;
    const operations: ImplementationCandidateCoordinatorOperations = {
      observeProtectedHead: async () => protectedHead,
      finalizeQualifiedFront: async () => {
        gateCalls += 1;
      },
      confirmQualifiedFront: async () => {
        throw new Error("stale source must not confirm");
      },
      retireStaleSource: async ({ control, ontoCommit }) => {
        events.push("retire");
        expect(control.attempt.resultCommit).toBe(staged.candidate.resultCommit);
        expect(ontoCommit).toBe(protectedHead);
        return { sourceReference: "retired:T6519:1" };
      },
      rebaseRetiredSource: async (input) => {
        events.push("rebase");
        expect(input).toMatchObject({
          operation: "rebase",
          ontoCommit: protectedHead,
          retirement: { sourceReference: "retired:T6519:1" },
        });
        expect(input.operationId).toMatch(/^implementation-rebase-[0-9a-f]{32}$/u);
        return { guardedRebase: `cq-guarded-rebase:v1:${"c".repeat(64)}` };
      },
      prepareSuccessor: async ({ retirement, rebase, ontoCommit }) => {
        events.push("prepare-successor");
        expect(retirement.sourceReference).toBe("retired:T6519:1");
        expect(rebase.guardedRebase).toMatch(/^cq-guarded-rebase:v1:/u);
        expect(ontoCommit).toBe(protectedHead);
        return { attestationId: "att_successor", generation: 2 };
      },
    };
    const coordinator = new ImplementationCandidateCoordinator(fixture.adapter, operations);

    const outcome = await coordinator.run({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "local-coordinator",
    });

    expect(outcome).toEqual({
      state: "successor-queued",
      source: {
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
      },
      successor: { attestationId: "att_successor", generation: 2 },
    });
    expect(events).toEqual(["retire", "rebase", "prepare-successor"]);
    expect(gateCalls).toBe(0);
  });
});
