import { describe, expect, test } from "bun:test";
import { InMemoryAttestationBackend, InMemoryAttestationStore } from "@cq/config";
import {
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
    const secondQualified = await fixture.adapter.qualifyNativeCompletion({
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
});
