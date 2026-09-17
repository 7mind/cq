import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  dispatchPayloadDigest,
  fetchDispatchInputOn,
  prepareDispatchOn,
  provenanceBindingOf,
  sequentialDispatchRandomBytes,
  storeDispatchResultOn,
  type AttestationNamespace,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
} from "@cq/config";
import { PLAN_FINALIZED_MANIFEST_FIELD, type LedgerStore } from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import { currentRecoveryTaskEvidence } from "../src/dispatchRecoverySeal.js";
import { ImplementationCandidateQueueAdapter } from "../src/implementationCandidateQueue.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function finalizedTaskStore(): LedgerStore {
  const task = {
    id: "T6519",
    milestoneId: "M211",
    status: "wip",
    fields: {
      headline: "Queue native completion",
      description: "Qualify one staged result.",
      acceptance: "The exact process observation is durable.",
      ledgerRefs: ["goals:G211"],
      worksetOwnerRef: "goals:G211",
      worksetOwnerEdgeKind: "active-current-draft",
    },
    createdAt: "2026-09-16T09:00:00.000Z",
    updatedAt: "2026-09-16T09:00:00.000Z",
    author: "planner",
    session: "plan",
  };
  return {
    fetchItem: (ledgerId: string) =>
      ledgerId === "tasks"
        ? task
        : {
            fields: {
              [PLAN_FINALIZED_MANIFEST_FIELD]: JSON.stringify({
                revision: 1,
                milestones: [{ key: "queue", id: "M211" }],
                tasks: [{ key: "qualify", id: "T6519" }],
              }),
            },
          },
  } as unknown as LedgerStore;
}

