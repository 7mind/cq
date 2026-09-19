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
  ImplementationEvidenceService,
  PLAN_FINALIZED_MANIFEST_FIELD,
  createAttestationStoreForConstruction,
  createInMemoryImplementationEvidenceStore,
  createInMemoryWorksetStore,
  implementationCompletionMergeAdmissionProviderFromStore,
  prepareManagedWorktree,
  resolveSingleProjectAttestationNamespace,
  type LedgerStore,
  type ImplementationReviewerIdentity,
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
const CAPSTONE_MANIFEST = JSON.stringify({
  revision: 1,
  milestones: [{ key: "queue", id: "M6521" }],
  tasks: [{ key: "capstone", id: "T6521" }],
});

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
  const workset = createInMemoryWorksetStore();
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
    worksetStore: () => workset,
    fetchItem: (ledgerId: string) =>
      ledgerId === "tasks"
        ? task
        : {
            fields: {
              [PLAN_FINALIZED_MANIFEST_FIELD]: CAPSTONE_MANIFEST,
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

  test("yields a deterministic-red front, advances its successor, and resumes one corrected gate", async () => {
    const backend = new InMemoryAttestationBackend(
      new InMemoryAttestationStore({ ...namespace, projectKey: "implementation-queue-correction" }),
    );
    const fixture = new ImplementationCandidateQueueFixture(backend);
    const partition = {
      repositoryId: "f".repeat(64),
      integrationRef: "refs/heads/main",
      goalRef: "goals:G213",
      finalizedManifestDigest: "e".repeat(64),
    };
    const first = await fixture.stage({ taskId: "T6523", ...partition });
    const firstQualified = await fixture.adapter.qualifyNativeCompletion({
      candidate: first.candidate,
      ...first.qualification,
    });
    const second = await fixture.stage({ taskId: "T6524", ...partition });
    await fixture.adapter.qualifyNativeCompletion({
      candidate: second.candidate,
      ...second.qualification,
    });
    const firstLease = await fixture.adapter.acquire({
      partitionKey: firstQualified.queue.partition.partitionKey,
      holderId: "capstone-red-front",
    });
    if (firstLease.state !== "leased") throw new Error("expected deterministic-red front lease");
    const yielded = await fixture.adapter.applyHeadOfLineDisposition({
      disposition: "deterministic-red",
      lease: firstLease.lease,
      expectedPartitionRevision: firstLease.partitionRevision,
      detail: { failureIdentity: "packages/ledger-mcp/test/capstone.test.ts:correction" },
    });
    if (!("partition" in yielded)) throw new Error("expected a yielded queue control");
    const escaped = await fixture.adapter.acquire({
      partitionKey: firstQualified.queue.partition.partitionKey,
      holderId: "capstone-next-front",
    });
    if (escaped.state !== "leased") throw new Error("expected the next eligible lease");
    expect(escaped.lease).toMatchObject({
      attestationId: second.prepared.attestationId,
      generation: second.prepared.generation,
    });
    const released = await fixture.adapter.release({
      ...escaped.lease,
      expectedPartitionRevision: escaped.partitionRevision,
      detail: { disposition: "gate-complete" },
    });
    const resumed = await fixture.adapter.applyHeadOfLineDisposition({
      disposition: "resume",
      lease: firstLease.lease,
      expectedPartitionRevision: released.partitionRevision,
      detail: { disposition: "corrected" },
    });
    let correctionGateCount = 0;
    let completionCount = 0;
    const coordinator = new ImplementationCandidateCoordinator(fixture.adapter, {
      observeProtectedHead: async (control) => control.attempt.observedBaseCommit,
      finalizeQualifiedFront: async ({ lease }) => {
        correctionGateCount += 1;
        expect(lease.leaseGeneration).toBe(firstLease.lease.leaseGeneration + 1);
      },
      confirmQualifiedFront: async ({ lease, control }) => {
        completionCount += 1;
        await fixture.adapter.release({
          ...lease,
          expectedPartitionRevision: control.partitionRevision,
          detail: { disposition: "gate-complete" },
        });
      },
      retireStaleSource: async () => {
        throw new Error("a corrected current front must not retire");
      },
      rebaseRetiredSource: async () => {
        throw new Error("a corrected current front must not rebase");
      },
      prepareSuccessor: async () => {
        throw new Error("a corrected current front must not prepare another successor");
      },
    });
    expect(
      await coordinator.run({
        partitionKey: firstQualified.queue.partition.partitionKey,
        holderId: "capstone-corrected-front",
      }),
    ).toMatchObject({
      state: "completed",
      handle: {
        attestationId: first.prepared.attestationId,
        generation: first.prepared.generation,
      },
    });
    expect({
      deterministicRed: yielded.state === "yielded" ? 1 : 0,
      headOfLineEscape: escaped.lease.attestationId === second.prepared.attestationId ? 1 : 0,
      resume: resumed.state === "qualified" ? 1 : 0,
      correctionGate: correctionGateCount,
      completion: completionCount,
    }).toEqual({
      deterministicRed: 1,
      headOfLineEscape: 1,
      resume: 1,
      correctionGate: 1,
      completion: 1,
    });
  });

  test("composes local XDG rollout through public qualification, acquisition, gate, and completion exactly once [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t6521-capstone-repository-"));
    const stateHome = await mkdtemp(path.join(tmpdir(), "t6521-capstone-state-"));
    let runtime: Awaited<ReturnType<typeof createSingleProjectDispatchRuntime>> | undefined;
    let successorHandle:
      { readonly attestationId: string; readonly generation: number } | undefined;
    let successorResultCommit: string | undefined;
    let successorInput: Readonly<Record<string, unknown>> | undefined;
    let successorOutput: Readonly<Record<string, unknown>> | undefined;
    let successorQualifications = 0;
    let successorAdmissions = 0;
    try {
      const projectId = `capstone-${crypto.randomUUID()}`;
      await writeFile(
        path.join(repositoryRoot, "cq.toml"),
        `[ledger]\nbackend = "xdg"\nprojectId = "${projectId}"\n`,
      );
      git(repositoryRoot, "init", "-q", "-b", "main");
      git(repositoryRoot, "config", "user.name", "T6521");
      git(repositoryRoot, "config", "user.email", "t6521@example.invalid");
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
          description: "Run rollout, qualification, coordination, gate, and completion.",
          acceptance: "One exact accepted attempt reaches consumption through the public runtime.",
          worktreePath: managed.handle.absolutePath,
          branch: managed.handle.branch,
          baseCommit,
          round: 0,
          startingCommit: baseCommit,
          validationIntent: "final",
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
      const implementationSuccessorLauncher: NonNullable<
        Parameters<typeof createSingleProjectDispatchRuntime>[0]["implementationSuccessorLauncher"]
      > = async ({ prepared: successorPrepared, managed: successorManaged, expectedChild }) => {
        if (runtime === undefined || runtime.kind === "unavailable") {
          throw new Error("successor launcher has no local runtime");
        }
        const materialized = await runtime.capability.fetchInput({
          attestationId: successorPrepared.attestationId,
          generation: successorPrepared.generation,
          inputCapability: successorPrepared.inputCapability,
        });
        if (materialized.state !== "input-materialized") {
          throw new Error("successor input did not materialize");
        }
        const input = materialized.input as Readonly<Record<string, unknown>>;
        const lineage = input["guardedRebaseLineage"] as
          Readonly<Record<string, unknown>> | undefined;
        const baseCommit = input["baseCommit"];
        const resultCommit = input["startingCommit"];
        if (
          typeof baseCommit !== "string" ||
          typeof resultCommit !== "string" ||
          lineage === undefined ||
          typeof lineage["guardedRebase"] !== "string" ||
          typeof lineage["ontoCommit"] !== "string" ||
          typeof lineage["rebasedStartCommit"] !== "string" ||
          typeof lineage["exactTip"] !== "boolean"
        ) {
          throw new Error("successor lineage was not server-materialized");
        }
        const filesTouched = git(
          successorManaged.worktreePath,
          "diff",
          "--name-only",
          `${baseCommit}..${resultCommit}`,
        )
          .split("\n")
          .filter((entry) => entry.length > 0);
        const output = {
          taskId,
          status: "pass",
          resultCommit,
          branch: successorManaged.branch,
          actualWorktreePath: successorManaged.worktreePath,
          filesTouched,
          gitReceipts: [],
          gitLineage: {
            kind: "guarded-rebase",
            guardedRebase: lineage["guardedRebase"],
            ontoCommit: lineage["ontoCommit"],
            rebasedStartCommit: lineage["rebasedStartCommit"],
            exactTip: lineage["exactTip"],
          },
          checkSummary: "exact post-rebase capstone checks passed",
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit,
            headCommit: resultCommit,
          },
          summary: "guarded-rebase successor retained the exact rebased tip",
        } as const;
        expect(
          await runtime.capability.storeResult({
            resultCapability: successorPrepared.resultCapability,
            output,
          }),
        ).toMatchObject({ state: "gate-pending" });
        if (
          runtime.capability.qualifyImplementationCandidate === undefined ||
          runtime.capability.coordinateImplementationCandidate === undefined
        ) {
          throw new Error("successor queue execution is unavailable");
        }
        const correlationId = expectedChild.childId.slice("implement-worker#".length);
        const qualifiedSuccessor = await runtime.capability.qualifyImplementationCandidate({
          attestationId: successorPrepared.attestationId,
          generation: successorPrepared.generation,
          roleId: "implement-worker",
          correlationId,
          childThreadId: "capstone-successor-thread",
          expectedRunId: expectedChild.runId,
          outcome: "completed",
          exitStatus: 0,
          observedAt: new Date().toISOString(),
          promptDigest: successorPrepared.promptProvenance.promptDigest,
        });
        if (qualifiedSuccessor.state !== "queued") {
          throw new Error("successor did not qualify");
        }
        successorQualifications += 1;
        const completedSuccessor = await runtime.capability.coordinateImplementationCandidate({
          partitionKey: qualifiedSuccessor.partitionKey,
          holderId: "capstone-successor-holder",
        });
        if (completedSuccessor.state !== "completed") {
          throw new Error(`successor did not complete: ${JSON.stringify(completedSuccessor)}`);
        }
        successorAdmissions += 1;
        successorHandle = {
          attestationId: successorPrepared.attestationId,
          generation: successorPrepared.generation,
        };
        successorResultCommit = resultCommit;
        successorInput = input;
        successorOutput = output;
      };
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
        implementationSuccessorLauncher,
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
      const initialEnqueue = runtime.implementationQueueRollout?.adoptedUnqualified;
      await writeFile(path.join(repositoryRoot, "protected.txt"), "protected advance\n");
      git(repositoryRoot, "add", "protected.txt");
      git(repositoryRoot, "commit", "-q", "-m", "advance protected head");
      const protectedHead = git(repositoryRoot, "rev-parse", "HEAD");
      const retired = await runtime.capability.coordinateImplementationCandidate({
        partitionKey: qualified.partitionKey,
        holderId: "capstone-holder",
      });
      expect(retired).toMatchObject({
        state: "successor-queued",
        source: {
          attestationId: prepared.prepared.attestationId,
          generation: prepared.prepared.generation,
        },
        successor: {
          attestationId: prepared.prepared.attestationId,
          generation: prepared.prepared.generation + 1,
        },
      });
      if (
        successorHandle === undefined ||
        successorResultCommit === undefined ||
        successorInput === undefined ||
        successorOutput === undefined
      ) {
        throw new Error("stale coordination did not run its guarded successor");
      }
      const resolvedSuccessorHandle = successorHandle;
      const resolvedSuccessorResultCommit = successorResultCommit;
      const resolvedSuccessorInput = successorInput;
      expect(gateRunner.requests).toHaveLength(1);
      await runtime.close();
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
      const restartedRuntime = runtime;
      const delivered = await restartedRuntime.capability.fetch(resolvedSuccessorHandle);
      if (
        delivered.state !== "consumed" ||
        delivered.output === null ||
        typeof delivered.output !== "object" ||
        Array.isArray(delivered.output)
      ) {
        throw new Error("successor output was not delivered after restart");
      }
      const deliveredOutput = delivered.output as Readonly<Record<string, unknown>>;
      expect(deliveredOutput).toMatchObject({
        status: "pass",
        resultCommit: resolvedSuccessorResultCommit,
        supervisedGateEvidence: {
          resultCommit: resolvedSuccessorResultCommit,
          failCount: 0,
        },
      });
      expect(await restartedRuntime.capability.fetch(resolvedSuccessorHandle)).toMatchObject({
        state: "output-already-materialized",
      });
      expect(
        await restartedRuntime.capability.fetch({
          attestationId: prepared.prepared.attestationId,
          generation: prepared.prepared.generation,
        }),
      ).toMatchObject({ state: "aborted", reason: "staged-rebase" });
      if (
        restartedRuntime.capability.resolveImplementationCandidateAuthority === undefined ||
        restartedRuntime.capability.reserveImplementationCandidateAuthority === undefined ||
        restartedRuntime.capability.releaseImplementationCandidateAuthority === undefined
      ) {
        throw new Error("local candidate authority is unavailable");
      }
      let rejectedEvidence = 0;
      await expect(
        restartedRuntime.capability.resolveImplementationCandidateAuthority({
          workerDispatch: {
            attestationId: prepared.prepared.attestationId,
            generation: prepared.prepared.generation,
          },
          taskRef: `tasks:${taskId}`,
          resultCommit: receipt.newHead,
        }),
      ).rejects.toThrow();
      rejectedEvidence += 1;
      await expect(
        restartedRuntime.capability.resolveImplementationCandidateAuthority({
          workerDispatch: resolvedSuccessorHandle,
          taskRef: `tasks:${taskId}`,
          resultCommit: baseCommit,
        }),
      ).rejects.toThrow();
      rejectedEvidence += 1;
      const authority = await restartedRuntime.capability.resolveImplementationCandidateAuthority({
        workerDispatch: resolvedSuccessorHandle,
        taskRef: `tasks:${taskId}`,
        resultCommit: resolvedSuccessorResultCommit,
      });
      expect(authority).toMatchObject({
        kind: "cq-implementation-candidate-authority",
        workerDispatch: resolvedSuccessorHandle,
        taskRef: `tasks:${taskId}`,
        resultCommit: resolvedSuccessorResultCommit,
      });

      const reviewer: ImplementationReviewerIdentity = {
        alias: "native",
        harness: "codex",
        model: "frontier",
        provider: null,
        launch: "native",
        adapterId: "codex:native",
      };
      const reviewedDispatches = new Set<string>();
      let completionWrites = 0;
      const evidence = new ImplementationEvidenceService({
        store: implementationEvidenceStore,
        resolveReviewerRoster: () => [reviewer],
        nativeFallback: reviewer,
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
        fetchNativeReview: async (dispatch) => {
          reviewedDispatches.add(dispatch.attestationId);
          return {
            state: "consumed" as const,
            retainedAttestation: dispatch.attestationId,
            output: {
              taskId,
              verdict: "approve",
              criticism: [],
              questions: [],
              defects: [],
              rationale: "exact guarded successor is current",
              gateReRan: false,
              gateDurationMs: 0,
              resultCommitVerified: true,
              resultCommitEvidence: {
                status: "verified",
                resultCommit: resolvedSuccessorResultCommit,
                branchTip: resolvedSuccessorResultCommit,
              },
              baseAncestry: {
                status: "verified",
                relation: "descendant",
                baseCommit: protectedHead,
                resultCommit: resolvedSuccessorResultCommit,
                mergeBase: protectedHead,
              },
            },
          };
        },
        executeExternalReview: async () => {
          throw new Error("external review is not configured");
        },
        fetchWorker: async () => ({
          state: "consumed" as const,
          input: resolvedSuccessorInput as never,
          output: delivered.output,
        }),
        resolveCandidateAuthority: async (input) =>
          await restartedRuntime.capability.resolveImplementationCandidateAuthority!(input),
        releaseCandidateAuthority: async (candidate, binding) =>
          await restartedRuntime.capability.releaseImplementationCandidateAuthority!(
            candidate,
            binding,
          ),
        readTaskAuthority: async () => ({
          taskRef: `tasks:${taskId}`,
          ownerGoalRef: "goals:G213",
          status: "wip",
          finalizedManifest: CAPSTONE_MANIFEST,
        }),
        repositoryHead: async () => git(repositoryRoot, "rev-parse", "HEAD"),
        verifyImplementation: async () => ({
          baseCommit: protectedHead,
          startingCommit: resolvedSuccessorResultCommit,
          clean: true,
          ancestryVerified: true,
          receiptsVerified: true,
          acceptanceVerified: true,
          gateVerified: true,
          details: { guardedSuccessor: true },
        }),
        recordLedgerCompletion: async () => {
          completionWrites += 1;
          return { reviewRef: "reviews:R6521" };
        },
      });
      const panel = await evidence.prepareReviewPanel({
        taskRef: `tasks:${taskId}`,
        resultCommit: resolvedSuccessorResultCommit,
        workerDispatch: resolvedSuccessorHandle,
        operationId: "capstone-review-panel",
        author: "parent",
      });
      const attemptRef = panel.attemptRefs[0]!;
      await evidence.prepareReviewAttempt({
        panelRef: panel.panelRef,
        attemptRef,
        operationId: "capstone-review-attempt",
        author: "parent",
      });
      await evidence.finalizeReviewAttempt({
        attemptRef,
        operationId: "capstone-review-finalize",
        author: "parent",
      });
      const completion = await evidence.prepareCompletion({
        taskRef: `tasks:${taskId}`,
        expectedRepositoryHead: protectedHead,
        resultCommit: resolvedSuccessorResultCommit,
        workerDispatch: resolvedSuccessorHandle,
        reviewAttemptRefs: [attemptRef],
        completion: "guarded successor reviewed",
        logPaths: [],
        mergeOperationId: "capstone-ff-merge",
        operationId: "capstone-completion",
        author: "parent",
      });
      const mergeProvider = await implementationCompletionMergeAdmissionProviderFromStore({
        provider: {
          acquire: async (input) => ({
            id: "capstone-merge-admission",
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
        store: implementationEvidenceStore,
        binding: {
          kind: "merge",
          targetRef: `tasks:${taskId}`,
          repositoryRoot,
          commit: resolvedSuccessorResultCommit,
          completionRef: completion.completionRef,
          mergeOperationId: "capstone-ff-merge",
        },
        repositoryHead: async () => git(repositoryRoot, "rev-parse", "HEAD"),
        authorizeCandidate: async (candidate) => {
          await restartedRuntime.capability.resolveImplementationCandidateAuthority!({
            workerDispatch: candidate.workerDispatch,
            taskRef: candidate.taskRef,
            resultCommit: candidate.resultCommit,
          });
        },
        reserveCandidate: async (candidate, binding) =>
          await restartedRuntime.capability.reserveImplementationCandidateAuthority!(
            candidate,
            binding,
          ),
      });
      const admission = await mergeProvider.acquire({
        kind: "merge",
        targetRef: `tasks:${taskId}`,
      });
      await admission.registerProcessGroup({ pgid: 6521, leaderPid: 6521 });
      await admission.shareWithGuardian({ pgid: 6521, leaderPid: 6521 });
      git(repositoryRoot, "merge", "--ff-only", resolvedSuccessorResultCommit);
      await admission.markSettled();
      await admission.releaseAfterSettlement();
      expect(
        await evidence.recordCompletion({
          taskRef: `tasks:${taskId}`,
          expectedRepositoryHead: resolvedSuccessorResultCommit,
          operationId: "capstone-record-completion",
          author: "parent",
        }),
      ).toMatchObject({ status: "recorded" });
      expect(
        await evidence.recordCompletion({
          taskRef: `tasks:${taskId}`,
          expectedRepositoryHead: resolvedSuccessorResultCommit,
          operationId: "capstone-record-completion-replay",
          author: "parent",
        }),
      ).toMatchObject({ status: "existing" });
      const inspected = await createAttestationStoreForConstruction({
        backend: "xdg",
        namespace: durableNamespace,
        env: environment,
      });
      const rows = await inspected.transact({ kind: "namespace" }, (store) => store.rows());
      await inspected.close();
      const source = rows.find(
        (row) =>
          row.attestationId === prepared.prepared.attestationId &&
          row.generation === prepared.prepared.generation,
      );
      const successor = rows.find(
        (row) =>
          row.attestationId === resolvedSuccessorHandle.attestationId &&
          row.generation === resolvedSuccessorHandle.generation,
      );
      expect(source).toMatchObject({
        state: "aborted",
        implementationQueue: { state: "staged-rebase-retired" },
      });
      expect(successor).toMatchObject({
        state: "consumed",
        implementationQueue: { state: "released", terminal: { reason: "gate-complete" } },
      });
      expect({
        enqueue: rows.filter((row) => row.implementationQueue !== undefined).length,
        qualification: (qualified.state === "queued" ? 1 : 0) + successorQualifications,
        admission: 1 + successorAdmissions,
        retirement: source?.implementationQueue?.state === "staged-rebase-retired" ? 1 : 0,
        rebase: source?.implementationQueue?.stagedRebaseSource === undefined ? 0 : 1,
        gate: gateRunner.requests.length,
        review: reviewedDispatches.size,
        preservation: typeof deliveredOutput["supervisedGateEvidence"] === "object" ? 1 : 0,
        rejection: rejectedEvidence,
        merge: git(repositoryRoot, "rev-parse", "HEAD") === resolvedSuccessorResultCommit ? 1 : 0,
        completion: completionWrites,
        delivery: delivered.state === "consumed" ? 1 : 0,
        eagerSourceGate: gateRunner.requests.length - successorAdmissions,
        postFfGate: gateRunner.requests.length - 1,
        rolloutEnqueue: initialEnqueue,
      }).toEqual({
        enqueue: 2,
        qualification: 2,
        admission: 2,
        retirement: 1,
        rebase: 1,
        gate: 1,
        review: 1,
        preservation: 1,
        rejection: 2,
        merge: 1,
        completion: 1,
        delivery: 1,
        eagerSourceGate: 0,
        postFfGate: 0,
        rolloutEnqueue: 1,
      });
    } finally {
      await runtime?.close().catch(() => undefined);
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(stateHome, { recursive: true, force: true });
    }
  });
});
