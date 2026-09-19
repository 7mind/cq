import { SQL } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ATTESTATION_TABLE, type PromptSurface } from "@cq/config";
import {
  attestationNamespaceForTrustedHubProject,
  createAttestationStoreForConstruction,
  resolveSingleProjectAttestationNamespace,
  InMemoryLedgerStore,
  LEDGER_TOOL_NAMES,
  PLAN_FINALIZED_MANIFEST_FIELD,
  createInMemoryImplementationEvidenceStore,
  prepareManagedWorktree,
  releaseManagedWorktree,
  type SupervisedWorkerGateRunRequest,
  type SupervisedWorkerGateRunResult,
  type SupervisedWorkerGateRunner,
  type LedgerStore,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import {
  createPostgresHubDispatchRuntime,
  createDispatchCapability,
  createSingleProjectDispatchRuntime,
  refuseDispatchRuntime,
} from "../src/dispatchCapability.js";
import { createLedgerMcpServer } from "../src/main.js";
import type {
  PromptArtifactRoleMetadata,
  PromptArtifactStore,
} from "../src/promptArtifactStore.js";
import { assertDispatchConstructionConformance } from "./dispatchConstructionConformance.js";

const roots: string[] = [];
const PG_URL = process.env["CQ_TEST_PG_URL"];
const livePgTest = PG_URL === undefined ? test.skip : test;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function inMemoryStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

function workerArtifactStore(surface: PromptSurface): PromptArtifactStore {
  const metadataFor = (roleId: string): PromptArtifactRoleMetadata => ({
    roleId,
    roleKind: "dispatched-subagent",
    artifactPath: `roles/${roleId}.md`,
    sidecarSchemaRoleId: roleId,
    promptSurface: surface,
    promptDigest: "a".repeat(64),
    schemaVersion: 1,
  });
  const roles = ["implement-worker", "plan-advance"].map(metadataFor);
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles,
      promptSurface: surface,
      catalogHash: "b".repeat(64),
    }),
    readRole: (roleId) => {
      const metadata = roles.find((role) => role.roleId === roleId);
      if (metadata === undefined) throw new Error(`unexpected role "${roleId}"`);
      return { metadata, bytes: new Uint8Array([1]) };
    },
  };
}

function git(repositoryRoot: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repositoryRoot, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function finalizedTaskStore(taskId: string): LedgerStore {
  const task = {
    id: taskId,
    milestoneId: "M6521",
    status: "wip",
    fields: {
      headline: "Adopt legacy queue candidate",
      description: "Upgrade the staged row before local queue service starts.",
      acceptance: "The staged result is enrolled without invented completion.",
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
                tasks: [{ key: "adopt", id: taskId }],
              }),
            },
          },
  } as unknown as LedgerStore;
}

class CountingGateRunner implements SupervisedWorkerGateRunner {
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

describe("production dispatch runtime construction", () => {
  test("refuses unsupported construction and backend cells before registration", async () => {
    const store = await inMemoryStore();
    const unsupportedBackend: ResolvedLedgerStore = {
      store,
      configRoot: "/must-not-be-resolved",
      backend: "remote",
      branch: "cq-ledger",
    };
    const backendVerdict = await createSingleProjectDispatchRuntime({
      construction: "direct",
      resolved: unsupportedBackend,
    });
    expect(backendVerdict.kind).toBe("unavailable");
    if (backendVerdict.kind === "available") throw new Error("expected refusal");
    expect(backendVerdict.reason).toContain("remote");

    const constructionVerdict = refuseDispatchRuntime("xdg-catalog-hub", "xdg");
    expect(constructionVerdict.kind).toBe("unavailable");
    if (constructionVerdict.kind === "available") throw new Error("expected refusal");
    expect(constructionVerdict.reason).toContain("xdg");
    await store.dispose();
  });

  test("owns and closes the durable xdg attestation backend", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ledger-mcp-dispatch-runtime-"));
    const stateHome = await mkdtemp(path.join(tmpdir(), "ledger-mcp-dispatch-state-"));
    roots.push(root, stateHome);
    await writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nprojectId = "runtime-close-test"\n',
      "utf8",
    );
    const store = await inMemoryStore();
    const resolved: ResolvedLedgerStore = {
      store,
      configRoot: root,
      backend: "xdg",
      branch: "cq-ledger",
      projectKey: "runtime-close-test",
    };
    const runtime = await createSingleProjectDispatchRuntime({
      construction: "direct",
      resolved,
      promptArtifactStore: {
        readManifest: () => {
          throw new Error("fetch does not read the prompt manifest");
        },
        readRole: () => {
          throw new Error("fetch does not read a prompt role");
        },
      },
      environment: { XDG_STATE_HOME: stateHome },
    });
    expect(runtime.kind).toBe("available");
    if (runtime.kind === "unavailable") throw new Error(runtime.reason);
    const handle = { attestationId: `att_${"a".repeat(32)}`, generation: 1 };
    expect(await runtime.capability.fetch(handle)).toMatchObject({
      state: "attestation-not-found",
      ...handle,
    });
    await runtime.close();
    await expect(runtime.capability.fetch(handle)).rejects.toThrow(/closed/i);
    await store.dispose();
  });

