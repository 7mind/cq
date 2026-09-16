import { describe, expect, test } from "bun:test";
import { InMemoryAttestationBackend, InMemoryAttestationStore } from "@cq/config";
import {
  ImplementationCandidateCoordinator,
  type ImplementationCandidateCoordinatorOperations,
} from "../src/implementationCandidateQueue.js";
import { ImplementationCandidateQueueFixture } from "./implementationCandidateQueueFixture.js";

const namespace = { backend: "xdg" as const, projectKey: "candidate-scheduler" };

describe("implementation candidate scheduler [Behavioral-Active, Blackbox-Group]", () => {
  test("unchanged qualified front gates, confirms, and fetches with its stored native proof", async () => {
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
    const events: string[] = [];
    const operations: ImplementationCandidateCoordinatorOperations = {
      observeProtectedHead: async () => qualified.queue.attempt.observedBaseCommit,
      finalizeQualifiedFront: async ({ lease, control }) => {
        events.push("gate");
        expect(lease.attemptId).toBe(control.attempt.attemptId);
      },
      confirmAndFetchQualifiedFront: async ({ nativeCompletion }) => {
        events.push("confirm-fetch");
        expect(nativeCompletion).toEqual(staged.qualification.nativeCompletion);
      },
      retireStaleSource: async () => {
        throw new Error("unchanged front must not retire");
      },
      rebaseRetiredSource: async () => {
        throw new Error("unchanged front must not rebase");
      },
      prepareSuccessor: async () => {
        throw new Error("unchanged front must not prepare a successor");
      },
    };
    const coordinator = new ImplementationCandidateCoordinator(fixture.adapter, operations);

    const outcome = await coordinator.run({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "local-coordinator",
    });

    expect(outcome).toEqual({
      state: "completed",
      handle: {
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
      },
    });
    expect(events).toEqual(["gate", "confirm-fetch"]);
    expect(
      fixture.backend.storedRows().find(
        (row) =>
          row.attestationId === staged.prepared.attestationId &&
          row.generation === staged.prepared.generation,
      )?.implementationQueue,
    ).toMatchObject({ state: "released", leaseGeneration: 1 });
  });
});
