import { describe, expect, test } from "bun:test";
import { InMemoryAttestationBackend, InMemoryAttestationStore } from "@cq/config";
import {
  ImplementationCandidateCoordinator,
  type ImplementationCandidateCoordinatorOperations,
} from "../src/implementationCandidateQueue.js";
import { ImplementationCandidateQueueFixture } from "./implementationCandidateQueueFixture.js";

const namespace = { backend: "xdg" as const, projectKey: "stale-rebase" };

describe("implementation candidate stale-base routing [Behavioral-Active, Blackbox-Group]", () => {
  // specified: T6519 — no gate is allowed before the retired source is rebased and succeeded.
  test("stale qualified front retires, broker-rebases, and prepares one successor without a gate", async () => {
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
    const protectedHead = "f".repeat(40);
    const events: string[] = [];
    let gateCalls = 0;
    const operations: ImplementationCandidateCoordinatorOperations = {
      observeProtectedHead: async () => protectedHead,
      finalizeQualifiedFront: async () => {
        gateCalls += 1;
      },
      confirmAndFetchQualifiedFront: async () => {
        throw new Error("stale source must not confirm");
      },
      retireStaleSource: async ({ control, ontoCommit }) => {
        events.push("retire");
        expect(control.attempt.resultCommit).toBe(staged.candidate.resultCommit);
        expect(ontoCommit).toBe(protectedHead);
        return { sourceReference: "retired:T6519:1" };
      },
      rebaseRetiredSource: async (input) => {
        events.push("rebase");
        expect(input).toMatchObject({
          operation: "rebase",
          ontoCommit: protectedHead,
          retirement: { sourceReference: "retired:T6519:1" },
        });
        expect(input.operationId).toMatch(/^implementation-rebase-[0-9a-f]{32}$/u);
        return { guardedRebase: `cq-guarded-rebase:v1:${"c".repeat(64)}` };
      },
      prepareSuccessor: async ({ retirement, rebase, ontoCommit }) => {
        events.push("prepare-successor");
        expect(retirement.sourceReference).toBe("retired:T6519:1");
        expect(rebase.guardedRebase).toMatch(/^cq-guarded-rebase:v1:/u);
        expect(ontoCommit).toBe(protectedHead);
        return { attestationId: "att_successor", generation: 2 };
      },
    };
    const coordinator = new ImplementationCandidateCoordinator(fixture.adapter, operations);

    const outcome = await coordinator.run({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "local-coordinator",
    });

    expect(outcome).toEqual({
      state: "successor-queued",
      source: {
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
      },
      successor: { attestationId: "att_successor", generation: 2 },
    });
    expect(events).toEqual(["retire", "rebase", "prepare-successor"]);
    expect(gateCalls).toBe(0);
  });
});
