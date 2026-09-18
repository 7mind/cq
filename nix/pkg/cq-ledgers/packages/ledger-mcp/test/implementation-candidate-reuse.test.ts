import { describe, expect, test } from "bun:test";
import {
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  claimQualifiedParentGateOn,
  completeQualifiedParentGateOn,
  confirmDispatchCompletionOn,
  type DispatchJSONValue,
} from "@cq/config";
import { ImplementationCandidateQueueFixture } from "./implementationCandidateQueueFixture.js";

const namespace = { backend: "xdg" as const, projectKey: "candidate-reuse" };

describe("implementation candidate gate reuse [Behavioral-Active, Blackbox-Group]", () => {
  test("an exact installed handoff never leases a different queued candidate", async () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const common = {
      repositoryId: "d".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "e".repeat(64),
    };
    const first = await fixture.stage({ ...common, taskId: "T6520" });
    const second = await fixture.stage({ ...common, taskId: "T6521" });
    const firstQualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: first.candidate,
      ...first.qualification,
    });
    await fixture.adapter.qualifyNativeCompletion({
      candidate: second.candidate,
      ...second.qualification,
    });

    expect(
      await fixture.adapter.acquire({
        partitionKey: firstQualified.queue.partition.partitionKey,
        holderId: "installed-second-candidate",
        expectedCandidate: {
          attestationId: second.prepared.attestationId,
          generation: second.prepared.generation,
        },
      }),
    ).toMatchObject({
      state: "blocked",
      front: {
        attestationId: first.prepared.attestationId,
        generation: first.prepared.generation,
      },
      frontState: "qualified",
    });
    const rowsAfterBlockedHandoff = await backend.transact({ kind: "namespace" }, (store) =>
      store.rows(),
    );
    expect(rowsAfterBlockedHandoff).toHaveLength(2);
    expect(
      rowsAfterBlockedHandoff.map((row) => row.implementationQueue?.state),
    ).toEqual(["qualified", "qualified"]);

    expect(
      await fixture.adapter.acquire({
        partitionKey: firstQualified.queue.partition.partitionKey,
        holderId: "installed-first-candidate",
        expectedCandidate: {
          attestationId: first.prepared.attestationId,
          generation: first.prepared.generation,
        },
      }),
    ).toMatchObject({
      state: "leased",
      lease: {
        attestationId: first.prepared.attestationId,
        generation: first.prepared.generation,
      },
    });
  });

  test("one unchanged qualified candidate retains one green gate across review handoff", async () => {
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
    const acquired = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "protected-handoff",
    });
    if (acquired.state !== "leased") throw new Error("expected qualified candidate lease");

    const claimed = await claimQualifiedParentGateOn(
      backend,
      { ...staged.prepared, queueLease: acquired.lease },
      { now: fixture.clock.now },
    );
    if (claimed.state !== "gate-running") throw new Error("expected one claimed gate");
    const gateEvidence = {
      kind: "cq-supervised-gate-evidence",
      version: 1,
      attestationId: staged.prepared.attestationId,
      generation: staged.prepared.generation,
      roleId: "implement-worker",
      roleVersion: staged.prepared.promptProvenance.version,
      surface: "codex",
      promptDigest: staged.prepared.promptProvenance.promptDigest,
      catalogHash: staged.prepared.promptProvenance.catalogHash,
      inputDigest: staged.prepared.promptProvenance.inputDigest,
      taskId: staged.binding.taskId,
      worktreePath: staged.binding.worktreePath,
      branch: staged.binding.branch,
      baseCommit: staged.binding.baseCommit,
      startingCommit: staged.binding.baseCommit,
      resultCommit: staged.candidate.resultCommit,
      clean: true,
      command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
      gateExitCode: 0,
      passCount: 1,
      failCount: 0,
      gateDurationMs: 1,
      capturedAt: fixture.clock.now(),
      filesTouchedDigest: "1".repeat(64),
      gitReceiptsDigest: "2".repeat(64),
      mutationTableDigest: "3".repeat(64),
    } as const;
    await completeQualifiedParentGateOn(
      backend,
      {
        ...staged.prepared,
        queueLease: acquired.lease,
        gateEpoch: claimed.gateEpoch,
        output: {
          ...(claimed.output as Readonly<Record<string, DispatchJSONValue>>),
          supervisedGateEvidence: gateEvidence,
        },
      },
      { now: fixture.clock.now },
    );
    expect(
      await claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: acquired.lease },
        { now: fixture.clock.now },
      ),
    ).toMatchObject({ state: "result-stored" });

    await confirmDispatchCompletionOn(
      backend,
      {
        namespace,
        ...staged.prepared,
        nativeCompletion: staged.qualification.nativeCompletion,
        expectedProvenance: staged.qualification.expectedProvenance,
        continuationContext: { liveTip: staged.binding.baseCommit, gitReceipts: [] },
      },
      { now: fixture.clock.now },
    );

    const row = await backend.transact({ kind: "handle", handle: staged.prepared }, (store) =>
      store.read(staged.prepared),
    );
    expect(row).toMatchObject({
      state: "consumed",
      implementationQueue: {
        state: "leased",
        leaseGeneration: acquired.lease.leaseGeneration,
        lease: {
          holderId: acquired.lease.holderId,
          generation: acquired.lease.leaseGeneration,
        },
      },
      output: { supervisedGateEvidence: gateEvidence },
    });
    expect(
      await fixture.adapter.acquire({
        partitionKey: qualified.queue.partition.partitionKey,
        holderId: acquired.lease.holderId,
      }),
    ).toMatchObject({ state: "leased", replayed: true, lease: acquired.lease });
    expect(
      await fixture.adapter.acquire({
        partitionKey: qualified.queue.partition.partitionKey,
        holderId: "foreign-review-holder",
      }),
    ).toMatchObject({ state: "blocked", frontState: "leased" });
  });
});
