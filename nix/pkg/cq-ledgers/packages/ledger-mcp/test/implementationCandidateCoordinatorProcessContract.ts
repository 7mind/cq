import { SQL } from "bun";
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  PostgresAttestationBackend,
  SqliteAttestationBackend,
  dispatchPayloadDigest,
  isAttestationTombstone,
  sequentialDispatchRandomBytes,
  type AttestationBackend,
  type AttestationEnvelope,
  type AttestationNamespace,
  type DispatchPrepared,
} from "@cq/config";
import {
  PLAN_FINALIZED_MANIFEST_FIELD,
  createInMemoryImplementationEvidenceStore,
  createInMemoryWorksetStore,
  prepareManagedWorktree,
  type LedgerStore,
  type SupervisedWorkerGateRunRequest,
  type SupervisedWorkerGateRunResult,
  type SupervisedWorkerGateRunner,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const exec = promisify(execFile);
const WORKER = fileURLToPath(
  new URL("./fixtures/implementationCandidateCoordinatorProcessWorker.ts", import.meta.url),
);
const PROCESS_TIMEOUT_MS = 60_000;

export interface CoordinatorProcessContractOptions {
  readonly backend: "sqlite" | "postgres";
  readonly postgresDsn?: string;
}

interface WorkerOutcome {
  readonly ok: boolean;
  readonly workerId: string;
  readonly pid?: number;
  readonly accepted?: boolean;
  readonly rejected?: boolean;
  readonly reason?: string;
  readonly error?: string;
  readonly outcome?: {
    readonly state: "empty" | "blocked" | "completed" | "successor-queued";
    readonly source?: { readonly attestationId: string; readonly generation: number };
    readonly successor?: { readonly attestationId: string; readonly generation: number };
  };
}

interface SpawnedWorker {
  readonly id: string;
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T6519",
      GIT_AUTHOR_EMAIL: "t6519@example.invalid",
      GIT_COMMITTER_NAME: "T6519",
      GIT_COMMITTER_EMAIL: "t6519@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return stdout.trim();
}

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
    await fs.appendFile(this.markerPath, `${request.worktreePath}\n`);
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

async function openBackend(
  options: CoordinatorProcessContractOptions,
  namespace: AttestationNamespace,
  location: string,
): Promise<AttestationBackend> {
  if (options.backend === "sqlite") {
    return new SqliteAttestationBackend({ namespace, dbPath: location });
  }
  return await PostgresAttestationBackend.open({
    namespace,
    pool: new SQL({ url: location, max: 1 }),
    ownsPool: true,
  });
}

async function waitForFile(filePath: string, label: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  for (;;) {
    if (await Bun.file(filePath).exists()) return;
    if (Date.now() >= deadline) throw new Error(`${label} did not appear before timeout`);
    await Bun.sleep(5);
  }
}

function spawnWorker(
  configPath: string,
  id: string,
  environment: NodeJS.ProcessEnv,
): SpawnedWorker {
  const child = Bun.spawn([process.execPath, "run", WORKER, configPath, id], {
    cwd: path.dirname(path.dirname(import.meta.dir)),
    env: environment,
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    id,
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

function signalWorkerGroup(worker: SpawnedWorker, signal: NodeJS.Signals): void {
  try {
    process.kill(-worker.child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function settleWorker(worker: SpawnedWorker): Promise<WorkerOutcome> {
  let exitCode = await Promise.race([
    worker.child.exited,
    Bun.sleep(PROCESS_TIMEOUT_MS).then(() => undefined),
  ]);
  if (exitCode === undefined) {
    signalWorkerGroup(worker, "SIGTERM");
    exitCode = await Promise.race([
      worker.child.exited,
      Bun.sleep(1_000).then(() => undefined),
    ]);
  }
  if (exitCode === undefined) {
    signalWorkerGroup(worker, "SIGKILL");
    exitCode = await worker.child.exited;
  }
  const [stdout, stderr] = await Promise.all([worker.stdout, worker.stderr]);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let parsed: WorkerOutcome;
  try {
    parsed = JSON.parse(line) as WorkerOutcome;
  } catch {
    throw new Error(
      `coordinator ${worker.id} produced no JSON (exit ${String(exitCode)}): stdout=${stdout} stderr=${stderr}`,
    );
  }
  if (exitCode !== 0 || !parsed.ok) {
    throw new Error(
      `coordinator ${worker.id} failed (exit ${String(exitCode)}): ${parsed.error ?? stderr}`,
    );
  }
  return parsed;
}

async function stageCandidate(input: {
  readonly capability: ReturnType<typeof createDispatchCapability>;
  readonly taskId: "T6519" | "T6520";
  readonly managed: Awaited<ReturnType<typeof prepareManagedWorktree>> & { status: "prepared" };
  readonly baseCommit: string;
  readonly correlationId: string;
}): Promise<{ readonly prepared: DispatchPrepared; readonly partitionKey: string }> {
  const expectedChild = {
    childId: `implement-worker#${input.correlationId}`,
    runId: `run-${input.taskId}`,
  };
  const prepared = await input.capability.prepare({
    roleId: "implement-worker",
    input: {
      taskId: input.taskId,
      headline: `process candidate ${input.taskId}`,
      description: "qualify one durable process candidate",
      acceptance: "only the runnable front receives a lease",
      worktreePath: input.managed.handle.absolutePath,
      branch: input.managed.handle.branch,
      baseCommit: input.baseCommit,
      round: 0,
      startingCommit: input.baseCommit,
      validationIntent: "final",
    },
    idempotencyKey: `${input.taskId}-process-race`,
    timeoutMs: 600_000,
    expectedChild,
  });
  if (
    !prepared.accepted ||
    prepared.prepared.gitChangeCapability === undefined ||
    prepared.prepared.parentGateCapability === undefined
  ) {
    throw new Error(`${input.taskId} did not receive broker and parent-gate authority`);
  }
  await input.capability.fetchInput({
    attestationId: prepared.prepared.attestationId,
    generation: prepared.prepared.generation,
    inputCapability: prepared.prepared.inputCapability,
  });
  const candidatePath = `candidate-${input.taskId}.txt`;
  const candidateBody = `candidate ${input.taskId}\n`;
  await fs.writeFile(path.join(input.managed.handle.absolutePath, candidatePath), candidateBody);
  if (input.capability.gitCommit === undefined) throw new Error("git_commit unavailable");
  const receipt = await input.capability.gitCommit({
    attestationId: prepared.prepared.attestationId,
    generation: prepared.prepared.generation,
    gitChangeCapability: prepared.prepared.gitChangeCapability,
    operationId: `${input.taskId}-process-result`,
    expectedHead: input.baseCommit,
    message: `stage ${input.taskId} process result`,
    changes: [
      {
        kind: "add",
        path: candidatePath,
        newState: { mode: "100644", digest: sha256(candidateBody) },
      },
    ],
  });
  if (receipt.version !== 1) throw new Error("task fixture received a cohort receipt");
  const output = {
    taskId: input.taskId,
    status: "pass",
    resultCommit: receipt.newHead,
    branch: input.managed.handle.branch,
    actualWorktreePath: input.managed.handle.absolutePath,
    filesTouched: [...receipt.paths],
    gitReceipts: [{ ...receipt, objectOids: [...receipt.objectOids], paths: [...receipt.paths] }],
    checkSummary: "process fixture staged",
    baseVerification: {
      status: "verified",
      relation: "descendant",
      baseCommit: input.baseCommit,
      headCommit: receipt.newHead,
    },
    summary: "qualified process fixture candidate",
  } as const;
  expect(
    await input.capability.storeResult({
      resultCapability: prepared.prepared.resultCapability,
      output,
    }),
  ).toMatchObject({ state: "gate-pending" });
  if (input.capability.qualifyImplementationCandidate === undefined) {
    throw new Error("candidate qualifier unavailable");
  }
  const qualified = await input.capability.qualifyImplementationCandidate({
    attestationId: prepared.prepared.attestationId,
    generation: prepared.prepared.generation,
    roleId: "implement-worker",
    correlationId: input.correlationId,
    childThreadId: `thread-${input.taskId}`,
    expectedRunId: expectedChild.runId,
    outcome: "completed",
    exitStatus: 0,
    observedAt: "2026-09-16T12:00:01.000Z",
    promptDigest: prepared.prepared.promptProvenance.promptDigest,
  });
  if (qualified.state !== "queued") throw new Error(`${input.taskId} did not qualify`);
  return { prepared: prepared.prepared, partitionKey: qualified.partitionKey };
}

function liveRows(rows: readonly unknown[]): AttestationEnvelope[] {
  return rows.filter(
    (row): row is AttestationEnvelope =>
      typeof row === "object" && row !== null && !isAttestationTombstone(row as never),
  );
}

export async function runCoordinatorProcessContract(
  options: CoordinatorProcessContractOptions,
): Promise<void> {
  if (options.backend === "postgres" && options.postgresDsn === undefined) {
    throw new Error("PostgreSQL coordinator contract requires a DSN");
  }
  const root = await fs.mkdtemp(path.join(tmpdir(), `t6519-${options.backend}-process-`));
  const repositoryRoot = path.join(root, "repository");
  const stateDir = path.join(root, "managed-state");
  const readyDir = path.join(root, "ready");
  const startBarrier = path.join(root, "start");
  const rebaseMarker = path.join(root, "rebase-marker");
  const rebaseRelease = path.join(root, "rebase-release");
  const gateMarker = path.join(root, "gate-marker");
  const configPath = path.join(root, "worker-config.json");
  const projectKey = `t6519-${options.backend}-${crypto.randomUUID()}`;
  const namespace: AttestationNamespace = {
    backend: options.backend === "sqlite" ? "xdg" : "postgres",
    projectKey,
  };
  const location =
    options.backend === "sqlite" ? path.join(root, "attestations.sqlite") : options.postgresDsn!;
  let backend: AttestationBackend | undefined;
  const workers: SpawnedWorker[] = [];
  try {
    await fs.mkdir(repositoryRoot);
    await fs.mkdir(readyDir);
    await git(repositoryRoot, ["init", "-q", "-b", "main"]);
    await git(repositoryRoot, ["config", "user.name", "T6519"]);
    await git(repositoryRoot, ["config", "user.email", "t6519@example.invalid"]);
    await fs.writeFile(path.join(repositoryRoot, "base.txt"), "base\n");
    await git(repositoryRoot, ["add", "base.txt"]);
    await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const frontManaged = await prepareManagedWorktree(
      { repositoryRoot, taskId: "T6519", baseCommit },
      { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    const trailingManaged = await prepareManagedWorktree(
      { repositoryRoot, taskId: "T6520", baseCommit },
      { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    if (frontManaged.status !== "prepared" || trailingManaged.status !== "prepared") {
      throw new Error("process fixture managed worktrees did not prepare");
    }
    backend = await openBackend(options, namespace, location);
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore(),
      ledgerStore: finalizedTaskStore(),
      implementationEvidenceStore: createInMemoryImplementationEvidenceStore(),
      implementationExecutorMode: "local-xdg",
      repositoryRoot,
      worktreeStateDir: stateDir,
      supervisedWorkerGateRunner: new MarkerGateRunner(gateMarker),
      now: () => "2026-09-16T12:00:00.000Z",
      randomBytes: sequentialDispatchRandomBytes(6519),
    });
    const front = await stageCandidate({
      capability,
      taskId: "T6519",
      managed: frontManaged,
      baseCommit,
      correlationId: "front-correlation",
    });
    const trailing = await stageCandidate({
      capability,
      taskId: "T6520",
      managed: trailingManaged,
      baseCommit,
      correlationId: "trailing-correlation",
    });
    expect(trailing.partitionKey).toBe(front.partitionKey);
    await fs.writeFile(path.join(repositoryRoot, "protected.txt"), "protected advance\n");
    await git(repositoryRoot, ["add", "protected.txt"]);
    await git(repositoryRoot, ["commit", "-q", "-m", "advance protected head"]);
    const protectedHead = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    await git(repositoryRoot, ["checkout", "--detach", baseCommit]);
    expect(await git(repositoryRoot, ["rev-parse", "refs/heads/main"])).toBe(protectedHead);
    expect(await git(repositoryRoot, ["rev-parse", "HEAD"])).toBe(baseCommit);

    const hook = path.join(repositoryRoot, ".git", "hooks", "pre-rebase");
    await fs.writeFile(
      hook,
      [
        "#!/bin/sh",
        "set -eu",
        'printf \'%s\\n\' "${CQ_T6519_WORKER_ID:?}" >> "${CQ_T6519_REBASE_MARKER:?}"',
        "remaining=600",
        'while test ! -e "${CQ_T6519_REBASE_RELEASE:?}"; do',
        '  test "$remaining" -gt 0 || exit 124',
        "  remaining=$((remaining - 1))",
        "  sleep 0.1",
        "done",
        "",
      ].join("\n"),
    );
    await fs.chmod(hook, 0o700);
    const baseConfig = {
      backend: options.backend,
      location,
      namespace,
      repositoryRoot,
      stateDir,
      partitionKey: front.partitionKey,
      readyDir,
      startBarrier,
      gateMarker,
      now: "2026-09-16T12:00:02.000Z",
      action: "coordinate",
      waitForBarrier: true,
    } as const;
    await fs.writeFile(configPath, JSON.stringify(baseConfig));
    for (const id of ["1", "2", "3"] as const) {
      workers.push(
        spawnWorker(configPath, id, {
          ...process.env,
          CQ_T6519_WORKER_ID: id,
          CQ_T6519_REBASE_MARKER: rebaseMarker,
          CQ_T6519_REBASE_RELEASE: rebaseRelease,
        }),
      );
    }
    await Promise.all(
      workers.map((worker) => waitForFile(path.join(readyDir, worker.id), `worker ${worker.id}`)),
    );
    await fs.writeFile(startBarrier, "start\n", { flag: "wx" });
    await Promise.race([
      waitForFile(rebaseMarker, "guarded rebase launch marker"),
      waitForFile(gateMarker, "unexpected pre-rebase gate marker").then(() => {
        throw new Error("detached checkout HEAD was used instead of refs/heads/main");
      }),
      Promise.all(workers.map((worker) => worker.child.exited)).then(() => {
        throw new Error("all coordinators exited before the protected-ref rebase launched");
      }),
    ]);
    await fs.writeFile(rebaseRelease, "release\n", { flag: "wx" });
    const outcomes = await Promise.all(workers.map(settleWorker));
    expect(outcomes).toHaveLength(3);
    expect(
      outcomes.every(
        ({ outcome }) => outcome?.state === "blocked" || outcome?.state === "successor-queued",
      ),
    ).toBe(true);

    await backend.close();
    backend = await openBackend(options, namespace, location);
    const rows = liveRows(
      await backend.transact({ kind: "namespace" }, (store) => [...store.rows()]),
    );
    const taskIdOf = (row: AttestationEnvelope): unknown =>
      row.input !== null && typeof row.input === "object" && !Array.isArray(row.input)
        ? (row.input as Readonly<Record<string, unknown>>)["taskId"]
        : undefined;
    const source = rows.find(
      (row) => row.attestationId === front.prepared.attestationId && row.generation === 1,
    );
    const successor = rows.find(
      (row) => row.attestationId === front.prepared.attestationId && row.generation === 2,
    );
    const trailingRow = rows.find((row) => taskIdOf(row) === "T6520");
    if (
      source?.implementationQueue === undefined ||
      successor === undefined ||
      trailingRow?.implementationQueue === undefined
    ) {
      throw new Error("coordinator process contract lost source, successor, or trailing row");
    }
    expect(source).toMatchObject({
      state: "aborted",
      abortReason: "staged-rebase",
      implementationQueue: {
        state: "staged-rebase-retired",
        leaseGeneration: 1,
      },
    });
    expect(successor).toMatchObject({
      state: "prepared",
      generation: 2,
      input: {
        baseCommit: protectedHead,
        priorResultCommit: source.implementationQueue.attempt.resultCommit,
        round: 1,
      },
    });
    expect(trailingRow).toMatchObject({
      state: "gate-pending",
      implementationQueue: { state: "qualified", leaseGeneration: 0 },
    });
    expect(await Bun.file(gateMarker).exists()).toBe(false);
    const launchIds = (await fs.readFile(rebaseMarker, "utf8")).trim().split("\n");
    expect(launchIds).toHaveLength(1);

    const journalsRoot = path.join(stateDir, "guarded-rebase");
    const journalDirs = (await fs.readdir(journalsRoot, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
    expect(journalDirs).toHaveLength(1);
    const journal = JSON.parse(
      await fs.readFile(path.join(journalsRoot, journalDirs[0]!.name, "journal.json"), "utf8"),
    ) as Readonly<Record<string, unknown>>;
    const stableOperationId = `implementation-rebase-${dispatchPayloadDigest({
      enrollmentId: source.implementationQueue.enrollment.enrollmentId,
      attemptId: source.implementationQueue.attempt.attemptId,
    }).slice(0, 32)}`;
    expect(journal).toMatchObject({
      state: "finalized",
      operationId: stableOperationId,
      oldResultCommit: source.implementationQueue.attempt.resultCommit,
      ontoCommit: protectedHead,
      outcome: "clean",
    });

    const staleLease = {
      attestationId: source.attestationId,
      generation: source.generation,
      partitionKey: source.implementationQueue.partition.partitionKey,
      enrollmentId: source.implementationQueue.enrollment.enrollmentId,
      attemptId: source.implementationQueue.attempt.attemptId,
      holderId: `coordinator-${launchIds[0]!}`,
      leaseGeneration: source.implementationQueue.leaseGeneration,
    } as const;
    await fs.writeFile(
      configPath,
      JSON.stringify({
        ...baseConfig,
        action: "release-stale",
        waitForBarrier: false,
        staleLease,
        expectedPartitionRevision: source.implementationQueue.partitionRevision,
      }),
    );
    const stale = await settleWorker(
      spawnWorker(configPath, "stale", {
        ...process.env,
        CQ_T6519_WORKER_ID: "stale",
        CQ_T6519_REBASE_MARKER: rebaseMarker,
        CQ_T6519_REBASE_RELEASE: rebaseRelease,
      }),
    );
    expect(stale).toMatchObject({ rejected: true, reason: "stale-lease" });

    await fs.writeFile(
      configPath,
      JSON.stringify({ ...baseConfig, action: "coordinate", waitForBarrier: false }),
    );
    const restarted = await settleWorker(
      spawnWorker(configPath, "restart", {
        ...process.env,
        CQ_T6519_WORKER_ID: "restart",
        CQ_T6519_REBASE_MARKER: rebaseMarker,
        CQ_T6519_REBASE_RELEASE: rebaseRelease,
      }),
    );
    expect(restarted.outcome).toEqual({
      state: "successor-queued",
      source: { attestationId: source.attestationId, generation: 1 },
      successor: { attestationId: source.attestationId, generation: 2 },
    });
    expect((await fs.readFile(rebaseMarker, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(await Bun.file(gateMarker).exists()).toBe(false);
  } finally {
    for (const worker of workers) {
      if ((await Promise.race([worker.child.exited.then(() => true), Promise.resolve(false)])) === false) {
        signalWorkerGroup(worker, "SIGKILL");
      }
    }
    await backend?.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
}
