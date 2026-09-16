import { describe, expect, test } from "bun:test";
import { InMemoryAttestationBackend, InMemoryAttestationStore } from "@cq/config";
import {
  ImplementationCandidateCoordinator,
  type ImplementationCandidateCoordinatorOperations,
} from "../src/implementationCandidateQueue.js";
import { ImplementationCandidateQueueFixture } from "./implementationCandidateQueueFixture.js";

const namespace = { backend: "xdg" as const, projectKey: "coordinator-race" };

describe("implementation candidate coordinator race [Behavioral-Active, Blackbox-Group]", () => {
  test("three workers observe one runnable-front lease and one gate launch", async () => {
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
    let gateCalls = 0;
    const operations: ImplementationCandidateCoordinatorOperations = {
      observeProtectedHead: async () => qualified.queue.attempt.observedBaseCommit,
      finalizeQualifiedFront: async () => {
        gateCalls += 1;
      },
      confirmAndFetchQualifiedFront: async () => {},
      retireStaleSource: async () => {
        throw new Error("race fixture must not retire");
      },
      rebaseRetiredSource: async () => {
        throw new Error("race fixture must not rebase");
      },
      prepareSuccessor: async () => {
        throw new Error("race fixture must not prepare");
      },
    };
    const coordinators = [1, 2, 3].map(
      () => new ImplementationCandidateCoordinator(fixture.adapter, operations),
    );

    const outcomes = await Promise.all(
      coordinators.map((coordinator, index) =>
        coordinator.run({
          partitionKey: qualified.queue.partition.partitionKey,
          holderId: `coordinator-${String(index + 1)}`,
        }),
      ),
    );

    expect(outcomes.filter(({ state }) => state === "completed")).toHaveLength(1);
    expect(outcomes.filter(({ state }) => state === "blocked")).toHaveLength(2);
    expect(gateCalls).toBe(1);
  });
});
