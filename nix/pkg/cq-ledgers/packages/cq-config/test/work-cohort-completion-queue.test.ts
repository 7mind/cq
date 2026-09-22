import { expect, test } from "bun:test";
import { acquireImplementationCandidateOn, reserveImplementationCompletionLeaseOn,
  releaseImplementationCompletionLeaseOn } from "../src/dispatchImplementationQueue.js";
import { cohortQueueFixture } from "./workCohortQueueFixture.js";
import { sealedCohortRoleEnvelope } from "./workCohortRoleFixture.js";
import { cohortValueDigestV1 } from "@cq/process-control";

for (const adapter of ["memory", "sqlite"] as const) {
  test(`cohort completion reservation binds every member without a task anchor ${adapter} [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const f = await cohortQueueFixture(adapter);
    try {
      const row = await f.qualify();
      const queue = row.implementationQueue!;
      const acquired = await acquireImplementationCandidateOn(f.backend, { namespace: f.namespace,
        actor: "trusted-parent", partitionKey: queue.partition.partitionKey, holderId: "cohort-completion" }, { now: f.now });
      if (acquired.state !== "leased") throw new Error("fixture candidate is not at queue front");
      const envelope = sealedCohortRoleEnvelope();
      const subject = { batchDigest: "b".repeat(64), sealDigest: envelope.evidenceSubject.sealDigest, envelope,
        memberRefs: f.cohort.memberAuthorities.map(({ taskRef }) => taskRef) };
      const request = { namespace: f.namespace, actor: "trusted-parent" as const, ...acquired.lease,
        expectedPartitionRevision: acquired.partitionRevision, operationId: "complete-cohort", cohort: subject,
        completionRef: `cq-implementation-completion:v1:${subject.batchDigest}`, mergeOperationId: "merge-cohort",
        resultCommit: f.resultCommit, qualificationDigest: queue.qualification!.qualificationDigest };
      const reserved = await reserveImplementationCompletionLeaseOn(f.backend, request, { now: f.now });
      expect(reserved.version).toBe(2);
      expect("taskRef" in reserved).toBe(false);
      const current = await f.backend.transact({ kind: "namespace" }, (store) => store.read(f.prepared));
      if (current?.kind !== "envelope" || current.implementationQueue === undefined) throw new Error("queue disappeared");
      const { envelopeDigest: _digest, ...oldEnvelope } = envelope;
      const nextEnvelope = { ...oldEnvelope, executionEpoch: "resumed-epoch" };
      const renewed = { ...subject, envelope: { ...nextEnvelope, envelopeDigest: cohortValueDigestV1(nextEnvelope) } };
      expect(await reserveImplementationCompletionLeaseOn(f.backend, { ...request, cohort: renewed,
        expectedPartitionRevision: current.implementationQueue.partitionRevision }, { now: f.now })).toEqual(reserved);
      const release = { ...request, expectedPartitionRevision: current.implementationQueue.partitionRevision };
      await expect(releaseImplementationCompletionLeaseOn(f.backend, { ...release,
        cohort: { ...subject, memberRefs: subject.memberRefs.slice(0, 1) } }, { now: f.now })).rejects.toThrow();
      const released = await releaseImplementationCompletionLeaseOn(f.backend, release, { now: f.now });
      expect(released.state).toBe("released");
    } finally { await f.close(); }
  });
}
