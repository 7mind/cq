import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  type PromptSurface,
} from "@cq/config";
import {
  ImplementationCandidateCoordinator,
  type ImplementationCandidateCoordinatorOperations,
} from "../src/implementationCandidateQueue.js";
import {
  PLAN_FINALIZED_MANIFEST_FIELD,
  createAttestationStoreForConstruction,
  createInMemoryImplementationEvidenceStore,
  prepareManagedWorktree,
  resolveSingleProjectAttestationNamespace,
  type LedgerStore,
  type SupervisedWorkerGateRunRequest,
  type SupervisedWorkerGateRunResult,
  type SupervisedWorkerGateRunner,
} from "@cq/ledger";
import {
  createDispatchCapability,
  createSingleProjectDispatchRuntime,
} from "../src/dispatchCapability.js";
import type {
  PromptArtifactRoleMetadata,
  PromptArtifactStore,
} from "../src/promptArtifactStore.js";
import { ImplementationCandidateQueueFixture } from "./implementationCandidateQueueFixture.js";

const namespace = { backend: "xdg" as const, projectKey: "implementation-queue-capstone" };

function artifactStore(surface: PromptSurface): PromptArtifactStore {
  const metadata: PromptArtifactRoleMetadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent",
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: surface,
    promptDigest: "a".repeat(64),
    schemaVersion: 1,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: surface,
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

function taskStore(taskId: string): LedgerStore {
  const task = {
    id: taskId,
    milestoneId: "M6521",
    status: "wip",
    fields: {
      headline: "Compose the canonical implementation queue",
      description: "Run rollout, qualification, coordination, gate, and completion.",
      acceptance: "One exact accepted attempt reaches consumption through the public runtime.",
      ledgerRefs: ["goals:G213"],
      worksetOwnerRef: "goals:G213",
      worksetOwnerEdgeKind: "active-current-draft",
    },
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
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
                milestones: [{ key: "queue", id: "M6521" }],
                tasks: [{ key: "capstone", id: taskId }],
              }),
            },
          },
  } as unknown as LedgerStore;
}

