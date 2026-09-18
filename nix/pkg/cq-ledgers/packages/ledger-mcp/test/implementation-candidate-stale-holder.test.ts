import { describe, expect, test } from "bun:test";
import { InMemoryAttestationBackend, InMemoryAttestationStore, claimQualifiedParentGateOn } from "@cq/config";
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
});
