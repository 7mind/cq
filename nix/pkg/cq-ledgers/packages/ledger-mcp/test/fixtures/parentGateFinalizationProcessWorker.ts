import { appendFile, readFile, writeFile } from "node:fs/promises";
import {
  SqliteAttestationBackend,
  type AttestationNamespace,
  type ParentGateFinalizeRequest,
} from "@cq/config";
import {
  createInMemoryImplementationEvidenceStore,
  nodeSupervisedWorkerGateRunner,
  type SupervisedWorkerGateRunRequest,
  type SupervisedWorkerGateRunResult,
  type SupervisedWorkerGateRunner,
} from "@cq/ledger";
import { createDispatchCapability } from "../../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../../src/promptArtifactStore.js";

interface WorkerConfig {
  readonly namespace: AttestationNamespace;
  readonly dbPath: string;
  readonly repositoryRoot: string;
  readonly stateDir: string;
  readonly invocationMarker: string;
  readonly readyDirectory: string;
  readonly firstStartedMarker: string;
  readonly releaseFirstMarker: string;
  readonly now: string;
  readonly input: ParentGateFinalizeRequest;
  readonly runnerKind?: "blocking-marker" | "registered-process";
  readonly runtimePath?: string;
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

async function waitForFile(filePath: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    if (signal.aborted) throw new Error("process worker observed authenticated cancellation");
    if (await Bun.file(filePath).exists()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await Bun.sleep(5);
  }
}

class ProcessGateRunner implements SupervisedWorkerGateRunner {
  constructor(
    private readonly workerId: string,
    private readonly config: WorkerConfig,
  ) {}

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    await appendFile(this.config.invocationMarker, `${this.workerId}\n`);
    if (this.workerId === "first") {
      await writeFile(this.config.firstStartedMarker, `${String(process.pid)}\n`, { flag: "wx" });
      await waitForFile(this.config.releaseFirstMarker, request.cancellationSignal);
    }
    return {
      gateExitCode: 0,
      passCount: 1,
      failCount: 0,
      gateDurationMs: 1,
      capturedAt: this.config.now,
      outputTail: "1 pass\n0 fail",
    };
  }
}

const [configPath, workerId] = process.argv.slice(2);
if (configPath === undefined || workerId === undefined) {
  throw new Error("usage: parentGateFinalizationProcessWorker <config> <worker-id>");
}

const config = JSON.parse(await readFile(configPath, "utf8")) as WorkerConfig;
await writeFile(`${config.readyDirectory}/${workerId}`, `${String(process.pid)}\n`, { flag: "wx" });
if (config.runtimePath !== undefined) process.env["PATH"] = config.runtimePath;
const backend = new SqliteAttestationBackend({
  namespace: config.namespace,
  dbPath: config.dbPath,
});
try {
  const capability = createDispatchCapability({
    backend,
    promptArtifactStore: artifactStore(),
    implementationEvidenceStore: createInMemoryImplementationEvidenceStore(),
    repositoryRoot: config.repositoryRoot,
    worktreeStateDir: config.stateDir,
    supervisedWorkerGateRunner:
      config.runnerKind === "registered-process"
        ? nodeSupervisedWorkerGateRunner
        : new ProcessGateRunner(workerId, config),
    now: () => config.now,
  });
  if (capability.finalizeParentGate === undefined) {
    throw new Error("parent gate finalizer is unavailable");
  }
  const outcome = await capability.finalizeParentGate(config.input);
  process.stdout.write(`${JSON.stringify({ ok: true, workerId, outcome })}\n`);
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
