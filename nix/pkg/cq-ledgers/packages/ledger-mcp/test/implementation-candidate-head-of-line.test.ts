import { describe, expect, test } from "bun:test";
import { InMemoryAttestationBackend, InMemoryAttestationStore } from "@cq/config";
import {
  ImplementationCandidateCoordinator,
  IMPLEMENTATION_CANDIDATE_HEAD_OF_LINE_POLICIES,
  type ImplementationCandidateHeadOfLineDisposition,
} from "../src/implementationCandidateQueue.js";
import { ImplementationCandidateQueueFixture } from "./implementationCandidateQueueFixture.js";

const namespace = { backend: "xdg" as const, projectKey: "head-of-line" };

function candidate(taskId: string) {
  return {
    taskId,
    repositoryId: "a".repeat(64),
    integrationRef: "refs/heads/main",
    goalRef: `goals:G${taskId.slice(1)}`,
    finalizedManifestDigest: taskId.endsWith("9") ? "b".repeat(64) : "c".repeat(64),
  };
}

describe("implementation candidate head-of-line policy [Behavioral-Active, Blackbox-Group]", () => {
  test("every terminal or nonterminal front disposition has one explicit lease policy", () => {
    expect(IMPLEMENTATION_CANDIDATE_HEAD_OF_LINE_POLICIES).toEqual({
      park: "park",
      yield: "yield",
      resume: "resume",
      cancel: "cancelled",
      supersede: "superseded",
      "review-question": "park",
      "non-converging-criticism": "yield",
      "task-abandonment": "cancelled",
      "owner-revocation": "cancelled",
      "worktree-authority-revocation": "cancelled",
      "permanent-ineligibility": "superseded",
      conflict: "park",
      "deterministic-red": "yield",
      "execution-uncertainty": "park",
    });
  });

  // specified: T6519 — an explicitly parked front is fenced out until a fresh resume lease.
  test("park revokes the front lease and advances the next eligible enrollment", async () => {
    const fixture = new ImplementationCandidateQueueFixture(
      new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace)),
    );
    const first = await fixture.stage(candidate("T6519"));
    const firstQualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: first.candidate,
      ...first.qualification,
    });
    const second = await fixture.stage(candidate("T6520"));
    await fixture.adapter.qualifyNativeCompletion({
      candidate: second.candidate,
      ...second.qualification,
    });
    const firstLease = await fixture.adapter.acquire({
      partitionKey: firstQualified.queue.partition.partitionKey,
      holderId: "coordinator-first",
    });
    if (firstLease.state !== "leased") throw new Error("expected first lease");
    await fixture.adapter.park({
      ...firstLease.lease,
      expectedPartitionRevision: firstLease.partitionRevision,
      detail: { policy: "review-question" },
    });

    const advanced = await fixture.adapter.acquire({
      partitionKey: firstQualified.queue.partition.partitionKey,
      holderId: "coordinator-second",
    });

    expect(advanced).toMatchObject({
      state: "leased",
      lease: {
        attestationId: second.prepared.attestationId,
        generation: second.prepared.generation,
      },
    });
  });

  test.each([
    ["park", "parked"],
    ["yield", "yielded"],
    ["cancel", "terminal"],
    ["supersede", "terminal"],
    ["review-question", "parked"],
    ["non-converging-criticism", "yielded"],
    ["task-abandonment", "terminal"],
    ["owner-revocation", "terminal"],
    ["worktree-authority-revocation", "terminal"],
    ["permanent-ineligibility", "terminal"],
    ["conflict", "parked"],
    ["deterministic-red", "yielded"],
    ["execution-uncertainty", "parked"],
  ] as const)("applies %s durably and revokes its lease", async (disposition, expectedState) => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const staged = await fixture.stage(candidate(`T${String(6600 + disposition.length)}`));
    const qualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const acquired = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: `coordinator-${disposition}`,
    });
    if (acquired.state !== "leased") throw new Error("expected a live lease");

    await fixture.adapter.applyHeadOfLineDisposition({
      disposition: disposition as ImplementationCandidateHeadOfLineDisposition,
      lease: acquired.lease,
      expectedPartitionRevision: acquired.partitionRevision,
      detail: { disposition },
    });

    const row = backend.storedRows().find(
      (entry) =>
        entry.attestationId === staged.prepared.attestationId &&
        entry.generation === staged.prepared.generation,
    );
    expect(row?.implementationQueue).toMatchObject({
      state: expectedState,
      leaseGeneration: acquired.lease.leaseGeneration,
    });
    expect(row?.implementationQueue).not.toHaveProperty("lease");
  });

  test("resume retains enrollment and qualification under a fresh lease generation", async () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const staged = await fixture.stage(candidate("T6699"));
    const qualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const acquired = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "coordinator-before-resume",
    });
    if (acquired.state !== "leased") throw new Error("expected a live lease");
    const parked = await fixture.adapter.applyHeadOfLineDisposition({
      disposition: "park",
      lease: acquired.lease,
      expectedPartitionRevision: acquired.partitionRevision,
      detail: { disposition: "park" },
    });
    if (!("partition" in parked)) throw new Error("expected parked control");

    await fixture.adapter.applyHeadOfLineDisposition({
      disposition: "resume",
      lease: acquired.lease,
      expectedPartitionRevision: parked.partitionRevision,
      detail: { disposition: "resume" },
    });
    const resumed = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "coordinator-after-resume",
    });

    expect(resumed).toMatchObject({
      state: "leased",
      lease: {
        enrollmentId: acquired.lease.enrollmentId,
        attemptId: acquired.lease.attemptId,
        leaseGeneration: acquired.lease.leaseGeneration + 1,
      },
    });
  });

  // regression: T6519 round 21 — resuming an older parked/yielded enrollment
  // while a later enrollment held the partition lease created two live leases.
  test.each([
    ["park", "parked"],
    ["yield", "yielded"],
  ] as const)(
    "%s cannot resume across a later live lease and resumes after its release",
    async (disposition, expectedState) => {
      const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
      const fixture = new ImplementationCandidateQueueFixture(backend);
      const first = await fixture.stage(candidate("T6719"));
      const firstQualified = await fixture.adapter.qualifyNativeCompletion({
        candidate: first.candidate,
        ...first.qualification,
      });
      const second = await fixture.stage(candidate("T6720"));
      await fixture.adapter.qualifyNativeCompletion({
        candidate: second.candidate,
        ...second.qualification,
      });
      const firstLease = await fixture.adapter.acquire({
        partitionKey: firstQualified.queue.partition.partitionKey,
        holderId: `coordinator-${disposition}-first`,
      });
      if (firstLease.state !== "leased") throw new Error("expected first lease");
      const deferred = await fixture.adapter.applyHeadOfLineDisposition({
        disposition,
        lease: firstLease.lease,
        expectedPartitionRevision: firstLease.partitionRevision,
        detail: { disposition },
      });
      if (!("partition" in deferred)) throw new Error(`expected ${expectedState} control`);
      const secondLease = await fixture.adapter.acquire({
        partitionKey: firstQualified.queue.partition.partitionKey,
        holderId: `coordinator-${disposition}-second`,
      });
      if (secondLease.state !== "leased") throw new Error("expected second lease");

      await expect(
        fixture.adapter.applyHeadOfLineDisposition({
          disposition: "resume",
          lease: firstLease.lease,
          expectedPartitionRevision: deferred.partitionRevision,
          detail: { disposition: "resume", authority: "stale-revision" },
        }),
      ).rejects.toMatchObject({ reason: "partition-revision" });
      await expect(
        fixture.adapter.applyHeadOfLineDisposition({
          disposition: "resume",
          lease: {
            ...firstLease.lease,
            leaseGeneration: firstLease.lease.leaseGeneration + 1,
          },
          expectedPartitionRevision: secondLease.partitionRevision,
          detail: { disposition: "resume", authority: "stale-generation" },
        }),
      ).rejects.toMatchObject({ reason: "stale-lease" });
      await expect(
        fixture.adapter.applyHeadOfLineDisposition({
          disposition: "resume",
          lease: firstLease.lease,
          expectedPartitionRevision: secondLease.partitionRevision,
          detail: { disposition: "resume", authority: "current" },
        }),
      ).rejects.toMatchObject({ reason: "not-front" });

      let gateCount = 0;
      const coordinator = new ImplementationCandidateCoordinator(fixture.adapter, {
        observeProtectedHead: async () => {
          throw new Error("a leased partition must not observe another front");
        },
        finalizeQualifiedFront: async () => {
          gateCount += 1;
          throw new Error("a leased partition must not run a second gate");
        },
        confirmAndFetchQualifiedFront: async () => {
          throw new Error("a leased partition must not confirm another front");
        },
        retireStaleSource: async () => {
          throw new Error("a leased partition must not retire another front");
        },
        rebaseRetiredSource: async () => {
          throw new Error("a leased partition must not rebase another front");
        },
        prepareSuccessor: async () => {
          throw new Error("a leased partition must not prepare another front");
        },
      });
      const blocked = await coordinator.run({
        partitionKey: firstQualified.queue.partition.partitionKey,
        holderId: `coordinator-${disposition}-would-be-second`,
      });
      expect(blocked).toMatchObject({
        state: "blocked",
        front: {
          attestationId: second.prepared.attestationId,
          generation: second.prepared.generation,
        },
        frontState: "leased",
      });
      expect(gateCount).toBe(0);

      const rowsWhileLeased = backend.storedRows();
      const firstWhileLeased = rowsWhileLeased.find(
        (row) => row.attestationId === first.prepared.attestationId,
      );
      const secondWhileLeased = rowsWhileLeased.find(
        (row) => row.attestationId === second.prepared.attestationId,
      );
      expect(firstWhileLeased?.implementationQueue).toMatchObject({
        state: expectedState,
        leaseGeneration: firstLease.lease.leaseGeneration,
      });
      expect(secondWhileLeased?.implementationQueue).toMatchObject({
        state: "leased",
        lease: {
          holderId: secondLease.lease.holderId,
          generation: secondLease.lease.leaseGeneration,
        },
      });
      expect(
        rowsWhileLeased.filter((row) => row.implementationQueue?.state === "leased"),
      ).toHaveLength(1);

      const independent = await fixture.stage({
        ...candidate("T6730"),
        repositoryId: "d".repeat(64),
      });
      const independentQualified = await fixture.adapter.qualifyNativeCompletion({
        candidate: independent.candidate,
        ...independent.qualification,
      });
      const independentLease = await fixture.adapter.acquire({
        partitionKey: independentQualified.queue.partition.partitionKey,
        holderId: `coordinator-${disposition}-independent`,
      });
      if (independentLease.state !== "leased") throw new Error("expected independent lease");
      const independentDeferred = await fixture.adapter.applyHeadOfLineDisposition({
        disposition,
        lease: independentLease.lease,
        expectedPartitionRevision: independentLease.partitionRevision,
      });
      if (!("partition" in independentDeferred)) {
        throw new Error(`expected independent ${expectedState} control`);
      }
      await fixture.adapter.applyHeadOfLineDisposition({
        disposition: "resume",
        lease: independentLease.lease,
        expectedPartitionRevision: independentDeferred.partitionRevision,
      });
      expect(
        await fixture.adapter.acquire({
          partitionKey: independentQualified.queue.partition.partitionKey,
          holderId: `coordinator-${disposition}-independent-resumed`,
        }),
      ).toMatchObject({
        state: "leased",
        lease: { leaseGeneration: independentLease.lease.leaseGeneration + 1 },
      });

      const released = await fixture.adapter.release({
        ...secondLease.lease,
        expectedPartitionRevision: secondLease.partitionRevision,
        detail: { disposition: "gate-complete" },
      });
      const resumed = await fixture.adapter.applyHeadOfLineDisposition({
        disposition: "resume",
        lease: firstLease.lease,
        expectedPartitionRevision: released.partitionRevision,
        detail: { disposition: "resume", authority: "after-release" },
      });
      expect(resumed).toMatchObject({
        state: "qualified",
        enrollment: firstQualified.queue.enrollment,
        qualification: firstQualified.queue.qualification,
      });
      expect(
        await fixture.adapter.acquire({
          partitionKey: firstQualified.queue.partition.partitionKey,
          holderId: `coordinator-${disposition}-resumed`,
        }),
      ).toMatchObject({
        state: "leased",
        lease: {
          enrollmentId: firstLease.lease.enrollmentId,
          attemptId: firstLease.lease.attemptId,
          leaseGeneration: firstLease.lease.leaseGeneration + 1,
        },
      });
    },
  );
});
