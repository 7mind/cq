import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTESTATION_DB_FILENAME,
  SqliteAttestationBackend,
  SqliteAttestationConnectionRegistry,
  type AttestationNamespace,
} from "@cq/config";
import { ImplementationCandidateQueueAdapter } from "../src/implementationCandidateQueue.js";
import { ImplementationCandidateQueueFixture } from "./implementationCandidateQueueFixture.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("ledger-MCP SQLite implementation queue races", () => {
  test("completion reservation survives reopen and only its exact release retires the lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "cq-t6520-completion-reservation-"));
    roots.push(root);
    const namespace: AttestationNamespace = {
      backend: "xdg",
      projectKey: "ledger-mcp-sqlite-completion-reservation",
    };
    const registry = new SqliteAttestationConnectionRegistry();
    const open = (): SqliteAttestationBackend =>
      new SqliteAttestationBackend({
        namespace,
        dbPath: join(root, ATTESTATION_DB_FILENAME),
        registry,
      });
    const primary = open();
    const fixture = new ImplementationCandidateQueueFixture(primary);
    const staged = await fixture.stage({
      taskId: "T6520",
      repositoryId: "d".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G6518",
      finalizedManifestDigest: "e".repeat(64),
    });
    const qualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const acquired = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "sqlite-completion-holder",
    });
    if (acquired.state !== "leased" || qualified.queue.qualification === undefined) {
      throw new Error("SQLite completion candidate did not lease with qualification");
    }
    const binding = {
      operationId: "sqlite-completion-reservation",
      completionRef: `cq-implementation-completion:v1:${"1".repeat(64)}`,
      mergeOperationId: "sqlite-completion-merge",
      taskRef: "tasks:T6520",
      resultCommit: staged.candidate.resultCommit,
    } as const;
    await fixture.adapter.reserveCompletion({
      ...acquired.lease,
      expectedPartitionRevision: acquired.partitionRevision,
      qualificationDigest: qualified.queue.qualification.qualificationDigest,
      ...binding,
    });
    await primary.close();

    const restarted = open();
    const restartedAdapter = new ImplementationCandidateQueueAdapter({
      backend: restarted,
      actor: "trusted-parent",
      now: fixture.clock.now,
    });
    try {
      const retained = await restartedAdapter.inspectLease(acquired.lease);
      expect(retained.completionReservation).toMatchObject(binding);
      await expect(
        restartedAdapter.park({
          ...acquired.lease,
          expectedPartitionRevision: retained.partitionRevision,
        }),
      ).rejects.toMatchObject({ reason: "completion-reserved" });
      const released = await restartedAdapter.releaseCompletion({
        ...acquired.lease,
        expectedPartitionRevision: retained.partitionRevision,
        ...binding,
        detail: { operation: "protected-completion", ...binding },
      });
      expect(released.state).toBe("released");
    } finally {
      await restarted.close();
    }
  });

  test("peer processes elect one lease winner and fence one stale recovery after reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "cq-t6518-queue-race-"));
    roots.push(root);
    const namespace: AttestationNamespace = {
      backend: "xdg",
      projectKey: "ledger-mcp-sqlite-queue-race",
    };
    const registry = new SqliteAttestationConnectionRegistry();
    const open = (): SqliteAttestationBackend =>
      new SqliteAttestationBackend({
        namespace,
        dbPath: join(root, ATTESTATION_DB_FILENAME),
        registry,
      });
    const primary = open();
    const peer = open();
    const fixture = new ImplementationCandidateQueueFixture(primary);
    const peerAdapter = new ImplementationCandidateQueueAdapter({
      backend: peer,
      actor: "trusted-parent",
      now: fixture.clock.now,
    });
    try {
      const staged = await fixture.stage({
        taskId: "T6518",
        repositoryId: "d".repeat(64),
        integrationRef: "refs/heads/main",
        goalRef: "goals:G6518",
        finalizedManifestDigest: "e".repeat(64),
      });
      const qualified = await fixture.adapter.qualifyNativeCompletion({
        candidate: staged.candidate,
        ...staged.qualification,
      });
      const [left, right] = await Promise.all([
        fixture.adapter.acquire({
          partitionKey: qualified.queue.partition.partitionKey,
          holderId: "sqlite-parent-left",
        }),
        peerAdapter.acquire({
          partitionKey: qualified.queue.partition.partitionKey,
          holderId: "sqlite-parent-right",
        }),
      ]);
      expect([left.state, right.state].sort()).toEqual(["blocked", "leased"]);
      const winner = [left, right].find(
        (outcome): outcome is Extract<typeof outcome, { state: "leased" }> =>
          outcome.state === "leased",
      );
      if (winner === undefined) throw new Error("SQLite queue race produced no lease winner");

      await primary.close();
      await peer.close();
      const restarted = open();
      const restartedPeer = open();
      const restartedAdapter = new ImplementationCandidateQueueAdapter({
        backend: restarted,
        actor: "trusted-parent",
        now: fixture.clock.now,
      });
      const restartedPeerAdapter = new ImplementationCandidateQueueAdapter({
        backend: restartedPeer,
        actor: "trusted-parent",
        now: fixture.clock.now,
      });
      try {
        expect(
          await restartedAdapter.acquire({
            partitionKey: qualified.queue.partition.partitionKey,
            holderId: winner.lease.holderId,
          }),
        ).toMatchObject({ state: "leased", replayed: true, lease: winner.lease });
        const recovery = {
          attestationId: winner.lease.attestationId,
          generation: winner.lease.generation,
          partitionKey: winner.lease.partitionKey,
          enrollmentId: winner.lease.enrollmentId,
          attemptId: winner.lease.attemptId,
          staleLeaseGeneration: winner.lease.leaseGeneration,
          expectedPartitionRevision: winner.partitionRevision,
        };
        const recoveries = await Promise.allSettled([
          restartedAdapter.recover(recovery),
          restartedPeerAdapter.recover(recovery),
        ]);
        expect(recoveries.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(recoveries.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
        const recovered = recoveries.find(
          (
            outcome,
          ): outcome is PromiseFulfilledResult<
            Awaited<ReturnType<typeof restartedAdapter.recover>>
          > => outcome.status === "fulfilled",
        );
        if (recovered === undefined) throw new Error("SQLite recovery race produced no winner");
        expect(recovered.value.leaseGeneration).toBe(winner.lease.leaseGeneration + 1);
        expect(
          await restartedAdapter.acquire({
            partitionKey: qualified.queue.partition.partitionKey,
            holderId: "sqlite-parent-after-recovery",
            expectedPartitionRevision: recovered.value.partitionRevision,
          }),
        ).toMatchObject({
          state: "leased",
          lease: { leaseGeneration: winner.lease.leaseGeneration + 2 },
        });
      } finally {
        await restarted.close();
        await restartedPeer.close();
      }
    } finally {
      await primary.close();
      await peer.close();
    }
  });
});