function git(repositoryRoot: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repositoryRoot, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T6521",
      GIT_AUTHOR_EMAIL: "t6521@example.invalid",
      GIT_COMMITTER_NAME: "T6521",
      GIT_COMMITTER_EMAIL: "t6521@example.invalid",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

class CapstoneGateRunner implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    return {
      gateExitCode: 0,
      passCount: 1,
      failCount: 0,
      gateDurationMs: 1,
      capturedAt: new Date().toISOString(),
      outputTail: "1 pass\n0 fail",
    };
  }
}

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

  test("composes local XDG rollout through public qualification, acquisition, gate, and completion exactly once [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t6521-capstone-repository-"));
    const stateHome = await mkdtemp(path.join(tmpdir(), "t6521-capstone-state-"));
    let runtime: Awaited<ReturnType<typeof createSingleProjectDispatchRuntime>> | undefined;
    try {
      const projectId = `capstone-${crypto.randomUUID()}`;
      await writeFile(
        path.join(repositoryRoot, "cq.toml"),
        `[ledger]\nbackend = "xdg"\nprojectId = "${projectId}"\n`,
      );
      git(repositoryRoot, "init", "-q", "-b", "main");
      await writeFile(path.join(repositoryRoot, "base.txt"), "base\n");
      git(repositoryRoot, "add", "base.txt");
      git(repositoryRoot, "commit", "-q", "-m", "seed capstone");
      const baseCommit = git(repositoryRoot, "rev-parse", "HEAD");
      const taskId = "T6521";
      const managed = await prepareManagedWorktree(
        { repositoryRoot, taskId, baseCommit },
        { skipInstall: true, bunWorkspaceRoot: repositoryRoot },
      );
      if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
      const ledgerStore = taskStore(taskId);
      const implementationEvidenceStore = createInMemoryImplementationEvidenceStore();
      const environment = { XDG_STATE_HOME: stateHome };
      const durableNamespace = await resolveSingleProjectAttestationNamespace({
        construction: "direct",
        backend: "xdg",
        repoRoot: repositoryRoot,
        projectId,
      });
      const seedBackend = await createAttestationStoreForConstruction({
        backend: "xdg",
        namespace: durableNamespace,
        env: environment,
      });
      const startedAt = new Date().toISOString();
      const seed = createDispatchCapability({
        backend: seedBackend,
        promptArtifactStore: artifactStore("codex"),
        repositoryRoot,
        ledgerStore,
        implementationEvidenceStore,
        now: () => startedAt,
      });
      const expectedChild = {
        childId: "implement-worker#capstone",
        runId: "capstone-run",
      };
      const prepared = await seed.prepare({
        roleId: "implement-worker",
        input: {
          taskId,
          headline: "Compose the canonical implementation queue",
          description: "Run the complete local queue path through public operations.",
          acceptance: "One exact accepted attempt reaches durable consumption.",
          worktreePath: managed.handle.absolutePath,
          branch: managed.handle.branch,
          baseCommit,
          round: 0,
          startingCommit: baseCommit,
        },
        idempotencyKey: "T6521-capstone-public-flow",
        timeoutMs: 600_000,
        expectedChild,
      });
      if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
        throw new Error("capstone worker prepare was rejected");
      }
      await seed.fetchInput({
        attestationId: prepared.prepared.attestationId,
        generation: prepared.prepared.generation,
        inputCapability: prepared.prepared.inputCapability,
      });
      const candidateBody = "candidate\n";
      await writeFile(path.join(managed.handle.absolutePath, "candidate.txt"), candidateBody);
      if (seed.gitCommit === undefined) throw new Error("capstone Git broker is unavailable");
      const receipt = await seed.gitCommit({
        attestationId: prepared.prepared.attestationId,
        generation: prepared.prepared.generation,
        gitChangeCapability: prepared.prepared.gitChangeCapability,
        operationId: "T6521-capstone-result",
        expectedHead: baseCommit,
        message: "stage capstone candidate",
        changes: [
          {
            kind: "add",
            path: "candidate.txt",
            newState: {
              mode: "100644",
              digest: createHash("sha256").update(candidateBody).digest("hex"),
            },
          },
        ],
      });
      expect(
        await seed.storeResult({
          resultCapability: prepared.prepared.resultCapability,
          output: {
            taskId,
            status: "pass",
            resultCommit: receipt.newHead,
            branch: managed.handle.branch,
            actualWorktreePath: managed.handle.absolutePath,
            filesTouched: [...receipt.paths],
            gitReceipts: [
              { ...receipt, objectOids: [...receipt.objectOids], paths: [...receipt.paths] },
            ],
            checkSummary: "focused capstone checks passed",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit,
              headCommit: receipt.newHead,
            },
            summary: "capstone staged result",
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      await seedBackend.close();

      const gateRunner = new CapstoneGateRunner();
      runtime = await createSingleProjectDispatchRuntime({
        construction: "direct",
        resolved: {
          store: ledgerStore,
          implementationEvidenceStore,
          configRoot: repositoryRoot,
          backend: "xdg",
          branch: "cq-ledger",
          projectKey: projectId,
        },
        promptArtifactStore: artifactStore("codex"),
        environment,
        supervisedWorkerGateRunner: gateRunner,
      });
      if (runtime.kind === "unavailable") throw new Error(runtime.reason);
      if (
        runtime.capability.qualifyImplementationCandidate === undefined ||
        runtime.capability.coordinateImplementationCandidate === undefined
      ) {
        throw new Error("local XDG queue executor is unavailable");
      }
      const qualified = await runtime.capability.qualifyImplementationCandidate({
        attestationId: prepared.prepared.attestationId,
        generation: prepared.prepared.generation,
        roleId: "implement-worker",
        correlationId: "capstone",
        childThreadId: "capstone-thread",
        expectedRunId: expectedChild.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt: new Date().toISOString(),
        promptDigest: prepared.prepared.promptProvenance.promptDigest,
      });
      if (qualified.state !== "queued") {
        throw new Error(`capstone qualification failed: ${JSON.stringify(qualified)}`);
      }
      const completed = await runtime.capability.coordinateImplementationCandidate({
        partitionKey: qualified.partitionKey,
        holderId: "capstone-holder",
      });
      const replay = await runtime.capability.coordinateImplementationCandidate({
        partitionKey: qualified.partitionKey,
        holderId: "capstone-holder",
      });
      const fetched = await runtime.capability.fetch({
        attestationId: prepared.prepared.attestationId,
        generation: prepared.prepared.generation,
      });
      expect(completed).toMatchObject({ state: "completed" });
      expect(replay).toMatchObject({ state: "empty" });
      expect(fetched).toMatchObject({
        state: "consumed",
        output: { resultCommit: receipt.newHead, supervisedGateEvidence: { failCount: 0 } },
      });
      expect({
        enqueue: runtime.implementationQueueRollout?.adoptedUnqualified,
        qualification: qualified.state === "queued" ? 1 : 0,
        admission: completed.state === "completed" ? 1 : 0,
        retirement: 0,
        rebase: 0,
        gate: gateRunner.requests.length,
        completion: fetched.state === "consumed" ? 1 : 0,
        duplicateGate: gateRunner.requests.length - 1,
      }).toEqual({
        enqueue: 1,
        qualification: 1,
        admission: 1,
        retirement: 0,
        rebase: 0,
        gate: 1,
        completion: 1,
        duplicateGate: 0,
      });
    } finally {
      await runtime?.close().catch(() => undefined);
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(stateHome, { recursive: true, force: true });
    }
  });
});
