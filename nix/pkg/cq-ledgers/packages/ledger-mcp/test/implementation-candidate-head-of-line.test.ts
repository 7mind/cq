import { describe, expect, test } from "bun:test";
import { InMemoryAttestationBackend, InMemoryAttestationStore } from "@cq/config";
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
});
