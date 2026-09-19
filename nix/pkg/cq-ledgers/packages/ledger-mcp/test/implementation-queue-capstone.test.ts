import { describe, expect, test } from "bun:test";
import { InMemoryAttestationBackend, InMemoryAttestationStore } from "@cq/config";
import {
  ImplementationCandidateCoordinator,
  type ImplementationCandidateCoordinatorOperations,
} from "../src/implementationCandidateQueue.js";
import { ImplementationCandidateQueueFixture } from "./implementationCandidateQueueFixture.js";

const namespace = { backend: "xdg" as const, projectKey: "implementation-queue-capstone" };

describe("canonical implementation queue capstone [Behavioral-Active Blackbox-Group]", () => {
  test("runs one parent full gate and zero reruns for a settled qualified generation", async () => {
    const fixture = new ImplementationCandidateQueueFixture(
      new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace)),
    );
    const staged = await fixture.stage({
      taskId: "T6521",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G213",
      finalizedManifestDigest: "b".repeat(64),
    });
    const qualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    let fullGateInvocations = 0;
    let completionInvocations = 0;
    let settled = false;
    const unavailable = async (): Promise<never> => {
      throw new Error("stale routing is not expected for the current protected head");
    };
    const operations: ImplementationCandidateCoordinatorOperations = {
      isQualifiedFrontSettled: async () => settled,
      observeProtectedHead: async () => qualified.queue.attempt.observedBaseCommit,
      finalizeQualifiedFront: async () => {
        fullGateInvocations += 1;
      },
      confirmQualifiedFront: async () => {
        completionInvocations += 1;
        settled = true;
      },
      retireStaleSource: unavailable,
      rebaseRetiredSource: unavailable,
      prepareSuccessor: unavailable,
    };
    const coordinator = new ImplementationCandidateCoordinator(fixture.adapter, operations);
    const request = {
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "capstone-holder",
    };

    expect(await coordinator.run(request)).toEqual({
      state: "completed",
      handle: {
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
      },
    });
    expect(await coordinator.run(request)).toMatchObject({ state: "empty" });
    expect({ fullGateInvocations, completionInvocations }).toEqual({
      fullGateInvocations: 1,
      completionInvocations: 1,
    });
  });

  test("retires a stale qualified generation with zero full-gate invocations", async () => {
    const fixture = new ImplementationCandidateQueueFixture(
      new InMemoryAttestationBackend(
        new InMemoryAttestationStore({ ...namespace, projectKey: "implementation-queue-stale" }),
      ),
    );
    const staged = await fixture.stage({
      taskId: "T6522",
      repositoryId: "c".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G213",
      finalizedManifestDigest: "d".repeat(64),
    });
    const qualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    let fullGateInvocations = 0;
    let rebaseInvocations = 0;
    let successorInvocations = 0;
    const coordinator = new ImplementationCandidateCoordinator(fixture.adapter, {
      observeProtectedHead: async () => "e".repeat(40),
      finalizeQualifiedFront: async () => {
        fullGateInvocations += 1;
      },
      confirmQualifiedFront: async () => {
        throw new Error("a stale source cannot complete");
      },
      retireStaleSource: async ({ lease, control, ontoCommit }) => {
        const retired = await fixture.adapter.retireStagedRebaseSource({
          ...lease,
          expectedPartitionRevision: control.partitionRevision,
          stagedOutputDigest: staged.candidate.stagedOutputDigest,
          effectLock: {
            kind: "managed-worktree-effect-lock",
            bindingDigest: control.attempt.managedWorktreeBindingDigest,
          },
          live: {
            clean: true,
            liveTip: control.attempt.resultCommit,
            resultCommit: control.attempt.resultCommit,
            resultTree: control.attempt.resultTree,
            repositoryId: control.attempt.repositoryId,
            worktreePath: control.attempt.worktreePath,
            gitReceipts: control.attempt.gitReceipts,
          },
          ontoCommit,
          guardedRebase: `cq-guarded-rebase:v1:${"1".repeat(64)}`,
          guardedRebaseJournalDigest: "2".repeat(64),
        });
        return { sourceReference: retired.sourceReference };
      },
      rebaseRetiredSource: async () => {
        rebaseInvocations += 1;
        return { guardedRebase: `cq-guarded-rebase:v1:${"1".repeat(64)}` };
      },
      prepareSuccessor: async () => {
        successorInvocations += 1;
        return {
          attestationId: staged.prepared.attestationId,
          generation: staged.prepared.generation + 1,
        };
      },
    });

    expect(
      await coordinator.run({
        partitionKey: qualified.queue.partition.partitionKey,
        holderId: "stale-capstone-holder",
      }),
    ).toMatchObject({ state: "successor-queued" });
    expect({ fullGateInvocations, rebaseInvocations, successorInvocations }).toEqual({
      fullGateInvocations: 0,
      rebaseInvocations: 1,
      successorInvocations: 1,
    });
  });
});
