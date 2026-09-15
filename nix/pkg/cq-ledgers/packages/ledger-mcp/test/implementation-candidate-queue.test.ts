import { afterEach, describe, expect, test } from "bun:test";
import {
  ImplementationQueueConflictError,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  abortDispatchOn,
  claimParentGateOn,
  type AttestationNamespace,
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
    const resurrected = await subject.stage(candidate("T6518"));

    await expect(
      subject.adapter.qualifyNativeCompletion({
        candidate: resurrected.candidate,
        ...resurrected.qualification,
      }),
    ).rejects.toThrow(ImplementationQueueConflictError);
  });

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
    ).toMatchObject({ state: "blocked", frontState: "parked" });
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
