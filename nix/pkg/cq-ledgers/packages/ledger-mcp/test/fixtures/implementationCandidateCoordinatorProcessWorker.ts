import { SQL } from "bun";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import {
  PostgresAttestationBackend,
  SqliteAttestationBackend,
  type AttestationBackend,
  type AttestationNamespace,
  type ImplementationQueueLeaseBinding,
} from "@cq/config";
import {
  PLAN_FINALIZED_MANIFEST_FIELD,
  createInMemoryImplementationEvidenceStore,
  createInMemoryWorksetStore,
  type LedgerStore,
  type SupervisedWorkerGateRunRequest,
  type SupervisedWorkerGateRunResult,
  type SupervisedWorkerGateRunner,
} from "@cq/ledger";
import { createDispatchCapability } from "../../src/dispatchCapability.js";
import { ImplementationCandidateQueueAdapter } from "../../src/implementationCandidateQueue.js";
import type { PromptArtifactStore } from "../../src/promptArtifactStore.js";

interface WorkerConfig {
  readonly backend: "sqlite" | "postgres";
  readonly location: string;
  readonly namespace: AttestationNamespace;
  readonly repositoryRoot: string;
  readonly stateDir: string;
  readonly partitionKey: string;
  readonly readyDir: string;
  readonly startBarrier: string;
  readonly gateMarker: string;
  readonly now: string;
  readonly action: "coordinate" | "release-stale";
  readonly waitForBarrier: boolean;
  readonly staleLease?: ImplementationQueueLeaseBinding;
  readonly expectedPartitionRevision?: number;
}

const WAIT_TIMEOUT_MS = 30_000;

function artifactStore(): PromptArtifactStore {
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

function finalizedTaskStore(): LedgerStore {
  const workset = createInMemoryWorksetStore();
  const tasks = new Map(
    ["T6519", "T6520"].map((taskId) => [
      taskId,
      {
        id: taskId,
        milestoneId: "M6519",
        status: "wip",
        fields: {
          headline: `coordinator process fixture ${taskId}`,
          description: "exercise one qualified runnable front",
          acceptance: "one durable lease and one guarded rebase",
          ledgerRefs: ["goals:G211"],
          worksetOwnerRef: "goals:G211",
          worksetOwnerEdgeKind: "active-current-draft",
        },
        createdAt: "2026-09-16T12:00:00.000Z",
        updatedAt: "2026-09-16T12:00:00.000Z",
        author: "planner",
        session: "plan",
      },
    ]),
  );
  return {
    worksetStore: () => workset,
    fetchItem: (ledgerId: string, itemId: string) => {
      if (ledgerId === "tasks") {
        const task = tasks.get(itemId);
        if (task === undefined) throw new Error(`unknown fixture task ${itemId}`);
        return task;
      }
      return {
        fields: {
          [PLAN_FINALIZED_MANIFEST_FIELD]: JSON.stringify({
            revision: 1,
            milestones: [{ key: "coordinator", id: "M6519" }],
            tasks: [
              { key: "front", id: "T6519" },
              { key: "trailing", id: "T6520" },
            ],
          }),
        },
      };
    },
  } as unknown as LedgerStore;
}

class MarkerGateRunner implements SupervisedWorkerGateRunner {
  constructor(private readonly markerPath: string) {}

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    await appendFile(this.markerPath, `${request.worktreePath}\n`);
    return {
      gateExitCode: 0,
      passCount: 1,
      failCount: 0,
      gateDurationMs: 1,
      capturedAt: "2026-09-16T12:00:01.000Z",
      outputTail: "1 pass\n0 fail",
    };
  }
}

async function openBackend(config: WorkerConfig): Promise<AttestationBackend> {
  if (config.backend === "sqlite") {
    return new SqliteAttestationBackend({
      namespace: config.namespace,
      dbPath: config.location,
    });
  }
  return await PostgresAttestationBackend.open({
    namespace: config.namespace,
    pool: new SQL({ url: config.location, max: 1 }),
    ownsPool: true,
  });
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    if (await Bun.file(filePath).exists()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await Bun.sleep(5);
  }
}

const [configPath, workerId] = process.argv.slice(2);
if (configPath === undefined || workerId === undefined) {
  throw new Error("usage: implementationCandidateCoordinatorProcessWorker <config> <worker-id>");
}

const config = JSON.parse(await readFile(configPath, "utf8")) as WorkerConfig;
const backend = await openBackend(config);
try {
  if (config.action === "release-stale") {
    if (config.staleLease === undefined || config.expectedPartitionRevision === undefined) {
      throw new Error("stale release requires one lease and partition revision");
    }
    const queue = new ImplementationCandidateQueueAdapter({
      backend,
      actor: "trusted-extension",
      now: () => config.now,
    });
    try {
      await queue.release({
        ...config.staleLease,
        expectedPartitionRevision: config.expectedPartitionRevision,
        detail: { disposition: "stale-process-replay" },
      });
      process.stdout.write(`${JSON.stringify({ ok: false, workerId, accepted: true })}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          workerId,
          rejected: true,
          reason:
            error !== null && typeof error === "object" && "reason" in error
              ? String(error.reason)
              : undefined,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        })}\n`,
      );
    }
  } else {
    await writeFile(`${config.readyDir}/${workerId}`, `${String(process.pid)}\n`, { flag: "wx" });
    if (config.waitForBarrier) await waitForFile(config.startBarrier);
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore(),
      ledgerStore: finalizedTaskStore(),
      implementationEvidenceStore: createInMemoryImplementationEvidenceStore(),
      repositoryRoot: config.repositoryRoot,
      worktreeStateDir: config.stateDir,
      supervisedWorkerGateRunner: new MarkerGateRunner(config.gateMarker),
      now: () => config.now,
    });
    if (capability.coordinateImplementationCandidate === undefined) {
      throw new Error("implementation candidate coordinator is unavailable");
    }
    const outcome = await capability.coordinateImplementationCandidate({
      partitionKey: config.partitionKey,
      holderId: `coordinator-${workerId}`,
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, workerId, pid: process.pid, outcome })}\n`,
    );
  }
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      workerId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await backend.close();
}
