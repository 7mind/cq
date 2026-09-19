import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_OVERLAY_REGISTRY,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  SqliteAttestationBackend,
  claimQualifiedParentGateOn,
  completeQualifiedParentGateOn,
  confirmDispatchCompletionOn,
  discoverDispatchContinuationOn,
  enqueueImplementationCandidateOn,
  prepareDispatchOn,
  sequentialDispatchRandomBytes,
  type AttestationBackend,
  type DispatchJSONValue,
  type ImplementationQueueLeaseBinding,
} from "@cq/config";
import {
  ImplementationEvidenceService,
  PLAN_FINALIZED_MANIFEST_FIELD,
  createInMemoryWorksetStore,
  createInMemoryImplementationEvidenceStore,
  implementationCompletionMergeAdmissionProviderFromStore,
  prepareManagedWorktree,
  resolveManagedWorktreeDispatchBinding,
  type ImplementationCandidateAuthorityReceipt,
  type ImplementationReviewerIdentity,
  type LedgerStore,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import { currentRecoveryTaskEvidence } from "../src/dispatchRecoverySeal.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";
import {
  ImplementationCandidateQueueFixture,
  type PreparedQueueCandidate,
} from "./implementationCandidateQueueFixture.js";

const namespace = { backend: "xdg" as const, projectKey: "candidate-stale-holder" };

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...globalThis.process.env,
      GIT_AUTHOR_NAME: "T6520",
      GIT_AUTHOR_EMAIL: "t6520@example.invalid",
      GIT_COMMITTER_NAME: "T6520",
      GIT_COMMITTER_EMAIL: "t6520@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

function candidatePromptArtifacts(): PromptArtifactStore {
  const metadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const,
    promptDigest: "a".repeat(64),
    schemaVersion: 8,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: "codex",
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

function finalizedCandidateTaskStore(): LedgerStore {
  const workset = createInMemoryWorksetStore();
  const manifest = JSON.stringify({
    revision: 1,
    milestones: [{ key: "candidate", id: "M6520" }],
    tasks: [{ key: "handoff", id: "T6520" }],
  });
  return {
    worksetStore: () => workset,
    fetchItem: (ledgerId: string) =>
      ledgerId === "tasks"
        ? {
            id: "T6520",
            milestoneId: "M6520",
            status: "wip",
            fields: {
              headline: "Queue one implementation candidate",
              description: "Exercise the ledger-MCP implementation queue adapter.",
              acceptance: "Queue state is durable and fenced.",
              ledgerRefs: ["goals:G211"],
              worksetOwnerRef: "goals:G211",
              worksetOwnerEdgeKind: "active-current-draft",
            },
          }
        : {
            id: "G211",
            milestoneId: "M6520",
            status: "building",
            fields: { [PLAN_FINALIZED_MANIFEST_FIELD]: manifest },
          },
  } as unknown as LedgerStore;
}

async function completeCandidate(
  backend: AttestationBackend,
  fixture: ImplementationCandidateQueueFixture,
  staged: PreparedQueueCandidate,
  lease: ImplementationQueueLeaseBinding,
  baseCommit: string,
  startingCommit: string,
  liveTip: string = startingCommit,
): Promise<void> {
  const claimed = await claimQualifiedParentGateOn(
    backend,
    { ...staged.prepared, queueLease: lease },
    { now: fixture.clock.now },
  );
  if (claimed.state !== "gate-running") throw new Error("expected candidate gate claim");
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
          worktreePath: staged.binding.worktreePath,
          branch: staged.binding.branch,
          baseCommit,
          startingCommit,
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
  await confirmDispatchCompletionOn(
    backend,
    {
      namespace: backend.namespace,
      ...staged.prepared,
      nativeCompletion: staged.qualification.nativeCompletion,
      expectedProvenance: staged.qualification.expectedProvenance,
      continuationContext: {
        liveTip,
        gitReceipts: staged.candidate.gitReceipts,
      },
    },
    { now: fixture.clock.now },
  );
}

describe("implementation candidate stale-holder fencing [Behavioral-Active, Blackbox-Group]", () => {
  test("only the current resumed lease generation can attach gate evidence", async () => {
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
    const first = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "pre-restart-holder",
    });
    if (first.state !== "leased") throw new Error("expected first candidate lease");
    const parked = await fixture.adapter.park({
      ...first.lease,
      expectedPartitionRevision: first.partitionRevision,
      detail: { reason: "execution-uncertain" },
    });
    const resumed = await fixture.adapter.resume({
      ...first.lease,
      expectedPartitionRevision: parked.partitionRevision,
      detail: { reason: "operator-resume" },
    });
    const successor = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "post-restart-holder",
      expectedPartitionRevision: resumed.partitionRevision,
    });
    if (successor.state !== "leased") throw new Error("expected resumed candidate lease");
    expect(successor.lease.leaseGeneration).toBe(first.lease.leaseGeneration + 1);

    await expect(
      claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: first.lease },
        { now: fixture.clock.now },
      ),
    ).rejects.toThrow("exact current implementation queue lease");
    await expect(fixture.adapter.inspectLease(first.lease)).rejects.toThrow("stale");
    await expect(
      claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: successor.lease },
        { now: fixture.clock.now },
      ),
    ).resolves.toMatchObject({ state: "gate-running" });
  });

  test("a continuation resolved before completion reservation cannot claim a successor afterward [Behavioral-Active Blackbox-Group]", async () => {
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
    const acquired = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "completion-holder",
    });
    if (acquired.state !== "leased") throw new Error("expected completion lease");
    await completeCandidate(
      backend,
      fixture,
      staged,
      acquired.lease,
      staged.binding.baseCommit,
      staged.binding.baseCommit,
      staged.candidate.resultCommit,
    );
    const continuation = await discoverDispatchContinuationOn(
      backend,
      {
        namespace,
        actor: "trusted-parent",
        gitEffectBinding: staged.binding,
        liveTip: staged.candidate.resultCommit,
      },
      { now: fixture.clock.now },
    );
    const current = await fixture.adapter.inspectLease(acquired.lease);
    if (current.qualification === undefined) throw new Error("completion qualification disappeared");
    await fixture.adapter.reserveCompletion({
      ...acquired.lease,
      expectedPartitionRevision: current.partitionRevision,
      operationId: "resolved-continuation-reservation",
      completionRef: `cq-implementation-completion:v1:${"1".repeat(64)}`,
      mergeOperationId: "resolved-continuation-merge",
      taskRef: "tasks:T6520",
      resultCommit: staged.candidate.resultCommit,
      qualificationDigest: current.qualification.qualificationDigest,
    });

    await expect(
      discoverDispatchContinuationOn(
        backend,
        {
          namespace,
          actor: "trusted-parent",
          gitEffectBinding: staged.binding,
          liveTip: staged.candidate.resultCommit,
        },
        { now: fixture.clock.now },
      ),
    ).rejects.toThrow("completion reservation");

    await expect(
      prepareDispatchOn(
        backend,
        {
          namespace,
          roleId: "implement-worker",
          surface: "codex",
          input: {
            taskId: "T6520",
            headline: "Continue a completion-reserved candidate",
            description: "Exercise the post-resolution queue fence.",
            acceptance: "A reserved completion cannot transfer its lease.",
            worktreePath: staged.binding.worktreePath,
            branch: staged.binding.branch,
            baseCommit: staged.binding.baseCommit,
            round: staged.prepared.generation,
            startingCommit: staged.candidate.resultCommit,
            priorResultCommit: staged.candidate.resultCommit,
          },
          idempotencyKey: "resolved-before-completion-reservation",
          timeoutMs: 600_000,
          registry: DISPATCH_OVERLAY_REGISTRY,
          promptDigest: "a".repeat(64),
          catalogHash: "b".repeat(64),
          expectedChild: {
            childId: "resolved-continuation-child",
            runId: "resolved-continuation-run",
          },
          reprepareOf: staged.prepared,
          gitEffectBinding: staged.binding,
          continuationClaim: {
            continuationReference: continuation.continuationReference,
            actor: "trusted-parent",
            liveTip: continuation.liveTip,
          },
        },
        {
          mode: "manager-bound",
          now: fixture.clock.now,
          randomBytes: sequentialDispatchRandomBytes(6520),
          lineageFenceGuard: async () => null,
          withLineageLock: async (operation) => await operation(),
        },
      ),
    ).rejects.toThrow("completion reservation");
  });

  // regression: T6520 round 11 — same-enrollment resume coverage did not prove
  // that a guarded-rebase successor becomes the sole review/completion authority.
  test("after restart only the guarded-rebase successor acquires review and completion authority; its retired source and foreign task are rejected [Behavioral-Active Blackbox-Group]", async () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const common = {
      taskId: "T6520",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "b".repeat(64),
    } as const;
    const source = await fixture.stage({ ...common, withReceipt: true });
    const sourceQualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: source.candidate,
      ...source.qualification,
    });
    const sourceLease = await fixture.adapter.acquire({
      partitionKey: sourceQualified.queue.partition.partitionKey,
      holderId: "guarded-source-holder",
    });
    if (sourceLease.state !== "leased") throw new Error("expected guarded source lease");
    await completeCandidate(
      backend,
      fixture,
      source,
      sourceLease.lease,
      source.binding.baseCommit,
      source.candidate.resultCommit,
    );
    backend.rehydrate();

    const ontoCommit = "f".repeat(40);
    const rebasedStartCommit = "d".repeat(40);
    const successor = await fixture.stage({
      ...common,
      idempotencyKey: "guarded-successor-after-restart",
      reprepareOf: source,
      guardedRebase: {
        guardedRebase: `cq-guarded-rebase:v1:${"c".repeat(64)}`,
        requestDigest: "e".repeat(64),
        ontoCommit,
        rebasedStartCommit,
        resultTree: "9".repeat(40),
      },
    });
    const successorQualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: successor.candidate,
      ...successor.qualification,
    });
    const successorLease = await fixture.adapter.acquire({
      partitionKey: successorQualified.queue.partition.partitionKey,
      holderId: "guarded-successor-holder",
    });
    if (successorLease.state !== "leased") throw new Error("expected guarded successor lease");
    backend.rehydrate();
    await completeCandidate(
      backend,
      fixture,
      successor,
      successorLease.lease,
      ontoCommit,
      rebasedStartCommit,
    );
    backend.rehydrate();

    const [sourceRow, successorRow] = [...backend.storedRows()].sort(
      (left, right) => left.generation - right.generation,
    );
    expect(sourceRow).toMatchObject({
      state: "consumed",
      implementationQueue: {
        state: "staged-rebase-retired",
        stagedRebaseSource: {
          successor: {
            attestationId: successor.prepared.attestationId,
            generation: successor.prepared.generation,
          },
        },
      },
    });
    if (
      sourceRow?.kind !== "envelope" ||
      sourceRow.implementationQueue?.state !== "staged-rebase-retired"
    ) {
      throw new Error("guarded source did not retain its retirement boundary");
    }
    expect(sourceRow.implementationQueue.lease).toBeUndefined();
    expect(successorRow).toMatchObject({
      state: "consumed",
      implementationQueue: {
        state: "leased",
        lease: {
          holderId: successorLease.lease.holderId,
          generation: successorLease.lease.leaseGeneration,
        },
      },
    });
    if (
      successorRow?.kind !== "envelope" ||
      successorRow.implementationQueue?.state !== "leased" ||
      successorRow.implementationQueue.qualification === undefined
    ) {
      throw new Error("guarded successor authority did not survive restart");
    }
    const control = successorRow.implementationQueue;
    const qualification = control.qualification;
    if (qualification === undefined) {
      throw new Error("guarded successor lost its qualification after restart");
    }
    const authority: ImplementationCandidateAuthorityReceipt = {
      kind: "cq-implementation-candidate-authority",
      version: 1,
      workerDispatch: {
        attestationId: successor.prepared.attestationId,
        generation: successor.prepared.generation,
      },
      partitionKey: control.partition.partitionKey,
      enrollmentId: control.enrollment.enrollmentId,
      attemptId: control.attempt.attemptId,
      leaseHolderId: successorLease.lease.holderId,
      leaseGeneration: successorLease.lease.leaseGeneration,
      qualificationDigest: qualification.qualificationDigest,
      taskRef: "tasks:T6520",
      taskDigest: "4".repeat(64),
      goalRef: common.goalRef,
      finalizedManifestDigest: common.finalizedManifestDigest,
      integrationRef: common.integrationRef,
      repositoryId: common.repositoryId,
      worktreePath: successor.binding.worktreePath,
      resultCommit: rebasedStartCommit,
      resultTree: control.attempt.resultTree,
      gateCommand: control.attempt.gateCommand,
      packagedEnvironmentDigest: control.attempt.packagedEnvironmentDigest,
      managedWorktreeBindingDigest: control.attempt.managedWorktreeBindingDigest,
      gitReceiptLineageDigest: control.attempt.gitReceiptLineageDigest,
      gateEvidenceDigest: "5".repeat(64),
    };
    const reviewer: ImplementationReviewerIdentity = {
      alias: "native",
      harness: "codex",
      model: "frontier",
      provider: null,
      launch: "native",
      adapterId: "codex:native",
    };
    const service = new ImplementationEvidenceService({
      store: createInMemoryImplementationEvidenceStore(),
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
          rationale: "guarded successor is current",
          gateReRan: true,
          gateDurationMs: 1,
          resultCommitVerified: true,
          resultCommitEvidence: {
            status: "verified",
            resultCommit: rebasedStartCommit,
            branchTip: rebasedStartCommit,
          },
          baseAncestry: {
            status: "verified",
            relation: "descendant",
            baseCommit: ontoCommit,
            resultCommit: rebasedStartCommit,
            mergeBase: ontoCommit,
          },
        },
      }),
      executeExternalReview: async () => {
        throw new Error("external review is not configured");
      },
      fetchWorker: async () => ({
        state: "consumed",
        input: { taskId: "T6520", baseCommit: ontoCommit },
        output: {
          taskId: "T6520",
          status: "pass",
          resultCommit: rebasedStartCommit,
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit: ontoCommit,
            headCommit: rebasedStartCommit,
          },
        },
      }),
      resolveCandidateAuthority: async (input) => {
        if (
          input.workerDispatch.attestationId !== successor.prepared.attestationId ||
          input.workerDispatch.generation !== successor.prepared.generation ||
          input.taskRef !== authority.taskRef ||
          input.resultCommit !== authority.resultCommit
        ) {
          throw new Error("candidate is not the unique active guarded successor");
        }
        return authority;
      },
      releaseCandidateAuthority: async () => {},
      readTaskAuthority: async () => ({
        taskRef: "tasks:T6520",
        ownerGoalRef: common.goalRef,
        status: "wip",
        finalizedManifest: "manifest-v1\n",
      }),
      repositoryHead: async () => ontoCommit,
      verifyImplementation: async () => ({
        baseCommit: ontoCommit,
        startingCommit: rebasedStartCommit,
        clean: true,
        ancestryVerified: true,
        receiptsVerified: true,
        acceptanceVerified: true,
        gateVerified: true,
        details: { guardedSuccessor: true },
      }),
      recordLedgerCompletion: async () => ({ reviewRef: "reviews:R6520" }),
    });
    await expect(
      service.prepareReviewPanel({
        taskRef: "tasks:T6520",
        resultCommit: source.candidate.resultCommit,
        workerDispatch: {
          attestationId: source.prepared.attestationId,
          generation: source.prepared.generation,
        },
        operationId: "retired-source-review",
        author: "parent",
      }),
    ).rejects.toThrow("unique active guarded successor");
    await expect(
      service.prepareReviewPanel({
        taskRef: "tasks:T9999",
        resultCommit: rebasedStartCommit,
        workerDispatch: authority.workerDispatch,
        operationId: "foreign-task-review",
        author: "parent",
      }),
    ).rejects.toThrow("unique active guarded successor");

    const panel = await service.prepareReviewPanel({
      taskRef: authority.taskRef,
      resultCommit: authority.resultCommit,
      workerDispatch: authority.workerDispatch,
      operationId: "guarded-successor-review",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "guarded-successor-attempt",
      author: "parent",
    });
    await service.finalizeReviewAttempt({
      attemptRef,
      operationId: "guarded-successor-finalize",
      author: "parent",
    });
    const completion = await service.prepareCompletion({
      taskRef: authority.taskRef,
      expectedRepositoryHead: ontoCommit,
      resultCommit: authority.resultCommit,
      workerDispatch: authority.workerDispatch,
      reviewAttemptRefs: [attemptRef],
      completion: "guarded successor reviewed",
      logPaths: [],
      mergeOperationId: "guarded-successor-merge",
      operationId: "guarded-successor-completion",
      author: "parent",
    });
    expect(completion).toMatchObject({ status: "prepared", resultCommit: rebasedStartCommit });
  });

  // regression: T6520 round 13 — a test-local resolver could merely return the
  // successor it expected. This case uses the public capability over SQLite,
  // a live managed worktree, and the durable source/successor rows.
  test("public SQLite authority admits only the guarded-rebase successor after restart [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-t6520-public-successor-"));
    const stateDir = join(root, ".manager-state");
    await git(root, ["init", "-q", "-b", "main"]);
    await writeFile(join(root, "candidate.ts"), "export const candidate = false;\n");
    await git(root, ["add", "candidate.ts"]);
    await git(root, ["commit", "-q", "-m", "candidate base"]);
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    const managed = await prepareManagedWorktree(
      { repositoryRoot: root, taskId: "T6520", baseCommit },
      { stateDir, skipInstall: true, bunWorkspaceRoot: root },
    );
    if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: root,
        taskId: "T6520",
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
      },
      { stateDir },
    );
    if (binding === null) throw new Error("managed candidate binding did not resolve");
    await writeFile(
      join(managed.handle.absolutePath, "candidate.ts"),
      "export const candidate = 'source';\n",
    );
    await git(managed.handle.absolutePath, ["add", "candidate.ts"]);
    await git(managed.handle.absolutePath, ["commit", "-q", "-m", "source candidate"]);
    const sourceResultCommit = await git(managed.handle.absolutePath, ["rev-parse", "HEAD"]);
    const sourceResultTree = await git(managed.handle.absolutePath, ["rev-parse", "HEAD^{tree}"]);
    const sqliteNamespace = {
      backend: "xdg" as const,
      projectKey: "candidate-public-successor",
    };
    const backend = new SqliteAttestationBackend({
      namespace: sqliteNamespace,
      dbPath: join(root, "attestations.sqlite"),
    });
    try {
      const ledgerStore = finalizedCandidateTaskStore();
      const taskEvidence = currentRecoveryTaskEvidence(ledgerStore, "T6520");
      const fixture = new ImplementationCandidateQueueFixture(backend);
      const common = {
        taskId: "T6520",
        repositoryId: binding.repositoryId,
        integrationRef: "refs/heads/main",
        goalRef: "goals:G211",
        finalizedManifestDigest: taskEvidence.finalizedManifestDigest,
      } as const;
      const source = await fixture.stage({
        ...common,
        idempotencyKey: "public-source",
        gitEffectBinding: binding,
        resultCommit: sourceResultCommit,
        resultTree: sourceResultTree,
        withReceipt: true,
      });
      const sourceQualified = await fixture.adapter.qualifyNativeCompletion({
        candidate: source.candidate,
        ...source.qualification,
      });
      const sourceLease = await fixture.adapter.acquire({
        partitionKey: sourceQualified.queue.partition.partitionKey,
        holderId: "public-source-holder",
      });
      if (sourceLease.state !== "leased") throw new Error("public source did not lease");
      await completeCandidate(
        backend,
        fixture,
        source,
        sourceLease.lease,
        baseCommit,
        baseCommit,
        sourceResultCommit,
      );

      await writeFile(join(root, "protected.txt"), "protected advance\n");
      await git(root, ["add", "protected.txt"]);
      await git(root, ["commit", "-q", "-m", "advance protected head"]);
      const ontoCommit = await git(root, ["rev-parse", "HEAD"]);
      await git(managed.handle.absolutePath, ["rebase", "main"]);
      const rebasedStartCommit = await git(managed.handle.absolutePath, ["rev-parse", "HEAD"]);
      const rebasedTree = await git(managed.handle.absolutePath, ["rev-parse", "HEAD^{tree}"]);
      const guardedRebase = `cq-guarded-rebase:v1:${"c".repeat(64)}` as const;
      const successor = await fixture.stage({
        ...common,
        idempotencyKey: "public-successor",
        reprepareOf: source,
        guardedRebase: {
          guardedRebase,
          requestDigest: "c".repeat(64),
          ontoCommit,
          rebasedStartCommit,
          resultTree: rebasedTree,
        },
      });
      const successorQualified = await fixture.adapter.qualifyNativeCompletion({
        candidate: successor.candidate,
        ...successor.qualification,
      });
      const successorLease = await fixture.adapter.acquire({
        partitionKey: successorQualified.queue.partition.partitionKey,
        holderId: "public-successor-holder",
      });
      if (successorLease.state !== "leased") throw new Error("public successor did not lease");
      await completeCandidate(
        backend,
        fixture,
        successor,
        successorLease.lease,
        ontoCommit,
        rebasedStartCommit,
      );
      await backend.close();

      const restartedBackend = new SqliteAttestationBackend({
        namespace: sqliteNamespace,
        dbPath: join(root, "attestations.sqlite"),
      });
      try {
        const capability = createDispatchCapability({
          backend: restartedBackend,
          promptArtifactStore: candidatePromptArtifacts(),
          ledgerStore,
          repositoryRoot: root,
          worktreeStateDir: stateDir,
          now: fixture.clock.now,
        });
        if (capability.resolveImplementationCandidateAuthority === undefined) {
          throw new Error("public implementation candidate authority is unavailable");
        }
        const resolveAuthority = capability.resolveImplementationCandidateAuthority;
        await expect(
          resolveAuthority({
            workerDispatch: {
              attestationId: source.prepared.attestationId,
              generation: source.prepared.generation,
            },
            taskRef: "tasks:T6520",
            resultCommit: sourceResultCommit,
          }),
        ).rejects.toThrow();
        await expect(
          resolveAuthority({
            workerDispatch: {
              attestationId: successor.prepared.attestationId,
              generation: successor.prepared.generation,
            },
            taskRef: "tasks:T9999",
            resultCommit: rebasedStartCommit,
          }),
        ).rejects.toThrow();
        const authority = await resolveAuthority({
          workerDispatch: {
            attestationId: successor.prepared.attestationId,
            generation: successor.prepared.generation,
          },
          taskRef: "tasks:T6520",
          resultCommit: rebasedStartCommit,
        });
        expect(authority).toMatchObject({
          workerDispatch: {
            attestationId: successor.prepared.attestationId,
            generation: successor.prepared.generation,
          },
          leaseHolderId: "public-successor-holder",
          leaseGeneration: successorLease.lease.leaseGeneration,
          taskRef: "tasks:T6520",
          resultCommit: rebasedStartCommit,
        });

        const reviewer: ImplementationReviewerIdentity = {
          alias: "native",
          harness: "codex",
          model: "frontier",
          provider: null,
          launch: "native",
          adapterId: "codex:native",
        };
        const evidenceStore = createInMemoryImplementationEvidenceStore();
        const service = new ImplementationEvidenceService({
          store: evidenceStore,
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
              rationale: "public successor authority resolved",
              gateReRan: true,
              gateDurationMs: 1,
              resultCommitVerified: true,
              resultCommitEvidence: {
                status: "verified",
                resultCommit: rebasedStartCommit,
                branchTip: rebasedStartCommit,
              },
              baseAncestry: {
                status: "verified",
                relation: "descendant",
                baseCommit: ontoCommit,
                resultCommit: rebasedStartCommit,
                mergeBase: ontoCommit,
              },
            },
          }),
          executeExternalReview: async () => {
            throw new Error("external review is not configured");
          },
          fetchWorker: async () => ({
            state: "consumed",
            input: { taskId: "T6520", baseCommit: ontoCommit },
            output: {
              taskId: "T6520",
              status: "pass",
              resultCommit: rebasedStartCommit,
              baseVerification: {
                status: "verified",
                relation: "descendant",
                baseCommit: ontoCommit,
                headCommit: rebasedStartCommit,
              },
            },
          }),
          resolveCandidateAuthority: resolveAuthority,
          releaseCandidateAuthority: async () => {},
          readTaskAuthority: async () => ({
            taskRef: "tasks:T6520",
            ownerGoalRef: "goals:G211",
            status: "wip",
            finalizedManifest: "manifest-v1\n",
          }),
          repositoryHead: async () => ontoCommit,
          verifyImplementation: async () => ({
            baseCommit: ontoCommit,
            startingCommit: rebasedStartCommit,
            clean: true,
            ancestryVerified: true,
            receiptsVerified: true,
            acceptanceVerified: true,
            gateVerified: true,
            details: { publicSuccessorAuthority: true },
          }),
          recordLedgerCompletion: async () => ({ reviewRef: "reviews:R6520" }),
        });
        await expect(
          service.prepareReviewPanel({
            taskRef: "tasks:T6520",
            resultCommit: sourceResultCommit,
            workerDispatch: {
              attestationId: source.prepared.attestationId,
              generation: source.prepared.generation,
            },
            operationId: "public-retired-source-review",
            author: "parent",
          }),
        ).rejects.toThrow();
        const panel = await service.prepareReviewPanel({
          taskRef: "tasks:T6520",
          resultCommit: rebasedStartCommit,
          workerDispatch: authority.workerDispatch,
          operationId: "public-successor-review",
          author: "parent",
        });
        const attemptRef = panel.attemptRefs[0]!;
        await service.prepareReviewAttempt({
          panelRef: panel.panelRef,
          attemptRef,
          operationId: "public-successor-attempt",
          author: "parent",
        });
        await service.finalizeReviewAttempt({
          attemptRef,
          operationId: "public-successor-finalize",
          author: "parent",
        });
        const completion = await service.prepareCompletion({
          taskRef: "tasks:T6520",
          expectedRepositoryHead: ontoCommit,
          resultCommit: rebasedStartCommit,
          workerDispatch: authority.workerDispatch,
          reviewAttemptRefs: [attemptRef],
          completion: "public successor reviewed",
          logPaths: [],
          mergeOperationId: "public-successor-merge",
          operationId: "public-successor-completion",
          author: "parent",
        });
        expect(completion).toMatchObject({ status: "prepared", resultCommit: rebasedStartCommit });
        if (capability.reserveImplementationCandidateAuthority === undefined) {
          throw new Error("public implementation candidate reservation is unavailable");
        }
        const completionBinding = {
          operationId: "public-successor-completion",
          completionRef: completion.completionRef,
          mergeOperationId: "public-successor-merge",
          taskRef: "tasks:T6520",
          resultCommit: rebasedStartCommit,
        } as const;
        await expect(
          capability.reserveImplementationCandidateAuthority(
            { ...authority, leaseGeneration: authority.leaseGeneration + 1 },
            completionBinding,
          ),
        ).rejects.toThrow("authority changed before completion reservation");

        const finalAuthorization = Promise.withResolvers<void>();
        const allowGuardianShare = Promise.withResolvers<void>();
        let authorizationCount = 0;
        const mergeProvider = await implementationCompletionMergeAdmissionProviderFromStore({
          provider: {
            acquire: async (input) => ({
              id: "public-successor-merge-admission",
              epoch: 1,
              kind: input.kind,
              targetRef: input.targetRef,
              registerProcessGroup: () => {},
              prepareGuardianShare: async () => {
                finalAuthorization.resolve();
                await allowGuardianShare.promise;
              },
              shareWithGuardian: () => {},
              markSettled: () => {},
              releaseAfterSettlement: async () => {},
              abandonBeforeRegistration: async () => {},
            }),
          },
          store: evidenceStore,
          binding: {
            kind: "merge",
            targetRef: "tasks:T6520",
            repositoryRoot: root,
            commit: rebasedStartCommit,
            completionRef: completion.completionRef,
            mergeOperationId: "public-successor-merge",
          },
          repositoryHead: async () => ontoCommit,
          authorizeCandidate: async (receipt) => {
            authorizationCount += 1;
            await resolveAuthority({
              workerDispatch: receipt.workerDispatch,
              taskRef: receipt.taskRef,
              resultCommit: receipt.resultCommit,
            });
          },
          reserveCandidate: async (receipt, binding) => {
            if (capability.reserveImplementationCandidateAuthority === undefined) {
              throw new Error("public implementation candidate reservation is unavailable");
            }
            await capability.reserveImplementationCandidateAuthority(receipt, binding);
          },
        });
        const admission = await mergeProvider.acquire({
          kind: "merge",
          targetRef: "tasks:T6520",
        });
        await admission.registerProcessGroup({ pgid: 6520, leaderPid: 6520 });
        const guardianShare = admission.shareWithGuardian({ pgid: 6520, leaderPid: 6520 });
        await finalAuthorization.promise;
        expect(authorizationCount).toBe(2);
        const continuationFixture = new ImplementationCandidateQueueFixture(restartedBackend);
        try {
          await expect(
            continuationFixture.prepareOnly({
              ...common,
              idempotencyKey: "continuation-after-final-merge-authorization",
              reprepareOf: successor,
            }),
          ).rejects.toThrow("completion reservation");
        } finally {
          allowGuardianShare.resolve();
          await guardianShare;
        }
      } finally {
        await restartedBackend.close();
      }
    } finally {
      await backend.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unqualified and staged-rebase-retired rows remain ineligible after durable replay", async () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const staged = await fixture.stage({
      taskId: "T6520",
      repositoryId: "a".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G211",
      finalizedManifestDigest: "b".repeat(64),
    });
    const enqueued = await enqueueImplementationCandidateOn(
      backend,
      { namespace, actor: "trusted-parent", ...staged.candidate },
      { now: fixture.clock.now },
    );
    const neverQualifiedLease = {
      attestationId: staged.prepared.attestationId,
      generation: staged.prepared.generation,
      partitionKey: enqueued.partition.partitionKey,
      enrollmentId: enqueued.enrollment.enrollmentId,
      attemptId: enqueued.attempt.attemptId,
      holderId: "unqualified-holder",
      leaseGeneration: 1,
    } as const;
    expect(
      await fixture.adapter.acquire({
        partitionKey: enqueued.partition.partitionKey,
        holderId: neverQualifiedLease.holderId,
      }),
    ).toMatchObject({ state: "blocked", frontState: "enqueued" });
    await expect(
      claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: neverQualifiedLease },
        { now: fixture.clock.now },
      ),
    ).rejects.toThrow("exactly qualified staged completion");

    const qualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: staged.candidate,
      ...staged.qualification,
    });
    const acquired = await fixture.adapter.acquire({
      partitionKey: qualified.queue.partition.partitionKey,
      holderId: "pre-rebase-holder",
    });
    if (acquired.state !== "leased") throw new Error("expected qualified source lease");
    const source = await fixture.adapter.retireStagedRebaseSource({
      ...acquired.lease,
      expectedPartitionRevision: acquired.partitionRevision,
      stagedOutputDigest: staged.candidate.stagedOutputDigest,
      effectLock: {
        kind: "managed-worktree-effect-lock",
        bindingDigest: qualified.queue.attempt.managedWorktreeBindingDigest,
      },
      live: {
        clean: true,
        liveTip: qualified.queue.attempt.resultCommit,
        resultCommit: qualified.queue.attempt.resultCommit,
        resultTree: qualified.queue.attempt.resultTree,
        repositoryId: qualified.queue.attempt.repositoryId,
        worktreePath: qualified.queue.attempt.worktreePath,
        gitReceipts: qualified.queue.attempt.gitReceipts,
      },
      ontoCommit: "f".repeat(40),
      guardedRebase: `cq-guarded-rebase:v1:${"c".repeat(64)}`,
      guardedRebaseJournalDigest: "d".repeat(64),
    });
    backend.rehydrate();
    expect(backend.storedRows()[0]).toMatchObject({
      state: "aborted",
      implementationQueue: {
        state: "staged-rebase-retired",
        stagedRebaseSource: { sourceReference: source.sourceReference },
      },
    });
    await expect(
      claimQualifiedParentGateOn(
        backend,
        { ...staged.prepared, queueLease: acquired.lease },
        { now: fixture.clock.now },
      ),
    ).rejects.toThrow();
  });
});