describe("implementation candidate qualification [Behavioral-Active, Effectual-Group]", () => {
  test("installed-process observation durably qualifies staged bytes without claiming a gate", async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "cq-T6519-qualification-"));
    roots.push(repositoryRoot);
    git(repositoryRoot, "init", "-b", "main");
    git(repositoryRoot, "config", "user.name", "CQ Test");
    git(repositoryRoot, "config", "user.email", "cq@example.invalid");
    writeFileSync(join(repositoryRoot, "candidate.ts"), "export const candidate = true;\n");
    git(repositoryRoot, "add", "candidate.ts");
    git(repositoryRoot, "commit", "-m", "candidate");
    const resultCommit = git(repositoryRoot, "rev-parse", "HEAD");
    const namespace: AttestationNamespace = { backend: "xdg", projectKey: "qualification" };
    const clock = new FakeDispatchClock("2026-09-16T09:00:00.000Z");
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const correlationId = "candidate-correlation-0123456789abcdef";
    const expectedChild = {
      childId: `implement-worker#${correlationId}`,
      runId: "parent-run-T6519",
    };
    const binding: DispatchGitEffectBinding = {
      taskId: "T6519",
      handleToken: "managed-handle-T6519",
      handleFingerprint: "3".repeat(64),
      repositoryRoot,
      repositoryId: "4".repeat(64),
      commonDir: join(repositoryRoot, ".git"),
      worktreePath: repositoryRoot,
      branch: "implement/T6519",
      ref: "refs/heads/implement/T6519",
      baseCommit: resultCommit,
    };
    const prepared = await prepareDispatchOn(
      backend,
      {
        namespace,
        roleId: "implement-worker",
        surface: "codex",
        input: {
          taskId: "T6519",
          headline: "Queue native completion",
          description: "Qualify one staged result.",
          acceptance: "The exact process observation is durable.",
          worktreePath: repositoryRoot,
          branch: binding.branch,
          baseCommit: resultCommit,
          round: 0,
          startingCommit: resultCommit,
        },
        idempotencyKey: "T6519-installed-qualification",
        timeoutMs: 600_000,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: "5".repeat(64),
        catalogHash: "6".repeat(64),
        expectedChild,
        gitEffectBinding: binding,
      },
      {
        mode: "manager-bound",
        now: clock.now,
        randomBytes: sequentialDispatchRandomBytes(6519),
        lineageFenceGuard: async () => null,
        withLineageLock: async (operation) => await operation(),
      },
    );
    if (!prepared.accepted) throw new Error(prepared.detail);
    await fetchDispatchInputOn(
      backend,
      { ...prepared.prepared, namespace, inputCapability: prepared.prepared.inputCapability },
      { now: clock.now },
    );
    const output: DispatchJSONValue = {
      taskId: "T6519",
      status: "pass",
      resultCommit,
      branch: binding.branch,
      actualWorktreePath: repositoryRoot,
      filesTouched: ["candidate.ts"],
      gitReceipts: [],
      checkSummary: "focused check passed",
      baseVerification: {
        status: "verified",
        relation: "equal",
        baseCommit: resultCommit,
        headCommit: resultCommit,
      },
      summary: "candidate staged",
    };
    const staged = await storeDispatchResultOn(
      backend,
      { resultCapability: prepared.prepared.resultCapability, output },
      { now: clock.now },
    );
    expect(staged.state).toBe("gate-pending");
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: {} as PromptArtifactStore,
      ledgerStore: finalizedTaskStore(),
      now: clock.now,
    });

    const qualified = await capability.qualifyImplementationCandidate!({
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      roleId: "implement-worker",
      correlationId,
      childThreadId: "child-thread-T6519",
      outcome: "completed",
      exitStatus: 0,
      observedAt: clock.now(),
      promptDigest: "5".repeat(64),
    });

    expect(qualified).toMatchObject({
      state: "queued",
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      outputDigest: staged.state === "gate-pending" ? staged.result.outputDigest : "",
      qualificationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const row = backend.storedRows()[0];
    expect(row).toMatchObject({
      state: "gate-pending",
      implementationQueue: { state: "qualified" },
      stagedCompletionQualification: {
        nativeCompletion: {
          actor: "trusted-extension",
          childId: expectedChild.childId,
          runId: expectedChild.runId,
        },
      },
    });
  });

  test("guarded-rebase qualification retains manager identity and queues the rebased execution base", async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "cq-T6519-rebased-qualification-"));
    roots.push(repositoryRoot);
    git(repositoryRoot, "init", "-b", "main");
    git(repositoryRoot, "config", "user.name", "CQ Test");
    git(repositoryRoot, "config", "user.email", "cq@example.invalid");
    writeFileSync(join(repositoryRoot, "candidate.ts"), "export const candidate = false;\n");
    git(repositoryRoot, "add", "candidate.ts");
    git(repositoryRoot, "commit", "-m", "manager base");
    const managerBaseCommit = git(repositoryRoot, "rev-parse", "HEAD");
    writeFileSync(join(repositoryRoot, "candidate.ts"), "export const candidate = 'source';\n");
    git(repositoryRoot, "add", "candidate.ts");
    git(repositoryRoot, "commit", "-m", "source candidate");
    const sourceResultCommit = git(repositoryRoot, "rev-parse", "HEAD");
    const sourceResultTree = git(repositoryRoot, "rev-parse", `${sourceResultCommit}^{tree}`);
    writeFileSync(join(repositoryRoot, "candidate.ts"), "export const candidate = true;\n");
    git(repositoryRoot, "add", "candidate.ts");
    git(repositoryRoot, "commit", "-m", "rebased candidate");
    const rebasedStartCommit = git(repositoryRoot, "rev-parse", "HEAD");
    const namespace: AttestationNamespace = {
      backend: "xdg",
      projectKey: "rebased-qualification",
    };
    const clock = new FakeDispatchClock("2026-09-16T09:00:00.000Z");
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const ledgerStore = finalizedTaskStore();
    const taskEvidence = currentRecoveryTaskEvidence(ledgerStore, "T6519");
    const guardedRebase = `cq-guarded-rebase:v1:${"7".repeat(64)}`;
    const sourceExpectedChild = {
      childId: "implement-worker#source-candidate-correlation-0123456789abcdef",
      runId: "parent-run-T6519-source",
    };
    const sourceBinding: DispatchGitEffectBinding = {
      taskId: "T6519",
      handleToken: "managed-handle-T6519-rebased",
      handleFingerprint: "8".repeat(64),
      repositoryRoot,
      repositoryId: "9".repeat(64),
      commonDir: join(repositoryRoot, ".git"),
      worktreePath: repositoryRoot,
      branch: "implement/T6519",
      ref: "refs/heads/implement/T6519",
      baseCommit: managerBaseCommit,
    };
    const sourcePrepared = await prepareDispatchOn(
      backend,
      {
        namespace,
        roleId: "implement-worker",
        surface: "codex",
        input: {
          taskId: "T6519",
          headline: "Queue a stale native completion",
          description: "Create the retired source for a guarded successor.",
          acceptance: "The source retires under an exact qualified lease.",
          worktreePath: repositoryRoot,
          branch: sourceBinding.branch,
          baseCommit: managerBaseCommit,
          round: 0,
          startingCommit: managerBaseCommit,
        },
        idempotencyKey: "T6519-rebased-qualification-source",
        timeoutMs: 600_000,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: "c".repeat(64),
        catalogHash: "d".repeat(64),
        expectedChild: sourceExpectedChild,
        gitEffectBinding: sourceBinding,
      },
      {
        mode: "manager-bound",
        now: clock.now,
        randomBytes: sequentialDispatchRandomBytes(6520),
        lineageFenceGuard: async () => null,
        withLineageLock: async (operation) => await operation(),
      },
    );
    if (!sourcePrepared.accepted) throw new Error(sourcePrepared.detail);
    await fetchDispatchInputOn(
      backend,
      {
        ...sourcePrepared.prepared,
        namespace,
        inputCapability: sourcePrepared.prepared.inputCapability,
      },
      { now: clock.now },
    );
    const sourceStaged = await storeDispatchResultOn(
      backend,
      {
        resultCapability: sourcePrepared.prepared.resultCapability,
        output: {
          taskId: "T6519",
          status: "pass",
          resultCommit: sourceResultCommit,
          branch: sourceBinding.branch,
          actualWorktreePath: repositoryRoot,
          filesTouched: ["candidate.ts"],
          gitReceipts: [],
          checkSummary: "focused check passed",
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit: managerBaseCommit,
            headCommit: sourceResultCommit,
          },
          summary: "stale source staged",
        },
      },
      { now: clock.now },
    );
    if (sourceStaged.state !== "gate-pending") throw new Error("source did not stage");
    const queue = new ImplementationCandidateQueueAdapter({
      backend,
      actor: "trusted-extension",
      now: clock.now,
    });
    const sourceQualified = await queue.qualifyNativeCompletion({
      candidate: {
        attestationId: sourcePrepared.prepared.attestationId,
        generation: sourcePrepared.prepared.generation,
        repositoryId: sourceBinding.repositoryId,
        integrationRef: "refs/heads/main",
        authority: {
          taskId: "T6519",
          goalRef: "goals:G211",
          finalizedManifestDigest: taskEvidence.finalizedManifestDigest,
        },
        observedBaseCommit: managerBaseCommit,
        resultCommit: sourceResultCommit,
        resultTree: sourceResultTree,
        gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
        packagedEnvironmentDigest: "f".repeat(64),
        gitReceipts: [],
        gitEffectBinding: sourceBinding,
        stagedOutputDigest: sourceStaged.result.outputDigest,
      },
      expectedChild: sourceExpectedChild,
      expectedProvenance: provenanceBindingOf(sourcePrepared.prepared),
      nativeCompletion: {
        kind: "native-completion",
        actor: "trusted-extension",
        childId: sourceExpectedChild.childId,
        runId: sourceExpectedChild.runId,
        completedAt: clock.now(),
      },
    });
    const acquired = await queue.acquire({
      partitionKey: sourceQualified.queue.partition.partitionKey,
      holderId: "T6519-rebased-qualification-coordinator",
    });
    if (acquired.state !== "leased") throw new Error("source did not lease");
    await queue.retireStagedRebaseSource({
      ...acquired.lease,
      expectedPartitionRevision: acquired.partitionRevision,
      stagedOutputDigest: sourceStaged.result.outputDigest,
      effectLock: {
        kind: "managed-worktree-effect-lock",
        bindingDigest: dispatchPayloadDigest(sourceBinding as unknown as DispatchJSONValue),
      },
      live: {
        clean: true,
        liveTip: sourceResultCommit,
        resultCommit: sourceResultCommit,
        resultTree: sourceResultTree,
        repositoryId: sourceBinding.repositoryId,
        worktreePath: repositoryRoot,
        gitReceipts: [],
      },
      ontoCommit: rebasedStartCommit,
      guardedRebase,
      guardedRebaseJournalDigest: "7".repeat(64),
    });

    const correlationId = "rebased-candidate-correlation-0123456789abcdef";
    const expectedChild = {
      childId: `implement-worker#${correlationId}`,
      runId: "parent-run-T6519-rebased",
    };
    const binding: DispatchGitEffectBinding = {
      ...sourceBinding,
      guardedRebaseBridge: {
        guardedRebase,
        operationId: "T6519-rebased-qualification",
        requestDigest: "7".repeat(64),
        oldResultCommit: sourceResultCommit,
        ontoCommit: rebasedStartCommit,
        rebasedStartCommit,
        outcome: "clean",
        exactTip: true,
        finalizedAt: clock.now(),
      },
    };
    const prepared = await prepareDispatchOn(
      backend,
      {
        namespace,
        roleId: "implement-worker",
        surface: "codex",
        input: {
          taskId: "T6519",
          headline: "Queue a rebased native completion",
          description: "Retain manager identity while observing the rebased execution base.",
          acceptance: "The qualified attempt records the guarded-rebase onto commit.",
          worktreePath: repositoryRoot,
          branch: binding.branch,
          baseCommit: rebasedStartCommit,
          round: 1,
          startingCommit: rebasedStartCommit,
          priorResultCommit: sourceResultCommit,
          guardedRebaseLineage: {
            guardedRebase,
            oldResultCommit: sourceResultCommit,
            ontoCommit: rebasedStartCommit,
            rebasedStartCommit,
            exactTip: true,
          },
        },
        idempotencyKey: "T6519-rebased-qualification",
        timeoutMs: 600_000,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: "a".repeat(64),
        catalogHash: "b".repeat(64),
        expectedChild,
        gitEffectBinding: binding,
        reprepareOf: sourcePrepared.handle,
      },
      {
        mode: "manager-bound",
        now: clock.now,
        randomBytes: sequentialDispatchRandomBytes(6520),
        lineageFenceGuard: async () => null,
        withLineageLock: async (operation) => await operation(),
      },
    );
    if (!prepared.accepted) throw new Error(prepared.detail);
    await fetchDispatchInputOn(
      backend,
      { ...prepared.prepared, namespace, inputCapability: prepared.prepared.inputCapability },
      { now: clock.now },
    );
    const staged = await storeDispatchResultOn(
      backend,
      {
        resultCapability: prepared.prepared.resultCapability,
        output: {
          taskId: "T6519",
          status: "pass",
          resultCommit: rebasedStartCommit,
          branch: binding.branch,
          actualWorktreePath: repositoryRoot,
          filesTouched: [],
          gitReceipts: [],
          gitLineage: {
            kind: "guarded-rebase",
            guardedRebase,
            ontoCommit: rebasedStartCommit,
            rebasedStartCommit,
            exactTip: true,
          },
          checkSummary: "focused check passed",
          baseVerification: {
            status: "verified",
            relation: "equal",
            baseCommit: rebasedStartCommit,
            headCommit: rebasedStartCommit,
          },
          summary: "rebased candidate staged",
        },
      },
      { now: clock.now },
    );
    expect(staged.state).toBe("gate-pending");
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: {} as PromptArtifactStore,
      ledgerStore,
      now: clock.now,
    });

    const qualified = await capability.qualifyImplementationCandidate!({
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      roleId: "implement-worker",
      correlationId,
      childThreadId: "child-thread-T6519-rebased",
      outcome: "completed",
      exitStatus: 0,
      observedAt: clock.now(),
      promptDigest: "a".repeat(64),
    });

    expect(qualified.state).toBe("queued");
    const row = backend
      .storedRows()
      .find(
        (candidate) =>
          candidate.attestationId === prepared.prepared.attestationId &&
          candidate.generation === prepared.prepared.generation,
      );
    expect(row.gitEffectBinding).toMatchObject({
      baseCommit: managerBaseCommit,
      guardedRebaseBridge: { ontoCommit: rebasedStartCommit },
    });
    expect(row.implementationQueue).toMatchObject({
      state: "qualified",
      attempt: { observedBaseCommit: rebasedStartCommit },
    });
  });
});