  test("upgrades legacy staged rows before exposing the local XDG executor", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "ledger-mcp-rollout-runtime-"));
    const stateHome = await mkdtemp(path.join(tmpdir(), "ledger-mcp-rollout-state-"));
    roots.push(repositoryRoot, stateHome);
    const projectId = `rollout-runtime-${crypto.randomUUID()}`;
    await writeFile(
      path.join(repositoryRoot, "cq.toml"),
      `[ledger]\nbackend = "xdg"\nprojectId = "${projectId}"\n`,
      "utf8",
    );
    git(repositoryRoot, "init", "-q", "-b", "main");
    git(repositoryRoot, "config", "user.name", "T6521");
    git(repositoryRoot, "config", "user.email", "t6521@example.invalid");
    await writeFile(path.join(repositoryRoot, "base.txt"), "base\n");
    git(repositoryRoot, "add", "base.txt");
    git(repositoryRoot, "commit", "-q", "-m", "seed rollout runtime");
    const baseCommit = git(repositoryRoot, "rev-parse", "HEAD");
    const taskId = "T6521";
    const managed = await prepareManagedWorktree(
      { repositoryRoot, taskId, baseCommit },
      { skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
    const ledgerStore = finalizedTaskStore(taskId);
    const implementationEvidenceStore = createInMemoryImplementationEvidenceStore();
    const gateRunner = new CountingGateRunner();
    const rolloutStartedAt = new Date().toISOString();
    const environment = { XDG_STATE_HOME: stateHome };
    const namespace = await resolveSingleProjectAttestationNamespace({
      construction: "direct",
      backend: "xdg",
      repoRoot: repositoryRoot,
      projectId,
    });
    const seedBackend = await createAttestationStoreForConstruction({
      backend: "xdg",
      namespace,
      env: environment,
    });
    const seedCapability = createDispatchCapability({
      backend: seedBackend,
      promptArtifactStore: workerArtifactStore("codex"),
      repositoryRoot,
      ledgerStore,
      implementationEvidenceStore,
      now: () => rolloutStartedAt,
    });
    const prepared = await seedCapability.prepare({
      roleId: "implement-worker",
      input: {
        taskId,
        headline: "Adopt legacy queue candidate",
        description: "Upgrade the staged row before local queue service starts.",
        acceptance: "The staged result is enrolled without invented completion.",
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
        baseCommit,
        round: 0,
        startingCommit: baseCommit,
      },
      idempotencyKey: "T6521-production-rollout",
      timeoutMs: 600_000,
      expectedChild: {
        childId: "implement-worker#production-rollout",
        runId: "production-rollout-run",
      },
    });
    if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
      throw new Error("legacy rollout seed dispatch was rejected");
    }
    await seedCapability.fetchInput({
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      inputCapability: prepared.prepared.inputCapability,
    });
    const candidateBody = "candidate\n";
    await writeFile(path.join(managed.handle.absolutePath, "candidate.txt"), candidateBody);
    const receipt = await seedCapability.gitCommit!({
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      gitChangeCapability: prepared.prepared.gitChangeCapability,
      operationId: "T6521-production-rollout-result",
      expectedHead: baseCommit,
      message: "stage production rollout candidate",
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
    const output = {
      taskId,
      status: "pass",
      resultCommit: receipt.newHead,
      branch: managed.handle.branch,
      actualWorktreePath: managed.handle.absolutePath,
      filesTouched: [...receipt.paths],
      gitReceipts: [{ ...receipt, objectOids: [...receipt.objectOids], paths: [...receipt.paths] }],
      checkSummary: "legacy focused checks passed",
      baseVerification: {
        status: "verified",
        relation: "descendant",
        baseCommit,
        headCommit: receipt.newHead,
      },
      summary: "legacy result awaiting queue rollout",
    } as const;
    expect(
      await seedCapability.storeResult({
        resultCapability: prepared.prepared.resultCapability,
        output,
      }),
    ).toMatchObject({ state: "gate-pending" });

    // Regression: D509 — a released legacy binding must not abort local runtime startup.
    const staleTaskId = "T6522";
    const staleManaged = await prepareManagedWorktree(
      { repositoryRoot, taskId: staleTaskId, baseCommit },
      { skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    if (staleManaged.status !== "prepared") {
      throw new Error(`unexpected stale prepare ${staleManaged.status}`);
    }
    const stalePrepared = await seedCapability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: staleTaskId,
        headline: "Park a released legacy candidate",
        description: "Classify the legacy row without reviving its released worktree.",
        acceptance: "The row is parked without claiming worktree protection.",
        worktreePath: staleManaged.handle.absolutePath,
        branch: staleManaged.handle.branch,
        baseCommit,
        round: 0,
        startingCommit: baseCommit,
      },
      idempotencyKey: "T6522-production-rollout-stale",
      timeoutMs: 600_000,
      expectedChild: {
        childId: "implement-worker#production-rollout-stale",
        runId: "production-rollout-stale-run",
      },
    });
    if (!stalePrepared.accepted || stalePrepared.prepared.gitChangeCapability === undefined) {
      throw new Error("stale legacy rollout seed dispatch was rejected");
    }
    await seedCapability.fetchInput({
      attestationId: stalePrepared.prepared.attestationId,
      generation: stalePrepared.prepared.generation,
      inputCapability: stalePrepared.prepared.inputCapability,
    });
    const staleCandidateBody = "stale candidate\n";
    await writeFile(
      path.join(staleManaged.handle.absolutePath, "stale-candidate.txt"),
      staleCandidateBody,
    );
    const staleReceipt = await seedCapability.gitCommit!({
      attestationId: stalePrepared.prepared.attestationId,
      generation: stalePrepared.prepared.generation,
      gitChangeCapability: stalePrepared.prepared.gitChangeCapability,
      operationId: "T6522-production-rollout-result",
      expectedHead: baseCommit,
      message: "stage released production rollout candidate",
      changes: [
        {
          kind: "add",
          path: "stale-candidate.txt",
          newState: {
            mode: "100644",
            digest: createHash("sha256").update(staleCandidateBody).digest("hex"),
          },
        },
      ],
    });
    const staleOutput = {
      taskId: staleTaskId,
      status: "pass",
      resultCommit: staleReceipt.newHead,
      branch: staleManaged.handle.branch,
      actualWorktreePath: staleManaged.handle.absolutePath,
      filesTouched: [...staleReceipt.paths],
      gitReceipts: [
        { ...staleReceipt, objectOids: [...staleReceipt.objectOids], paths: [...staleReceipt.paths] },
      ],
      checkSummary: "legacy focused checks passed before release",
      baseVerification: {
        status: "verified",
        relation: "descendant",
        baseCommit,
        headCommit: staleReceipt.newHead,
      },
      summary: "released legacy result awaiting queue rollout",
    } as const;
    expect(
      await seedCapability.storeResult({
        resultCapability: stalePrepared.prepared.resultCapability,
        output: staleOutput,
      }),
    ).toMatchObject({ state: "gate-pending" });
    await seedBackend.close();
    expect(
      await releaseManagedWorktree({
        handle: staleManaged.handle,
        terminalDisposition: "done",
        resultCommit: staleReceipt.newHead,
      }),
    ).toMatchObject({ status: "released" });

    const runtime = await createSingleProjectDispatchRuntime({
      construction: "direct",
      resolved: {
        store: ledgerStore,
        implementationEvidenceStore,
        configRoot: repositoryRoot,
        backend: "xdg",
        branch: "cq-ledger",
        projectKey: projectId,
      },
      promptArtifactStore: workerArtifactStore("codex"),
      environment,
      supervisedWorkerGateRunner: gateRunner,
    });
    expect(runtime.kind).toBe("available");
    if (runtime.kind === "unavailable") throw new Error(runtime.reason);
    expect(runtime.implementationQueueRollout).toMatchObject({
      contract: "g213-t4",
      considered: 2,
      adoptedUnqualified: 1,
      adoptedQualified: 0,
      adoptedCompletedGreen: 0,
      parkedIncompatible: 1,
      executionUncertain: 0,
    });
    const peer = await createAttestationStoreForConstruction({
      backend: "xdg",
      namespace,
      env: environment,
    });
    try {
      const rows = await peer.transact({ kind: "namespace" }, (store) => store.rows());
      expect(rows).toHaveLength(2);
      const liveRow = rows.find(
        (row) => row.attestationId === prepared.prepared.attestationId,
      );
      const staleRow = rows.find(
        (row) => row.attestationId === stalePrepared.prepared.attestationId,
      );
      expect(liveRow).toMatchObject({
        state: "gate-pending",
        implementationQueue: { state: "enqueued" },
        implementationQueueRollout: {
          contract: "g213-t4",
          disposition: "adopted-unqualified",
          worktreeProtected: true,
        },
      });
      expect(staleRow).toMatchObject({
        state: "gate-pending",
        implementationQueueRollout: {
          contract: "g213-t4",
          disposition: "parked-incompatible",
          worktreeProtected: false,
          diagnosticArtifact: {
            detail: { reason: "managed-worktree-binding-no-longer-live" },
          },
        },
      });
      expect(staleRow?.implementationQueue).toBeUndefined();
      if (
        runtime.capability.qualifyImplementationCandidate === undefined ||
        runtime.capability.coordinateImplementationCandidate === undefined
      ) {
        throw new Error("local XDG implementation executor is unavailable");
      }
      const qualified = await runtime.capability.qualifyImplementationCandidate({
        attestationId: prepared.prepared.attestationId,
        generation: prepared.prepared.generation,
        roleId: "implement-worker",
        correlationId: "production-rollout",
        childThreadId: "production-rollout-thread",
        expectedRunId: "production-rollout-run",
        outcome: "completed",
        exitStatus: 0,
        observedAt: new Date().toISOString(),
        promptDigest: prepared.prepared.promptProvenance.promptDigest,
      });
      if (qualified.state !== "queued") {
        throw new Error(`rollout candidate did not qualify: ${JSON.stringify(qualified)}`);
      }
      expect(
        await runtime.capability.coordinateImplementationCandidate({
          partitionKey: qualified.partitionKey,
          holderId: "production-rollout-coordinator",
        }),
      ).toMatchObject({
        state: "completed",
        handle: {
          attestationId: prepared.prepared.attestationId,
          generation: prepared.prepared.generation,
        },
      });
      expect(gateRunner.requests).toHaveLength(1);
      const consumed = await peer.transact({ kind: "handle", handle: prepared.prepared }, (store) =>
        store.read(prepared.prepared),
      );
      expect(consumed).toMatchObject({
        state: "consumed",
        implementationQueue: {
          state: "leased",
          lease: { holderId: "production-rollout-coordinator", generation: 1 },
        },
      });
    } finally {
      await peer.close();
      await runtime.close();
    }
  });

  livePgTest(
    "preserves the T977 dispatch contract through the PostgreSQL hub construction",
    async () => {
      const trustedProjectKey = `t977-hub-${crypto.randomUUID()}`;
      const pool = new SQL({ url: PG_URL!, max: 1 });
      const store = await inMemoryStore();
      const promptArtifactStore = workerArtifactStore("claude");
      const runtime = await createPostgresHubDispatchRuntime({
        pool,
        trustedProjectKey,
        store,
        promptArtifactStore,
      });
      expect(runtime.kind).toBe("available");
      if (runtime.kind === "unavailable") throw new Error(runtime.reason);
      const namespace = attestationNamespaceForTrustedHubProject(trustedProjectKey);
      const peer = await createAttestationStoreForConstruction({
        backend: "postgres",
        namespace,
        pool,
      });
      const server = createLedgerMcpServer({
        store,
        displayName: trustedProjectKey,
        projectKey: trustedProjectKey,
        promptArtifactStore,
        dispatchCapability: runtime.capability,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "postgres-hub-dispatch-contract-test", version: "0.0.1" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);
      try {
        await assertDispatchConstructionConformance({
          cell: "postgres-hub",
          client,
          surface: "claude",
          expectedToolNames: LEDGER_TOOL_NAMES,
          rows: async () =>
            (await peer.transact({ kind: "namespace" }, (attestations) => attestations.rows())) ??
            [],
        });
      } finally {
        await client.close();
        await server.close();
        await peer.close();
        await runtime.close();
        try {
          await pool`
          DELETE FROM ${pool(ATTESTATION_TABLE)}
           WHERE backend = 'postgres' AND project_key = ${trustedProjectKey}
        `;
        } finally {
          await pool.close();
          await store.dispose();
        }
      }
    },
  );
});
