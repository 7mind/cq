import { describe, expect, test } from "bun:test";
import { InMemoryAttestationBackend, InMemoryAttestationStore } from "@cq/config";
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
      confirmAndFetchQualifiedFront: async () => {
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
