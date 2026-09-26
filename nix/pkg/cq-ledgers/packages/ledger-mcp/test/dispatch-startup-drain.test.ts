import { afterEach, describe, expect, test } from "bun:test";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  type AttestationNamespace,
} from "@cq/config";
import type { DispatchCapability } from "@cq/ledger";
import { drainStrandedImplementationPartitions } from "../src/dispatchDriverWiring.js";
import {
  ImplementationCandidateQueueFixture,
  type PrepareQueueCandidateOptions,
} from "./implementationCandidateQueueFixture.js";

const namespace: AttestationNamespace = { backend: "xdg", projectKey: "dispatch-startup-drain" };

function candidate(taskId: string, repositoryId: string): PrepareQueueCandidateOptions {
  return {
    taskId,
    repositoryId,
    integrationRef: "refs/heads/main",
    goalRef: "goals:G6518",
    finalizedManifestDigest: "f".repeat(64),
  };
}

// D589: a queued candidate is coordinated only by the process that launched its
// worker. When that process is replaced, nothing coordinates the candidate
// again and it strands its partition. A serving process drains such fronts.
describe("D589 startup drain of stranded implementation-queue fronts", () => {
  const backends: InMemoryAttestationBackend[] = [];

  afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.close();
  });

  test("coordinates each partition with a qualified unleased front once, and reports each outcome [BA]", async () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    backends.push(backend);
    const subject = new ImplementationCandidateQueueFixture(backend);
    const partitions: string[] = [];
    for (const [taskId, repositoryId] of [
      ["T1", "a".repeat(64)],
      ["T2", "a".repeat(64)],
      ["T3", "b".repeat(64)],
    ] as const) {
      const staged = await subject.stage(candidate(taskId, repositoryId));
      const qualified = await subject.adapter.qualifyNativeCompletion({
        candidate: staged.candidate,
        ...staged.qualification,
      });
      partitions.push(qualified.queue.partition.partitionKey);
    }
    // A staged-rebase source retired without a successor strands its partition
    // too; one whose successor exists does not.
    const retiredPartitions: string[] = [];
    for (const [taskId, repositoryId, successor] of [
      ["T5", "d".repeat(64), undefined],
      ["T6", "e".repeat(64), { attestationId: "att_successor", generation: 1 }],
    ] as const) {
      const staged = await subject.stage(candidate(taskId, repositoryId));
      const qualified = await subject.adapter.qualifyNativeCompletion({
        candidate: staged.candidate,
        ...staged.qualification,
      });
      retiredPartitions.push(qualified.queue.partition.partitionKey);
      await backend.transact({ kind: "handle", handle: staged.prepared }, (store) => {
        const row = store.read(staged.prepared);
        if (row === undefined || row.kind !== "envelope" || row.implementationQueue === undefined) {
          throw new Error("staged fixture row disappeared");
        }
        store.replace(row, {
          ...row,
          implementationQueue: {
            ...row.implementationQueue,
            state: "staged-rebase-retired",
            stagedRebaseSource: {
              ...({} as NonNullable<typeof row.implementationQueue.stagedRebaseSource>),
              ...(successor === undefined ? {} : { successor }),
            },
          },
        });
      });
    }
    const leasedOnly = await subject.stage(candidate("T4", "c".repeat(64)));
    const leasedQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: leasedOnly.candidate,
      ...leasedOnly.qualification,
    });
    const lease = await subject.adapter.acquire({
      partitionKey: leasedQualified.queue.partition.partitionKey,
      holderId: "live-coordinator",
    });
    expect(lease.state).toBe("leased");

    const coordinated: unknown[] = [];
    const reports: string[] = [];
    const capability = {
      coordinateImplementationCandidate: async (input: unknown) => {
        coordinated.push(input);
        if (coordinated.length === 1) throw new Error("cohort parent execution grant has expired");
        return { state: "empty", partitionKey: "p", partitionRevision: 1 };
      },
    } as unknown as DispatchCapability;

    await drainStrandedImplementationPartitions({
      backend,
      capability,
      holderId: "startup-drain",
      report: (line) => reports.push(line),
    });

    expect(coordinated).toEqual([
      { partitionKey: partitions[0], holderId: "startup-drain" },
      { partitionKey: partitions[2], holderId: "startup-drain" },
      { partitionKey: retiredPartitions[0], holderId: "startup-drain" },
    ]);
    expect(reports).toEqual([
      `ledger-mcp: draining implementation queue partition ${partitions[0]} failed: cohort parent execution grant has expired`,
      expect.stringContaining(
        `drained implementation queue partition ${partitions[2]}: {"state":"empty"`,
      ),
      expect.stringContaining(`drained implementation queue partition ${retiredPartitions[0]}`),
    ]);
  });
});
