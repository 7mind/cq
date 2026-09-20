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
  dispatchPayloadDigest,
  fetchDispatchResultOn,
  releaseImplementationCandidateOn,
  sweepAttestationsOn,
  type DispatchJSONValue,
} from "@cq/config";
import {
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
  implementationCompletionMergeAdmissionProviderFromStore,
  type ImplementationCandidateAuthorityReceipt,
  type ImplementationCandidateCompletionReservationBinding,
  type ImplementationReviewerIdentity,
} from "@cq/ledger";
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

  // regression: T6573 — an older stable enrollment can qualify a correction
  // while another candidate's completed lease remains the partition authority.
  test("a retained completion lease remains authoritative when an older enrollment reenters the partition [Behavioral-Active Blackbox-Group]", async () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const common = {
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "b".repeat(64),
    } as const;
    const complete = async (
      staged: Awaited<ReturnType<typeof fixture.stage>>,
      holderId: string,
    ) => {
      const qualified = await fixture.adapter.qualifyNativeCompletion({
        candidate: staged.candidate,
        ...staged.qualification,
      });
      const acquired = await fixture.adapter.acquire({
        partitionKey: qualified.queue.partition.partitionKey,
        holderId,
        expectedCandidate: staged.prepared,
      });
      if (acquired.state !== "leased") throw new Error("expected exact candidate lease");
      if (staged.prepared.parentGateCapability === undefined) {
        throw new Error("managed candidate omitted parent gate capability");
      }
      const claimed = await claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: acquired.lease },
        { now: fixture.clock.now },
      );
      if (claimed.state !== "gate-running") throw new Error("expected claimed parent gate");
      await completeQualifiedParentGateOn(
        backend,
        {
          ...staged.prepared,
          queueLease: acquired.lease,
          gateEpoch: claimed.gateEpoch,
          output: {
            ...(claimed.output as Readonly<Record<string, DispatchJSONValue>>),
            supervisedGateEvidence: {
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
            },
          },
        },
        { now: fixture.clock.now },
      );
      const control = await fixture.adapter.inspectLease(acquired.lease);
      if (control.qualification === undefined) {
        throw new Error("completed candidate lost its qualification");
      }
      await confirmDispatchCompletionOn(
        backend,
        {
          namespace,
          ...staged.prepared,
          nativeCompletion: control.qualification.nativeCompletion,
          expectedProvenance: control.qualification.expectedProvenance,
          continuationContext: {
            liveTip: staged.candidate.resultCommit,
            gitReceipts: staged.candidate.gitReceipts,
          },
        },
        { now: fixture.clock.now },
      );
      return { acquired, control };
    };

    const older = await fixture.stage({
      ...common,
      taskId: "T6573",
      resultCommit: "1".repeat(40),
      resultTree: "2".repeat(40),
    });
    await complete(older, "older-completion");
    const correction = await fixture.stage({
      ...common,
      taskId: "T6573",
      reprepareOf: older,
      resultCommit: "2".repeat(40),
      resultTree: "3".repeat(40),
    });
    const retained = await fixture.stage({
      ...common,
      taskId: "T6574",
      resultCommit: "3".repeat(40),
      resultTree: "4".repeat(40),
    });
    const retainedCompletion = await complete(retained, "retained-completion");
    const correctionQualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: correction.candidate,
      ...correction.qualification,
    });
    expect(correctionQualified.queue.enrollment.admissionOrdinal).toBeLessThan(
      retainedCompletion.control.enrollment.admissionOrdinal,
    );

    expect(
      await fixture.adapter.acquire({
        partitionKey: correctionQualified.queue.partition.partitionKey,
        holderId: "retained-completion",
        expectedCandidate: retained.prepared,
      }),
    ).toMatchObject({
      state: "leased",
      replayed: true,
      lease: retainedCompletion.acquired.lease,
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
      withReceipt: true,
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
            continuationContext: {
              liveTip: staged.candidate.resultCommit,
              gitReceipts: staged.candidate.gitReceipts,
            },
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
    if (
      row?.kind !== "envelope" ||
      row.implementationQueue?.state !== "leased" ||
      row.implementationQueue.qualification === undefined ||
      gateEvidence === undefined
    ) {
      throw new Error("protected candidate lost its completion lease");
    }
    const control = row.implementationQueue;
    const authority: ImplementationCandidateAuthorityReceipt = {
      kind: "cq-implementation-candidate-authority",
      version: 1,
      workerDispatch: {
        attestationId: staged.prepared.attestationId,
        generation: staged.prepared.generation,
      },
      partitionKey: control.partition.partitionKey,
      enrollmentId: control.enrollment.enrollmentId,
      attemptId: control.attempt.attemptId,
      leaseHolderId: "protected-handoff",
      leaseGeneration: 1,
      qualificationDigest: control.qualification!.qualificationDigest,
      taskRef: "tasks:T6520",
      taskDigest: "4".repeat(64),
      goalRef: "goals:G211",
      finalizedManifestDigest: "b".repeat(64),
      integrationRef: control.partition.integrationRef,
      repositoryId: control.attempt.repositoryId,
      worktreePath: control.attempt.worktreePath,
      resultCommit: control.attempt.resultCommit,
      resultTree: control.attempt.resultTree,
      gateCommand: control.attempt.gateCommand,
      packagedEnvironmentDigest: control.attempt.packagedEnvironmentDigest,
      managedWorktreeBindingDigest: control.attempt.managedWorktreeBindingDigest,
      gitReceiptLineageDigest: control.attempt.gitReceiptLineageDigest,
      gateEvidenceDigest: dispatchPayloadDigest(gateEvidence),
    } as const;
    const reviewer: ImplementationReviewerIdentity = {
      alias: "native",
      harness: "codex",
      model: "frontier",
      provider: null,
      launch: "native",
      adapterId: "codex:native",
    };
    const evidence = createInMemoryImplementationEvidenceStore();
    let ledgerWrites = 0;
    const releaseEffects: string[] = [];
    const reserveCandidateAuthority = async (
      receipt: ImplementationCandidateAuthorityReceipt,
      binding: ImplementationCandidateCompletionReservationBinding,
    ): Promise<void> => {
      const current = await backend.transact(
        { kind: "handle", handle: receipt.workerDispatch },
        (store) => store.read(receipt.workerDispatch),
      );
      if (current?.implementationQueue?.state !== "leased") {
        throw new Error("completion reservation lost its live candidate lease");
      }
      await fixture.adapter.reserveCompletion({
        attestationId: receipt.workerDispatch.attestationId,
        generation: receipt.workerDispatch.generation,
        partitionKey: receipt.partitionKey,
        enrollmentId: receipt.enrollmentId,
        attemptId: receipt.attemptId,
        holderId: receipt.leaseHolderId,
        leaseGeneration: receipt.leaseGeneration,
        expectedPartitionRevision: current.implementationQueue.partitionRevision,
        qualificationDigest: receipt.qualificationDigest,
        ...binding,
      });
    };
    const service = new ImplementationEvidenceService({
      store: evidence,
      resolveReviewerRoster: () => [reviewer],
      nativeFallback: reviewer,
      now: fixture.clock.now,
      prepareNativeReview: async ({ attemptRef }) => ({
        attestationId: `att_${attemptRef.slice(-12)}`,
        generation: 1,
        responseStoreNow: "2099-01-01T00:00:00.000Z",
        childCancelAt: "2099-01-01T00:01:00.000Z",
        launchDeadline: "2098-12-31T23:59:00.000Z",
        promptProvenance: {
          roleId: "implement-reviewer",
          version: 7,
          surface: "codex",
          promptDigest: "6".repeat(64),
          catalogHash: "7".repeat(64),
          inputDigest: "8".repeat(64),
        },
        inputCapability: { scope: "fetch-input", token: "input" },
        resultCapability: { scope: "store-result", token: "result" },
      }),
      fetchNativeReview: async (dispatch) => ({
        state: "consumed",
        retainedAttestation: dispatch.attestationId,
        output: {
          taskId: "T6520",
          verdict: "approve",
          criticism: [],
          questions: [],
          defects: [],
          rationale: "unchanged candidate remains qualified",
          gateReRan: false,
          gateDurationMs: 0,
          resultCommitVerified: true,
          resultCommitEvidence: {
            status: "verified",
            resultCommit: staged.candidate.resultCommit,
            branchTip: staged.candidate.resultCommit,
          },
          baseAncestry: {
            status: "verified",
            relation: "descendant",
            baseCommit: staged.binding.baseCommit,
            resultCommit: staged.candidate.resultCommit,
            mergeBase: staged.binding.baseCommit,
          },
        },
      }),
      executeExternalReview: async () => {
        throw new Error("external review is not configured");
      },
      fetchWorker: async () => ({
        state: "consumed",
        input: { taskId: "T6520", baseCommit: staged.binding.baseCommit },
        output: {
          taskId: "T6520",
          status: "pass",
          resultCommit: staged.candidate.resultCommit,
          branch: staged.binding.branch,
          actualWorktreePath: staged.binding.worktreePath,
          filesTouched: ["candidate.ts"],
          gitReceipts: [],
          checkSummary: "runner-supervised gate requested",
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit: staged.binding.baseCommit,
            headCommit: staged.candidate.resultCommit,
          },
          supervisedGateEvidence: gateEvidence!,
        },
      }),
      resolveCandidateAuthority: async (input) => {
        if (
          input.workerDispatch.attestationId !== authority.workerDispatch.attestationId ||
          input.workerDispatch.generation !== authority.workerDispatch.generation ||
          input.taskRef !== authority.taskRef ||
          input.resultCommit !== authority.resultCommit
        ) {
          throw new Error("unchanged candidate authority target changed");
        }
        await fixture.adapter.inspectLease({
          attestationId: authority.workerDispatch.attestationId,
          generation: authority.workerDispatch.generation,
          partitionKey: authority.partitionKey,
          enrollmentId: authority.enrollmentId,
          attemptId: authority.attemptId,
          holderId: authority.leaseHolderId,
          leaseGeneration: authority.leaseGeneration,
        });
        return authority;
      },
      releaseCandidateAuthority: async (receipt, binding) => {
        const current = await backend.transact(
          { kind: "handle", handle: receipt.workerDispatch },
          (store) => store.read(receipt.workerDispatch),
        );
        if (current?.implementationQueue?.state === "released") return;
        if (current?.implementationQueue?.state !== "leased") {
          throw new Error("completion release lost its live candidate lease");
        }
        releaseEffects.push("protected-completion-release");
        await fixture.adapter.releaseCompletion({
          attestationId: receipt.workerDispatch.attestationId,
          generation: receipt.workerDispatch.generation,
          partitionKey: receipt.partitionKey,
          enrollmentId: receipt.enrollmentId,
          attemptId: receipt.attemptId,
          holderId: receipt.leaseHolderId,
          leaseGeneration: receipt.leaseGeneration,
          expectedPartitionRevision: current.implementationQueue.partitionRevision,
          ...binding,
          detail: { operation: "protected-completion", ...binding },
        });
      },
      readTaskAuthority: async () => ({
        taskRef: "tasks:T6520",
        ownerGoalRef: "goals:G211",
        status: "wip",
        finalizedManifest: "manifest-v1\n",
      }),
      repositoryHead: async () => protectedHead,
      verifyImplementation: async () => ({
        baseCommit: staged.binding.baseCommit,
        startingCommit: staged.binding.baseCommit,
        clean: true,
        ancestryVerified: true,
        receiptsVerified: true,
        acceptanceVerified: true,
        gateVerified: true,
        details: { exactCandidate: true },
      }),
      recordLedgerCompletion: async () => {
        ledgerWrites += 1;
        return { reviewRef: "reviews:R6520" };
      },
    });
    const panelInput = {
      taskRef: "tasks:T6520",
      resultCommit: staged.candidate.resultCommit,
      workerDispatch: authority.workerDispatch,
      operationId: "unchanged-review-panel",
      author: "parent",
    } as const;
    const panel = await service.prepareReviewPanel(panelInput);
    gateCounts.push(gateRuns);
    await expect(service.prepareReviewPanel(panelInput)).resolves.toMatchObject({
      status: "existing",
      panelRef: panel.panelRef,
    });
    gateCounts.push(gateRuns);
    const attemptRef = panel.attemptRefs[0]!;
    await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "unchanged-review-attempt",
      author: "parent",
    });
    await service.finalizeReviewAttempt({
      attemptRef,
      operationId: "unchanged-review-finalize",
      author: "parent",
    });
    const completion = await service.prepareCompletion({
      taskRef: "tasks:T6520",
      expectedRepositoryHead: staged.binding.baseCommit,
      resultCommit: staged.candidate.resultCommit,
      workerDispatch: authority.workerDispatch,
      reviewAttemptRefs: [attemptRef],
      completion: "unchanged candidate reviewed",
      logPaths: [],
      mergeOperationId: "unchanged-ff-merge",
      operationId: "unchanged-completion",
      author: "parent",
    });
    gateCounts.push(gateRuns);
    const mergeProvider = await implementationCompletionMergeAdmissionProviderFromStore({
      provider: {
        acquire: async (input) => ({
          id: "unchanged-merge-admission",
          epoch: 1,
          kind: input.kind,
          targetRef: input.targetRef,
          registerProcessGroup: () => {},
          shareWithGuardian: () => {},
          markSettled: () => {},
          releaseAfterSettlement: async () => {},
          abandonBeforeRegistration: async () => {},
        }),
      },
      store: evidence,
      binding: {
        kind: "merge",
        targetRef: "tasks:T6520",
        repositoryRoot: "/repo",
        commit: staged.candidate.resultCommit,
        completionRef: completion.completionRef,
        mergeOperationId: "unchanged-ff-merge",
      },
      repositoryHead: async () => protectedHead,
      authorizeCandidate: async (receipt) => {
        if (
          dispatchPayloadDigest(receipt as unknown as DispatchJSONValue) !==
          dispatchPayloadDigest(authority as unknown as DispatchJSONValue)
        ) {
          throw new Error("merge candidate authority changed");
        }
      },
      reserveCandidate: reserveCandidateAuthority,
    });
    const admission = await mergeProvider.acquire({ kind: "merge", targetRef: "tasks:T6520" });
    await admission.registerProcessGroup({ pgid: 6520, leaderPid: 6520 });
    await admission.shareWithGuardian({ pgid: 6520, leaderPid: 6520 });
    protectedHead = staged.candidate.resultCommit;
    await admission.markSettled();
    await admission.releaseAfterSettlement();
    gateCounts.push(gateRuns);
    await expect(
      service.recordCompletion({
        taskRef: "tasks:T6520",
        expectedRepositoryHead: staged.candidate.resultCommit,
        operationId: "unchanged-record",
        author: "parent",
      }),
    ).resolves.toMatchObject({ status: "recorded" });
    gateCounts.push(gateRuns);
    await expect(
      service.recordCompletion({
        taskRef: "tasks:T6520",
        expectedRepositoryHead: staged.candidate.resultCommit,
        operationId: "unchanged-record-replay",
        author: "parent",
      }),
    ).resolves.toMatchObject({ status: "existing" });
    gateCounts.push(gateRuns);

    expect(ledgerWrites).toBe(1);
    expect(releaseEffects).toEqual(["protected-completion-release"]);
    expect(gateCounts).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(gateCounts.at(-1)! - gateCounts[0]!).toBe(0);
    const released = await backend.transact({ kind: "handle", handle: staged.prepared }, (store) =>
      store.read(staged.prepared),
    );
    expect(released?.implementationQueue?.state).toBe("released");
  });

  // regression: T6520 round 13 — assertion-local counters did not prove that
  // the production coordinator rejected stale dispatch identity and ran the
  // gate for each newly qualified code identity.
  test("changed tip, tree, command, and environment reject stale coordination before one fresh gate [Behavioral-Active Blackbox-Group]", async () => {
    const replacements = [
      { name: "tip", fields: { resultCommit: "3".repeat(40) }, invalidGateCommand: null },
      { name: "tree", fields: { resultTree: "3".repeat(40) }, invalidGateCommand: null },
      { name: "command", fields: {}, invalidGateCommand: "bun run replacement-check" },
      {
        name: "environment",
        fields: { packagedEnvironmentDigest: "3".repeat(64) },
        invalidGateCommand: null,
      },
    ] as const;

    for (const replacement of replacements) {
      const backend = new InMemoryAttestationBackend(
        new InMemoryAttestationStore({
          backend: "xdg",
          projectKey: `candidate-change-${replacement.name}`,
        }),
      );
      const fixture = new ImplementationCandidateQueueFixture(backend);
      const common = {
        taskId: "T6520",
        repositoryId: "a".repeat(64),
        integrationRef: "refs/heads/main",
        goalRef: "goals:G211",
        finalizedManifestDigest: "b".repeat(64),
        resultCommit: "1".repeat(40),
        resultTree: "2".repeat(40),
        packagedEnvironmentDigest: "c".repeat(64),
      } as const;
      const candidates = new Map<number, Awaited<ReturnType<typeof fixture.stage>>>();
      let gateRuns = 0;
      const gatedHandles: Array<{ readonly attestationId: string; readonly generation: number }> =
        [];
      const coordinator = new ImplementationCandidateCoordinator(fixture.adapter, {
        observeProtectedHead: async (control) => control.attempt.observedBaseCommit,
        finalizeQualifiedFront: async ({ lease, control }) => {
          const staged = candidates.get(lease.generation);
          if (staged === undefined) throw new Error("gate callback received an unknown candidate");
          const claimed = await claimQualifiedParentGateOn(
            backend,
            { ...staged.prepared, queueLease: lease },
            { now: fixture.clock.now },
          );
          if (claimed.state !== "gate-running") throw new Error("expected a fresh gate claim");
          gateRuns += 1;
          gatedHandles.push({
            attestationId: staged.prepared.attestationId,
            generation: staged.prepared.generation,
          });
          await completeQualifiedParentGateOn(
            backend,
            {
              ...staged.prepared,
              queueLease: lease,
              gateEpoch: claimed.gateEpoch,
              output: {
                ...(claimed.output as Readonly<Record<string, DispatchJSONValue>>),
                supervisedGateEvidence: {
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
                  worktreePath: control.attempt.worktreePath,
                  branch: staged.binding.branch,
                  baseCommit: control.attempt.observedBaseCommit,
                  startingCommit: control.attempt.observedBaseCommit,
                  resultCommit: control.attempt.resultCommit,
                  clean: true,
                  command: control.attempt.gateCommand,
                  gateExitCode: 0,
                  passCount: 1,
                  failCount: 0,
                  gateDurationMs: 1,
                  capturedAt: fixture.clock.now(),
                  filesTouchedDigest: "1".repeat(64),
                  gitReceiptsDigest: "2".repeat(64),
                  mutationTableDigest: "3".repeat(64),
                },
              },
            },
            { now: fixture.clock.now },
          );
        },
        confirmQualifiedFront: async ({ lease, control, nativeCompletion }) => {
          const staged = candidates.get(lease.generation);
          if (staged === undefined || control.qualification === undefined) {
            throw new Error("confirmation callback lost its qualified candidate");
          }
          await confirmDispatchCompletionOn(
            backend,
            {
              namespace: backend.namespace,
              ...staged.prepared,
              nativeCompletion,
              expectedProvenance: control.qualification.expectedProvenance,
              continuationContext: {
                liveTip: staged.binding.baseCommit,
                gitReceipts: staged.candidate.gitReceipts,
              },
            },
            { now: fixture.clock.now },
          );
        },
        retireStaleSource: async () => {
          throw new Error("a qualified replacement unexpectedly became stale");
        },
        rebaseRetiredSource: async () => {
          throw new Error("a qualified replacement unexpectedly rebased");
        },
        prepareSuccessor: async () => {
          throw new Error("a qualified replacement unexpectedly prepared a successor");
        },
      });

      const original = await fixture.stage({
        ...common,
        idempotencyKey: `original-${replacement.name}`,
      });
      candidates.set(original.prepared.generation, original);
      const originalQualified = await fixture.adapter.qualifyNativeCompletion({
        candidate: original.candidate,
        ...original.qualification,
      });
      await expect(
        coordinator.run({
          partitionKey: originalQualified.queue.partition.partitionKey,
          holderId: `original-${replacement.name}-holder`,
          expectedCandidate: {
            attestationId: original.prepared.attestationId,
            generation: original.prepared.generation,
          },
        }),
      ).resolves.toMatchObject({ state: "completed" });
      expect(gateRuns, replacement.name).toBe(1);

      const fresh = await fixture.stage({
        ...common,
        ...replacement.fields,
        reprepareOf: original,
        idempotencyKey: `fresh-${replacement.name}`,
      });
      candidates.set(fresh.prepared.generation, fresh);
      if (replacement.invalidGateCommand !== null) {
        await expect(
          fixture.adapter.qualifyNativeCompletion({
            candidate: {
              ...fresh.candidate,
              gateCommand: replacement.invalidGateCommand,
            } as unknown as typeof fresh.candidate,
            ...fresh.qualification,
          }),
        ).rejects.toThrow("implementation queue requires the canonical gate command");
        expect(gateRuns, replacement.name).toBe(1);
      }
      const freshQualified = await fixture.adapter.qualifyNativeCompletion({
        candidate: fresh.candidate,
        ...fresh.qualification,
      });
      await expect(
        coordinator.run({
          partitionKey: freshQualified.queue.partition.partitionKey,
          holderId: `fresh-${replacement.name}-holder`,
          expectedCandidate: {
            attestationId: original.prepared.attestationId,
            generation: original.prepared.generation,
          },
        }),
      ).resolves.toMatchObject({
        state: "blocked",
        front: {
          attestationId: fresh.prepared.attestationId,
          generation: fresh.prepared.generation,
        },
      });
      expect(gateRuns, replacement.name).toBe(1);
      await expect(
        coordinator.run({
          partitionKey: freshQualified.queue.partition.partitionKey,
          holderId: `fresh-${replacement.name}-holder`,
          expectedCandidate: {
            attestationId: fresh.prepared.attestationId,
            generation: fresh.prepared.generation,
          },
        }),
      ).resolves.toMatchObject({ state: "completed" });
      expect(gateRuns, replacement.name).toBe(2);
      expect(gatedHandles, replacement.name).toEqual([
        {
          attestationId: original.prepared.attestationId,
          generation: original.prepared.generation,
        },
        {
          attestationId: fresh.prepared.attestationId,
          generation: fresh.prepared.generation,
        },
      ]);
    }
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
