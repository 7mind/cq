import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttestationKeyReuseError,
  IDEMPOTENCY_HORIZON_MS,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  SqliteAttestationBackend,
  TERMINAL_ENVELOPE_RETENTION_MS,
  claimQualifiedParentGateOn,
  completeQualifiedParentGateOn,
  confirmDispatchCompletionOn,
  fetchDispatchResultOn,
  releaseImplementationCandidateOn,
  sweepAttestationsOn,
  type DispatchJSONValue,
} from "@cq/config";
import { ImplementationCandidateCoordinator } from "../src/implementationCandidateQueue.js";
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
    expect(rowsAfterBlockedHandoff.map((row) => row.implementationQueue?.state)).toEqual([
      "qualified",
      "qualified",
    ]);

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

  // regression: T6520 round 11 — the prior canonical test stopped after
  // reacquiring the lease and did not carry the counted gate through settlement.
  test("one unchanged exact candidate uses one gate through review retry, ff-only merge, completion, and replay with zero post-merge gates [Behavioral-Active Blackbox-Group]", async () => {
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
    let gateRuns = 0;
    let protectedHead = staged.binding.baseCommit;
    let gateEvidence: Readonly<Record<string, DispatchJSONValue>> | undefined;
    const coordinator = new ImplementationCandidateCoordinator(fixture.adapter, {
      isQualifiedFrontSettled: async ({ lease }) =>
        await backend.transact({ kind: "handle", handle: lease }, (store) => {
          const row = store.read(lease);
          return row?.kind === "envelope" && row.state === "consumed";
        }),
      observeProtectedHead: async () => protectedHead,
      finalizeQualifiedFront: async ({ lease }) => {
        const claimed = await claimQualifiedParentGateOn(
          backend,
          { ...staged.prepared, queueLease: lease },
          { now: fixture.clock.now },
        );
        if (claimed.state !== "gate-running") throw new Error("expected one claimed gate");
        gateRuns += 1;
        gateEvidence = {
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
        };
        await completeQualifiedParentGateOn(
          backend,
          {
            ...staged.prepared,
            queueLease: lease,
            gateEpoch: claimed.gateEpoch,
            output: {
              ...(claimed.output as Readonly<Record<string, DispatchJSONValue>>),
              supervisedGateEvidence: gateEvidence,
            },
          },
          { now: fixture.clock.now },
        );
      },
      confirmQualifiedFront: async ({ lease, control, nativeCompletion }) => {
        if (control.qualification === undefined) {
          throw new Error("qualified front lost its completion proof");
        }
        await confirmDispatchCompletionOn(
          backend,
          {
            namespace,
            ...lease,
            nativeCompletion,
            expectedProvenance: control.qualification.expectedProvenance,
            continuationContext: { liveTip: staged.binding.baseCommit, gitReceipts: [] },
          },
          { now: fixture.clock.now },
        );
      },
      retireStaleSource: async () => {
        throw new Error("unchanged candidate unexpectedly became stale");
      },
      rebaseRetiredSource: async () => {
        throw new Error("unchanged candidate unexpectedly rebased");
      },
      prepareSuccessor: async () => {
        throw new Error("unchanged candidate unexpectedly prepared a successor");
      },
    });
    const coordinate = () =>
      coordinator.run({
        partitionKey: qualified.queue.partition.partitionKey,
        holderId: "protected-handoff",
        expectedCandidate: {
          attestationId: staged.prepared.attestationId,
          generation: staged.prepared.generation,
        },
      });
    await expect(coordinate()).resolves.toMatchObject({ state: "completed" });
    const gateCounts = [gateRuns];

    await expect(coordinate()).resolves.toMatchObject({ state: "empty" });
    gateCounts.push(gateRuns);
    protectedHead = staged.candidate.resultCommit;
    await expect(coordinate()).resolves.toMatchObject({ state: "empty" });
    gateCounts.push(gateRuns);

    const row = await backend.transact({ kind: "handle", handle: staged.prepared }, (store) =>
      store.read(staged.prepared),
    );
    expect(row).toMatchObject({
      state: "consumed",
      implementationQueue: {
        state: "leased",
        leaseGeneration: 1,
        lease: {
          holderId: "protected-handoff",
          generation: 1,
        },
      },
      output: { supervisedGateEvidence: gateEvidence },
    });
    if (row?.kind !== "envelope" || row.implementationQueue?.state !== "leased") {
      throw new Error("protected candidate lost its completion lease");
    }
    const release = {
      attestationId: row.attestationId,
      generation: row.generation,
      partitionKey: row.implementationQueue.partition.partitionKey,
      enrollmentId: row.implementationQueue.enrollment.enrollmentId,
      attemptId: row.implementationQueue.attempt.attemptId,
      holderId: "protected-handoff",
      leaseGeneration: 1,
      expectedPartitionRevision: row.implementationQueue.partitionRevision,
      detail: { operation: "protected-completion" },
    } as const;
    const settleCompletion = async () => {
      const current = await backend.transact({ kind: "handle", handle: staged.prepared }, (store) =>
        store.read(staged.prepared),
      );
      if (current?.implementationQueue?.state === "released") return;
      await releaseImplementationCandidateOn(
        backend,
        { namespace, actor: "trusted-parent", ...release },
        { now: fixture.clock.now },
      );
    };
    await settleCompletion();
    gateCounts.push(gateRuns);
    await settleCompletion();
    await expect(coordinate()).resolves.toMatchObject({ state: "empty" });
    gateCounts.push(gateRuns);

    expect(gateCounts).toEqual([1, 1, 1, 1, 1]);
    expect(gateCounts.at(-1)! - gateCounts[1]!).toBe(0);
  });

  // regression: T6520 round 9 — a consumed dispatch stays authoritative while
  // its qualified queue lease is live, so dispatch retention starts at release.
  test("a retained candidate survives both old retention boundaries and restarts, then expires from release [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-candidate-retention-"));
    const dbPath = join(root, "attestations.sqlite");
    let backend = new SqliteAttestationBackend({ namespace, dbPath });
    try {
      const fixture = new ImplementationCandidateQueueFixture(backend);
      const idempotencyKey = "retained-candidate-authority";
      const staged = await fixture.stage({
        taskId: "T6520",
        repositoryId: "a".repeat(64),
        integrationRef: "refs/heads/main",
        goalRef: "goals:G211",
        finalizedManifestDigest: "b".repeat(64),
        idempotencyKey,
      });
      const qualified = await fixture.adapter.qualifyNativeCompletion({
        candidate: staged.candidate,
        ...staged.qualification,
      });
      const acquired = await fixture.adapter.acquire({
        partitionKey: qualified.queue.partition.partitionKey,
        holderId: "protected-retention-handoff",
      });
      if (acquired.state !== "leased") throw new Error("expected retained candidate lease");

      const claimed = await claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: acquired.lease },
        { now: fixture.clock.now },
      );
      if (claimed.state !== "gate-running") throw new Error("expected claimed parent gate");
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
      const dispatchTerminalAt = fixture.clock.peek();

      fixture.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
      await backend.close();
      backend = new SqliteAttestationBackend({ namespace, dbPath });
      expect(await sweepAttestationsOn(backend, { now: fixture.clock.now })).toMatchObject({
        envelopesCollapsed: [],
        tombstonesRemoved: [],
        rowsRemaining: 1,
      });

      fixture.clock.advance(IDEMPOTENCY_HORIZON_MS - TERMINAL_ENVELOPE_RETENTION_MS);
      await expect(sweepAttestationsOn(backend, { now: fixture.clock.now })).resolves.toMatchObject(
        { envelopesCollapsed: [], tombstonesRemoved: [], rowsRemaining: 1 },
      );
      await expect(
        fetchDispatchResultOn(
          backend,
          { namespace, actor: "trusted-parent", ...staged.prepared },
          { now: fixture.clock.now },
        ),
      ).resolves.toMatchObject({ state: "consumed" });

      const restartedFixture = new ImplementationCandidateQueueFixture(backend);
      restartedFixture.clock.set(fixture.clock.peek());
      await expect(
        restartedFixture.prepareOnly({
          taskId: "T6521",
          repositoryId: "a".repeat(64),
          integrationRef: "refs/heads/main",
          goalRef: "goals:G211",
          finalizedManifestDigest: "b".repeat(64),
          idempotencyKey,
        }),
      ).rejects.toThrow(AttestationKeyReuseError);

      const live = await backend.transact({ kind: "handle", handle: staged.prepared }, (store) =>
        store.read(staged.prepared),
      );
      if (live?.kind !== "envelope" || live.implementationQueue?.lease === undefined) {
        throw new Error("retained candidate authority disappeared");
      }
      const releaseAt = fixture.clock.peek();
      await releaseImplementationCandidateOn(
        backend,
        {
          namespace,
          actor: "trusted-parent",
          attestationId: live.attestationId,
          generation: live.generation,
          partitionKey: live.implementationQueue.partition.partitionKey,
          enrollmentId: live.implementationQueue.enrollment.enrollmentId,
          attemptId: live.implementationQueue.attempt.attemptId,
          holderId: live.implementationQueue.lease.holderId,
          leaseGeneration: live.implementationQueue.lease.generation,
          expectedPartitionRevision: live.implementationQueue.partitionRevision,
          detail: { completion: "recorded" },
        },
        { now: fixture.clock.now },
      );

      await backend.close();
      backend = new SqliteAttestationBackend({ namespace, dbPath });
      fixture.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS - 1);
      expect(await sweepAttestationsOn(backend, { now: fixture.clock.now })).toMatchObject({
        envelopesCollapsed: [],
        rowsRemaining: 1,
      });
      fixture.clock.advance(1);
      expect(await sweepAttestationsOn(backend, { now: fixture.clock.now })).toMatchObject({
        envelopesCollapsed: [
          {
            attestationId: staged.prepared.attestationId,
            generation: staged.prepared.generation,
          },
        ],
        rowsRemaining: 1,
      });
      const [collapsed] = backend.storedRows();
      expect(collapsed).toMatchObject({
        kind: "tombstone",
        terminalAt: dispatchTerminalAt,
        reuseAfter: new Date(Date.parse(releaseAt) + IDEMPOTENCY_HORIZON_MS).toISOString(),
        implementationQueue: {
          state: "released",
          terminal: { terminalAt: releaseAt },
        },
      });

      fixture.clock.advance(IDEMPOTENCY_HORIZON_MS - TERMINAL_ENVELOPE_RETENTION_MS);
      await backend.close();
      backend = new SqliteAttestationBackend({ namespace, dbPath });
      expect(await sweepAttestationsOn(backend, { now: fixture.clock.now })).toMatchObject({
        tombstonesRemoved: [
          {
            attestationId: staged.prepared.attestationId,
            generation: staged.prepared.generation,
          },
        ],
        rowsRemaining: 0,
      });
    } finally {
      await backend.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
