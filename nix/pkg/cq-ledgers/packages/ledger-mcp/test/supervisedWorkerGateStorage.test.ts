/** T2081 host-supervised worker gate storage contract. */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CODEX_STAGED_TIMING_BASIS,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  SqliteAttestationBackend,
  isAttestationTombstone,
  serializeWipArtifact,
  sequentialDispatchRandomBytes,
  type AttestationEnvelope,
  type AttestationNamespace,
  type DispatchJSONValue,
} from "@cq/config";
import {
  SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS,
  SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
  InMemoryCurrentRecoverySealJournalStore,
  PLAN_FINALIZED_MANIFEST_FIELD,
  assertManagedWorktreeWipClosure,
  continueManagedWorktreeRebase,
  createInMemoryImplementationEvidenceStore,
  createNodeSupervisedWorkerGateRunner,
  createInMemoryWorksetStore,
  gitRebaseConflictStateDigest,
  listManagedLiveWorktrees,
  nodeSupervisedWorkerGateRunner,
  observeManagedWorktreeConflictState,
  prepareManagedWorktree,
  releaseManagedWorktree,
  resolveManagedWorktreeDispatchBinding,
  runGuardedRebase,
  SqliteLedgerStore,
  settleProcessGroups,
  settleWorktreeGateCommands,
  type NodeSupervisedWorkerGateSettlement,
  type ProcessGroupRegistration,
  type SettleProcessGroupsResult,
  type SettleWorktreeGateCommandsOptions,
  type SupervisedWorkerGateRunRequest,
  type SupervisedWorkerGateRunResult,
  type SupervisedWorkerGateRunner,
  type LedgerStore,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import { createImplementationSuccessorLauncher } from "../src/main.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const exec = promisify(execFile);
const CODEX_ROLE_DISPATCH_SCRIPT = fileURLToPath(
  new URL("../../cq-config/scripts/codex-role-dispatch.ts", import.meta.url),
);
const PARENT_GATE_PROCESS_WORKER = fileURLToPath(
  new URL("./fixtures/parentGateFinalizationProcessWorker.ts", import.meta.url),
);
const T6576_LEGACY_QUEUE_FIXTURE_PROVENANCE = Object.freeze({
  source: "cq-0.0.1/share/cq/packages/cq-config/src/dispatchImplementationQueue.ts",
  sha256: "e4efc3a417084f447d5dbe43fee059c247645ade0c30f8479745f5d85717f51f",
});
const roots: string[] = [];
let sequence = 0;

function t6576LegacyQueueFixture(row: AttestationEnvelope): {
  readonly provenance: typeof T6576_LEGACY_QUEUE_FIXTURE_PROVENANCE;
  readonly row: AttestationEnvelope;
} {
  const {
    dispatchContinuationClaim: _dispatchContinuationClaim,
    dispatchJournalRecoveryClaim: _dispatchJournalRecoveryClaim,
    ...legacyRow
  } = row;
  return JSON.parse(
    JSON.stringify({ provenance: T6576_LEGACY_QUEUE_FIXTURE_PROVENANCE, row: legacyRow }),
  ) as {
    readonly provenance: typeof T6576_LEGACY_QUEUE_FIXTURE_PROVENANCE;
    readonly row: AttestationEnvelope;
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T2081",
      GIT_AUTHOR_EMAIL: "t2081@example.invalid",
      GIT_COMMITTER_NAME: "T2081",
      GIT_COMMITTER_EMAIL: "t2081@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return stdout.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactStore(
  promptDigest = "a".repeat(64),
  roleBytes = new Uint8Array([1]),
): PromptArtifactStore {
  const metadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const,
    promptDigest,
    schemaVersion: 8,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: "codex",
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: roleBytes }),
  };
}

function finalizedTaskStore(): LedgerStore {
  const workset = createInMemoryWorksetStore();
  const logs = new Map<string, string>();
  const task = {
    id: "T2081",
    milestoneId: "M2081",
    status: "wip",
    fields: {
      headline: "supervise exact tip",
      description: "run the full gate outside the workspace-write sandbox",
      acceptance: "only a green exact tip becomes consumable",
      ledgerRefs: ["goals:G2081"],
      worksetOwnerRef: "goals:G2081",
      worksetOwnerEdgeKind: "active-current-draft",
    },
    createdAt: "2026-08-12T20:00:00.000Z",
    updatedAt: "2026-08-12T20:00:00.000Z",
    author: "planner",
    session: "plan",
  };
  return {
    worksetStore: () => workset,
    putLog: async (logPath: string, content: string) => {
      logs.set(logPath, content);
    },
    readLog: async (logPath: string) => {
      const normalized = logPath.replace(/^\.cq\/logs\//u, "");
      const content = logs.get(normalized);
      if (content === undefined) throw new Error(`missing test log artifact ${logPath}`);
      return { path: logPath, content };
    },
    fetchItem: (ledgerId: string) =>
      ledgerId === "tasks"
        ? task
        : {
            fields: {
              [PLAN_FINALIZED_MANIFEST_FIELD]: JSON.stringify({
                revision: 1,
                milestones: [{ key: "managed", id: "M2081" }],
                tasks: [{ key: "supervise", id: "T2081" }],
              }),
            },
          },
  } as unknown as LedgerStore;
}

class GateDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];
  readonly callerProcessIds: number[] = [];

  constructor(
    private readonly result: SupervisedWorkerGateRunResult = {
      gateExitCode: 0,
      passCount: 17,
      failCount: 0,
      gateDurationMs: 123,
      capturedAt: "2026-08-12T20:00:01.000Z",
      outputTail: "17 pass\nRan 17 tests across 4 files.",
    },
  ) {}

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    this.callerProcessIds.push(process.pid);
    return this.result;
  }
}

class GateSequenceDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  constructor(private readonly results: readonly SupervisedWorkerGateRunResult[]) {}

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    const result = this.results[this.requests.length - 1];
    if (result === undefined) throw new Error("supervised gate sequence exhausted");
    return result;
  }
}

class ThrowingGateDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  constructor(private readonly message: string) {}

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    throw new Error(this.message);
  }
}

class ParentLossThenGreenGateDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      throw new Error("controlled parent loss after qualification");
    }
    return {
      gateExitCode: 0,
      passCount: 17,
      failCount: 0,
      gateDurationMs: 123,
      capturedAt: "2026-08-12T20:00:09.000Z",
      outputTail: "17 pass\n0 fail",
    };
  }
}

class GateRejectedThenParentLossThenGreenGateDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        gateExitCode: 1,
        passCount: 16,
        failCount: 1,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:03.000Z",
        outputTail: "(fail) authenticated historical rejection\n16 pass\n1 fail",
      };
    }
    if (this.requests.length === 2) {
      throw new Error("controlled parent loss after gate-rejected correction");
    }
    return {
      gateExitCode: 0,
      passCount: 17,
      failCount: 0,
      gateDurationMs: 1,
      capturedAt: "2026-08-12T20:00:09.000Z",
      outputTail: "17 pass\n0 fail",
    };
  }
}

class MovingTipGateDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    const branchRef = await git(request.worktreePath, ["symbolic-ref", "HEAD"]);
    const parent = await git(request.worktreePath, ["rev-parse", "HEAD^"]);
    await git(request.worktreePath, ["update-ref", branchRef, parent]);
    return {
      gateExitCode: 0,
      passCount: 17,
      failCount: 0,
      gateDurationMs: 123,
      capturedAt: "2026-08-12T20:00:01.000Z",
      outputTail: "17 pass\n0 fail",
    };
  }
}

class BlockingGateDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];
  readonly started: Promise<void>;
  private resolveStarted!: () => void;
  private readonly released: Promise<void>;
  private resolveReleased!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    this.released = new Promise((resolve) => {
      this.resolveReleased = resolve;
    });
  }

  release(): void {
    this.resolveReleased();
  }

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    this.resolveStarted();
    await new Promise<void>((resolve, reject) => {
      const cancelled = (): void => {
        reject(new Error("blocking gate observed authenticated cancellation"));
      };
      request.cancellationSignal.addEventListener("abort", cancelled, { once: true });
      void this.released.then(() => {
        request.cancellationSignal.removeEventListener("abort", cancelled);
        resolve();
      });
    });
    return {
      gateExitCode: 0,
      passCount: 17,
      failCount: 0,
      gateDurationMs: 123,
      capturedAt: "2026-08-12T20:00:01.000Z",
      outputTail: "17 pass\n0 fail",
    };
  }
}

class ClockAdvancingGateDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  constructor(private readonly advance: () => void) {}

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    this.advance();
    return {
      gateExitCode: 0,
      passCount: 17,
      failCount: 0,
      gateDurationMs: 600_001,
      capturedAt: "2026-08-12T20:10:01.000Z",
      outputTail: "17 pass\n0 fail",
    };
  }
}

type DispatchBaseMode = "managed" | "descendant";
type WipFixtureMode =
  | false
  | "exact"
  | "inherited"
  | "inherited-current-open"
  | "after-prepare-inherited"
  | "foreign"
  | "modified-foreign"
  | "malformed";

function wipFixtureBody(taskId: string, baseCommit: string, body: string): string {
  return serializeWipArtifact({
    id: taskId,
    role: "implement-worker",
    baseCommit,
    startedAt: "2026-08-12T20:00:00.000Z",
    checkpoints: [
      {
        name: "trusted full gate",
        status: "unmeasured",
        body,
      },
    ],
    complete: false,
    openCheckpoints: ["trusted full gate"],
  });
}

async function fixtureWithDispatchBase(
  runner: SupervisedWorkerGateRunner,
  dispatchBaseMode: DispatchBaseMode,
  now: () => string = () => "2026-08-12T20:00:00.000Z",
  wipFixture: WipFixtureMode = false,
  withLedgerStore = false,
  implementationSuccessorLauncher?: NonNullable<
    Parameters<typeof createDispatchCapability>[0]["implementationSuccessorLauncher"]
  >,
  promptArtifactStore: PromptArtifactStore = artifactStore(),
  attestationBackend: "memory" | "sqlite" = "memory",
  validationIntent: "final" | "focused-only" = "final",
  prepareForm: "inline" | "refs" = "inline",
  ledgerStoreOverride?: LedgerStore,
) {
  sequence += 1;
  const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), `t2081-gate-${sequence}-`));
  roots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "-q"]);
  await fs.writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
  await git(repositoryRoot, ["add", "file.txt"]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  let baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  if ((await git(repositoryRoot, ["show", `${baseCommit}:file.txt`])) !== "before") {
    throw new Error("test seed commit does not contain the expected bytes");
  }
  const baseWipBodies = new Map<string, string>();
  if (wipFixture === "inherited" || wipFixture === "modified-foreign") {
    const inheritedPath = "WIP-T2234.md";
    const inheritedBody = wipFixtureBody(
      "T2234",
      baseCommit,
      "Earlier task checkpoint retained in integration history.\n",
    );
    baseWipBodies.set(inheritedPath, inheritedBody);
    await fs.writeFile(path.join(repositoryRoot, inheritedPath), inheritedBody);
    await git(repositoryRoot, ["add", inheritedPath]);
    await git(repositoryRoot, ["commit", "-q", "-m", "retain earlier task WIP evidence"]);
    baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  }
  if (wipFixture === "inherited-current-open") {
    const currentPath = "WIP-T2081.md";
    const currentBody = serializeWipArtifact({
      id: "T2081",
      role: "implement-worker",
      baseCommit,
      startedAt: "2026-08-12T20:00:00.000Z",
      checkpoints: [{ name: "implementation", status: "todo", body: "Still open.\n" }],
      complete: false,
      openCheckpoints: ["implementation"],
    });
    await fs.writeFile(path.join(repositoryRoot, currentPath), currentBody);
    await git(repositoryRoot, ["add", currentPath]);
    await git(repositoryRoot, ["commit", "-q", "-m", "retain current task WIP evidence"]);
    baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  }
  const stateDir = path.join(repositoryRoot, ".manager-state");
  const managed = await prepareManagedWorktree(
    { repositoryRoot, taskId: "T2081", baseCommit },
    { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
  );
  if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
  let dispatchBaseCommit = baseCommit;
  if (wipFixture === "after-prepare-inherited") {
    const inheritedPath = "WIP-T2234.md";
    const inheritedBody = wipFixtureBody(
      "T2234",
      baseCommit,
      "Earlier task checkpoint entered integration after this task prepared.\n",
    );
    await fs.writeFile(path.join(repositoryRoot, inheritedPath), inheritedBody);
    await git(repositoryRoot, ["add", inheritedPath]);
    await git(repositoryRoot, ["commit", "-q", "-m", "advance integration with retained WIP"]);
    dispatchBaseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    await git(managed.handle.absolutePath, ["merge", "--ff-only", dispatchBaseCommit]);
  }
  if (dispatchBaseMode === "descendant") {
    await fs.writeFile(path.join(managed.handle.absolutePath, "round-base.txt"), "round base\n");
    await git(managed.handle.absolutePath, ["add", "round-base.txt"]);
    await git(managed.handle.absolutePath, ["commit", "-q", "-m", "correction-round base"]);
    dispatchBaseCommit = await git(managed.handle.absolutePath, ["rev-parse", "HEAD"]);
  }
  const namespace: AttestationNamespace = {
    backend: "xdg",
    projectKey: `t2081-${sequence}`,
  };
  const store = new InMemoryAttestationStore(namespace);
  const backend =
    attestationBackend === "sqlite"
      ? new SqliteAttestationBackend({
          namespace,
          dbPath: path.join(repositoryRoot, "attestations.sqlite"),
        })
      : new InMemoryAttestationBackend(store);
  const ledgerStore = withLedgerStore ? (ledgerStoreOverride ?? finalizedTaskStore()) : undefined;
  const implementationEvidenceStore = createInMemoryImplementationEvidenceStore();
  const capabilityOptions = {
    backend,
    promptArtifactStore,
    narrativeSource: {
      projectKey: namespace.projectKey,
      readItem: (ledgerId: string, itemId: string) =>
        ledgerId === "tasks" && itemId === "T2081"
          ? {
              id: "T2081",
              status: "wip",
              fields: {
                headline: "supervise exact tip",
                description: "run the full gate outside the workspace-write sandbox",
                acceptance: "only a green exact tip becomes consumable",
              },
            }
          : undefined,
    },
    ...(ledgerStore === undefined ? {} : { ledgerStore }),
    implementationEvidenceStore,
    ...(implementationSuccessorLauncher === undefined ? {} : { implementationSuccessorLauncher }),
    repositoryRoot,
    worktreeStateDir: stateDir,
    supervisedWorkerGateRunner: runner,
    now,
    randomBytes: sequentialDispatchRandomBytes(sequence * 32),
  };
  const capability = createDispatchCapability(capabilityOptions);
  const expectedChild = {
    childId: `implement-worker#candidate-correlation-${sequence}`,
    runId: `run-${sequence}`,
  };
  const prepareEnvelope = {
    idempotencyKey: `T2081-${sequence}`,
    timeoutMs: 600_000,
    expectedChild,
  } as const;
  const prepared =
    prepareForm === "refs"
      ? await capability.prepare({
          ...prepareEnvelope,
          refs: {
            roleId: "implement-worker",
            surface: "codex",
            projectKey: namespace.projectKey,
            taskId: "T2081",
            coordinates: {
              worktreePath: managed.handle.absolutePath,
              branch: managed.handle.branch,
              baseCommit: dispatchBaseCommit,
            },
            round: 0,
            startingCommit: dispatchBaseCommit,
            validationIntent,
          },
        })
      : await capability.prepare({
          ...prepareEnvelope,
          roleId: "implement-worker",
          input: {
            taskId: "T2081",
            headline: "supervise exact tip",
            description: "run the full gate outside the workspace-write sandbox",
            acceptance: "only a green exact tip becomes consumable",
            worktreePath: managed.handle.absolutePath,
            branch: managed.handle.branch,
            baseCommit: dispatchBaseCommit,
            round: 0,
            startingCommit: dispatchBaseCommit,
            validationIntent,
          },
        });
  if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
    throw new Error("worker dispatch did not receive Git authority");
  }
  await capability.fetchInput({
    attestationId: prepared.prepared.attestationId,
    generation: prepared.prepared.generation,
    inputCapability: prepared.prepared.inputCapability,
  });
  await fs.writeFile(path.join(managed.handle.absolutePath, "file.txt"), "after\n");
  const wipFiles: readonly { readonly path: string; readonly body: string }[] =
    wipFixture === "malformed"
      ? [{ path: `WIP-${managed.handle.taskId}.md`, body: "not a WIP artifact\n" }]
      : (wipFixture === "exact"
          ? [{ taskId: managed.handle.taskId, path: `WIP-${managed.handle.taskId}.md` }]
          : wipFixture === "foreign"
            ? [
                { taskId: "T2234", path: "WIP-T2234.md" },
                { taskId: "T2235", path: "WIP-T2235.md" },
              ]
            : wipFixture === "modified-foreign"
              ? [{ taskId: "T2234", path: "WIP-T2234.md" }]
              : []
        ).map(({ taskId, path: wipPath }) => ({
          path: wipPath,
          body: wipFixtureBody(
            taskId,
            dispatchBaseCommit,
            wipFixture === "modified-foreign"
              ? "Candidate modified an earlier task artifact.\n"
              : "Awaiting the runner-owned parent gate.\n",
          ),
        }));
  for (const wip of wipFiles) {
    await fs.writeFile(path.join(managed.handle.absolutePath, wip.path), wip.body);
  }
  if (capability.gitCommit === undefined) throw new Error("git_commit unavailable");
  const receipt = await capability.gitCommit({
    attestationId: prepared.prepared.attestationId,
    generation: prepared.prepared.generation,
    gitChangeCapability: prepared.prepared.gitChangeCapability,
    operationId: `T2081-${sequence}-commit`,
    expectedHead: dispatchBaseCommit,
    message: "supervised result",
    changes: [
      {
        kind: "modify",
        path: "file.txt",
        oldState: { mode: "100644", digest: sha256("before\n") },
        newState: { mode: "100644", digest: sha256("after\n") },
      },
      ...wipFiles.map((wip) => {
        const oldBody = baseWipBodies.get(wip.path);
        return oldBody === undefined
          ? {
              kind: "add" as const,
              path: wip.path,
              newState: { mode: "100644" as const, digest: sha256(wip.body) },
            }
          : {
              kind: "modify" as const,
              path: wip.path,
              oldState: { mode: "100644" as const, digest: sha256(oldBody) },
              newState: { mode: "100644" as const, digest: sha256(wip.body) },
            };
      }),
    ],
  });
  const output = {
    taskId: "T2081",
    status: "pass",
    resultCommit: receipt.newHead,
    branch: managed.handle.branch,
    actualWorktreePath: managed.handle.absolutePath,
    filesTouched: [...receipt.paths],
    gitReceipts: [{ ...receipt, objectOids: [...receipt.objectOids], paths: [...receipt.paths] }],
    checkSummary: "runner-supervised gate requested",
    ...(validationIntent === "focused-only"
      ? {
          focusedChecks: [
            {
              command: "bun test focused.test.ts",
              exitCode: 0,
              passCount: 1,
              failCount: 0,
            },
          ],
        }
      : {}),
    summary: "candidate exact tip",
    baseVerification: {
      status: "verified",
      relation: "descendant",
      baseCommit: dispatchBaseCommit,
      headCommit: receipt.newHead,
    },
  };
  return {
    capabilityOptions,
    capability,
    repositoryRoot,
    managed,
    prepared: prepared.prepared,
    receipt,
    output,
    store,
    backend,
    ledgerStore,
    implementationEvidenceStore,
    runner,
    dispatchBaseCommit,
    expectedChild,
    stateDir,
  };
}

async function fixture(
  runner: SupervisedWorkerGateRunner = new GateDummy(),
  withLedgerStore = false,
) {
  return await fixtureWithDispatchBase(
    runner,
    "managed",
    () => "2026-08-12T20:00:00.000Z",
    false,
    withLedgerStore,
  );
}

type GateFixture = Awaited<ReturnType<typeof fixture>>;

async function resolveRecovery(subject: GateFixture) {
  const binding = await resolveManagedWorktreeDispatchBinding(
    {
      repositoryRoot: subject.repositoryRoot,
      taskId: subject.managed.handle.taskId,
      worktreePath: subject.managed.handle.absolutePath,
      branch: subject.managed.handle.branch,
    },
    { stateDir: subject.stateDir },
  );
  if (binding === null || subject.capability.resolveRecovery === undefined)
    throw new Error("missing recovery binding");
  return await subject.capability.resolveRecovery(binding, subject.receipt.newHead);
}

function parentGateInput(subject: GateFixture) {
  if (subject.prepared.parentGateCapability === undefined) {
    throw new Error("worker dispatch did not receive parent gate authority");
  }
  return {
    attestationId: subject.prepared.attestationId,
    generation: subject.prepared.generation,
    parentGateCapability: subject.prepared.parentGateCapability,
  };
}

async function stage(subject: GateFixture) {
  return await subject.capability.storeResult({
    resultCapability: subject.prepared.resultCapability,
    output: subject.output,
  });
}

async function finalize(subject: GateFixture) {
  if (subject.capability.finalizeParentGate === undefined) {
    throw new Error("parent gate finalizer is unavailable");
  }
  return await subject.capability.finalizeParentGate(parentGateInput(subject));
}

async function stageAndFinalize(subject: GateFixture) {
  expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
  return await finalize(subject);
}

test("intentional worker failure is consumed without queue or gate side effects", async () => {
  const runner = new GateDummy();
  let successorLaunches = 0;
  const subject = await fixtureWithDispatchBase(
    runner,
    "managed",
    () => "2026-08-12T20:00:00.000Z",
    false,
    true,
    async () => {
      successorLaunches += 1;
    },
  );
  const failure = {
    ...subject.output,
    status: "fail",
    resultCommit: null,
    blockedReason: "intentional worker failure",
  } as const;
  expect(
    await subject.capability.storeResult({
      resultCapability: subject.prepared.resultCapability,
      output: failure,
    }),
  ).toMatchObject({ state: "gate-pending" });
  if (subject.capability.qualifyImplementationCandidate === undefined) {
    throw new Error("implementation candidate qualification is unavailable");
  }
  const observation = {
    attestationId: subject.prepared.attestationId,
    generation: subject.prepared.generation,
    roleId: "implement-worker",
    correlationId: subject.expectedChild.childId.slice("implement-worker#".length),
    childThreadId: "intentional-fail-child-thread",
    expectedRunId: subject.expectedChild.runId,
    outcome: "completed" as const,
    exitStatus: 0,
    observedAt: "2026-08-12T20:00:02.000Z",
    promptDigest: subject.prepared.promptProvenance.promptDigest,
  };
  const consumed = await subject.capability.qualifyImplementationCandidate(observation);
  expect(consumed).toMatchObject({
    state: "consumed",
    result: {
      state: "consumed",
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
    },
  });
  expect(await subject.capability.qualifyImplementationCandidate(observation)).toEqual(consumed);
  await expect(
    subject.capability.qualifyImplementationCandidate({
      ...observation,
      childThreadId: "altered-intentional-fail-child-thread",
    }),
  ).rejects.toThrow("different qualification observation");
  expect(await subject.capability.fetch(subject.prepared)).toMatchObject({
    state: "consumed",
    output: failure,
  });
  expect(await subject.capability.fetch(subject.prepared)).toMatchObject({
    state: "output-already-materialized",
  });
  expect(runner.requests).toHaveLength(0);
  expect(successorLaunches).toBe(0);
  expect(subject.backend.storedRows()[0]).toMatchObject({
    state: "consumed",
    dispatchContinuationBinding: {
      currentRecoverySource: { kind: "consumed-fail", version: 1, status: "fail" },
    },
  });
  expect(subject.backend.storedRows()[0]?.implementationQueue).toBeUndefined();
});

test("real SQLite reopens and replays one consumed intentional failure", async () => {
  const runner = new GateDummy();
  let successorLaunches = 0;
  const subject = await fixtureWithDispatchBase(
    runner,
    "managed",
    () => "2026-08-12T20:00:00.000Z",
    false,
    true,
    async () => {
      successorLaunches += 1;
    },
    artifactStore(),
    "sqlite",
  );
  const failure = {
    ...subject.output,
    status: "fail",
    resultCommit: null,
    blockedReason: "intentional SQLite worker failure",
  } as const;
  expect(
    await subject.capability.storeResult({
      resultCapability: subject.prepared.resultCapability,
      output: failure,
    }),
  ).toMatchObject({ state: "gate-pending" });
  await subject.backend.close();
  const backend = new SqliteAttestationBackend({
    namespace: subject.backend.namespace,
    dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
  });
  const capability = createDispatchCapability({ ...subject.capabilityOptions, backend });
  try {
    if (capability.qualifyImplementationCandidate === undefined) {
      throw new Error("SQLite qualification is unavailable after reopen");
    }
    const observation = {
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
      roleId: "implement-worker",
      correlationId: subject.expectedChild.childId.slice("implement-worker#".length),
      childThreadId: "sqlite-intentional-fail-child-thread",
      expectedRunId: subject.expectedChild.runId,
      outcome: "completed" as const,
      exitStatus: 0,
      observedAt: "2026-08-12T20:00:02.000Z",
      promptDigest: subject.prepared.promptProvenance.promptDigest,
    };
    const consumed = await capability.qualifyImplementationCandidate(observation);
    expect(consumed).toMatchObject({ state: "consumed" });
    expect(await capability.qualifyImplementationCandidate(observation)).toEqual(consumed);
    await expect(
      capability.qualifyImplementationCandidate({
        ...observation,
        childThreadId: "changed-sqlite-intentional-fail-child-thread",
      }),
    ).rejects.toThrow("different qualification observation");
    expect(await capability.fetch(subject.prepared)).toMatchObject({
      state: "consumed",
      output: failure,
    });
    const row = await backend.transact({ kind: "handle", handle: subject.prepared }, (store) =>
      store.read(subject.prepared),
    );
    expect(row).toMatchObject({
      state: "consumed",
      dispatchContinuationBinding: {
        currentRecoverySource: { kind: "consumed-fail", status: "fail" },
      },
    });
    expect(row?.kind === "envelope" ? row.implementationQueue : undefined).toBeUndefined();
    expect(runner.requests).toHaveLength(0);
    expect(successorLaunches).toBe(0);
  } finally {
    await backend.close();
  }
});

test("intentional failure receipt and manager substitutions fail closed before consumption", async () => {
  const cases = [
    {
      label: "incomplete receipts",
      mutate: (subject: GateFixture) => ({ ...subject.output, gitReceipts: [] }),
      expected: "omits or invents",
    },
    {
      label: "substituted receipt",
      mutate: (subject: GateFixture) => ({
        ...subject.output,
        gitReceipts: [{ ...subject.output.gitReceipts[0]!, requestDigest: "f".repeat(64) }],
      }),
      expected: "does not match its durable journal",
    },
    {
      label: "extended receipts",
      mutate: (subject: GateFixture) => ({
        ...subject.output,
        gitReceipts: [...subject.output.gitReceipts, ...subject.output.gitReceipts],
      }),
      expected: "omits or invents",
    },
    {
      label: "foreign task",
      mutate: (subject: GateFixture) => ({ ...subject.output, taskId: "T9999" }),
      expected: "taskId does not match",
    },
    {
      label: "foreign branch",
      mutate: (subject: GateFixture) => ({ ...subject.output, branch: "implement/T9999" }),
      expected: "branch does not match",
    },
    {
      label: "foreign worktree",
      mutate: (subject: GateFixture) => ({
        ...subject.output,
        actualWorktreePath: path.join(subject.repositoryRoot, "foreign-worktree"),
      }),
      expected: "worktree path does not match",
    },
  ] as const;
  for (const control of cases) {
    const runner = new GateDummy();
    const subject = await fixtureWithDispatchBase(
      runner,
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      false,
      true,
    );
    const failure = {
      ...control.mutate(subject),
      status: "fail",
      resultCommit: null,
      blockedReason: `controlled ${control.label}`,
    } as const;
    expect(
      await subject.capability.storeResult({
        resultCapability: subject.prepared.resultCapability,
        output: failure,
      }),
      control.label,
    ).toMatchObject({ state: "gate-pending" });
    if (subject.capability.qualifyImplementationCandidate === undefined) {
      throw new Error("implementation candidate qualification is unavailable");
    }
    await expect(
      subject.capability.qualifyImplementationCandidate({
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
        roleId: "implement-worker",
        correlationId: subject.expectedChild.childId.slice("implement-worker#".length),
        childThreadId: `rejected-${control.label.replaceAll(" ", "-")}`,
        expectedRunId: subject.expectedChild.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt: "2026-08-12T20:00:02.000Z",
        promptDigest: subject.prepared.promptProvenance.promptDigest,
      }),
      control.label,
    ).rejects.toThrow(control.expected);
    const row = await subject.backend.transact(
      { kind: "handle", handle: subject.prepared },
      (store) => store.read(subject.prepared),
    );
    expect(row, control.label).toMatchObject({ state: "gate-pending" });
    expect(row?.kind === "envelope" ? row.implementationQueue : undefined).toBeUndefined();
    expect(runner.requests, control.label).toHaveLength(0);
  }
});

test("malformed failure and invalid pass receipts cannot consume or enter the queue", async () => {
  for (const status of ["fail", "pass"] as const) {
    const runner = new GateDummy();
    const subject = await fixtureWithDispatchBase(
      runner,
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      false,
      true,
    );
    const output = {
      ...subject.output,
      status,
      ...(status === "fail" ? { resultCommit: null, blockedReason: "malformed receipt" } : {}),
      gitReceipts: [{ ...subject.output.gitReceipts[0]!, requestDigest: "f".repeat(64) }],
    } as const;
    if (status === "pass") {
      await expect(
        subject.capability.storeResult({
          resultCapability: subject.prepared.resultCapability,
          output,
        }),
      ).rejects.toThrow("does not match its durable journal");
    } else {
      const malformed = { ...output, gitReceipts: [{ kind: "not-a-receipt" }] };
      expect(
        await subject.capability.storeResult({
          resultCapability: subject.prepared.resultCapability,
          output: malformed as never,
        }),
      ).toMatchObject({ state: "aborted", result: { reason: "invalid-output" } });
    }
    expect(runner.requests).toHaveLength(0);
    const row = await subject.backend.transact(
      { kind: "handle", handle: subject.prepared },
      (store) => store.read(subject.prepared),
    );
    expect(row?.kind === "envelope" ? row.implementationQueue : undefined).toBeUndefined();
  }
});

test("reordered intentional-failure receipts are rejected before consumption", async () => {
  const runner = new GateDummy();
  const subject = await fixtureWithDispatchBase(
    runner,
    "managed",
    () => "2026-08-12T20:00:00.000Z",
    false,
    true,
  );
  if (
    subject.capability.gitCommit === undefined ||
    subject.prepared.gitChangeCapability === undefined ||
    subject.capability.qualifyImplementationCandidate === undefined
  ) {
    throw new Error("brokered qualification is unavailable");
  }
  await fs.writeFile(path.join(subject.managed.handle.absolutePath, "extra.txt"), "extra\n");
  const secondReceipt = await subject.capability.gitCommit({
    attestationId: subject.prepared.attestationId,
    generation: subject.prepared.generation,
    gitChangeCapability: subject.prepared.gitChangeCapability,
    operationId: `T2081-${sequence}-second-commit`,
    expectedHead: subject.receipt.newHead,
    message: "second supervised result",
    changes: [
      {
        kind: "add",
        path: "extra.txt",
        newState: { mode: "100644", digest: sha256("extra\n") },
      },
    ],
  });
  const failure = {
    ...subject.output,
    status: "fail",
    resultCommit: null,
    blockedReason: "controlled reordered receipt closure",
    filesTouched: ["extra.txt", "file.txt"],
    gitReceipts: [secondReceipt, subject.receipt].map((receipt) => ({
      ...receipt,
      objectOids: [...receipt.objectOids],
      paths: [...receipt.paths],
    })),
    baseVerification: {
      ...subject.output.baseVerification,
      headCommit: secondReceipt.newHead,
    },
  } as const;
  expect(
    await subject.capability.storeResult({
      resultCapability: subject.prepared.resultCapability,
      output: failure,
    }),
  ).toMatchObject({ state: "gate-pending" });
  await expect(
    subject.capability.qualifyImplementationCandidate({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
      roleId: "implement-worker",
      correlationId: subject.expectedChild.childId.slice("implement-worker#".length),
      childThreadId: "reordered-receipts-child-thread",
      expectedRunId: subject.expectedChild.runId,
      outcome: "completed",
      exitStatus: 0,
      observedAt: "2026-08-12T20:00:02.000Z",
      promptDigest: subject.prepared.promptProvenance.promptDigest,
    }),
  ).rejects.toThrow("does not match its durable journal");
  const row = await subject.backend.transact(
    { kind: "handle", handle: subject.prepared },
    (store) => store.read(subject.prepared),
  );
  expect(row).toMatchObject({ state: "gate-pending" });
  expect(row?.kind === "envelope" ? row.implementationQueue : undefined).toBeUndefined();
  expect(runner.requests).toHaveLength(0);
});

const D342_ADMISSION_TIMEOUT_MS = 15_000;
const D342_EXECUTION_TIMEOUT_MS = 5_000;
const D342_MARKER_TIMEOUT_MS = 90_000;
const D342_TEST_TIMEOUT_MS = 300_000;
const D342_REAP_TIMEOUT_MS = 5_000;
const D342_DEADLINE_MESSAGE = "supervised worker gate exceeded its host execution deadline";
const D342_MARKER_ENV = "CQ_D342_MARKER";

async function waitForD342Marker(markerPath: string): Promise<void> {
  const deadline = Date.now() + D342_MARKER_TIMEOUT_MS;
  for (;;) {
    if (await Bun.file(markerPath).exists()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `D342 marker timeout: blocking child reported no live marker within ${String(D342_MARKER_TIMEOUT_MS)} ms`,
      );
    }
    await Bun.sleep(5);
  }
}

interface ParentGateProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnParentGateProcess(
  configPath: string,
  workerId: "first" | "peer",
): Promise<ParentGateProcessResult> {
  const child = Bun.spawn([process.execPath, PARENT_GATE_PROCESS_WORKER, configPath, workerId], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
}

async function readInvocationMarker(markerPath: string): Promise<string[]> {
  try {
    const body = await fs.readFile(markerPath, "utf8");
    return body.trim() === "" ? [] : body.trim().split("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function observeForbiddenPeerInvocation(markerPath: string): Promise<string[]> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const invocations = await readInvocationMarker(markerPath);
    if (invocations.length > 1 || Date.now() >= deadline) return invocations;
    await Bun.sleep(5);
  }
}

function d342KillProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

function d342ProcessAbsent(pid: number): boolean {
  return d342KillProbe(pid);
}

function d342GroupAbsent(pgid: number): boolean {
  return d342KillProbe(-pgid);
}

/** Hygiene, never assertion: reap the blocking child's group after a fail-first run. */
async function reapD342MarkerGroup(markerPath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(markerPath, "utf8");
  } catch {
    return;
  }
  const pgid = Number(content.trim().split(/\s+/u)[1]);
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (d342GroupAbsent(pgid)) return;
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + D342_REAP_TIMEOUT_MS;
    while (!d342GroupAbsent(pgid) && Date.now() < deadline) await Bun.sleep(10);
  }
}

type D342RootFault =
  { readonly kind: "reject"; readonly detail: string } | { readonly kind: "survivors" };

/** Hand-written worktree-arm wrapper: records the call, settles for real, then injects. */
class D342WorktreeSettlement {
  calls = 0;

  constructor(private readonly rejection: string | undefined) {}

  readonly settle = async (
    options: SettleWorktreeGateCommandsOptions,
  ): Promise<SettleProcessGroupsResult> => {
    this.calls += 1;
    const result = await settleWorktreeGateCommands(options);
    if (this.rejection !== undefined) throw new Error(this.rejection);
    return result;
  };
}

/**
 * Hand-written registered-root wrapper: observes the registration and the live
 * marker, performs the real settlement, then injects a rejection or a survivor
 * list carrying the concrete registered PGIDs.
 */
class D342RootSettlement {
  calls = 0;
  readonly observed: ProcessGroupRegistration[] = [];
  realResult: SettleProcessGroupsResult | undefined;

  constructor(
    private readonly markerPath: string,
    private readonly fault: D342RootFault | undefined,
  ) {}

  readonly settle = async (
    registrations: readonly ProcessGroupRegistration[],
  ): Promise<SettleProcessGroupsResult> => {
    this.calls += 1;
    this.observed.push(...registrations);
    await waitForD342Marker(this.markerPath);
    const result = await settleProcessGroups(registrations);
    this.realResult = result;
    if (this.fault?.kind === "reject") throw new Error(this.fault.detail);
    if (this.fault?.kind === "survivors") {
      return { signaled: result.signaled, survivors: registrations.map(({ pgid }) => pgid) };
    }
    return result;
  };
}

interface D342Scenario {
  readonly failure: unknown;
  readonly worktreeArm: D342WorktreeSettlement;
  readonly rootArm: D342RootSettlement;
  readonly markerPath: string;
}

async function runD342Scenario(options: {
  readonly worktreeRejection?: string;
  readonly rootFault?: D342RootFault;
}): Promise<D342Scenario> {
  sequence += 1;
  const root = await fs.mkdtemp(path.join(tmpdir(), `t2230-d342-${sequence}-`));
  roots.push(root);
  const worktreePath = path.join(root, "worktree");
  await fs.mkdir(path.join(worktreePath, "nix", "pkg", "cq-ledgers"), { recursive: true });
  await git(worktreePath, ["init", "-q"]);
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  const markerPath = path.join(root, "child-live");
  const cq = path.join(bin, "cq");
  await fs.writeFile(
    cq,
    [
      "#!/bin/sh",
      "set -eu",
      'printf \'%s %s\\n\' "$$" "$(ps -o pgid= -p $$ | tr -d \'[:space:]\')" > "$CQ_D342_MARKER"',
      "exec sleep 86400",
      "",
    ].join("\n"),
  );
  await fs.chmod(cq, 0o700);
  const worktreeArm = new D342WorktreeSettlement(options.worktreeRejection);
  const rootArm = new D342RootSettlement(markerPath, options.rootFault);
  const settlement: NodeSupervisedWorkerGateSettlement = {
    settleWorktreeGateCommands: worktreeArm.settle,
    settleProcessGroups: rootArm.settle,
  };
  const runner = createNodeSupervisedWorkerGateRunner(settlement);
  const priorPath = process.env["PATH"];
  const priorMarker = process.env[D342_MARKER_ENV];
  process.env["PATH"] = `${bin}${path.delimiter}${priorPath ?? ""}`;
  process.env[D342_MARKER_ENV] = markerPath;
  let failure: unknown;
  try {
    await runner.run({
      worktreePath,
      admissionTimeoutMs: D342_ADMISSION_TIMEOUT_MS,
      executionTimeoutMs: D342_EXECUTION_TIMEOUT_MS,
      cancellationSignal: new AbortController().signal,
    });
    failure = new Error("D342 scenario unexpectedly completed the supervised gate");
  } catch (error) {
    failure = error;
  } finally {
    if (priorPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = priorPath;
    if (priorMarker === undefined) delete process.env[D342_MARKER_ENV];
    else process.env[D342_MARKER_ENV] = priorMarker;
    await reapD342MarkerGroup(markerPath);
  }
  return { failure, worktreeArm, rootArm, markerPath };
}

/** Observation and absence proof shared by every D342 scenario. */
async function expectD342ObservationAndAbsence(scenario: D342Scenario): Promise<void> {
  const registration = scenario.rootArm.observed[0];
  if (registration === undefined) {
    throw new Error("D342 root settlement observed no registered process group");
  }
  expect(Number.isSafeInteger(registration.pgid)).toBe(true);
  expect(registration.pgid).toBeGreaterThan(1);
  expect(registration.leader.pid).toBe(registration.pgid);
  expect(registration.leader.startTime).not.toBe("");
  expect(await Bun.file(scenario.markerPath).exists()).toBe(true);
  expect(scenario.rootArm.realResult?.signaled).toContain(registration.pgid);
  expect(d342GroupAbsent(registration.pgid)).toBe(true);
  expect(d342ProcessAbsent(registration.leader.pid)).toBe(true);
}

/**
 * D326/T2231 named bounds (D341: the retired 100 ms allowance let host process
 * startup consume the semantic execution budget). The queued child's admission
 * wait overlaps the first run; it never extends the serial enclosure below.
 */
const FIRST_EXECUTION_TIMEOUT_MS = 15_000;
const QUEUED_EXECUTION_TIMEOUT_MS = 5_000;
const ADMISSION_HOLD_MS = 6_000;
const QUEUED_ADMISSION_TIMEOUT_MS = 90_000;
const D326_TEST_TIMEOUT_MS = 300_000;
const D326_LAUNCH_HANDSHAKE_MS = 60_000;
const D326_RUN_SETTLEMENT_MS = 40_000;
const D326_SERIAL_ENCLOSURE_MS =
  2 * D326_LAUNCH_HANDSHAKE_MS +
  FIRST_EXECUTION_TIMEOUT_MS +
  QUEUED_EXECUTION_TIMEOUT_MS +
  2 * D326_RUN_SETTLEMENT_MS;

interface ChildIdentityMarker {
  readonly pid: number;
  readonly pgid: number;
}

function parseChildIdentityMarker(content: string): ChildIdentityMarker | undefined {
  const fields = content.trim().split(/\s+/u);
  if (fields.length !== 2) return undefined;
  const pid = Number(fields[0]);
  const pgid = Number(fields[1]);
  if (
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(pgid) ||
    pid <= 1 ||
    pgid <= 1 ||
    pid === pgid
  ) {
    return undefined;
  }
  return { pid, pgid };
}

/** Bounded wait until the marker names its child as a non-empty "pid pgid" pair. */
async function waitForChildIdentityMarker(markerPath: string): Promise<ChildIdentityMarker> {
  const deadline = Date.now() + D342_MARKER_TIMEOUT_MS;
  for (;;) {
    let content: string | undefined;
    try {
      content = await fs.readFile(markerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (content !== undefined) {
      const identity = parseChildIdentityMarker(content);
      if (identity !== undefined) return identity;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `child identity marker timeout: no non-empty PID/PGID marker within ${String(D342_MARKER_TIMEOUT_MS)} ms`,
      );
    }
    await Bun.sleep(5);
  }
}

async function pathAbsent(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("T2081 supervised worker result storage [Effectual-GoodCommunication]", () => {
  test("D343 staged timing basis keeps the ledger effect-lock acquisition source-bound [Behavioral-Active Blackbox-Atomic]", () => {
    expect(SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS).toBe(3_600_000);
    expect(SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS).toBe(
      CODEX_STAGED_TIMING_BASIS.storeResultEffectLockAcquisitionMs,
    );
    expect(CODEX_STAGED_TIMING_BASIS.storeResultSubmissionBudgetMs).toBe(3_960_000);
    expect(CODEX_STAGED_TIMING_BASIS.parentGateWindowMs).toBe(9_611_000);
  });

  test("production coordinator gates, confirms, and retains one qualified managed front for review", async () => {
    const runner = new GateDummy();
    const subject = await fixture(runner, true);
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    if (
      subject.capability.qualifyImplementationCandidate === undefined ||
      subject.capability.coordinateImplementationCandidate === undefined ||
      subject.prepared.parentGateCapability === undefined
    ) {
      throw new Error("implementation candidate runtime is unavailable");
    }
    const correlationId = subject.expectedChild.childId.slice("implement-worker#".length);
    const qualified = await subject.capability.qualifyImplementationCandidate({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
      roleId: "implement-worker",
      correlationId,
      childThreadId: "managed-child-thread",
      expectedRunId: subject.expectedChild.runId,
      outcome: "completed",
      exitStatus: 0,
      observedAt: "2026-08-12T20:00:02.000Z",
      promptDigest: subject.prepared.promptProvenance.promptDigest,
    });
    if (qualified.state !== "queued") throw new Error("candidate did not qualify");

    const outcome = await subject.capability.coordinateImplementationCandidate({
      partitionKey: qualified.partitionKey,
      holderId: "production-coordinator",
    });

    expect(outcome).toEqual({
      state: "completed",
      handle: {
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
      },
    });
    expect(runner.requests).toHaveLength(1);
    const confirmed = subject.store.rows()[0];
    expect(confirmed).toMatchObject({
      state: "consumed",
      implementationQueue: {
        state: "leased",
        leaseGeneration: 1,
        lease: { holderId: "production-coordinator", generation: 1 },
      },
    });
    expect(confirmed).not.toHaveProperty("outputMaterializedAt");

    expect(
      await subject.capability.coordinateImplementationCandidate({
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
        holderId: "production-coordinator",
        parentGateCapability: subject.prepared.parentGateCapability,
      }),
    ).toMatchObject({ state: "empty", partitionKey: qualified.partitionKey });
    expect(runner.requests).toHaveLength(1);

    await subject.backend.transact({ kind: "handle", handle: subject.prepared }, (store) => {
      const row = store.read(subject.prepared);
      if (
        row === undefined ||
        isAttestationTombstone(row) ||
        row.output === null ||
        typeof row.output !== "object" ||
        Array.isArray(row.output)
      ) {
        throw new Error("consumed candidate output is unavailable");
      }
      const output = row.output as Readonly<Record<string, DispatchJSONValue>>;
      const gate = output["supervisedGateEvidence"];
      if (gate === null || typeof gate !== "object" || Array.isArray(gate)) {
        throw new Error("consumed candidate gate evidence is unavailable");
      }
      store.replace(
        row,
        Object.freeze({
          ...row,
          output: {
            ...output,
            supervisedGateEvidence: { ...gate, taskId: "T9999" },
          } as DispatchJSONValue,
        }),
      );
    });
    await expect(
      subject.capability.coordinateImplementationCandidate({
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
        holderId: "production-coordinator",
        parentGateCapability: subject.prepared.parentGateCapability,
      }),
    ).rejects.toThrow("consumed implementation front lost its exact gate and lease authority");
    expect(runner.requests).toHaveLength(1);

    const fetched = await subject.capability.fetch({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
    });
    expect(fetched).toMatchObject({
      state: "consumed",
      output: {
        status: "pass",
        resultCommit: subject.receipt.newHead,
      },
    });
    await expect(
      subject.capability.fetch({
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
      }),
    ).resolves.toMatchObject({ state: "output-already-materialized" });
    expect(runner.requests).toHaveLength(1);
  });

  // regression: D497 — a child PASS is not parent authority to broaden focused validation.
  test("refs-only focused validation continues into one explicit final gate without stranded ownership [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const runner = new GateDummy();
    const subject = await fixtureWithDispatchBase(
      runner,
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      false,
      true,
      undefined,
      artifactStore(),
      "memory",
      "focused-only",
      "refs",
    );
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    if (
      subject.capability.qualifyImplementationCandidate === undefined ||
      subject.capability.coordinateImplementationCandidate === undefined
    ) {
      throw new Error("focused implementation candidate runtime is unavailable");
    }
    const qualified = await subject.capability.qualifyImplementationCandidate({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
      roleId: "implement-worker",
      correlationId: subject.expectedChild.childId.slice("implement-worker#".length),
      childThreadId: "focused-validation-child-thread",
      expectedRunId: subject.expectedChild.runId,
      outcome: "completed",
      exitStatus: 0,
      observedAt: "2026-08-12T20:00:02.000Z",
      promptDigest: subject.prepared.promptProvenance.promptDigest,
    });
    if (qualified.state !== "queued") throw new Error("focused candidate did not qualify");

    expect(
      await subject.capability.coordinateImplementationCandidate({
        partitionKey: qualified.partitionKey,
        holderId: "focused-validation-coordinator",
      }),
    ).toMatchObject({
      state: "completed",
      handle: {
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
      },
    });
    expect(runner.requests).toHaveLength(0);
    expect(subject.store.rows()[0]).toMatchObject({
      state: "consumed",
      output: { focusedChecks: [{ exitCode: 0, passCount: 1, failCount: 0 }] },
    });
    if (subject.prepared.parentGateCapability === undefined) {
      throw new Error("focused dispatch omitted parent coordination authority");
    }
    expect(
      await subject.capability.coordinateImplementationCandidate({
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
        holderId: "focused-validation-coordinator",
        parentGateCapability: subject.prepared.parentGateCapability,
      }),
    ).toMatchObject({ state: "empty", partitionKey: qualified.partitionKey });
    expect(runner.requests).toHaveLength(0);

    const malformedRows = subject.store.rows().length;
    for (const validationIntent of [undefined, "child-selected"] as const) {
      const refs: Record<string, unknown> = {
        roleId: "implement-worker",
        surface: "codex",
        projectKey: subject.store.namespace.projectKey,
        taskId: "T2081",
        coordinates: {
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: subject.dispatchBaseCommit,
        },
        round: 1,
        startingCommit: subject.receipt.newHead,
        priorResultCommit: subject.receipt.newHead,
        ...(validationIntent === undefined ? {} : { validationIntent }),
      };
      const rejected = await subject.capability.prepare({
        refs: refs as never,
        idempotencyKey: `T2081-${String(sequence)}-invalid-${String(validationIntent)}`,
        timeoutMs: 600_000,
        expectedChild: {
          childId: `implement-worker#invalid-${String(validationIntent)}`,
          runId: `invalid-${String(validationIntent)}`,
        },
      });
      expect(rejected).toMatchObject({
        accepted: false,
        allocated: false,
        reason: "invalid-refs-form",
        path: "refs.validationIntent",
      });
    }
    expect(subject.store.rows()).toHaveLength(malformedRows);

    if (subject.capability.resolveContinuation === undefined) {
      throw new Error("focused completion omitted continuation authority");
    }
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: subject.repositoryRoot,
        taskId: subject.managed.handle.taskId,
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
      },
      { stateDir: subject.stateDir },
    );
    if (binding === null) throw new Error("focused completion lost its managed binding");
    const continuation = await subject.capability.resolveContinuation(
      binding,
      subject.receipt.newHead,
    );
    const finalChild = {
      childId: `implement-worker#final-validation-${String(sequence)}`,
      runId: `final-validation-${String(sequence)}`,
    };
    const finalPrepared = await subject.capability.prepare({
      refs: {
        roleId: "implement-worker",
        surface: "codex",
        projectKey: subject.store.namespace.projectKey,
        taskId: "T2081",
        coordinates: {
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: subject.dispatchBaseCommit,
        },
        round: 1,
        startingCommit: subject.receipt.newHead,
        validationIntent: "final",
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-final-validation`,
      timeoutMs: 600_000,
      expectedChild: finalChild,
      continuation: continuation.continuationReference,
    });
    if (!finalPrepared.accepted) throw new Error(finalPrepared.detail);
    await subject.capability.fetchInput({
      ...finalPrepared.handle,
      inputCapability: finalPrepared.prepared.inputCapability,
    });
    const { focusedChecks: _focusedChecks, ...finalOutput } =
      subject.output as typeof subject.output & { readonly focusedChecks: DispatchJSONValue };
    expect(
      await subject.capability.storeResult({
        resultCapability: finalPrepared.prepared.resultCapability,
        output: {
          ...finalOutput,
          gitReceipts: [],
          checkSummary: "explicit final validation after focused checks",
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    const finalQualified = await subject.capability.qualifyImplementationCandidate({
      attestationId: finalPrepared.handle.attestationId,
      generation: finalPrepared.handle.generation,
      roleId: "implement-worker",
      correlationId: finalChild.childId.slice("implement-worker#".length),
      childThreadId: "final-validation-child-thread",
      expectedRunId: finalChild.runId,
      outcome: "completed",
      exitStatus: 0,
      observedAt: "2026-08-12T20:00:03.000Z",
      promptDigest: finalPrepared.prepared.promptProvenance.promptDigest,
    });
    if (finalQualified.state !== "queued") throw new Error("final candidate did not qualify");
    expect(
      await subject.capability.coordinateImplementationCandidate({
        partitionKey: finalQualified.partitionKey,
        holderId: "final-validation-coordinator",
      }),
    ).toMatchObject({ state: "completed", handle: finalPrepared.handle });
    expect(runner.requests).toHaveLength(1);
    expect(
      await subject.capability.coordinateImplementationCandidate({
        partitionKey: finalQualified.partitionKey,
        holderId: "final-validation-coordinator",
      }),
    ).toMatchObject({ state: "empty", partitionKey: finalQualified.partitionKey });
    expect(runner.requests).toHaveLength(1);
  });

  test("parent validation intent rejects focused/final evidence substitution before the gate [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const scenarios = [
      {
        intent: "final" as const,
        output: (subject: GateFixture) => ({
          ...subject.output,
          focusedChecks: [
            { command: "bun test substituted.test.ts", exitCode: 0, passCount: 1, failCount: 0 },
          ],
        }),
        expected: "final validation cannot substitute",
      },
      {
        intent: "focused-only" as const,
        output: (subject: GateFixture) => {
          const { focusedChecks: _focusedChecks, ...withoutFocusedChecks } =
            subject.output as typeof subject.output & {
              readonly focusedChecks?: DispatchJSONValue;
            };
          return withoutFocusedChecks;
        },
        expected: "focused-only validation requires",
      },
    ];
    for (const scenario of scenarios) {
      const runner = new GateDummy();
      const subject = await fixtureWithDispatchBase(
        runner,
        "managed",
        () => "2026-08-12T20:00:00.000Z",
        false,
        true,
        undefined,
        artifactStore(),
        "memory",
        scenario.intent,
        "refs",
      );
      expect(
        await subject.capability.storeResult({
          resultCapability: subject.prepared.resultCapability,
          output: scenario.output(subject),
        }),
      ).toMatchObject({ state: "gate-pending" });
      if (
        subject.capability.qualifyImplementationCandidate === undefined ||
        subject.capability.coordinateImplementationCandidate === undefined
      ) {
        throw new Error("implementation candidate runtime is unavailable");
      }
      const qualified = await subject.capability.qualifyImplementationCandidate({
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
        roleId: "implement-worker",
        correlationId: subject.expectedChild.childId.slice("implement-worker#".length),
        childThreadId: `${scenario.intent}-substitution-child-thread`,
        expectedRunId: subject.expectedChild.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt: "2026-08-12T20:00:02.000Z",
        promptDigest: subject.prepared.promptProvenance.promptDigest,
      });
      if (qualified.state !== "queued") throw new Error("substitution candidate did not qualify");
      await expect(
        subject.capability.coordinateImplementationCandidate({
          partitionKey: qualified.partitionKey,
          holderId: `${scenario.intent}-substitution-coordinator`,
        }),
      ).rejects.toThrow(scenario.expected);
      expect(runner.requests).toHaveLength(0);
    }
  });

  // regression: T6520 round 3 — uniqueness is namespace-wide and a
  // handle-scoped SQLite transaction must not enumerate sibling rows.
  test("real SQLite resolves the exact consumed leased candidate through public authority [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const observedNow = () => "2026-08-12T20:00:00.000Z";
    const runner = new GateDummy();
    const subject = await fixtureWithDispatchBase(
      runner,
      "managed",
      observedNow,
      false,
      true,
      undefined,
      artifactStore(),
      "sqlite",
    );
    try {
      expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
      if (
        subject.capability.qualifyImplementationCandidate === undefined ||
        subject.capability.resolveImplementationCandidateAuthority === undefined ||
        subject.capability.coordinateImplementationCandidate === undefined
      ) {
        throw new Error("implementation candidate authority is unavailable");
      }
      const qualified = await subject.capability.qualifyImplementationCandidate({
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
        roleId: "implement-worker",
        correlationId: subject.expectedChild.childId.slice("implement-worker#".length),
        childThreadId: "sqlite-authority-child-thread",
        expectedRunId: subject.expectedChild.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt: observedNow(),
        promptDigest: subject.prepared.promptProvenance.promptDigest,
      });
      if (qualified.state !== "queued") throw new Error("candidate did not qualify");
      expect(
        await subject.capability.coordinateImplementationCandidate({
          partitionKey: qualified.partitionKey,
          holderId: "sqlite-protected-handoff",
        }),
      ).toMatchObject({
        state: "completed",
        handle: {
          attestationId: subject.prepared.attestationId,
          generation: subject.prepared.generation,
        },
      });

      const candidateRequest = {
        workerDispatch: {
          attestationId: subject.prepared.attestationId,
          generation: subject.prepared.generation,
        },
        taskRef: "tasks:T2081",
        resultCommit: subject.receipt.newHead,
      } as const;
      await expect(
        subject.capability.resolveImplementationCandidateAuthority(candidateRequest),
      ).resolves.toMatchObject({
        kind: "cq-implementation-candidate-authority",
        workerDispatch: {
          attestationId: subject.prepared.attestationId,
          generation: subject.prepared.generation,
        },
        leaseHolderId: "sqlite-protected-handoff",
        leaseGeneration: 1,
        taskRef: "tasks:T2081",
        resultCommit: subject.receipt.newHead,
      });
      const canonicalCandidate = await subject.backend.transact(
        { kind: "handle", handle: subject.prepared },
        (store) => {
          const row = store.read(subject.prepared);
          if (
            row?.kind !== "envelope" ||
            row.input === null ||
            typeof row.input !== "object" ||
            Array.isArray(row.input)
          ) {
            throw new Error("consumed candidate input is unavailable");
          }
          store.replace(
            row,
            Object.freeze({
              ...row,
              input: Object.freeze({
                ...row.input,
                description: "mismatched finalized task specification",
              }),
            }),
          );
          return row;
        },
      );
      try {
        await expect(
          subject.capability.resolveImplementationCandidateAuthority(candidateRequest),
        ).rejects.toThrow("implementation candidate task, goal, or finalized manifest changed");
      } finally {
        await subject.backend.transact({ kind: "handle", handle: subject.prepared }, (store) => {
          const row = store.read(subject.prepared);
          if (row?.kind !== "envelope") {
            throw new Error("consumed candidate row is unavailable");
          }
          store.replace(row, canonicalCandidate);
        });
      }
    } finally {
      await subject.backend.close();
    }
  });

  // regression: T6519 round 30 — composed coverage had displaced these boundary controls.
  test("successor launcher keeps private authorities off argv and rejects a foreign returned handle [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const subject = await fixture();
    const managed = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: subject.repositoryRoot,
        taskId: subject.managed.handle.taskId,
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
      },
      { stateDir: subject.stateDir },
    );
    if (
      managed === null ||
      subject.prepared.parentGateCapability === undefined ||
      subject.prepared.gitChangeCapability === undefined
    ) {
      throw new Error("successor launcher fixture lacks exact worker authority");
    }
    const controlRoot = await fs.mkdtemp(path.join(tmpdir(), "t2081-successor-controls-"));
    roots.push(controlRoot);
    const marker = path.join(controlRoot, "argv.json");
    const roleScript = path.join(controlRoot, "controlled-successor.ts");
    await fs.writeFile(
      roleScript,
      `import { writeFile } from "node:fs/promises";
const invocation = JSON.parse(await Bun.stdin.text());
await writeFile(process.env["CQ_T2081_SUCCESSOR_ARGV_MARKER"], JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({
  attestationId: invocation.handle.attestationId,
  generation: invocation.handle.generation + (process.env["CQ_T2081_RETURN_FOREIGN"] === "1" ? 1 : 0),
}));
`,
    );
    const inheritedPath = process.env["PATH"];
    if (inheritedPath === undefined || inheritedPath.trim() === "") {
      throw new Error("test PATH is unavailable");
    }
    const profile = {
      roleCommand: process.execPath,
      roleScript,
      ledgerCommand: "/controlled/cq",
      codexExecutable: "/controlled/codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      sandboxMode: "workspace-write" as const,
    };
    const launchInput = {
      prepared: subject.prepared,
      managed,
      expectedChild: subject.expectedChild,
      timeoutMs: 600_000,
    };
    const launcher = createImplementationSuccessorLauncher(profile, controlRoot, {
      PATH: inheritedPath,
      CQ_T2081_SUCCESSOR_ARGV_MARKER: marker,
    });

    await launcher(launchInput);

    const argv = JSON.parse(await fs.readFile(marker, "utf8")) as readonly string[];
    expect(argv).toEqual([]);
    const renderedArgv = argv.join("\n");
    for (const capability of [
      subject.prepared.inputCapability,
      subject.prepared.resultCapability,
      subject.prepared.parentGateCapability,
      subject.prepared.gitChangeCapability,
    ]) {
      expect(renderedArgv).not.toContain(capability.token);
    }
    const foreignLauncher = createImplementationSuccessorLauncher(profile, controlRoot, {
      PATH: inheritedPath,
      CQ_T2081_SUCCESSOR_ARGV_MARKER: marker,
      CQ_T2081_RETURN_FOREIGN: "1",
    });
    await expect(foreignLauncher(launchInput)).rejects.toThrow(
      "implementation successor boundary returned a foreign handle",
    );
  });

  // regression: T6519 round 29 — the stale-front owner must finish its real successor boundary.
  test("production coordinator retires a stale front and the installed successor boundary completes it [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const scenarioStartedAt = Date.now();
    const observedNow = () => new Date(scenarioStartedAt).toISOString();
    const runner = new GateDummy({
      gateExitCode: 0,
      passCount: 17,
      failCount: 0,
      gateDurationMs: 123,
      capturedAt: new Date(scenarioStartedAt + 1_000).toISOString(),
      outputTail: "17 pass\nRan 17 tests across 4 files.",
    });
    const launchMarker = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "t2081-successor-owner-")),
      "launches.jsonl",
    );
    const launchRoot = path.dirname(launchMarker);
    const phaseMarker = path.join(launchRoot, "phases.jsonl");
    const bridgeRoot = path.join(launchRoot, "bridge");
    const promptRoot = path.join(launchRoot, "prompts");
    const codexExecutable = path.join(launchRoot, "controlled-codex");
    const ledgerCommand = path.join(launchRoot, "controlled-cq");
    const roleInstructions = "Complete the exact guarded successor through the public protocol.\n";
    const roleBytes = new TextEncoder().encode(roleInstructions);
    const promptArtifactStore = artifactStore(sha256(roleInstructions), roleBytes);
    roots.push(launchRoot);
    await fs.mkdir(bridgeRoot);
    await fs.mkdir(path.join(promptRoot, "roles"), { recursive: true });
    await fs.writeFile(path.join(promptRoot, "roles", "implement-worker.md"), roleInstructions);
    await fs.writeFile(
      codexExecutable,
      `#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
const bridgeRoot = process.env["CQ_T2081_BRIDGE_ROOT"];
const launchMarker = process.env["CQ_T2081_SUCCESSOR_MARKER"];
const phaseMarker = process.env["CQ_T2081_PHASE_MARKER"];
if (bridgeRoot === undefined || launchMarker === undefined || phaseMarker === undefined) throw new Error("controlled Codex environment is incomplete");
async function bridge(operation, request) {
  const id = randomUUID();
  const requestPath = path.join(bridgeRoot, id + ".request.json");
  const temporaryPath = requestPath + ".tmp";
  const responsePath = path.join(bridgeRoot, id + ".response.json");
  await writeFile(temporaryPath, JSON.stringify({ id, operation, request }));
  await rename(temporaryPath, requestPath);
  for (;;) {
    try {
      const response = JSON.parse(await readFile(responsePath, "utf8"));
      await unlink(responsePath);
      if (response.ok !== true) throw new Error(response.error);
      return response.value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await Bun.sleep(5);
  }
}
const launch = JSON.parse(await Bun.stdin.text());
const handle = { attestationId: launch.attestationId, generation: launch.generation };
await appendFile(launchMarker, JSON.stringify(handle) + "\\n");
await appendFile(phaseMarker, JSON.stringify({ phase: "codex", ...handle }) + "\\n");
const materialized = await bridge("fetch", {
  ...handle,
  inputCapability: launch.inputCapability,
});
const input = materialized.input;
const lineage = input.guardedRebaseLineage;
if (lineage === undefined || lineage.exactTip !== true) throw new Error("controlled Codex requires an exact-tip guarded successor");
const gitExecutable = process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git";
const changed = Bun.spawnSync(
  [gitExecutable, "diff", "--name-only", "--no-renames", "-z", input.baseCommit, input.startingCommit, "--"],
  { cwd: input.worktreePath, stdout: "pipe", stderr: "pipe" },
);
if (changed.exitCode !== 0) throw new Error(changed.stderr.toString());
const output = {
  taskId: input.taskId,
  status: "pass",
  resultCommit: input.startingCommit,
  branch: input.branch,
  actualWorktreePath: input.worktreePath,
  filesTouched: changed.stdout.toString().split("\\0").filter(Boolean).sort(),
  gitReceipts: [],
  gitLineage: {
    kind: "guarded-rebase",
    guardedRebase: lineage.guardedRebase,
    ontoCommit: lineage.ontoCommit,
    rebasedStartCommit: lineage.rebasedStartCommit,
    exactTip: lineage.exactTip,
  },
  checkSummary: "controlled installed successor check passed",
  baseVerification: {
    status: "verified",
    relation: input.baseCommit === input.startingCommit ? "equal" : "descendant",
    baseCommit: input.baseCommit,
    headCommit: input.startingCommit,
  },
  summary: "exact guarded successor completed through the installed boundary",
};
const stored = await bridge("store", { resultCapability: launch.resultCapability, output });
if (stored.state !== "gate-pending") throw new Error("controlled Codex result did not stage");
process.stdout.write([
  JSON.stringify({ type: "thread.started", thread_id: "t2081-successor-thread-" + String(handle.generation) }),
  JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "ledger", tool: "store_result", result: { content: [{ type: "text", text: JSON.stringify(stored) }] } } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(handle) } }),
  JSON.stringify({ type: "turn.completed", usage: {} }),
].join("\\n"));
`,
    );
    await fs.chmod(codexExecutable, 0o700);
    await fs.writeFile(
      ledgerCommand,
      `#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
const bridgeRoot = process.env["CQ_T2081_BRIDGE_ROOT"];
const phaseMarker = process.env["CQ_T2081_PHASE_MARKER"];
if (bridgeRoot === undefined || phaseMarker === undefined) throw new Error("controlled cq environment is incomplete");
if (process.argv.includes("__workset-effect-provider")) {
  await appendFile(phaseMarker, JSON.stringify({ phase: "provider-start" }) + "\\n");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const request = JSON.parse(line);
    await appendFile(phaseMarker, JSON.stringify({ phase: "provider-" + request.op }) + "\\n");
    process.stdout.write(JSON.stringify(request.op === "acquire" ? { ok: true, epoch: 1 } : { ok: true }) + "\\n");
    if (request.op === "release" || request.op === "abandon") break;
  }
  process.exit(0);
}
async function bridge(operation, request) {
  const id = randomUUID();
  const requestPath = path.join(bridgeRoot, id + ".request.json");
  const temporaryPath = requestPath + ".tmp";
  const responsePath = path.join(bridgeRoot, id + ".response.json");
  await writeFile(temporaryPath, JSON.stringify({ id, operation, request }));
  await rename(temporaryPath, requestPath);
  for (;;) {
    try {
      const response = JSON.parse(await readFile(responsePath, "utf8"));
      await unlink(responsePath);
      if (response.ok !== true) throw new Error(response.error);
      return response.value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await Bun.sleep(5);
  }
}
const request = JSON.parse(await Bun.stdin.text());
if (process.argv.includes("--implementation-candidate-qualify")) {
  await appendFile(phaseMarker, JSON.stringify({ phase: "qualify" }) + "\\n");
  process.stdout.write(JSON.stringify(await bridge("qualify", request)));
  process.exit(0);
}
if (process.argv.includes("--implementation-candidate-coordinate")) {
  await appendFile(phaseMarker, JSON.stringify({ phase: "coordinate" }) + "\\n");
  process.stdout.write(JSON.stringify(await bridge("coordinate", request)));
  process.exit(0);
}
throw new Error("unexpected controlled cq invocation");
`,
    );
    await fs.chmod(ledgerCommand, 0o700);
    const inheritedPath = process.env["PATH"];
    if (inheritedPath === undefined || inheritedPath.trim() === "") {
      throw new Error("test PATH is unavailable");
    }
    const launcherEnvironment = {
      PATH: inheritedPath,
      CQ_T2081_BRIDGE_ROOT: bridgeRoot,
      CQ_T2081_SUCCESSOR_MARKER: launchMarker,
      CQ_T2081_PHASE_MARKER: phaseMarker,
      XDG_STATE_HOME: path.join(launchRoot, "xdg-state"),
      XDG_CONFIG_HOME: path.join(launchRoot, "xdg-config"),
      ...(process.env["CQ_TEST_GIT_EXECUTABLE"] === undefined
        ? {}
        : { CQ_TEST_GIT_EXECUTABLE: process.env["CQ_TEST_GIT_EXECUTABLE"] }),
    };
    const implementationSuccessorLauncher = createImplementationSuccessorLauncher(
      {
        roleCommand: process.execPath,
        roleScript: CODEX_ROLE_DISPATCH_SCRIPT,
        ledgerCommand,
        codexExecutable,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        sandboxMode: "workspace-write",
      },
      promptRoot,
      launcherEnvironment,
    );
    const recordedSuccessorLauncher: NonNullable<
      Parameters<typeof createDispatchCapability>[0]["implementationSuccessorLauncher"]
    > = async (input) => {
      await implementationSuccessorLauncher(input);
    };
    const subject = await fixtureWithDispatchBase(
      runner,
      "managed",
      observedNow,
      false,
      true,
      recordedSuccessorLauncher,
      promptArtifactStore,
    );
    type BridgeRequest = {
      readonly id: string;
      readonly operation: "fetch" | "store" | "qualify" | "coordinate";
      readonly request: Readonly<Record<string, unknown>>;
    };
    const processedRequests = new Set<string>();
    const runWithBridge = async <T>(operation: Promise<T>): Promise<T> => {
      let settled = false;
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const pending = new Set<Promise<void>>();
      while (!settled || pending.size > 0) {
        const entries = await fs.readdir(bridgeRoot);
        for (const entry of entries.filter((name) => name.endsWith(".request.json"))) {
          const requestPath = path.join(bridgeRoot, entry);
          if (processedRequests.has(requestPath)) continue;
          processedRequests.add(requestPath);
          const task = (async () => {
            const message = JSON.parse(await fs.readFile(requestPath, "utf8")) as BridgeRequest;
            let value: unknown;
            try {
              switch (message.operation) {
                case "fetch":
                  value = await subject.capability.fetchInput(
                    message.request as unknown as Parameters<
                      typeof subject.capability.fetchInput
                    >[0],
                  );
                  break;
                case "store":
                  value = await subject.capability.storeResult(
                    message.request as unknown as Parameters<
                      typeof subject.capability.storeResult
                    >[0],
                  );
                  break;
                case "qualify":
                  value = await subject.capability.qualifyImplementationCandidate!(
                    message.request as unknown as Parameters<
                      NonNullable<typeof subject.capability.qualifyImplementationCandidate>
                    >[0],
                  );
                  break;
                case "coordinate":
                  value = await subject.capability.coordinateImplementationCandidate!(
                    message.request as unknown as Parameters<
                      NonNullable<typeof subject.capability.coordinateImplementationCandidate>
                    >[0],
                  );
                  break;
              }
              const temporaryResponse = path.join(bridgeRoot, `${message.id}.response.json.tmp`);
              await fs.writeFile(temporaryResponse, JSON.stringify({ ok: true, value }));
              await fs.rename(
                temporaryResponse,
                path.join(bridgeRoot, `${message.id}.response.json`),
              );
            } catch (error) {
              const temporaryResponse = path.join(bridgeRoot, `${message.id}.response.json.tmp`);
              await fs.writeFile(
                temporaryResponse,
                JSON.stringify({
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
              await fs.rename(
                temporaryResponse,
                path.join(bridgeRoot, `${message.id}.response.json`),
              );
            }
          })();
          pending.add(task);
          void task.finally(() => pending.delete(task));
        }
        if (!settled || pending.size > 0) await Bun.sleep(5);
      }
      return await operation;
    };
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    if (
      subject.capability.qualifyImplementationCandidate === undefined ||
      subject.capability.coordinateImplementationCandidate === undefined
    ) {
      throw new Error("implementation candidate runtime is unavailable");
    }
    const correlationId = subject.expectedChild.childId.slice("implement-worker#".length);
    const qualified = await subject.capability.qualifyImplementationCandidate({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
      roleId: "implement-worker",
      correlationId,
      childThreadId: "stale-child-thread",
      expectedRunId: subject.expectedChild.runId,
      outcome: "completed",
      exitStatus: 0,
      observedAt: observedNow(),
      promptDigest: subject.prepared.promptProvenance.promptDigest,
    });
    if (qualified.state !== "queued") throw new Error("candidate did not qualify");
    await fs.writeFile(
      path.join(subject.repositoryRoot, "advance.txt"),
      "advance protected head\n",
    );
    await git(subject.repositoryRoot, ["add", "advance.txt"]);
    await git(subject.repositoryRoot, ["commit", "-q", "-m", "advance protected head"]);
    await git(subject.repositoryRoot, ["config", "user.name", "T2081"]);
    await git(subject.repositoryRoot, ["config", "user.email", "t2081@example.invalid"]);
    const protectedHead = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);

    const outcome = await runWithBridge(
      subject.capability.coordinateImplementationCandidate({
        partitionKey: qualified.partitionKey,
        holderId: "production-stale-coordinator",
      }),
    );

    expect(outcome).toEqual({
      state: "successor-queued",
      source: {
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
      },
      successor: {
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation + 1,
      },
    });
    expect(runner.requests).toHaveLength(1);
    if (subject.ledgerStore === undefined) {
      throw new Error("stale successor restart requires the task ledger");
    }
    const restarted = createDispatchCapability({
      backend: subject.backend,
      promptArtifactStore,
      ledgerStore: subject.ledgerStore,
      implementationEvidenceStore: subject.implementationEvidenceStore,
      repositoryRoot: subject.repositoryRoot,
      worktreeStateDir: subject.stateDir,
      supervisedWorkerGateRunner: runner,
      implementationSuccessorLauncher: recordedSuccessorLauncher,
      now: observedNow,
      randomBytes: sequentialDispatchRandomBytes(sequence * 48),
    });
    if (restarted.coordinateImplementationCandidate === undefined) {
      throw new Error("restarted implementation coordinator is unavailable");
    }
    expect(
      await runWithBridge(
        restarted.coordinateImplementationCandidate({
          partitionKey: qualified.partitionKey,
          holderId: "restarted-production-stale-coordinator",
        }),
      ),
    ).toMatchObject({
      state: "blocked",
      partitionKey: qualified.partitionKey,
      front: {
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation + 1,
      },
      frontState: "leased",
    });
    const launches = (await fs.readFile(launchMarker, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            attestationId: string;
            generation: number;
          },
      );
    expect(launches).toEqual([
      {
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation + 1,
      },
    ]);
    const [source, successor] = [...subject.store.rows()].sort(
      (left, right) => left.generation - right.generation,
    );
    expect(source).toMatchObject({
      state: "aborted",
      abortReason: "staged-rebase",
      implementationQueue: { state: "staged-rebase-retired" },
    });
    expect(successor).toMatchObject({
      state: "consumed",
      generation: subject.prepared.generation + 1,
      implementationQueue: { state: "leased" },
      stagedCompletionQualification: {
        nativeCompletion: {
          kind: "native-completion",
          actor: "trusted-extension",
          childId: subject.expectedChild.childId,
          runId: subject.expectedChild.runId,
        },
      },
      input: {
        baseCommit: protectedHead,
        priorResultCommit: subject.receipt.newHead,
        round: 1,
        guardedRebaseLineage: {
          oldResultCommit: subject.receipt.newHead,
          ontoCommit: protectedHead,
        },
      },
    });
    expect(successor).not.toHaveProperty("outputMaterializedAt");
    expect(runner.requests).toHaveLength(1);
    const successorHandle = {
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation + 1,
    };
    const successorResultCommit = await git(subject.managed.handle.absolutePath, [
      "rev-parse",
      "HEAD",
    ]);
    expect(await subject.capability.fetch(successorHandle)).toMatchObject({
      state: "consumed",
      output: {
        status: "pass",
        resultCommit: successorResultCommit,
      },
    });
    expect(await subject.capability.fetch(successorHandle)).toMatchObject({
      state: "output-already-materialized",
    });
    expect(await subject.capability.fetch(subject.prepared)).toMatchObject({
      state: "aborted",
      reason: "staged-rebase",
    });
    expect(
      subject.store.rows().filter((row) => row.generation === subject.prepared.generation + 1),
    ).toHaveLength(1);
    expect(
      await git(subject.managed.handle.absolutePath, [
        "merge-base",
        "--is-ancestor",
        protectedHead,
        "HEAD",
      ]),
    ).toBe("");
  }, 30_000);

  test("a fresh production coordinator replays one persisted conflict without gating or relaunching it", async () => {
    const runner = new GateDummy();
    const subject = await fixture(runner, true);
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    if (
      subject.capability.qualifyImplementationCandidate === undefined ||
      subject.capability.coordinateImplementationCandidate === undefined ||
      subject.ledgerStore === undefined
    ) {
      throw new Error("implementation candidate runtime is unavailable");
    }
    const correlationId = subject.expectedChild.childId.slice("implement-worker#".length);
    const qualified = await subject.capability.qualifyImplementationCandidate({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
      roleId: "implement-worker",
      correlationId,
      childThreadId: "conflicted-child-thread",
      expectedRunId: subject.expectedChild.runId,
      outcome: "completed",
      exitStatus: 0,
      observedAt: "2026-08-12T20:00:02.000Z",
      promptDigest: subject.prepared.promptProvenance.promptDigest,
    });
    if (qualified.state !== "queued") throw new Error("candidate did not qualify");
    await fs.writeFile(path.join(subject.repositoryRoot, "file.txt"), "protected\n");
    await git(subject.repositoryRoot, ["add", "file.txt"]);
    await git(subject.repositoryRoot, ["commit", "-q", "-m", "conflict protected head"]);
    await git(subject.repositoryRoot, ["config", "user.name", "T2081"]);
    await git(subject.repositoryRoot, ["config", "user.email", "t2081@example.invalid"]);

    const first = await subject.capability.coordinateImplementationCandidate({
      partitionKey: qualified.partitionKey,
      holderId: "production-conflict-coordinator",
    });

    expect(first).toMatchObject({
      state: "blocked",
      front: {
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
      },
      frontState: "staged-rebase-retired",
    });
    expect(runner.requests).toHaveLength(0);
    const retired = subject.store
      .rows()
      .find(
        (row) =>
          row.attestationId === subject.prepared.attestationId &&
          row.generation === subject.prepared.generation,
      );
    expect(retired?.implementationQueue).toMatchObject({
      state: "staged-rebase-retired",
      stagedRebaseDisposition: { state: "conflict-pending" },
    });
    const persistedControl = retired?.implementationQueue;

    const restarted = createDispatchCapability({
      backend: new InMemoryAttestationBackend(subject.store),
      promptArtifactStore: artifactStore(),
      ledgerStore: subject.ledgerStore,
      implementationEvidenceStore: subject.implementationEvidenceStore,
      repositoryRoot: subject.repositoryRoot,
      worktreeStateDir: subject.stateDir,
      supervisedWorkerGateRunner: runner,
      now: () => "2026-08-12T20:00:00.000Z",
      randomBytes: sequentialDispatchRandomBytes(sequence * 64),
    });
    if (restarted.coordinateImplementationCandidate === undefined) {
      throw new Error("restarted implementation coordinator is unavailable");
    }

    const replay = await restarted.coordinateImplementationCandidate({
      partitionKey: qualified.partitionKey,
      holderId: "restarted-conflict-coordinator",
    });

    expect(replay).toEqual(first);
    expect(runner.requests).toHaveLength(0);
    expect(
      subject.store
        .rows()
        .find(
          (row) =>
            row.attestationId === subject.prepared.attestationId &&
            row.generation === subject.prepared.generation,
        )?.implementationQueue,
    ).toEqual(persistedControl);

    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: subject.repositoryRoot,
        taskId: subject.managed.handle.taskId,
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        allowDetachedRebase: true,
      },
      { stateDir: subject.stateDir },
    );
    if (binding === null) throw new Error("conflicted managed binding did not resolve");
    const conflict = await observeManagedWorktreeConflictState(binding, {
      stateDir: subject.stateDir,
    });
    const resolvedBody = "protected + candidate\n";
    await fs.writeFile(path.join(subject.managed.handle.absolutePath, "file.txt"), resolvedBody);
    await continueManagedWorktreeRebase(
      {
        authorization: {
          ...binding,
          attestationId: "cq_attest_t2081_conflict_resolver",
          generation: 1,
          roleId: "implement-conflict-resolver",
          surface: "codex",
          childCancelAt: "2099-01-01T00:00:00.000Z",
          conflictStateDigest: gitRebaseConflictStateDigest(conflict),
        },
        operationId: "t2081-conflict-resolution",
        expectedState: conflict,
        resolutions: [
          {
            kind: "regular",
            path: "file.txt",
            newState: { mode: "100644", digest: sha256(resolvedBody) },
          },
        ],
      },
      { stateDir: subject.stateDir, authorize: async () => undefined },
    );
    const finalizedRestart = createDispatchCapability({
      backend: new InMemoryAttestationBackend(subject.store),
      promptArtifactStore: artifactStore(),
      ledgerStore: subject.ledgerStore,
      implementationEvidenceStore: subject.implementationEvidenceStore,
      repositoryRoot: subject.repositoryRoot,
      worktreeStateDir: subject.stateDir,
      supervisedWorkerGateRunner: runner,
      now: () => "2026-08-12T20:00:00.000Z",
      randomBytes: sequentialDispatchRandomBytes(sequence * 96),
    });
    if (finalizedRestart.coordinateImplementationCandidate === undefined) {
      throw new Error("finalized-journal coordinator is unavailable");
    }

    expect(
      await finalizedRestart.coordinateImplementationCandidate({
        partitionKey: qualified.partitionKey,
        holderId: "finalized-journal-coordinator",
      }),
    ).toEqual({
      state: "successor-queued",
      source: {
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
      },
      successor: {
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation + 1,
      },
    });
    expect(runner.requests).toHaveLength(0);
    expect(
      subject.store
        .rows()
        .filter(
          (row) =>
            row.attestationId === subject.prepared.attestationId &&
            row.generation === subject.prepared.generation + 1,
        ),
    ).toHaveLength(1);
  });

  test("an exact staged result retry recovers the same acknowledgement before and after parent finalization", async () => {
    const runner = new GateDummy();
    const subject = await fixture(runner);
    const first = await stage(subject);
    expect(first).toMatchObject({ state: "gate-pending" });
    await expect(stage(subject)).resolves.toEqual(first);
    await expect(finalize(subject)).resolves.toMatchObject({ state: "result-stored" });
    await expect(stage(subject)).resolves.toEqual(first);
    expect(runner.requests).toHaveLength(1);
  });

  test("attaches runner-owned evidence before an exact green tip becomes consumable", async () => {
    const runner = new GateDummy();
    const subject = await fixture(runner);
    expect(await stageAndFinalize(subject)).toMatchObject({ state: "result-stored" });
    expect(runner.requests).toEqual([
      {
        worktreePath: subject.managed.handle.absolutePath,
        admissionTimeoutMs: 3_600_000,
        executionTimeoutMs: SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
        cancellationSignal: expect.any(AbortSignal),
      },
    ]);
    const confirmation = await subject.capability.confirmCompletion({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
      nativeCompletion: {
        kind: "native-completion",
        actor: "trusted-parent",
        childId: subject.expectedChild.childId,
        runId: subject.expectedChild.runId,
        completedAt: "2026-08-12T20:00:02.000Z",
      },
      expectedProvenance: {
        roleId: subject.prepared.promptProvenance.roleId,
        version: subject.prepared.promptProvenance.version,
        promptDigest: subject.prepared.promptProvenance.promptDigest,
        inputDigest: subject.prepared.promptProvenance.inputDigest,
      },
    });
    expect(confirmation.state).toBe("consumed");
    const consumed = await subject.capability.fetch({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
    });
    expect(consumed).toMatchObject({
      state: "consumed",
      output: {
        status: "pass",
        resultCommit: subject.receipt.newHead,
        supervisedGateEvidence: {
          kind: "cq-supervised-gate-evidence",
          version: 1,
          attestationId: subject.prepared.attestationId,
          generation: subject.prepared.generation,
          roleId: "implement-worker",
          roleVersion: subject.prepared.promptProvenance.version,
          surface: "codex",
          taskId: "T2081",
          resultCommit: subject.receipt.newHead,
          gateExitCode: 0,
          passCount: 17,
          failCount: 0,
          clean: true,
        },
      },
    });
  });

  // regression: D508 — a genuine red gate made every later changed generation terminal.
  test("a genuine rejected gate admits only a changed receipt-bound correction and gates it once [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const runner = new GateSequenceDummy([
      {
        gateExitCode: 1,
        passCount: 16,
        failCount: 1,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:03.000Z",
        outputTail: "(fail) deterministic source rejection\n16 pass\n1 fail",
      },
      {
        gateExitCode: 0,
        passCount: 17,
        failCount: 0,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:06.000Z",
        outputTail: "17 pass\n0 fail",
      },
    ]);
    const subject = await fixture(runner, true);
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    if (
      subject.capability.qualifyImplementationCandidate === undefined ||
      subject.capability.coordinateImplementationCandidate === undefined
    ) {
      throw new Error("implementation candidate runtime is unavailable");
    }
    const qualify = async (
      prepared: typeof subject.prepared,
      expectedChild: typeof subject.expectedChild,
      observedAt: string,
    ) =>
      await subject.capability.qualifyImplementationCandidate!({
        attestationId: prepared.attestationId,
        generation: prepared.generation,
        roleId: "implement-worker",
        correlationId: expectedChild.childId.slice("implement-worker#".length),
        childThreadId: `correction-thread-${String(prepared.generation)}`,
        expectedRunId: expectedChild.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt,
        promptDigest: prepared.promptProvenance.promptDigest,
      });

    const sourceQualified = await qualify(
      subject.prepared,
      subject.expectedChild,
      "2026-08-12T20:00:02.000Z",
    );
    if (sourceQualified.state !== "queued") throw new Error("red source did not qualify");
    await expect(
      subject.capability.coordinateImplementationCandidate({
        partitionKey: sourceQualified.partitionKey,
        holderId: "d508-red-source",
      }),
    ).rejects.toThrow();
    expect(runner.requests).toHaveLength(1);
    expect(subject.store.rows()[0]).toMatchObject({
      state: "aborted",
      abortReason: "gate-rejected",
      implementationQueue: { state: "terminal", terminal: { reason: "gate-rejected" } },
    });

    const unchangedChild = {
      childId: `implement-worker#unchanged-correction-${String(sequence)}`,
      runId: `unchanged-correction-run-${String(sequence)}`,
    };
    const unchanged = await subject.capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        round: 1,
        startingCommit: subject.receipt.newHead,
        validationIntent: "final",
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-unchanged-correction`,
      timeoutMs: 600_000,
      expectedChild: unchangedChild,
      reprepareOf: {
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
      },
    });
    if (!unchanged.accepted) throw new Error(`unchanged correction refused: ${unchanged.detail}`);
    await subject.capability.fetchInput({
      attestationId: unchanged.prepared.attestationId,
      generation: unchanged.prepared.generation,
      inputCapability: unchanged.prepared.inputCapability,
    });
    expect(
      await subject.capability.storeResult({
        resultCapability: unchanged.prepared.resultCapability,
        output: {
          ...subject.output,
          gitReceipts: [],
          checkSummary: "unchanged correction must not rerun the gate",
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    await expect(
      qualify(unchanged.prepared, unchangedChild, "2026-08-12T20:00:04.000Z"),
    ).rejects.toThrow("cannot be resurrected");
    expect(runner.requests).toHaveLength(1);
    expect(
      await subject.capability.abort({
        attestationId: unchanged.prepared.attestationId,
        generation: unchanged.prepared.generation,
        reason: "cancelled",
      }),
    ).toMatchObject({ state: "aborted", reason: "cancelled" });

    const correctedChild = {
      childId: `implement-worker#changed-correction-${String(sequence)}`,
      runId: `changed-correction-run-${String(sequence)}`,
    };
    const corrected = await subject.capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        round: 2,
        startingCommit: subject.receipt.newHead,
        validationIntent: "final",
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-changed-correction`,
      timeoutMs: 600_000,
      expectedChild: correctedChild,
      reprepareOf: {
        attestationId: unchanged.prepared.attestationId,
        generation: unchanged.prepared.generation,
      },
    });
    if (!corrected.accepted || corrected.prepared.gitChangeCapability === undefined) {
      throw new Error("changed correction did not receive Git authority");
    }
    await subject.capability.fetchInput({
      attestationId: corrected.prepared.attestationId,
      generation: corrected.prepared.generation,
      inputCapability: corrected.prepared.inputCapability,
    });
    await fs.writeFile(path.join(subject.managed.handle.absolutePath, "file.txt"), "corrected\n");
    if (subject.capability.gitCommit === undefined) throw new Error("git_commit unavailable");
    const correctionReceipt = await subject.capability.gitCommit({
      attestationId: corrected.prepared.attestationId,
      generation: corrected.prepared.generation,
      gitChangeCapability: corrected.prepared.gitChangeCapability,
      operationId: `T2081-${String(sequence)}-changed-correction-commit`,
      expectedHead: subject.receipt.newHead,
      message: "correct rejected candidate",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("after\n") },
          newState: { mode: "100644", digest: sha256("corrected\n") },
        },
      ],
    });
    expect(
      await subject.capability.storeResult({
        resultCapability: corrected.prepared.resultCapability,
        output: {
          ...subject.output,
          resultCommit: correctionReceipt.newHead,
          filesTouched: [...correctionReceipt.paths],
          gitReceipts: [
            {
              ...correctionReceipt,
              objectOids: [...correctionReceipt.objectOids],
              paths: [...correctionReceipt.paths],
            },
          ],
          checkSummary: "changed correction checks passed",
          summary: "changed correction retains the rejected source receipt prefix",
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit: subject.dispatchBaseCommit,
            headCommit: correctionReceipt.newHead,
          },
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    const sourceHandle = {
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
    };
    const exactSource = subject.store.read(sourceHandle);
    if (
      exactSource === undefined ||
      isAttestationTombstone(exactSource) ||
      exactSource.gitEffectBinding === undefined ||
      exactSource.abortDetails === undefined ||
      exactSource.implementationQueue === undefined
    ) {
      throw new Error("rejected source evidence is unavailable");
    }
    const rejectCorruptedSource = async (
      corruptedSource: typeof exactSource,
      observedAt: string,
    ) => {
      subject.store.replace(exactSource, corruptedSource);
      await expect(qualify(corrected.prepared, correctedChild, observedAt)).rejects.toThrow(
        "cannot be resurrected",
      );
      subject.store.replace(corruptedSource, exactSource);
    };
    await rejectCorruptedSource(
      Object.freeze({
        ...exactSource,
        gitEffectBinding: Object.freeze({
          ...exactSource.gitEffectBinding,
          repositoryId: "repository:foreign",
        }),
      }),
      "2026-08-12T20:00:04.100Z",
    );
    await rejectCorruptedSource(
      Object.freeze({
        ...exactSource,
        abortDetails: {
          ...(exactSource.abortDetails as Readonly<Record<string, DispatchJSONValue>>),
          outputTail: "forged gate rejection diagnostics",
        },
      }),
      "2026-08-12T20:00:04.200Z",
    );
    await rejectCorruptedSource(
      Object.freeze({
        ...exactSource,
        implementationQueue: Object.freeze({
          ...exactSource.implementationQueue,
          attempt: Object.freeze({
            ...exactSource.implementationQueue.attempt,
            gitReceiptLineageDigest: "0".repeat(64),
          }),
        }),
      }),
      "2026-08-12T20:00:04.300Z",
    );
    const correctionQualified = await qualify(
      corrected.prepared,
      correctedChild,
      "2026-08-12T20:00:05.000Z",
    );
    if (correctionQualified.state !== "queued")
      throw new Error("changed correction did not qualify");
    expect(
      await subject.capability.coordinateImplementationCandidate({
        partitionKey: correctionQualified.partitionKey,
        holderId: "d508-changed-correction",
      }),
    ).toMatchObject({
      state: "completed",
      handle: {
        attestationId: corrected.prepared.attestationId,
        generation: corrected.prepared.generation,
      },
    });
    expect(runner.requests).toHaveLength(2);
    expect(
      await subject.capability.coordinateImplementationCandidate({
        partitionKey: correctionQualified.partitionKey,
        holderId: "d508-correction-replay",
      }),
    ).toMatchObject({
      state: "blocked",
      front: {
        attestationId: corrected.prepared.attestationId,
        generation: corrected.prepared.generation,
      },
      frontState: "leased",
    });
    expect(runner.requests).toHaveLength(2);
    const retainedRows = subject.store.rows();
    expect(retainedRows).toHaveLength(3);
    expect(retainedRows[0]).toMatchObject({
      generation: subject.prepared.generation,
      state: "aborted",
      abortReason: "gate-rejected",
    });
    expect(retainedRows[1]).toMatchObject({
      generation: unchanged.prepared.generation,
      state: "aborted",
      abortReason: "cancelled",
    });
    expect(retainedRows[1]).not.toHaveProperty("implementationQueue");
    expect(retainedRows[2]).toMatchObject({
      generation: corrected.prepared.generation,
      state: "consumed",
      implementationQueue: { state: "leased" },
    });
  });

  test("a consumed pass followed by a rejected continuation admits its changed correction", async () => {
    const runner = new GateSequenceDummy([
      {
        gateExitCode: 0,
        passCount: 17,
        failCount: 0,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:03.000Z",
        outputTail: "17 pass\n0 fail",
      },
      {
        gateExitCode: 1,
        passCount: 16,
        failCount: 1,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:06.000Z",
        outputTail: "(fail) deterministic continuation rejection\n16 pass\n1 fail",
      },
      {
        gateExitCode: 0,
        passCount: 17,
        failCount: 0,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:09.000Z",
        outputTail: "17 pass\n0 fail",
      },
    ]);
    const subject = await fixture(runner, true);
    if (
      subject.capability.qualifyImplementationCandidate === undefined ||
      subject.capability.coordinateImplementationCandidate === undefined ||
      subject.capability.resolveContinuation === undefined ||
      subject.capability.gitCommit === undefined
    ) {
      throw new Error("composed correction runtime is unavailable");
    }
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: subject.repositoryRoot,
        taskId: subject.managed.handle.taskId,
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
      },
      { stateDir: subject.stateDir },
    );
    if (binding === null) throw new Error("composed correction binding disappeared");
    const qualify = async (
      prepared: typeof subject.prepared,
      child: typeof subject.expectedChild,
      observedAt: string,
    ) =>
      await subject.capability.qualifyImplementationCandidate!({
        attestationId: prepared.attestationId,
        generation: prepared.generation,
        roleId: "implement-worker",
        correlationId: child.childId.slice("implement-worker#".length),
        childThreadId: `composed-correction-${String(prepared.generation)}`,
        expectedRunId: child.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt,
        promptDigest: prepared.promptProvenance.promptDigest,
      });

    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    const initialQualified = await qualify(
      subject.prepared,
      subject.expectedChild,
      "2026-08-12T20:00:02.000Z",
    );
    if (initialQualified.state !== "queued") throw new Error("initial pass did not qualify");
    expect(
      await subject.capability.coordinateImplementationCandidate({
        partitionKey: initialQualified.partitionKey,
        holderId: "composed-initial-pass",
      }),
    ).toMatchObject({ state: "completed" });

    const continuation = await subject.capability.resolveContinuation(
      binding,
      subject.receipt.newHead,
    );
    const rejectedChild = {
      childId: `implement-worker#composed-rejected-${String(sequence)}`,
      runId: `composed-rejected-run-${String(sequence)}`,
    };
    const rejected = await subject.capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        round: 1,
        startingCommit: subject.receipt.newHead,
        validationIntent: "final",
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-composed-rejected`,
      timeoutMs: 600_000,
      expectedChild: rejectedChild,
      continuation: continuation.continuationReference,
    });
    if (!rejected.accepted) throw new Error(rejected.detail);
    await subject.capability.fetchInput({
      ...rejected.handle,
      inputCapability: rejected.prepared.inputCapability,
    });
    expect(
      await subject.capability.storeResult({
        resultCapability: rejected.prepared.resultCapability,
        output: {
          ...subject.output,
          gitReceipts: [],
          checkSummary: "continuation candidate awaits its gate",
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    const rejectedQualified = await qualify(
      rejected.prepared,
      rejectedChild,
      "2026-08-12T20:00:05.000Z",
    );
    if (rejectedQualified.state !== "queued") throw new Error("continuation did not qualify");
    await expect(
      subject.capability.coordinateImplementationCandidate({
        partitionKey: rejectedQualified.partitionKey,
        holderId: "composed-rejected-continuation",
      }),
    ).rejects.toThrow();

    const correctionChild = {
      childId: `implement-worker#composed-correction-${String(sequence)}`,
      runId: `composed-correction-run-${String(sequence)}`,
    };
    const correction = await subject.capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        round: 2,
        startingCommit: subject.receipt.newHead,
        validationIntent: "final",
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-composed-correction`,
      timeoutMs: 600_000,
      expectedChild: correctionChild,
      reprepareOf: rejected.handle,
    });
    if (!correction.accepted || correction.prepared.gitChangeCapability === undefined) {
      throw new Error("changed composed correction did not receive Git authority");
    }
    await subject.capability.fetchInput({
      ...correction.handle,
      inputCapability: correction.prepared.inputCapability,
    });
    await fs.writeFile(
      path.join(subject.managed.handle.absolutePath, "file.txt"),
      "composed correction\n",
    );
    const correctionReceipt = await subject.capability.gitCommit({
      ...correction.handle,
      gitChangeCapability: correction.prepared.gitChangeCapability,
      operationId: `T2081-${String(sequence)}-composed-correction-commit`,
      expectedHead: subject.receipt.newHead,
      message: "correct composed rejected continuation",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("after\n") },
          newState: { mode: "100644", digest: sha256("composed correction\n") },
        },
      ],
    });
    expect(
      await subject.capability.storeResult({
        resultCapability: correction.prepared.resultCapability,
        output: {
          ...subject.output,
          resultCommit: correctionReceipt.newHead,
          filesTouched: [...correctionReceipt.paths],
          gitReceipts: [
            {
              ...correctionReceipt,
              objectOids: [...correctionReceipt.objectOids],
              paths: [...correctionReceipt.paths],
            },
          ],
          checkSummary: "composed correction checks passed",
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit: subject.dispatchBaseCommit,
            headCommit: correctionReceipt.newHead,
          },
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    const retainedRejected = subject.store.read(rejected.handle);
    if (
      retainedRejected === undefined ||
      isAttestationTombstone(retainedRejected) ||
      retainedRejected.dispatchContinuationClaim === undefined
    ) {
      throw new Error("rejected continuation lost its persisted source claim");
    }
    const rejectContinuationMutation = async (
      mutate: (row: AttestationEnvelope) => AttestationEnvelope,
      observedAt: string,
    ) => {
      const corrupted = mutate(retainedRejected);
      subject.store.replace(retainedRejected, corrupted);
      await expect(qualify(correction.prepared, correctionChild, observedAt)).rejects.toThrow(
        "cannot be resurrected",
      );
      subject.store.replace(corrupted, retainedRejected);
    };
    await rejectContinuationMutation((row) => {
      const { dispatchContinuationClaim: _claim, ...withoutClaim } = row;
      return withoutClaim;
    }, "2026-08-12T20:00:07.100Z");
    await rejectContinuationMutation(
      (row) => ({
        ...row,
        dispatchContinuationClaim: {
          ...row.dispatchContinuationClaim!,
          continuationReference: `cq-dispatch-continuation:v1:${"0".repeat(64)}`,
        },
      }),
      "2026-08-12T20:00:07.200Z",
    );
    await rejectContinuationMutation(
      (row) => ({
        ...row,
        dispatchContinuationClaim: {
          ...row.dispatchContinuationClaim!,
          source: {
            ...row.dispatchContinuationClaim!.source,
            generation: row.dispatchContinuationClaim!.source.generation + 1,
          },
        },
      }),
      "2026-08-12T20:00:07.300Z",
    );
    const correctionQualified = await qualify(
      correction.prepared,
      correctionChild,
      "2026-08-12T20:00:08.000Z",
    );
    if (correctionQualified.state !== "queued") {
      throw new Error("composed correction did not qualify");
    }
    expect(
      await subject.capability.coordinateImplementationCandidate({
        partitionKey: correctionQualified.partitionKey,
        holderId: "composed-correction-final",
      }),
    ).toMatchObject({ state: "completed" });
    expect(runner.requests).toHaveLength(3);
  });

  test.each(["memory", "sqlite"] as const)(
    "current-recovered staged retirement admits its exact guarded successor despite older terminal enrollment history (%s)",
    async (attestationBackend) => {
      const runner = new GateRejectedThenParentLossThenGreenGateDummy();
      const subject = await fixtureWithDispatchBase(
        runner,
        "managed",
        () => "2026-08-12T20:00:00.000Z",
        false,
        true,
        undefined,
        artifactStore(),
        attestationBackend,
      );
      const recoveryJournal = new InMemoryCurrentRecoverySealJournalStore();
      type LaunchedSuccessor = Parameters<
        NonNullable<
          Parameters<typeof createDispatchCapability>[0]["implementationSuccessorLauncher"]
        >
      >[0];
      let launchedSuccessor: LaunchedSuccessor | undefined;
      const currentLaunchedSuccessor = (): LaunchedSuccessor | undefined => launchedSuccessor;
      let capability = createDispatchCapability({
        ...subject.capabilityOptions,
        recoveryJournal,
        implementationSuccessorLauncher: async (input) => {
          launchedSuccessor = input;
        },
      });
      if (
        capability.qualifyImplementationCandidate === undefined ||
        capability.coordinateImplementationCandidate === undefined ||
        capability.resolveRecovery === undefined ||
        capability.gitCommit === undefined
      ) {
        throw new Error("composed recovery runtime is unavailable");
      }
      const binding = await resolveManagedWorktreeDispatchBinding(
        {
          repositoryRoot: subject.repositoryRoot,
          taskId: subject.managed.handle.taskId,
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
        },
        { stateDir: subject.stateDir },
      );
      if (binding === null) throw new Error("composed recovery binding disappeared");
      const qualify = async (
        prepared: typeof subject.prepared,
        child: typeof subject.expectedChild,
        observedAt: string,
      ) =>
        await capability.qualifyImplementationCandidate!({
          attestationId: prepared.attestationId,
          generation: prepared.generation,
          roleId: "implement-worker",
          correlationId: child.childId.slice("implement-worker#".length),
          childThreadId: `t6576-composed-${String(prepared.generation)}`,
          expectedRunId: child.runId,
          outcome: "completed",
          exitStatus: 0,
          observedAt,
          promptDigest: prepared.promptProvenance.promptDigest,
        });

      expect(
        await capability.storeResult({
          resultCapability: subject.prepared.resultCapability,
          output: subject.output,
        }),
      ).toMatchObject({ state: "gate-pending" });
      const rejectedQualified = await qualify(
        subject.prepared,
        subject.expectedChild,
        "2026-08-12T20:00:02.000Z",
      );
      if (rejectedQualified.state !== "queued")
        throw new Error("initial candidate did not qualify");
      await expect(
        capability.coordinateImplementationCandidate({
          partitionKey: rejectedQualified.partitionKey,
          holderId: `t6576-rejected-${attestationBackend}`,
        }),
      ).rejects.toThrow();

      const correctionChild = {
        childId: `implement-worker#t6576-correction-${attestationBackend}-${String(sequence)}`,
        runId: `t6576-correction-${attestationBackend}-run-${String(sequence)}`,
      };
      const correction = await capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: subject.dispatchBaseCommit,
          round: 1,
          startingCommit: subject.receipt.newHead,
          validationIntent: "final",
          priorResultCommit: subject.receipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-${attestationBackend}-rejected-correction`,
        timeoutMs: 600_000,
        expectedChild: correctionChild,
        reprepareOf: subject.prepared,
      });
      if (!correction.accepted || correction.prepared.gitChangeCapability === undefined) {
        throw new Error("gate-rejected correction did not receive Git authority");
      }
      await capability.fetchInput({
        ...correction.handle,
        inputCapability: correction.prepared.inputCapability,
      });
      const correctionBytes = `gate-rejected correction ${attestationBackend}\n`;
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "file.txt"),
        correctionBytes,
      );
      const correctionReceipt = await capability.gitCommit({
        ...correction.handle,
        gitChangeCapability: correction.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-${attestationBackend}-rejected-correction-commit`,
        expectedHead: subject.receipt.newHead,
        message: "correct authenticated gate rejection",
        changes: [
          {
            kind: "modify",
            path: "file.txt",
            oldState: { mode: "100644", digest: sha256("after\n") },
            newState: { mode: "100644", digest: sha256(correctionBytes) },
          },
        ],
      });
      expect(
        await capability.storeResult({
          resultCapability: correction.prepared.resultCapability,
          output: {
            ...subject.output,
            resultCommit: correctionReceipt.newHead,
            filesTouched: [...correctionReceipt.paths],
            gitReceipts: [
              {
                ...correctionReceipt,
                objectOids: [...correctionReceipt.objectOids],
                paths: [...correctionReceipt.paths],
              },
            ],
            checkSummary: "gate-rejected correction awaits its gate",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: subject.dispatchBaseCommit,
              headCommit: correctionReceipt.newHead,
            },
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      const correctionQualified = await qualify(
        correction.prepared,
        correctionChild,
        "2026-08-12T20:00:05.000Z",
      );
      if (correctionQualified.state !== "queued") throw new Error("correction did not qualify");
      await expect(
        capability.coordinateImplementationCandidate({
          partitionKey: correctionQualified.partitionKey,
          holderId: `t6576-parent-lost-${attestationBackend}`,
        }),
      ).rejects.toThrow("controlled parent loss after gate-rejected correction");

      const recovery = await capability.resolveRecovery(binding, correctionReceipt.newHead);
      if (recovery.preparation.kind !== "current") {
        throw new Error("parent-lost correction did not produce current recovery authority");
      }
      const recoveredChild = {
        childId: `implement-worker#t6576-recovered-${attestationBackend}-${String(sequence)}`,
        runId: `t6576-recovered-${attestationBackend}-run-${String(sequence)}`,
      };
      const recovered = await capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: subject.dispatchBaseCommit,
          round: 2,
          startingCommit: correctionReceipt.newHead,
          validationIntent: "final",
          priorResultCommit: correctionReceipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-${attestationBackend}-current-recovered`,
        timeoutMs: 600_000,
        expectedChild: recoveredChild,
        recoveryPreparation: recovery.preparation.recoveryPreparation,
      });
      if (!recovered.accepted || recovered.prepared.gitChangeCapability === undefined) {
        throw new Error("current-recovered worker did not receive Git authority");
      }
      await capability.fetchInput({
        ...recovered.handle,
        inputCapability: recovered.prepared.inputCapability,
      });
      const recoveredBytes = `current recovered ${attestationBackend}\n`;
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "file.txt"),
        recoveredBytes,
      );
      const recoveredReceipt = await capability.gitCommit({
        ...recovered.handle,
        gitChangeCapability: recovered.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-${attestationBackend}-current-recovered-commit`,
        expectedHead: correctionReceipt.newHead,
        message: "advance authenticated current recovery",
        changes: [
          {
            kind: "modify",
            path: "file.txt",
            oldState: { mode: "100644", digest: sha256(correctionBytes) },
            newState: { mode: "100644", digest: sha256(recoveredBytes) },
          },
        ],
      });
      expect(
        await capability.storeResult({
          resultCapability: recovered.prepared.resultCapability,
          output: {
            ...subject.output,
            resultCommit: recoveredReceipt.newHead,
            filesTouched: [...recoveredReceipt.paths],
            gitReceipts: [
              {
                ...recoveredReceipt,
                objectOids: [...recoveredReceipt.objectOids],
                paths: [...recoveredReceipt.paths],
              },
            ],
            checkSummary: "current-recovered candidate awaits its gate",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: subject.dispatchBaseCommit,
              headCommit: recoveredReceipt.newHead,
            },
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      const recoveredQualified = await qualify(
        recovered.prepared,
        recoveredChild,
        "2026-08-12T20:00:08.000Z",
      );
      if (recoveredQualified.state !== "queued")
        throw new Error("recovered worker did not qualify");

      await fs.writeFile(path.join(subject.repositoryRoot, "integration.txt"), "advanced\n");
      await git(subject.repositoryRoot, ["add", "integration.txt"]);
      await git(subject.repositoryRoot, ["commit", "-q", "-m", "advance integration"]);
      await git(subject.repositoryRoot, ["config", "user.name", "T2081"]);
      await git(subject.repositoryRoot, ["config", "user.email", "t2081@example.invalid"]);
      const ontoCommit = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);
      const preRetirementSource = await subject.backend.transact(
        { kind: "handle", handle: recovered.handle },
        (store) => store.read(recovered.handle),
      );
      if (preRetirementSource === undefined || isAttestationTombstone(preRetirementSource)) {
        throw new Error("current recovered source disappeared before retirement");
      }
      expect(Object.hasOwn(preRetirementSource, "dispatchContinuationClaim")).toBe(false);
      expect(Object.hasOwn(preRetirementSource, "dispatchJournalRecoveryClaim")).toBe(true);
      expect(
        await capability.coordinateImplementationCandidate({
          partitionKey: recoveredQualified.partitionKey,
          holderId: `t6576-retire-recovered-${attestationBackend}`,
        }),
      ).toMatchObject({
        state: "successor-queued",
        source: recovered.handle,
        successor: {
          attestationId: recovered.handle.attestationId,
          generation: recovered.handle.generation + 1,
        },
      });
      const retiredSource = await subject.backend.transact(
        { kind: "handle", handle: recovered.handle },
        (store) => store.read(recovered.handle),
      );
      expect(retiredSource).toMatchObject({
        state: "aborted",
        abortReason: "staged-rebase",
        implementationQueue: {
          state: "staged-rebase-retired",
          terminal: { reason: "staged-rebase" },
        },
      });
      if (retiredSource === undefined || isAttestationTombstone(retiredSource)) {
        throw new Error("legacy staged retirement disappeared");
      }
      expect(Object.hasOwn(retiredSource, "dispatchContinuationClaim")).toBe(false);
      expect(Object.hasOwn(retiredSource, "dispatchJournalRecoveryClaim")).toBe(true);
      const legacyFixture = t6576LegacyQueueFixture(retiredSource);
      expect(legacyFixture.provenance).toEqual(T6576_LEGACY_QUEUE_FIXTURE_PROVENANCE);
      const legacyRetiredSource = legacyFixture.row;
      await subject.backend.transact({ kind: "handle", handle: recovered.handle }, (store) => {
        const current = store.read(recovered.handle);
        if (current === undefined) throw new Error("staged retirement disappeared");
        store.replace(current, legacyRetiredSource);
      });
      expect(Object.hasOwn(legacyRetiredSource, "dispatchContinuationClaim")).toBe(false);
      expect(Object.hasOwn(legacyRetiredSource, "dispatchJournalRecoveryClaim")).toBe(false);
      const guarded = launchedSuccessor;
      if (guarded === undefined) throw new Error("staged retirement did not launch its successor");
      await subject.backend.close();
      const reopenedBackend =
        attestationBackend === "sqlite"
          ? new SqliteAttestationBackend({
              namespace: subject.backend.namespace,
              dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
            })
          : new InMemoryAttestationBackend(subject.store);
      capability = createDispatchCapability({
        ...subject.capabilityOptions,
        backend: reopenedBackend,
        recoveryJournal,
        implementationSuccessorLauncher: async (input) => {
          launchedSuccessor = input;
        },
      });
      if (
        capability.qualifyImplementationCandidate === undefined ||
        capability.coordinateImplementationCandidate === undefined ||
        capability.resolveRecovery === undefined ||
        capability.gitCommit === undefined
      ) {
        throw new Error("reopened current recovery runtime is unavailable");
      }
      const guardedInput = await capability.fetchInput({
        attestationId: guarded.prepared.attestationId,
        generation: guarded.prepared.generation,
        inputCapability: guarded.prepared.inputCapability,
      });
      if (guardedInput.state !== "input-materialized") throw new Error("guarded input unavailable");
      const guardedRecord = guardedInput.input as Readonly<Record<string, DispatchJSONValue>>;
      const guardedLineage = guardedRecord["guardedRebaseLineage"] as Readonly<
        Record<string, DispatchJSONValue>
      >;
      const rebasedStartCommit = guardedRecord["startingCommit"];
      const guardedRebase = guardedLineage["guardedRebase"];
      const exactTip = guardedLineage["exactTip"];
      if (
        typeof rebasedStartCommit !== "string" ||
        typeof guardedRebase !== "string" ||
        typeof exactTip !== "boolean"
      ) {
        throw new Error("guarded successor lineage is unavailable");
      }
      expect(
        await capability.storeResult({
          resultCapability: guarded.prepared.resultCapability,
          output: {
            taskId: "T2081",
            status: "pass",
            resultCommit: rebasedStartCommit,
            branch: subject.managed.handle.branch,
            actualWorktreePath: subject.managed.handle.absolutePath,
            filesTouched: ["file.txt"],
            gitReceipts: [],
            gitLineage: {
              kind: "guarded-rebase",
              guardedRebase,
              ontoCommit,
              rebasedStartCommit,
              exactTip,
            },
            checkSummary: "guarded current-recovery successor awaits its gate",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: ontoCommit,
              headCommit: rebasedStartCommit,
            },
            summary: "guarded successor retains composed terminal ancestry",
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      const readLiveRow = async (handle: {
        readonly attestationId: string;
        readonly generation: number;
      }) => {
        const row = await reopenedBackend.transact({ kind: "handle", handle }, (store) =>
          store.read(handle),
        );
        if (row === undefined || isAttestationTombstone(row)) {
          throw new Error("legacy recovery evidence row disappeared");
        }
        return row;
      };
      const legacyParentLost = await readLiveRow(correction.handle);
      const legacyRetired = await readLiveRow(recovered.handle);
      const rejectLegacyEvidenceMutation = async (
        retained: AttestationEnvelope,
        mutate: (row: AttestationEnvelope) => AttestationEnvelope,
        observedAt: string,
      ) => {
        const corrupted = mutate(retained);
        await reopenedBackend.transact(
          {
            kind: "handle",
            handle: {
              attestationId: retained.attestationId,
              generation: retained.generation,
            },
          },
          (store) => {
            const current = store.read(retained);
            if (current === undefined) throw new Error("legacy recovery evidence disappeared");
            store.replace(current, corrupted);
          },
        );
        try {
          await expect(
            qualify(guarded.prepared, guarded.expectedChild, observedAt),
          ).rejects.toThrow("cannot be resurrected");
          const pending = await readLiveRow(guarded.prepared);
          expect(pending.state).toBe("gate-pending");
          expect(pending.implementationQueue).toBeUndefined();
        } finally {
          await reopenedBackend.transact(
            {
              kind: "handle",
              handle: {
                attestationId: retained.attestationId,
                generation: retained.generation,
              },
            },
            (store) => {
              const current = store.read(retained);
              if (current === undefined) throw new Error("legacy recovery evidence disappeared");
              store.replace(current, retained);
            },
          );
        }
      };
      await rejectLegacyEvidenceMutation(
        legacyParentLost,
        (row) => ({
          ...row,
          implementationQueue: {
            ...row.implementationQueue!,
            attempt: {
              ...row.implementationQueue!.attempt,
              gitReceipts: row.implementationQueue!.attempt.gitReceipts.map((receipt, index) =>
                index === row.implementationQueue!.attempt.gitReceipts.length - 1
                  ? { ...receipt, requestDigest: "0".repeat(64) }
                  : receipt,
              ),
            },
          },
        }),
        "2026-08-12T20:00:10.100Z",
      );
      await rejectLegacyEvidenceMutation(
        legacyRetired,
        (row) => ({
          ...row,
          stagedRebaseSourceBinding: {
            ...row.stagedRebaseSourceBinding!,
            guardedRebaseJournalDigest: "0".repeat(64),
          },
        }),
        "2026-08-12T20:00:10.200Z",
      );
      await rejectLegacyEvidenceMutation(
        legacyRetired,
        (row) => ({
          ...row,
          gitEffectBinding: {
            ...row.gitEffectBinding!,
            repositoryId: "0".repeat(64),
          },
        }),
        "2026-08-12T20:00:10.300Z",
      );
      await rejectLegacyEvidenceMutation(
        legacyRetired,
        (row) => ({
          ...row,
          implementationQueue: {
            ...row.implementationQueue!,
            enrollment: {
              ...row.implementationQueue!.enrollment,
              finalizedManifestDigest: "0".repeat(64),
            },
          },
        }),
        "2026-08-12T20:00:10.400Z",
      );
      const guardedQualified = await qualify(
        guarded.prepared,
        guarded.expectedChild,
        "2026-08-12T20:00:11.000Z",
      );
      expect(guardedQualified.state).toBe("queued");
      if (guardedQualified.state !== "queued") throw new Error("guarded successor did not qualify");
      await fs.writeFile(
        path.join(subject.repositoryRoot, "second-integration.txt"),
        "second protected advance\n",
      );
      await git(subject.repositoryRoot, ["add", "second-integration.txt"]);
      await git(subject.repositoryRoot, ["commit", "-q", "-m", "second protected advance"]);
      const secondOntoCommit = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);
      launchedSuccessor = undefined;
      expect(
        await capability.coordinateImplementationCandidate({
          partitionKey: guardedQualified.partitionKey,
          holderId: `t6576-retire-exact-tip-${attestationBackend}`,
        }),
      ).toMatchObject({
        state: "successor-queued",
        source: {
          attestationId: guarded.prepared.attestationId,
          generation: guarded.prepared.generation,
        },
        successor: {
          attestationId: guarded.prepared.attestationId,
          generation: guarded.prepared.generation + 1,
        },
      });
      const retiredGuarded = await reopenedBackend.transact(
        { kind: "handle", handle: guarded.prepared },
        (store) => store.read(guarded.prepared),
      );
      expect(retiredGuarded).toMatchObject({
        state: "aborted",
        abortReason: "staged-rebase",
        implementationQueue: {
          state: "staged-rebase-retired",
          attempt: { gitReceipts: [] },
          terminal: { reason: "staged-rebase" },
        },
      });
      const secondGuarded = currentLaunchedSuccessor();
      if (secondGuarded === undefined) {
        throw new Error("retired exact-tip worker did not launch its guarded successor");
      }
      const secondInput = await capability.fetchInput({
        attestationId: secondGuarded.prepared.attestationId,
        generation: secondGuarded.prepared.generation,
        inputCapability: secondGuarded.prepared.inputCapability,
      });
      if (secondInput.state !== "input-materialized") {
        throw new Error("second guarded input unavailable");
      }
      const secondRecord = secondInput.input as Readonly<Record<string, DispatchJSONValue>>;
      const secondStartingCommit = secondRecord["startingCommit"];
      const secondBaseCommit = secondRecord["baseCommit"];
      if (typeof secondStartingCommit !== "string" || typeof secondBaseCommit !== "string") {
        throw new Error("second guarded coordinates are unavailable");
      }
      expect(secondBaseCommit).toBe(secondOntoCommit);
      if (secondGuarded.prepared.gitChangeCapability === undefined) {
        throw new Error("second guarded successor lacks Git authority");
      }
      const freshGuardedBytes = `fresh guarded receipt ${attestationBackend}\n`;
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "fresh-guarded.txt"),
        freshGuardedBytes,
      );
      const freshGuardedReceipt = await capability.gitCommit({
        ...secondGuarded.prepared,
        gitChangeCapability: secondGuarded.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-${attestationBackend}-fresh-guarded`,
        expectedHead: secondStartingCommit,
        message: "persist fresh guarded receipt",
        changes: [
          {
            kind: "add",
            path: "fresh-guarded.txt",
            newState: { mode: "100644", digest: sha256(freshGuardedBytes) },
          },
        ],
      });
      expect(
        await capability.abort({
          attestationId: secondGuarded.prepared.attestationId,
          generation: secondGuarded.prepared.generation,
          reason: "cancelled",
        }),
      ).toMatchObject({ state: "aborted", reason: "cancelled" });
      const recaptured = await capability.resolveRecovery(binding, freshGuardedReceipt.newHead);
      expect(recaptured.preparation.kind).toBe("current");
      if (recaptured.preparation.kind !== "current") {
        throw new Error("cancelled repeated guarded successor did not recapture recovery");
      }
      const resumedChild = {
        childId: `implement-worker#t6576-repeated-resumed-${attestationBackend}-${String(sequence)}`,
        runId: `t6576-repeated-resumed-${attestationBackend}-run-${String(sequence)}`,
      };
      const resumed = await capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: secondBaseCommit,
          round: 5,
          startingCommit: freshGuardedReceipt.newHead,
          validationIntent: "final",
          priorResultCommit: freshGuardedReceipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-${attestationBackend}-repeated-resumed`,
        timeoutMs: 600_000,
        expectedChild: resumedChild,
        recoveryPreparation: recaptured.preparation.recoveryPreparation,
      });
      if (!resumed.accepted || resumed.prepared.gitChangeCapability === undefined) {
        throw new Error(resumed.accepted ? "resumed worker lacks Git authority" : resumed.detail);
      }
      await capability.fetchInput({
        ...resumed.handle,
        inputCapability: resumed.prepared.inputCapability,
      });
      const resumedBytes = `resumed after repeated guarded rebase ${attestationBackend}\n`;
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "second-recovery.txt"),
        resumedBytes,
      );
      const resumedReceipt = await capability.gitCommit({
        ...resumed.handle,
        gitChangeCapability: resumed.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-${attestationBackend}-repeated-resumed-commit`,
        expectedHead: freshGuardedReceipt.newHead,
        message: "resume repeated guarded recovery",
        changes: [
          {
            kind: "add",
            path: "second-recovery.txt",
            newState: { mode: "100644", digest: sha256(resumedBytes) },
          },
        ],
      });
      expect(
        await capability.storeResult({
          resultCapability: resumed.prepared.resultCapability,
          output: {
            taskId: "T2081",
            status: "pass",
            resultCommit: resumedReceipt.newHead,
            branch: subject.managed.handle.branch,
            actualWorktreePath: subject.managed.handle.absolutePath,
            filesTouched: ["file.txt", "fresh-guarded.txt", "second-recovery.txt"],
            gitReceipts: [
              {
                ...resumedReceipt,
                objectOids: [...resumedReceipt.objectOids],
                paths: [...resumedReceipt.paths],
              },
            ],
            checkSummary: "repeated guarded recovery awaits its gate",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: secondBaseCommit,
              headCommit: resumedReceipt.newHead,
            },
            mutationTable: [
              {
                mutation: "remove the repeated guarded receipt-prefix assembly",
                observed: "current-seal recovery rejects the incomplete receipt closure",
                restored: "the repeated guarded recovery and resumed worker both validate",
              },
            ],
            summary: "ordinary recovery resumes after repeated guarded transitions",
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      expect(
        await qualify(resumed.prepared, resumedChild, "2026-08-12T20:00:14.000Z"),
      ).toMatchObject({ state: "queued" });
      await reopenedBackend.close();
    },
  );

  async function exerciseCancelledRecoveryContinuation(
    continuationKind: "ordinary" | "guarded-rebase",
    stageCurrentSourceBeforeContinuation: boolean,
    cancelGuardedSuccessor: boolean,
    attestationBackend: "memory" | "sqlite",
    guardedFreshReceiptCount: 0 | 1 | 2,
    exerciseReceiptJournalControls: boolean,
  ): Promise<void> {
    const runner = new ParentLossThenGreenGateDummy();
    const subject = await fixtureWithDispatchBase(
      runner,
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      false,
      true,
      undefined,
      artifactStore(),
      attestationBackend,
    );
    const recoveryJournal = new InMemoryCurrentRecoverySealJournalStore();
    type LaunchedSuccessor = Parameters<
      NonNullable<Parameters<typeof createDispatchCapability>[0]["implementationSuccessorLauncher"]>
    >[0];
    let launchedSuccessor: LaunchedSuccessor | undefined;
    const implementationSuccessorLauncher = async (input: LaunchedSuccessor) => {
      launchedSuccessor = input;
    };
    const capability = createDispatchCapability({
      ...subject.capabilityOptions,
      recoveryJournal,
      implementationSuccessorLauncher,
    });
    let activeCapability = capability;
    if (
      capability.qualifyImplementationCandidate === undefined ||
      capability.coordinateImplementationCandidate === undefined ||
      capability.resolveRecovery === undefined ||
      capability.gitCommit === undefined
    ) {
      throw new Error("sealed recovery runtime is unavailable");
    }
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: subject.repositoryRoot,
        taskId: subject.managed.handle.taskId,
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
      },
      { stateDir: subject.stateDir },
    );
    if (binding === null) throw new Error("sealed recovery binding disappeared");
    const qualify = async (
      prepared: typeof subject.prepared,
      child: typeof subject.expectedChild,
      observedAt: string,
    ) =>
      await activeCapability.qualifyImplementationCandidate!({
        attestationId: prepared.attestationId,
        generation: prepared.generation,
        roleId: "implement-worker",
        correlationId: child.childId.slice("implement-worker#".length),
        childThreadId: `sealed-recovery-${String(prepared.generation)}`,
        expectedRunId: child.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt,
        promptDigest: prepared.promptProvenance.promptDigest,
      });

    expect(
      await capability.storeResult({
        resultCapability: subject.prepared.resultCapability,
        output: subject.output,
      }),
    ).toMatchObject({ state: "gate-pending" });
    const sourceQualified = await qualify(
      subject.prepared,
      subject.expectedChild,
      "2026-08-12T20:00:02.000Z",
    );
    if (sourceQualified.state !== "queued") throw new Error("parent-lost source did not qualify");
    await expect(
      capability.coordinateImplementationCandidate({
        partitionKey: sourceQualified.partitionKey,
        holderId: "sealed-recovery-parent-lost-source",
      }),
    ).rejects.toThrow("controlled parent loss after qualification");
    expect(
      await subject.backend.transact({ kind: "handle", handle: subject.prepared }, (store) =>
        store.read(subject.prepared),
      ),
    ).toMatchObject({
      state: "aborted",
      abortReason: "parent-lost",
      implementationQueue: { state: "terminal", terminal: { reason: "parent-lost" } },
    });

    const firstRecovery = await capability.resolveRecovery(binding, subject.receipt.newHead);
    expect(firstRecovery.preparation.kind).toBe("current");
    if (firstRecovery.preparation.kind !== "current") {
      throw new Error("parent-lost source did not produce current recovery authority");
    }
    const cancelledChild = {
      childId: `implement-worker#sealed-cancelled-${String(sequence)}`,
      runId: `sealed-cancelled-run-${String(sequence)}`,
    };
    const cancelled = await capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        round: 1,
        startingCommit: subject.receipt.newHead,
        validationIntent: "final",
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-sealed-cancelled`,
      timeoutMs: 600_000,
      expectedChild: cancelledChild,
      recoveryPreparation: firstRecovery.preparation.recoveryPreparation,
    });
    if (!cancelled.accepted) throw new Error(cancelled.detail);
    await capability.fetchInput({
      ...cancelled.handle,
      inputCapability: cancelled.prepared.inputCapability,
    });
    expect(await capability.abort({ ...cancelled.handle, reason: "cancelled" })).toMatchObject({
      state: "aborted",
      reason: "cancelled",
    });

    const promotedRecovery = await capability.resolveRecovery(binding, subject.receipt.newHead);
    expect(promotedRecovery.preparation.kind).toBe("current");
    if (promotedRecovery.preparation.kind !== "current") {
      throw new Error("cancelled successor did not promote current recovery authority");
    }
    const successorChild = {
      childId: `implement-worker#sealed-successor-${String(sequence)}`,
      runId: `sealed-successor-run-${String(sequence)}`,
    };
    const successor = await capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        round: 2,
        startingCommit: subject.receipt.newHead,
        validationIntent: "final",
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-sealed-successor`,
      timeoutMs: 600_000,
      expectedChild: successorChild,
      recoveryPreparation: promotedRecovery.preparation.recoveryPreparation,
    });
    if (!successor.accepted || successor.prepared.gitChangeCapability === undefined) {
      throw new Error("sealed successor did not receive Git authority");
    }
    await capability.fetchInput({
      ...successor.handle,
      inputCapability: successor.prepared.inputCapability,
    });
    await fs.writeFile(
      path.join(subject.managed.handle.absolutePath, "file.txt"),
      "sealed recovery correction\n",
    );
    const successorReceipt = await capability.gitCommit({
      ...successor.handle,
      gitChangeCapability: successor.prepared.gitChangeCapability,
      operationId: `T2081-${String(sequence)}-sealed-successor-commit`,
      expectedHead: subject.receipt.newHead,
      message: "correct sealed recovery successor",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("after\n") },
          newState: { mode: "100644", digest: sha256("sealed recovery correction\n") },
        },
      ],
    });
    expect(
      await capability.storeResult({
        resultCapability: successor.prepared.resultCapability,
        output: {
          ...subject.output,
          resultCommit: successorReceipt.newHead,
          filesTouched: [...successorReceipt.paths],
          gitReceipts: [
            {
              ...successorReceipt,
              objectOids: [...successorReceipt.objectOids],
              paths: [...successorReceipt.paths],
            },
          ],
          checkSummary: "sealed recovery successor checks passed",
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit: subject.dispatchBaseCommit,
            headCommit: successorReceipt.newHead,
          },
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    await subject.backend.close();
    const reopenedBackend =
      attestationBackend === "sqlite"
        ? new SqliteAttestationBackend({
            namespace: subject.backend.namespace,
            dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
          })
        : new InMemoryAttestationBackend(subject.store);
    activeCapability = createDispatchCapability({
      ...subject.capabilityOptions,
      backend: reopenedBackend,
      recoveryJournal,
      implementationSuccessorLauncher,
    });
    const exactSuccessor = await reopenedBackend.transact(
      { kind: "handle", handle: successor.handle },
      (store) => store.read(successor.handle),
    );
    if (
      exactSuccessor === undefined ||
      isAttestationTombstone(exactSuccessor) ||
      exactSuccessor.dispatchJournalRecoveryClaim === undefined
    ) {
      throw new Error("sealed successor lost its persisted journal claim");
    }
    const rejectJournalMutation = async (
      mutate: (row: AttestationEnvelope) => AttestationEnvelope,
      observedAt: string,
    ) => {
      const corrupted = mutate(exactSuccessor);
      await reopenedBackend.transact({ kind: "handle", handle: successor.handle }, (store) => {
        const current = store.read(successor.handle);
        if (current === undefined) throw new Error("sealed successor disappeared before mutation");
        store.replace(current, corrupted);
      });
      await expect(qualify(successor.prepared, successorChild, observedAt)).rejects.toThrow(
        "cannot be resurrected",
      );
      await reopenedBackend.transact({ kind: "handle", handle: successor.handle }, (store) => {
        const current = store.read(successor.handle);
        if (current === undefined) throw new Error("sealed successor disappeared after mutation");
        store.replace(current, exactSuccessor);
      });
    };
    await rejectJournalMutation((row) => {
      const { dispatchJournalRecoveryClaim: _claim, ...withoutClaim } = row;
      return withoutClaim;
    }, "2026-08-12T20:00:07.100Z");
    for (const [field, value, observedAt] of [
      ["goalRef", "goals:G9999", "2026-08-12T20:00:07.200Z"],
      ["finalizedManifestDigest", "0".repeat(64), "2026-08-12T20:00:07.300Z"],
      ["managedFingerprint", "0".repeat(64), "2026-08-12T20:00:07.400Z"],
      ["gitReceiptsDigest", "0".repeat(64), "2026-08-12T20:00:07.500Z"],
      ["sourceTerminalDigest", "0".repeat(64), "2026-08-12T20:00:07.600Z"],
    ] as const) {
      await rejectJournalMutation(
        (row) => ({
          ...row,
          dispatchJournalRecoveryClaim: {
            ...row.dispatchJournalRecoveryClaim!,
            [field]: value,
          },
        }),
        observedAt,
      );
    }
    await rejectJournalMutation(
      (row) => ({
        ...row,
        dispatchJournalRecoveryClaim: {
          ...row.dispatchJournalRecoveryClaim!,
          source: { kind: "aborted", version: 1, abortReason: "parent-lost" },
        },
      }),
      "2026-08-12T20:00:07.700Z",
    );
    const successorQualified = await qualify(
      successor.prepared,
      successorChild,
      "2026-08-12T20:00:08.000Z",
    );
    expect(successorQualified.state).toBe("queued");
    expect(runner.requests).toHaveLength(1);
    if (successorQualified.state !== "queued") {
      throw new Error("sealed successor did not qualify");
    }
    if (stageCurrentSourceBeforeContinuation) {
      await fs.writeFile(
        path.join(subject.repositoryRoot, "staged-advance.txt"),
        "advance before staged retirement\n",
      );
      await git(subject.repositoryRoot, ["add", "staged-advance.txt"]);
      await git(subject.repositoryRoot, ["commit", "-q", "-m", "advance before staged retirement"]);
      await git(subject.repositoryRoot, ["config", "user.name", "T2081"]);
      await git(subject.repositoryRoot, ["config", "user.email", "t2081@example.invalid"]);
      const stagedOutcome = await activeCapability.coordinateImplementationCandidate!({
        partitionKey: successorQualified.partitionKey,
        holderId: "sealed-staged-retirement",
      });
      expect(stagedOutcome).toMatchObject({
        state: "successor-queued",
        source: successor.handle,
        successor: {
          attestationId: successor.handle.attestationId,
          generation: successor.handle.generation + 1,
        },
      });
      const retired = await reopenedBackend.transact(
        { kind: "handle", handle: successor.handle },
        (store) => store.read(successor.handle),
      );
      expect(retired).toMatchObject({
        state: "aborted",
        abortReason: "staged-rebase",
        implementationQueue: {
          state: "staged-rebase-retired",
          terminal: { reason: "staged-rebase" },
        },
      });
      const guarded = launchedSuccessor;
      if (guarded === undefined) {
        throw new Error("staged retirement did not launch its guarded successor");
      }
      const guardedInput = await activeCapability.fetchInput({
        attestationId: guarded.prepared.attestationId,
        generation: guarded.prepared.generation,
        inputCapability: guarded.prepared.inputCapability,
      });
      if (guardedInput.state !== "input-materialized") {
        throw new Error("staged guarded successor input did not materialize");
      }
      const guardedRecord = guardedInput.input as Readonly<Record<string, DispatchJSONValue>>;
      const guardedTip = guardedRecord["startingCommit"];
      if (typeof guardedTip !== "string") {
        throw new Error("staged guarded successor starting commit is unavailable");
      }
      expect(
        await activeCapability.abort({
          attestationId: guarded.prepared.attestationId,
          generation: guarded.prepared.generation,
          reason: "cancelled",
        }),
      ).toMatchObject({ state: "aborted", reason: "cancelled" });
      let recaptured;
      try {
        recaptured = await activeCapability.resolveRecovery!(binding, guardedTip);
      } catch (error) {
        expect(error).toHaveProperty(
          "message",
          expect.stringContaining(
            "staged recovery retirement does not authenticate its exact guarded successor",
          ),
        );
        throw error;
      }
      expect(recaptured.preparation.kind).toBe("current");
      if (recaptured.preparation.kind !== "current") {
        throw new Error("cancelled guarded successor did not become current recovery authority");
      }
      const guardedBase = guardedRecord["baseCommit"];
      if (typeof guardedBase !== "string") {
        throw new Error("staged guarded successor base commit is unavailable");
      }
      const resumedChild = {
        childId: `implement-worker#sealed-staged-resumed-${attestationBackend}-${String(sequence)}`,
        runId: `sealed-staged-resumed-${attestationBackend}-run-${String(sequence)}`,
      };
      const resumed = await activeCapability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: guardedBase,
          round: 4,
          startingCommit: guardedTip,
          validationIntent: "final",
          priorResultCommit: guardedTip,
        },
        idempotencyKey: `T2081-${String(sequence)}-${attestationBackend}-staged-resumed`,
        timeoutMs: 600_000,
        expectedChild: resumedChild,
        recoveryPreparation: recaptured.preparation.recoveryPreparation,
      });
      if (!resumed.accepted || resumed.prepared.gitChangeCapability === undefined) {
        throw new Error("staged resumed worker did not receive Git authority");
      }
      await activeCapability.fetchInput({
        ...resumed.handle,
        inputCapability: resumed.prepared.inputCapability,
      });
      expect(
        await activeCapability.abort({ ...resumed.handle, reason: "cancelled" }),
      ).toMatchObject({ state: "aborted", reason: "cancelled" });
      const resumedRecovery = await activeCapability.resolveRecovery!(binding, guardedTip);
      expect(resumedRecovery).toMatchObject({
        status: "dispatch-recovery-resolved",
        liveTip: guardedTip,
        preparation: { kind: "current" },
      });
      expect(runner.requests).toHaveLength(1);
      await reopenedBackend.close();
      return;
    }
    expect(
      await activeCapability.coordinateImplementationCandidate!({
        partitionKey: successorQualified.partitionKey,
        holderId: `sealed-successor-${continuationKind}`,
      }),
    ).toMatchObject({ state: "completed" });
    expect(runner.requests).toHaveLength(2);

    const nextChild = {
      childId: `implement-worker#sealed-next-${continuationKind}-${String(sequence)}`,
      runId: `sealed-next-${continuationKind}-run-${String(sequence)}`,
    };
    let next;
    let nextOutput: DispatchJSONValue;
    let guardedSuccessorTip: string | undefined;
    let guardedRecoveryBase: string | undefined;
    if (continuationKind === "ordinary") {
      if (activeCapability.resolveContinuation === undefined) {
        throw new Error("consumed sealed successor omitted continuation authority");
      }
      const continuation = await activeCapability.resolveContinuation(
        binding,
        successorReceipt.newHead,
      );
      next = await activeCapability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: subject.dispatchBaseCommit,
          round: 3,
          startingCommit: successorReceipt.newHead,
          validationIntent: "final",
          priorResultCommit: successorReceipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-sealed-next-ordinary`,
        timeoutMs: 600_000,
        expectedChild: nextChild,
        continuation: continuation.continuationReference,
      });
      nextOutput = {
        ...subject.output,
        resultCommit: successorReceipt.newHead,
        filesTouched: [...successorReceipt.paths],
        gitReceipts: [],
        checkSummary: "ordinary continuation after sealed recovery checks passed",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit: subject.dispatchBaseCommit,
          headCommit: successorReceipt.newHead,
        },
      };
    } else {
      await fs.writeFile(path.join(subject.repositoryRoot, "integration.txt"), "advanced\n");
      await git(subject.repositoryRoot, ["add", "integration.txt"]);
      await git(subject.repositoryRoot, ["commit", "-q", "-m", "advance integration"]);
      const ontoCommit = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);
      const rebase = await runGuardedRebase({
        binding,
        operationId: `t2081-sealed-next-${String(sequence)}`,
        ontoCommit,
        stateDir: subject.stateDir,
        runEffect: async () => {
          await git(subject.managed.handle.absolutePath, ["rebase", ontoCommit]);
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      if (rebase.kind !== "finalized") {
        throw new Error("sealed recovery guarded rebase did not finalize");
      }
      guardedSuccessorTip = rebase.bridge.rebasedStartCommit;
      guardedRecoveryBase = rebase.bridge.ontoCommit;
      next = await activeCapability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: ontoCommit,
          round: 3,
          startingCommit: rebase.bridge.rebasedStartCommit,
          validationIntent: "final",
          priorResultCommit: successorReceipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-sealed-next-guarded`,
        timeoutMs: 600_000,
        expectedChild: nextChild,
        reprepareOf: successor.handle,
        guardedRebase: rebase.reference,
      });
      if (!next.accepted) throw new Error(next.detail);
      const materialized = await activeCapability.fetchInput({
        ...next.handle,
        inputCapability: next.prepared.inputCapability,
      });
      if (materialized.state !== "input-materialized") {
        throw new Error("guarded sealed successor input did not materialize");
      }
      const guardedInput = materialized.input;
      if (
        guardedInput === null ||
        typeof guardedInput !== "object" ||
        Array.isArray(guardedInput)
      ) {
        throw new Error("guarded sealed successor input is malformed");
      }
      const guardedRecord = guardedInput as Readonly<Record<string, DispatchJSONValue>>;
      const lineage = guardedRecord["guardedRebaseLineage"];
      if (lineage === null || typeof lineage !== "object" || Array.isArray(lineage)) {
        throw new Error("guarded sealed successor omitted server lineage");
      }
      const lineageRecord = lineage as Readonly<Record<string, DispatchJSONValue>>;
      const guardedRebase = lineageRecord["guardedRebase"];
      const lineageOntoCommit = lineageRecord["ontoCommit"];
      const rebasedStartCommit = lineageRecord["rebasedStartCommit"];
      const exactTip = lineageRecord["exactTip"];
      if (
        typeof guardedRebase !== "string" ||
        typeof lineageOntoCommit !== "string" ||
        typeof rebasedStartCommit !== "string" ||
        typeof exactTip !== "boolean"
      ) {
        throw new Error("guarded sealed successor omitted server lineage");
      }
      nextOutput = {
        taskId: "T2081",
        status: "pass",
        resultCommit: rebase.bridge.rebasedStartCommit,
        branch: subject.managed.handle.branch,
        actualWorktreePath: subject.managed.handle.absolutePath,
        filesTouched: ["file.txt"],
        gitReceipts: [],
        gitLineage: {
          kind: "guarded-rebase",
          guardedRebase,
          ontoCommit: lineageOntoCommit,
          rebasedStartCommit,
          exactTip,
        },
        checkSummary: "guarded continuation after sealed recovery checks passed",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit: ontoCommit,
          headCommit: rebase.bridge.rebasedStartCommit,
        },
        summary: "guarded continuation retains sealed recovery ancestry",
      };
    }
    if (!next.accepted) throw new Error(next.detail);
    if (continuationKind === "ordinary") {
      await activeCapability.fetchInput({
        ...next.handle,
        inputCapability: next.prepared.inputCapability,
      });
    }
    if (cancelGuardedSuccessor) {
      if (
        continuationKind !== "guarded-rebase" ||
        guardedSuccessorTip === undefined ||
        guardedRecoveryBase === undefined
      ) {
        throw new Error("current-seal staged-successor fixture requires a guarded successor");
      }
      if (next.prepared.gitChangeCapability === undefined) {
        throw new Error("guarded recovery successor lacks Git authority");
      }
      let guardedLiveTip = guardedSuccessorTip;
      let guardedFreshReceiptOperationId: string | undefined;
      for (let index = 0; index < guardedFreshReceiptCount; index += 1) {
        const relativePath = `fresh-guarded-${String(index)}.txt`;
        const bytes = `fresh guarded recovery ${String(index)}\n`;
        await fs.writeFile(path.join(subject.managed.handle.absolutePath, relativePath), bytes);
        const receipt = await activeCapability.gitCommit!({
          ...next.handle,
          gitChangeCapability: next.prepared.gitChangeCapability,
          operationId: `T2081-${String(sequence)}-sealed-fresh-guarded-${String(index)}`,
          expectedHead: guardedLiveTip,
          message: `persist guarded recovery receipt ${String(index)}`,
          changes: [
            {
              kind: "add",
              path: relativePath,
              newState: { mode: "100644", digest: sha256(bytes) },
            },
          ],
        });
        guardedFreshReceiptOperationId = receipt.operationId;
        guardedLiveTip = receipt.newHead;
      }
      expect(await activeCapability.abort({ ...next.handle, reason: "cancelled" })).toMatchObject({
        state: "aborted",
        reason: "cancelled",
      });
      if (exerciseReceiptJournalControls) {
        if (guardedFreshReceiptOperationId === undefined) {
          throw new Error("receipt-journal controls require one fresh guarded receipt");
        }
        const operationKey = sha256(
          `${next.handle.attestationId}\n${String(next.handle.generation)}\n${guardedFreshReceiptOperationId}`,
        );
        const journalPath = path.join(subject.stateDir, "git-broker", operationKey, "journal.json");
        const journalBytes = await fs.readFile(journalPath);
        const journalRecord = JSON.parse(journalBytes.toString()) as {
          receipt?: Record<string, unknown>;
        };
        if (journalRecord.receipt === undefined) {
          throw new Error("fresh guarded receipt journal omitted its receipt");
        }
        const recoveryBeforeControls = await recoveryJournal.read("T2081");
        const rejectJournalBytes = async (bytes: string): Promise<void> => {
          await fs.writeFile(journalPath, bytes);
          try {
            await expect(
              activeCapability.resolveRecovery!(binding, guardedLiveTip),
            ).rejects.toThrow();
            expect(await recoveryJournal.read("T2081")).toEqual(recoveryBeforeControls);
          } finally {
            await fs.writeFile(journalPath, journalBytes);
          }
        };
        await rejectJournalBytes("{}\n");
        const missingPath = `${journalPath}.missing`;
        await fs.rename(journalPath, missingPath);
        try {
          await expect(
            activeCapability.resolveRecovery!(binding, guardedLiveTip),
          ).rejects.toThrow();
          expect(await recoveryJournal.read("T2081")).toEqual(recoveryBeforeControls);
        } finally {
          await fs.rename(missingPath, journalPath);
        }
        await rejectJournalBytes(
          `${JSON.stringify({
            ...journalRecord,
            receipt: { ...journalRecord.receipt, attestationId: `att_${"f".repeat(32)}` },
          })}\n`,
        );
        await rejectJournalBytes(
          `${JSON.stringify({
            ...journalRecord,
            receipt: { ...journalRecord.receipt, oldHead: "0".repeat(40) },
          })}\n`,
        );
      }
      const recaptured = await activeCapability.resolveRecovery!(binding, guardedLiveTip);
      expect(recaptured.preparation.kind).toBe("current");
      if (recaptured.preparation.kind !== "current") {
        throw new Error("cancelled guarded successor did not become current recovery authority");
      }
      const resumedChild = {
        childId: `implement-worker#sealed-resumed-${String(sequence)}`,
        runId: `sealed-resumed-run-${String(sequence)}`,
      };
      const resumed = await activeCapability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: guardedRecoveryBase,
          round: 4,
          startingCommit: guardedLiveTip,
          validationIntent: "final",
          priorResultCommit: guardedLiveTip,
        },
        idempotencyKey: `T2081-${String(sequence)}-sealed-resumed`,
        timeoutMs: 600_000,
        expectedChild: resumedChild,
        recoveryPreparation: recaptured.preparation.recoveryPreparation,
      });
      if (!resumed.accepted || resumed.prepared.gitChangeCapability === undefined) {
        throw new Error("resumed guarded recovery did not receive Git authority");
      }
      await activeCapability.fetchInput({
        ...resumed.handle,
        inputCapability: resumed.prepared.inputCapability,
      });
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "resumed.txt"),
        "resumed after guarded recovery\n",
      );
      const resumedReceipt = await activeCapability.gitCommit!({
        ...resumed.handle,
        gitChangeCapability: resumed.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-sealed-resumed-commit`,
        expectedHead: guardedLiveTip,
        message: "resume guarded recovery",
        changes: [
          {
            kind: "add",
            path: "resumed.txt",
            newState: {
              mode: "100644",
              digest: sha256("resumed after guarded recovery\n"),
            },
          },
        ],
      });
      const resumedFiles = (
        await git(subject.managed.handle.absolutePath, [
          "diff",
          "--name-only",
          guardedRecoveryBase,
          resumedReceipt.newHead,
          "--",
        ])
      )
        .split("\n")
        .filter((entry) => entry !== "")
        .sort();
      expect(
        await activeCapability.storeResult({
          resultCapability: resumed.prepared.resultCapability,
          output: {
            ...subject.output,
            resultCommit: resumedReceipt.newHead,
            filesTouched: resumedFiles,
            gitReceipts: [
              {
                ...resumedReceipt,
                objectOids: [...resumedReceipt.objectOids],
                paths: [...resumedReceipt.paths],
              },
            ],
            checkSummary: "resumed guarded recovery checks passed",
            mutationTable: [
              {
                mutation: "remove the authenticated guarded receipt component",
                observed: "current-seal recapture rejects the incomplete receipt closure",
                restored: "the resumed worker validates the complete recovery closure",
              },
            ],
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: guardedRecoveryBase,
              headCommit: resumedReceipt.newHead,
            },
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      const resumedQualified = await qualify(
        resumed.prepared,
        resumedChild,
        "2026-08-12T20:00:13.000Z",
      );
      expect(resumedQualified.state).toBe("queued");
      if (resumedQualified.state !== "queued") {
        throw new Error("resumed guarded recovery did not qualify");
      }
      expect(
        await activeCapability.coordinateImplementationCandidate!({
          partitionKey: resumedQualified.partitionKey,
          holderId: "sealed-resumed-guarded",
        }),
      ).toMatchObject({ state: "completed" });
      expect(runner.requests).toHaveLength(3);
      await reopenedBackend.close();
      return;
    }
    expect(
      await activeCapability.storeResult({
        resultCapability: next.prepared.resultCapability,
        output: nextOutput,
      }),
    ).toMatchObject({ state: "gate-pending" });
    const retainedIntermediate = await reopenedBackend.transact(
      { kind: "handle", handle: successor.handle },
      (store) => store.read(successor.handle),
    );
    if (
      retainedIntermediate === undefined ||
      isAttestationTombstone(retainedIntermediate) ||
      retainedIntermediate.implementationQueue === undefined
    ) {
      throw new Error("sealed recovery intermediate lost its queue evidence");
    }
    const rejectIntermediateMutation = async (
      mutate: (row: AttestationEnvelope) => AttestationEnvelope,
      observedAt: string,
    ) => {
      const corrupted = mutate(retainedIntermediate);
      await reopenedBackend.transact({ kind: "handle", handle: successor.handle }, (store) => {
        const current = store.read(successor.handle);
        if (current === undefined) throw new Error("sealed recovery intermediate disappeared");
        store.replace(current, corrupted);
      });
      await expect(qualify(next.prepared, nextChild, observedAt)).rejects.toThrow(
        "cannot be resurrected",
      );
      await reopenedBackend.transact({ kind: "handle", handle: successor.handle }, (store) => {
        const current = store.read(successor.handle);
        if (current === undefined) throw new Error("sealed recovery intermediate disappeared");
        store.replace(current, retainedIntermediate);
      });
    };
    await rejectIntermediateMutation((row) => {
      const { dispatchJournalRecoveryClaim: _claim, ...withoutClaim } = row;
      return withoutClaim;
    }, "2026-08-12T20:00:10.100Z");
    await rejectIntermediateMutation(
      (row) => ({
        ...row,
        implementationQueue: {
          ...row.implementationQueue!,
          enrollment: {
            ...row.implementationQueue!.enrollment,
            finalizedManifestDigest: "0".repeat(64),
          },
        },
      }),
      "2026-08-12T20:00:10.200Z",
    );
    await rejectIntermediateMutation(
      (row) => ({
        ...row,
        implementationQueue: {
          ...row.implementationQueue!,
          attempt: {
            ...row.implementationQueue!.attempt,
            gitReceipts: [],
          },
        },
      }),
      "2026-08-12T20:00:10.300Z",
    );
    if (continuationKind === "guarded-rebase") {
      await rejectIntermediateMutation(
        (row) => ({
          ...row,
          implementationQueue: {
            ...row.implementationQueue!,
            stagedRebaseSource: {
              ...row.implementationQueue!.stagedRebaseSource!,
              guardedRebaseJournalDigest: "0".repeat(64),
            },
          },
        }),
        "2026-08-12T20:00:10.400Z",
      );
    } else {
      const retainedNext = await reopenedBackend.transact(
        { kind: "handle", handle: next.handle },
        (store) => store.read(next.handle),
      );
      if (
        retainedNext === undefined ||
        isAttestationTombstone(retainedNext) ||
        retainedNext.dispatchContinuationClaim === undefined
      ) {
        throw new Error("ordinary sealed continuation lost its persisted claim");
      }
      const changedClaim = {
        ...retainedNext,
        dispatchContinuationClaim: {
          ...retainedNext.dispatchContinuationClaim,
          source: {
            ...retainedNext.dispatchContinuationClaim.source,
            generation: retainedNext.dispatchContinuationClaim.source.generation + 1,
          },
        },
      };
      await reopenedBackend.transact({ kind: "handle", handle: next.handle }, (store) => {
        const current = store.read(next.handle);
        if (current === undefined) throw new Error("ordinary sealed continuation disappeared");
        store.replace(current, changedClaim);
      });
      await expect(qualify(next.prepared, nextChild, "2026-08-12T20:00:10.400Z")).rejects.toThrow(
        "cannot be resurrected",
      );
      await reopenedBackend.transact({ kind: "handle", handle: next.handle }, (store) => {
        const current = store.read(next.handle);
        if (current === undefined) throw new Error("ordinary sealed continuation disappeared");
        store.replace(current, retainedNext);
      });
    }
    expect(await qualify(next.prepared, nextChild, "2026-08-12T20:00:11.000Z")).toMatchObject({
      state: "queued",
    });
    await reopenedBackend.close();
  }

  test("a cancelled sealed recovery successor composes into an ordinary consumed continuation", async () => {
    await exerciseCancelledRecoveryContinuation("ordinary", false, false, "sqlite", 0, false);
  });

  test("a cancelled sealed recovery successor composes into an authenticated guarded rebase", async () => {
    await exerciseCancelledRecoveryContinuation("guarded-rebase", false, false, "sqlite", 0, false);
  });

  test("a staged-retired recovery source and its cancelled guarded successor advance the current seal", async () => {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
      await exerciseCancelledRecoveryContinuation(
        "guarded-rebase",
        true,
        false,
        attestationBackend,
        0,
        false,
      );
    }
  });

  test("cancelled guarded recovery workers retain zero one or multiple fresh receipt components after reopen", async () => {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
      for (const receiptCount of [0, 1, 2] as const) {
        await exerciseCancelledRecoveryContinuation(
          "guarded-rebase",
          false,
          true,
          attestationBackend,
          receiptCount,
          receiptCount === 1,
        );
      }
    }
  }, 30_000);

  test("cancelled unenrolled recovery workers retain fresh receipts across exact manual guarded successors", async () => {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
      for (const freshReceiptCount of [0, 1, 2] as const) {
        const runner = new GateDummy();
        const subject = await fixtureWithDispatchBase(
          runner,
          "managed",
          () => "2026-08-12T20:00:00.000Z",
          false,
          true,
          undefined,
          artifactStore(),
          attestationBackend,
        );
        const recoveryJournal = new InMemoryCurrentRecoverySealJournalStore();
        let activeBackend = subject.backend;
        let activeCapability = createDispatchCapability({
          ...subject.capabilityOptions,
          recoveryJournal,
        });
        if (activeCapability.resolveRecovery === undefined) {
          throw new Error("manual guarded recovery resolver is unavailable");
        }
        expect(
          await activeCapability.abort({ ...subject.prepared, reason: "parent-lost" }),
        ).toMatchObject({ state: "aborted", reason: "parent-lost" });
        const binding = await resolveManagedWorktreeDispatchBinding(
          {
            repositoryRoot: subject.repositoryRoot,
            taskId: subject.managed.handle.taskId,
            worktreePath: subject.managed.handle.absolutePath,
            branch: subject.managed.handle.branch,
          },
          { stateDir: subject.stateDir },
        );
        if (binding === null) throw new Error("manual guarded recovery binding disappeared");
        let currentTip = subject.receipt.newHead;
        let currentBase = subject.dispatchBaseCommit;
        let recovery = await activeCapability.resolveRecovery(binding, currentTip);
        expect(recovery.preparation.kind).toBe("current");
        if (recovery.preparation.kind !== "current") {
          throw new Error("parent-lost source did not produce current recovery authority");
        }
        const reopen = async (): Promise<void> => {
          if (attestationBackend === "sqlite") {
            await activeBackend.close();
            activeBackend = new SqliteAttestationBackend({
              namespace: subject.backend.namespace,
              dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
            });
          } else {
            activeBackend = new InMemoryAttestationBackend(subject.store);
          }
          activeCapability = createDispatchCapability({
            ...subject.capabilityOptions,
            backend: activeBackend,
            recoveryJournal,
          });
          if (activeCapability.resolveRecovery === undefined) {
            throw new Error("reopened manual guarded recovery resolver is unavailable");
          }
        };
        const bridgeRounds = freshReceiptCount === 2 ? 2 : 1;
        for (let bridgeRound = 0; bridgeRound < bridgeRounds; bridgeRound += 1) {
          const source = await activeCapability.prepare({
            roleId: "implement-worker",
            input: {
              taskId: "T2081",
              headline: "supervise exact tip",
              description: "run the full gate outside the workspace-write sandbox",
              acceptance: "only a green exact tip becomes consumable",
              worktreePath: subject.managed.handle.absolutePath,
              branch: subject.managed.handle.branch,
              baseCommit: currentBase,
              round: bridgeRound * 2 + 1,
              startingCommit: currentTip,
              validationIntent: "final",
              priorResultCommit: currentTip,
            },
            idempotencyKey: `T2081-${String(sequence)}-${attestationBackend}-${String(freshReceiptCount)}-${String(bridgeRound)}-manual-source`,
            timeoutMs: 600_000,
            expectedChild: {
              childId: `implement-worker#manual-source-${String(sequence)}-${String(bridgeRound)}`,
              runId: `manual-source-${String(sequence)}-${String(bridgeRound)}-run`,
            },
            recoveryPreparation: recovery.preparation.recoveryPreparation,
          });
          if (!source.accepted || source.prepared.gitChangeCapability === undefined) {
            throw new Error(
              `manual source refused: ${source.accepted ? "missing Git authority" : source.detail}`,
            );
          }
          await activeCapability.fetchInput({
            ...source.handle,
            inputCapability: source.prepared.inputCapability,
          });
          if (activeCapability.gitCommit === undefined) {
            throw new Error("manual source Git broker is unavailable");
          }
          let sourceTip = currentTip;
          for (let receiptIndex = 0; receiptIndex < freshReceiptCount; receiptIndex += 1) {
            const relativePath = `manual-source-${String(bridgeRound)}-${String(receiptIndex)}.txt`;
            const bytes = `manual source ${String(bridgeRound)} receipt ${String(receiptIndex)}\n`;
            await fs.writeFile(path.join(binding.worktreePath, relativePath), bytes);
            const receipt = await activeCapability.gitCommit({
              ...source.handle,
              gitChangeCapability: source.prepared.gitChangeCapability,
              operationId: `T2081-${String(sequence)}-${attestationBackend}-${String(freshReceiptCount)}-${String(bridgeRound)}-source-${String(receiptIndex)}`,
              expectedHead: sourceTip,
              message: "persist cancelled unenrolled recovery source",
              changes: [
                {
                  kind: "add",
                  path: relativePath,
                  newState: { mode: "100644", digest: sha256(bytes) },
                },
              ],
            });
            sourceTip = receipt.newHead;
          }
          expect(
            await activeCapability.abort({ ...source.handle, reason: "cancelled" }),
          ).toMatchObject({ state: "aborted", reason: "cancelled" });
          await reopen();

          const protectedPath = `manual-protected-${String(bridgeRound)}.txt`;
          await fs.writeFile(path.join(subject.repositoryRoot, protectedPath), "protected\n");
          await git(subject.repositoryRoot, ["add", protectedPath]);
          await git(subject.repositoryRoot, [
            "commit",
            "-q",
            "-m",
            `advance protected head ${String(bridgeRound)}`,
          ]);
          const protectedHead = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);
          const rebase = await runGuardedRebase({
            binding,
            operationId: `t6576-manual-${attestationBackend}-${String(freshReceiptCount)}-${String(bridgeRound)}`,
            ontoCommit: protectedHead,
            stateDir: subject.stateDir,
            runEffect: async () => {
              await git(binding.worktreePath, ["rebase", protectedHead]);
              return { code: 0, stdout: "", stderr: "" };
            },
          });
          if (rebase.kind !== "finalized") {
            throw new Error("manual guarded recovery rebase did not finalize");
          }
          const guarded = await activeCapability.prepare({
            roleId: "implement-worker",
            input: {
              taskId: "T2081",
              headline: "supervise exact tip",
              description: "run the full gate outside the workspace-write sandbox",
              acceptance: "only a green exact tip becomes consumable",
              worktreePath: subject.managed.handle.absolutePath,
              branch: subject.managed.handle.branch,
              baseCommit: protectedHead,
              round: bridgeRound * 2 + 2,
              startingCommit: rebase.bridge.rebasedStartCommit,
              validationIntent: "final",
              priorResultCommit: sourceTip,
            },
            idempotencyKey: `T2081-${String(sequence)}-${attestationBackend}-${String(freshReceiptCount)}-${String(bridgeRound)}-manual-successor`,
            timeoutMs: 600_000,
            expectedChild: {
              childId: `implement-worker#manual-successor-${String(sequence)}-${String(bridgeRound)}`,
              runId: `manual-successor-${String(sequence)}-${String(bridgeRound)}-run`,
            },
            reprepareOf: source.handle,
            guardedRebase: rebase.reference,
          });
          if (!guarded.accepted || guarded.prepared.gitChangeCapability === undefined) {
            throw new Error(
              `manual guarded successor refused: ${guarded.accepted ? "missing Git authority" : guarded.detail}`,
            );
          }
          await activeCapability.fetchInput({
            ...guarded.handle,
            inputCapability: guarded.prepared.inputCapability,
          });
          let guardedTip = rebase.bridge.rebasedStartCommit;
          for (let receiptIndex = 0; receiptIndex < freshReceiptCount; receiptIndex += 1) {
            const relativePath = `manual-guarded-${String(bridgeRound)}-${String(receiptIndex)}.txt`;
            const bytes = `manual guarded ${String(bridgeRound)} receipt ${String(receiptIndex)}\n`;
            await fs.writeFile(path.join(binding.worktreePath, relativePath), bytes);
            const receipt = await activeCapability.gitCommit!({
              ...guarded.handle,
              gitChangeCapability: guarded.prepared.gitChangeCapability,
              operationId: `T2081-${String(sequence)}-${attestationBackend}-${String(freshReceiptCount)}-${String(bridgeRound)}-guarded-${String(receiptIndex)}`,
              expectedHead: guardedTip,
              message: "persist cancelled manual guarded successor",
              changes: [
                {
                  kind: "add",
                  path: relativePath,
                  newState: { mode: "100644", digest: sha256(bytes) },
                },
              ],
            });
            guardedTip = receipt.newHead;
          }
          expect(
            await activeCapability.abort({ ...guarded.handle, reason: "cancelled" }),
          ).toMatchObject({ state: "aborted", reason: "cancelled" });
          await reopen();
          if (freshReceiptCount === 1 && bridgeRound === 0) {
            const exactSource = await activeBackend.transact(
              { kind: "handle", handle: source.handle },
              (store) => store.read(source.handle),
            );
            if (
              exactSource === undefined ||
              isAttestationTombstone(exactSource) ||
              exactSource.gitEffectBinding === undefined ||
              exactSource.dispatchJournalRecoveryClaim === undefined
            ) {
              throw new Error("manual recovery source lost its authenticated context");
            }
            const journalBeforeControls = await recoveryJournal.read("T2081");
            const rowsBeforeControls = await activeBackend.transact(
              { kind: "namespace" },
              (store) => store.rows().length,
            );
            const rejectSourceMutation = async (
              mutate: (row: AttestationEnvelope) => AttestationEnvelope,
            ): Promise<void> => {
              await activeBackend.transact({ kind: "handle", handle: source.handle }, (store) => {
                const current = store.read(source.handle);
                if (current === undefined) throw new Error("manual recovery source disappeared");
                store.replace(current, mutate(exactSource));
              });
              await expect(
                activeCapability.resolveRecovery!(binding, guardedTip),
              ).rejects.toThrow();
              expect(await recoveryJournal.read("T2081")).toEqual(journalBeforeControls);
              await activeBackend.transact({ kind: "handle", handle: source.handle }, (store) => {
                const current = store.read(source.handle);
                if (current === undefined) throw new Error("mutated recovery source disappeared");
                store.replace(current, exactSource);
              });
              expect(
                await activeBackend.transact({ kind: "namespace" }, (store) => store.rows().length),
              ).toBe(rowsBeforeControls);
            };
            for (const mutate of [
              (row: AttestationEnvelope): AttestationEnvelope => ({
                ...row,
                prepareRequestDigest: "0".repeat(64),
              }),
              (row: AttestationEnvelope): AttestationEnvelope => ({
                ...row,
                terminalDigest: "0".repeat(64),
              }),
              (row: AttestationEnvelope): AttestationEnvelope => ({
                ...row,
                gitEffectBinding: { ...row.gitEffectBinding!, repositoryId: "0".repeat(64) },
              }),
              (row: AttestationEnvelope): AttestationEnvelope => ({
                ...row,
                dispatchJournalRecoveryClaim: {
                  ...row.dispatchJournalRecoveryClaim!,
                  taskId: "T9999",
                },
              }),
              (row: AttestationEnvelope): AttestationEnvelope => ({
                ...row,
                dispatchJournalRecoveryClaim: {
                  ...row.dispatchJournalRecoveryClaim!,
                  goalRef: "goals:G9999",
                },
              }),
              (row: AttestationEnvelope): AttestationEnvelope => ({
                ...row,
                dispatchJournalRecoveryClaim: {
                  ...row.dispatchJournalRecoveryClaim!,
                  finalizedManifestDigest: "0".repeat(64),
                },
              }),
              (row: AttestationEnvelope): AttestationEnvelope => ({
                ...row,
                dispatchJournalRecoveryClaim: {
                  ...row.dispatchJournalRecoveryClaim!,
                  gitReceiptsDigest: "0".repeat(64),
                },
              }),
            ]) {
              await rejectSourceMutation(mutate);
            }
          }
          recovery = await activeCapability.resolveRecovery!(binding, guardedTip);
          expect(recovery).toMatchObject({
            status: "dispatch-recovery-resolved",
            liveTip: guardedTip,
            preparation: { kind: "current" },
          });
          if (recovery.preparation.kind !== "current") {
            throw new Error("manual guarded successor did not become current recovery authority");
          }
          currentTip = guardedTip;
          currentBase = protectedHead;
        }
        expect(runner.requests).toHaveLength(0);
        await activeBackend.close();
      }
    }
  }, 90_000);

  test("runner-owned green evidence closes only the exact reserved gate checkpoint without moving the tip", async () => {
    const subject = await fixtureWithDispatchBase(
      new GateDummy(),
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      "exact",
    );
    expect(await stageAndFinalize(subject)).toMatchObject({ state: "result-stored" });
    expect(await git(subject.managed.handle.absolutePath, ["rev-parse", "HEAD"])).toBe(
      subject.receipt.newHead,
    );
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: subject.managed.handle.repositoryRoot,
        taskId: subject.managed.handle.taskId,
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
      },
      { stateDir: subject.stateDir },
    );
    if (binding === null) throw new Error("expected live managed binding");
    await expect(
      assertManagedWorktreeWipClosure(binding, subject.receipt.newHead, {
        stateDir: subject.stateDir,
      }),
    ).resolves.toBeUndefined();

    const released = await releaseManagedWorktree(
      {
        handle: subject.managed.handle,
        terminalDisposition: "done",
        resultCommit: subject.receipt.newHead,
      },
      { stateDir: subject.stateDir },
    );
    expect(released).toMatchObject({ status: "released" });
  });

  test("pre-merge WIP closure ignores unchanged inherited artifacts and rejects candidate foreign artifacts [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const subject = await fixtureWithDispatchBase(
      new GateDummy(),
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      "inherited",
    );
    expect(await stageAndFinalize(subject)).toMatchObject({ state: "result-stored" });
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: subject.managed.handle.repositoryRoot,
        taskId: subject.managed.handle.taskId,
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
      },
      { stateDir: subject.stateDir },
    );
    if (binding === null) throw new Error("expected live managed binding");
    const integrationHead = await git(subject.managed.handle.repositoryRoot, ["rev-parse", "HEAD"]);
    const branchHead = await git(subject.managed.handle.absolutePath, ["rev-parse", "HEAD"]);
    const liveBefore = await listManagedLiveWorktrees(
      subject.managed.handle.repositoryRoot,
      subject.managed.handle.taskId,
      subject.stateDir,
    );

    // regression: D366 — unchanged tracked WIP belongs to integration history.
    await expect(
      assertManagedWorktreeWipClosure(binding, subject.receipt.newHead, {
        stateDir: subject.stateDir,
      }),
    ).resolves.toBeUndefined();
    expect(await git(subject.managed.handle.repositoryRoot, ["rev-parse", "HEAD"])).toBe(
      integrationHead,
    );
    expect(await git(subject.managed.handle.absolutePath, ["rev-parse", "HEAD"])).toBe(branchHead);
    expect(
      await listManagedLiveWorktrees(
        subject.managed.handle.repositoryRoot,
        subject.managed.handle.taskId,
        subject.stateDir,
      ),
    ).toEqual(liveBefore);

    for (const mode of ["foreign", "modified-foreign"] as const) {
      const foreign = await fixtureWithDispatchBase(
        new GateDummy(),
        "managed",
        () => "2026-08-12T20:00:00.000Z",
        mode,
      );
      expect(await stageAndFinalize(foreign)).toMatchObject({ state: "result-stored" });
      const foreignBinding = await resolveManagedWorktreeDispatchBinding(
        {
          repositoryRoot: foreign.managed.handle.repositoryRoot,
          taskId: foreign.managed.handle.taskId,
          worktreePath: foreign.managed.handle.absolutePath,
          branch: foreign.managed.handle.branch,
        },
        { stateDir: foreign.stateDir },
      );
      if (foreignBinding === null) throw new Error(`expected ${mode} binding`);
      await expect(
        assertManagedWorktreeWipClosure(foreignBinding, foreign.receipt.newHead, {
          stateDir: foreign.stateDir,
        }),
      ).rejects.toThrow(/foreign WIP artifact WIP-T223[45]\.md/u);
    }
  });

  // Regression: T2823 — task ownership is authoritative even when the integration diff is empty.
  test("pre-merge WIP closure inspects unchanged task-owned artifacts [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const runner = new GateDummy();
    const subject = await fixtureWithDispatchBase(
      runner,
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      "inherited-current-open",
    );
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    await expect(finalize(subject)).rejects.toThrow("implementation");
    expect(runner.requests).toEqual([]);
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: subject.managed.handle.repositoryRoot,
        taskId: subject.managed.handle.taskId,
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
      },
      { stateDir: subject.stateDir },
    );
    if (binding === null) throw new Error("expected live managed binding");

    await expect(
      assertManagedWorktreeWipClosure(binding, subject.receipt.newHead, {
        stateDir: subject.stateDir,
      }),
    ).rejects.toThrow("open checkpoints: implementation");
  });

  // Regression: D366 — integration can advance with retained WIP after task preparation.
  test("terminal release ignores unchanged WIP from authenticated post-prepare integration [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const subject = await fixtureWithDispatchBase(
      new GateDummy(),
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      "after-prepare-inherited",
    );
    expect(await stageAndFinalize(subject)).toMatchObject({ state: "result-stored" });

    const released = await releaseManagedWorktree(
      {
        handle: subject.managed.handle,
        terminalDisposition: "done",
        resultCommit: subject.receipt.newHead,
      },
      { stateDir: subject.stateDir },
    );
    expect(released).toMatchObject({ status: "released" });
  });

  // Regression: T2823 — release must preserve the current task's open recovery artifact.
  test("terminal release inspects unchanged task-owned artifacts [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const runner = new GateDummy();
    const subject = await fixtureWithDispatchBase(
      runner,
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      "inherited-current-open",
    );
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    await expect(finalize(subject)).rejects.toThrow("implementation");
    expect(runner.requests).toEqual([]);

    const released = await releaseManagedWorktree(
      {
        handle: subject.managed.handle,
        terminalDisposition: "done",
        resultCommit: subject.receipt.newHead,
      },
      { stateDir: subject.stateDir },
    );
    expect(released).toMatchObject({
      status: "refused",
      reason: "wip-open",
      openCheckpoints: ["implementation"],
    });
    expect(
      await fs.stat(subject.managed.handle.absolutePath).then((entry) => entry.isDirectory()),
    ).toBe(true);
  });

  // regression: I51 — incomplete task-local work must stop before the costly host gate.
  test("open non-gate WIP checkpoints invoke zero full gates [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const runner = new GateDummy();
    const subject = await fixtureWithDispatchBase(
      runner,
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      "inherited-current-open",
    );
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    await expect(finalize(subject)).rejects.toThrow("implementation");
    expect(runner.requests).toEqual([]);
  });

  test("gate projection rejects integration history outside the exact result ancestry [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const subject = await fixtureWithDispatchBase(new GateDummy(), "managed");
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    await fs.writeFile(
      path.join(subject.managed.handle.repositoryRoot, "integration-only.txt"),
      "advanced after dispatch\n",
    );
    await git(subject.managed.handle.repositoryRoot, ["add", "integration-only.txt"]);
    await git(subject.managed.handle.repositoryRoot, [
      "commit",
      "-q",
      "-m",
      "advance integration outside candidate",
    ]);

    await expect(finalize(subject)).rejects.toThrow(
      "supervised gate result does not contain the authenticated integration tip",
    );
  });

  test("pre-merge WIP closure denies missing, malformed, stale, and coordinate-mismatched evidence", async () => {
    const missing = await fixtureWithDispatchBase(
      new GateDummy(),
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      "exact",
    );
    const missingBinding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: missing.managed.handle.repositoryRoot,
        taskId: missing.managed.handle.taskId,
        worktreePath: missing.managed.handle.absolutePath,
        branch: missing.managed.handle.branch,
      },
      { stateDir: missing.stateDir },
    );
    if (missingBinding === null) throw new Error("expected missing-evidence binding");
    await expect(
      assertManagedWorktreeWipClosure(missingBinding, missing.receipt.newHead, {
        stateDir: missing.stateDir,
      }),
    ).rejects.toThrow("trusted full gate");

    const malformedRunner = new GateDummy();
    const malformed = await fixtureWithDispatchBase(
      malformedRunner,
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      "malformed",
    );
    expect(await stage(malformed)).toMatchObject({ state: "gate-pending" });
    await expect(finalize(malformed)).rejects.toThrow("malformed WIP artifact");
    expect(malformedRunner.requests).toEqual([]);
    const malformedBinding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: malformed.managed.handle.repositoryRoot,
        taskId: malformed.managed.handle.taskId,
        worktreePath: malformed.managed.handle.absolutePath,
        branch: malformed.managed.handle.branch,
      },
      { stateDir: malformed.stateDir },
    );
    if (malformedBinding === null) throw new Error("expected malformed-evidence binding");
    await expect(
      assertManagedWorktreeWipClosure(malformedBinding, malformed.receipt.newHead, {
        stateDir: malformed.stateDir,
      }),
    ).rejects.toThrow("malformed artifact");

    const stale = await fixtureWithDispatchBase(
      new GateDummy(),
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      "exact",
    );
    expect(await stageAndFinalize(stale)).toMatchObject({ state: "result-stored" });
    await fs.writeFile(path.join(stale.managed.handle.absolutePath, "moved.txt"), "moved\n");
    await git(stale.managed.handle.absolutePath, ["add", "moved.txt"]);
    await git(stale.managed.handle.absolutePath, ["commit", "-q", "-m", "move candidate tip"]);
    const movedTip = await git(stale.managed.handle.absolutePath, ["rev-parse", "HEAD"]);
    const staleBinding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: stale.managed.handle.repositoryRoot,
        taskId: stale.managed.handle.taskId,
        worktreePath: stale.managed.handle.absolutePath,
        branch: stale.managed.handle.branch,
      },
      { stateDir: stale.stateDir },
    );
    if (staleBinding === null) throw new Error("expected stale-evidence binding");
    await expect(
      assertManagedWorktreeWipClosure(staleBinding, movedTip, { stateDir: stale.stateDir }),
    ).rejects.toThrow("trusted full gate");
    await expect(
      assertManagedWorktreeWipClosure(
        { ...staleBinding, handleToken: "substituted-token" },
        movedTip,
        { stateDir: stale.stateDir },
      ),
    ).rejects.toThrow("binding changed at handleToken");
    expect(await git(stale.managed.handle.absolutePath, ["rev-parse", "HEAD"])).toBe(movedTip);
  });

  test("D340 runs the default supervised worker gate in the child-started ledger MCP process [Behavioral-Progression Blackbox-GoodCommunication]", async () => {
    const parentProcessId = process.pid;
    const runner = new GateDummy();
    const subject = await fixture(runner);

    await expect(
      subject.capability.storeResult({
        resultCapability: subject.prepared.resultCapability,
        output: subject.output,
      }),
    ).resolves.toMatchObject({ state: "gate-pending" });
    expect(runner.callerProcessIds).toEqual([]);
    await expect(finalize(subject)).resolves.toMatchObject({ state: "result-stored" });
    expect(runner.callerProcessIds).toEqual([parentProcessId]);
  });

  test("accepts correction-round verification against a descendant dispatch base", async () => {
    const subject = await fixtureWithDispatchBase(new GateDummy(), "descendant");
    expect(subject.dispatchBaseCommit).not.toBe(subject.managed.handle.baseCommit);
    await expect(stageAndFinalize(subject)).resolves.toMatchObject({ state: "result-stored" });
    expect(subject.store.rows()).toMatchObject([
      {
        state: "result-stored",
        output: {
          supervisedGateEvidence: { baseCommit: subject.dispatchBaseCommit },
        },
      },
    ]);
  });

  test("rejects caller-minted evidence", async () => {
    const fabricated = await fixture();
    await expect(
      fabricated.capability.storeResult({
        resultCapability: fabricated.prepared.resultCapability,
        output: { ...fabricated.output, supervisedGateEvidence: {} },
      }),
    ).rejects.toThrow("caller-minted");
  });

  for (const [reason, result] of [
    ["nonzero exit", { gateExitCode: 1, passCount: 16, failCount: 1 }],
    ["no passing tests", { gateExitCode: 0, passCount: 0, failCount: 0 }],
    ["failing tests", { gateExitCode: 0, passCount: 17, failCount: 1 }],
  ] as const) {
    test(`terminalizes and replays deterministic gate rejection without rerunning the gate (${reason})`, async () => {
      const runner = new GateDummy({
        ...result,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:01.000Z",
        outputTail: "controlled red gate",
      });
      const subject = await fixture(runner);
      expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
      const rejected = await finalize(subject);
      expect(rejected).toMatchObject({
        state: "aborted",
        result: {
          state: "aborted",
          reason: "gate-rejected",
          details: {
            kind: "cq-supervised-gate-rejection",
            version: 2,
            command:
              'cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check',
            ...result,
            outputTail: "controlled red gate",
            diagnosticArtifact: {
              kind: "cq-supervised-gate-diagnostic-artifact",
              version: 1,
              attestationId: subject.prepared.attestationId,
              generation: subject.prepared.generation,
              taskId: "T2081",
              resultCommit: subject.receipt.newHead,
              firstFailure: null,
              failureIndex: [],
            },
          },
        },
      });
      expect(await finalize(subject)).toEqual(rejected);
      await expect(resolveRecovery(subject)).rejects.toThrow("gate-rejected");
      expect(runner.requests).toHaveLength(1);
    });
  }

  test("retains one redacted deterministic-red diagnostic through fetch without rerunning", async () => {
    const secret = `sk-${"R".repeat(32)}`;
    const runner = new GateDummy({
      gateExitCode: 1,
      passCount: 4,
      failCount: 1,
      gateDurationMs: 1,
      capturedAt: "2026-08-12T20:00:01.000Z",
      outputTail: `(fail) first deterministic assertion ${secret}\n4 pass\n1 fail`,
    });
    const subject = await fixture(runner);
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    const rejected = await finalize(subject);
    expect(runner.requests).toHaveLength(1);
    expect(rejected).toMatchObject({ state: "aborted", result: { reason: "gate-rejected" } });
    if (rejected.state !== "aborted" || rejected.result.details === undefined) {
      throw new Error("deterministic-red finalization details are missing");
    }
    const rejectedDetails = rejected.result.details as Readonly<Record<string, DispatchJSONValue>>;
    const rejectedTail = rejectedDetails["outputTail"];
    if (typeof rejectedTail !== "string") {
      throw new Error("deterministic-red finalization output tail is missing");
    }
    expect(rejectedTail).toContain("[REDACTED:api-key]");
    const fetched = await subject.capability.fetch({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
    });
    expect(fetched).toEqual(rejected.result);
    if (fetched.state !== "aborted" || fetched.details === undefined) {
      throw new Error("deterministic-red diagnostic was not retrievable");
    }
    const details = fetched.details as Readonly<Record<string, DispatchJSONValue>>;
    const retained = details["outputTail"];
    if (typeof retained !== "string") {
      throw new Error(`deterministic-red output tail is missing: ${JSON.stringify(fetched)}`);
    }
    expect(retained.includes(secret)).toBe(false);
    expect(retained).toContain("[REDACTED:api-key]");
    expect(await finalize(subject)).toEqual(rejected);
    expect(runner.requests).toHaveLength(1);
  });

  test("D500 retains a redacted exact-attempt failure index through terminal fetch [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const secret = `sk-${"D".repeat(32)}`;
    const runner = new GateDummy({
      gateExitCode: 1,
      passCount: 2,
      failCount: 2,
      gateDurationMs: 7,
      capturedAt: "2026-08-12T20:00:07.000Z",
      outputTail: `(fail) first ${secret}\n2 pass\n2 fail`,
      diagnosticArtifact: {
        reportDigest: "d".repeat(64),
        failures: [
          {
            identity: `first ${secret}`,
            reference: "packages/example/test/first.test.ts",
            assertion: `expected ${secret} to be absent`,
          },
          {
            identity: "second failure",
            reference: "packages/example/test/second.test.ts",
            assertion: "expected true to be false",
          },
        ],
      },
    });
    const subject = await fixture(runner);
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    const rejected = await finalize(subject);
    expect(rejected).toMatchObject({ state: "aborted", result: { reason: "gate-rejected" } });
    if (rejected.state !== "aborted") throw new Error("D500 gate unexpectedly passed");
    const fetched = await subject.capability.fetch({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
    });
    expect(fetched).toEqual(rejected.result);
    expect(fetched).toMatchObject({
      state: "aborted",
      details: {
        version: 2,
        diagnosticArtifact: {
          attestationId: subject.prepared.attestationId,
          generation: subject.prepared.generation,
          taskId: "T2081",
          resultCommit: subject.receipt.newHead,
          capturedAt: "2026-08-12T20:00:07.000Z",
          reportDigest: "d".repeat(64),
          firstFailure: {
            identity: "first [REDACTED:api-key]",
            assertion: "expected [REDACTED:api-key] to be absent",
          },
          failureIndex: [{ identity: "first [REDACTED:api-key]" }, { identity: "second failure" }],
        },
      },
    });
    expect(JSON.stringify(fetched)).not.toContain(secret);
    expect(runner.requests).toHaveLength(1);
    expect(await finalize(subject)).toEqual(rejected);
    expect(runner.requests).toHaveLength(1);
  });

  test("rejects dirty or moving tips and does not run the gate on replay", async () => {
    const dirtyRunner = new GateDummy();
    const dirty = await fixture(dirtyRunner);
    await fs.writeFile(path.join(dirty.managed.handle.absolutePath, "untracked.txt"), "dirty\n");
    await expect(stage(dirty)).rejects.toThrow("clean managed tip");
    expect(dirtyRunner.requests).toHaveLength(0);

    const movingRunner = new MovingTipGateDummy();
    const moving = await fixture(movingRunner);
    await expect(stage(moving)).resolves.toMatchObject({ state: "gate-pending" });
    await expect(finalize(moving)).rejects.toThrow("branch tip moved during the gate");
    expect(movingRunner.requests).toHaveLength(1);
    expect(moving.store.rows()).toMatchObject([{ state: "gate-running" }]);

    const replayRunner = new GateDummy();
    const replay = await fixture(replayRunner);
    await stageAndFinalize(replay);
    await expect(finalize(replay)).resolves.toMatchObject({ state: "result-stored" });
    expect(replayRunner.requests).toHaveLength(1);
  });

  test("fails closed when the trusted runner times out or is cancelled", async () => {
    for (const message of [
      "supervised worker gate timed out",
      "supervised worker gate cancelled",
    ]) {
      const runner = new ThrowingGateDummy(message);
      const subject = await fixture(runner);
      expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
      await expect(finalize(subject)).rejects.toThrow(message);
      expect(runner.requests).toHaveLength(1);
      expect(subject.store.rows()).toMatchObject([
        {
          state: "aborted",
          abortReason: "parent-lost",
          dispatchRecoveryBinding: {
            liveTip: subject.receipt.newHead,
            gitReceipts: [{ newHead: subject.receipt.newHead }],
          },
        },
      ]);
      expect(await resolveRecovery(subject)).toMatchObject({ preparation: { kind: "legacy" } });
    }
  });

  test("retains a bounded redacted first-runner diagnostic through terminal retrieval", async () => {
    const secret = `sk-${"A".repeat(32)}`;
    const runner = new ThrowingGateDummy(`first runner ${secret} ${"é".repeat(1_000)}`);
    const subject = await fixture(runner);
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    await expect(finalize(subject)).rejects.toThrow(secret);
    const row = subject.store.rows()[0];
    if (row === undefined || isAttestationTombstone(row)) {
      throw new Error("first-runner terminal row is unavailable");
    }
    expect(row.abortDetails).toMatchObject({ phase: "supervised-gate" });
    const retained = (row.abortDetails as Readonly<Record<string, DispatchJSONValue>>)["message"];
    if (typeof retained !== "string") throw new Error("runner diagnostic message is unavailable");
    expect(retained).not.toContain(secret);
    expect(retained).toContain("[REDACTED:api-key]");
    expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(1_024);
    expect(
      await subject.capability.fetch({
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
      }),
    ).toMatchObject({
      state: "aborted",
      reason: "parent-lost",
      details: { phase: "supervised-gate", message: retained },
    });
  });

  test("authenticated cancellation settles while the parent gate runner is still active", async () => {
    const runner = new BlockingGateDummy();
    const subject = await fixture(runner);
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    const finalizing = finalize(subject);
    await runner.started;
    const aborting = subject.capability.abort({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
      reason: "cancelled",
    });
    try {
      const disposition = await Promise.race([
        aborting.then((result) => ({ state: "settled" as const, result })),
        Bun.sleep(100).then(() => ({ state: "blocked" as const })),
      ]);
      expect(disposition).toMatchObject({
        state: "settled",
        result: { state: "aborted", reason: "cancelled" },
      });
    } finally {
      runner.release();
      await finalizing.catch(() => undefined);
      await aborting.catch(() => undefined);
    }
    expect(subject.store.rows()).toMatchObject([{ state: "aborted", abortReason: "cancelled" }]);
  });

  // Regression: an unbound process worker could store fabricated supervised evidence.
  test("rejects fabricated supervised evidence without a runner-owned Git binding", async () => {
    sequence += 1;
    const namespace: AttestationNamespace = {
      backend: "xdg",
      projectKey: `t2081-unbound-${sequence}`,
    };
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace)),
      promptArtifactStore: artifactStore(),
      now: () => "2026-08-12T20:00:00.000Z",
      randomBytes: sequentialDispatchRandomBytes(sequence * 32),
    });
    const baseCommit = "a".repeat(40);
    const resultCommit = "b".repeat(40);
    const digest = "c".repeat(64);
    const worktreePath = "/tmp/unbound/.claude/worktrees/T2081";
    const prepared = await capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2081",
        headline: "reject unbound evidence",
        description: "forbid a worker pass without the runner-owned Git and gate binding",
        acceptance: "caller-minted evidence never becomes consumable",
        worktreePath,
        branch: "implement/T2081",
        baseCommit,
        round: 0,
        startingCommit: baseCommit,
        validationIntent: "final",
      },
      idempotencyKey: `T2081-unbound-${sequence}`,
      timeoutMs: 600_000,
      expectedChild: { childId: `child-${sequence}`, runId: `run-${sequence}` },
    });
    if (!prepared.accepted) throw new Error("unbound worker dispatch was rejected before storage");
    await capability.fetchInput({
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      inputCapability: prepared.prepared.inputCapability,
    });
    const output = {
      taskId: "T2081",
      status: "pass",
      resultCommit,
      branch: "implement/T2081",
      actualWorktreePath: worktreePath,
      filesTouched: ["file.txt"],
      gitReceipts: [
        {
          kind: "cq-git-change-receipt",
          version: 1,
          attestationId: prepared.prepared.attestationId,
          generation: prepared.prepared.generation,
          taskId: "T2081",
          operationId: "fabricated",
          requestDigest: digest,
          oldHead: baseCommit,
          newHead: resultCommit,
          tree: resultCommit,
          objectOids: [resultCommit],
          paths: ["file.txt"],
          committedAt: "2026-08-12T19:59:00.000Z",
        },
      ],
      checkSummary: "fabricated supervised gate evidence",
      baseVerification: {
        status: "verified",
        relation: "descendant",
        baseCommit,
        headCommit: resultCommit,
      },
      summary: "must not be stored",
      supervisedGateEvidence: {
        kind: "cq-supervised-gate-evidence",
        version: 1,
        attestationId: prepared.prepared.attestationId,
        generation: prepared.prepared.generation,
        roleId: "implement-worker",
        roleVersion: prepared.prepared.promptProvenance.version,
        surface: "codex",
        promptDigest: prepared.prepared.promptProvenance.promptDigest,
        catalogHash: prepared.prepared.promptProvenance.catalogHash,
        inputDigest: prepared.prepared.promptProvenance.inputDigest,
        taskId: "T2081",
        worktreePath,
        branch: "implement/T2081",
        baseCommit,
        startingCommit: baseCommit,
        resultCommit,
        clean: true,
        command:
          'cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check',
        gateExitCode: 0,
        passCount: 17,
        failCount: 0,
        gateDurationMs: 123,
        capturedAt: "2026-08-12T20:00:01.000Z",
        filesTouchedDigest: digest,
        gitReceiptsDigest: digest,
        mutationTableDigest: digest,
      },
    };

    await expect(
      capability.storeResult({
        resultCapability: prepared.prepared.resultCapability,
        output,
      }),
    ).rejects.toThrow("runner-owned Git/gate binding");
  });

  test("serializes concurrent stores into one active gate attempt", async () => {
    const runner = new BlockingGateDummy();
    const subject = await fixture(runner);
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    const first = finalize(subject);
    await runner.started;
    const second = finalize(subject);
    await Promise.resolve();
    runner.release();

    await expect(first).resolves.toMatchObject({ state: "result-stored" });
    await expect(second).resolves.toMatchObject({ state: "result-stored" });
    expect(runner.requests).toHaveLength(1);
  });

  test.each(["memory", "sqlite"] as const)(
    "D489 serializes %s peer capabilities into one durable gate attempt [Behavioral-Active, Effectual-Group]",
    async (attestationBackend) => {
      const runner = new BlockingGateDummy();
      const subject = await fixtureWithDispatchBase(
        runner,
        "managed",
        () => "2026-08-12T20:00:00.000Z",
        false,
        false,
        undefined,
        artifactStore(),
        attestationBackend,
      );
      expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
      const peerBackend =
        attestationBackend === "memory"
          ? new InMemoryAttestationBackend(subject.store)
          : new SqliteAttestationBackend({
              namespace: subject.backend.namespace,
              dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
            });
      const peer = createDispatchCapability({
        backend: peerBackend,
        promptArtifactStore: artifactStore(),
        implementationEvidenceStore: subject.implementationEvidenceStore,
        repositoryRoot: subject.repositoryRoot,
        worktreeStateDir: subject.stateDir,
        supervisedWorkerGateRunner: runner,
        now: () => "2026-08-12T20:00:00.000Z",
      });
      if (peer.finalizeParentGate === undefined) {
        throw new Error("peer parent gate finalizer is unavailable");
      }
      const first = finalize(subject);
      await runner.started;
      const second = peer.finalizeParentGate(parentGateInput(subject));
      try {
        await Bun.sleep(50);
        expect(runner.requests).toHaveLength(1);
        runner.release();
        await expect(Promise.all([first, second])).resolves.toMatchObject([
          { state: "result-stored" },
          { state: "result-stored" },
        ]);
      } finally {
        runner.release();
        await Promise.allSettled([first, second]);
        await peerBackend.close();
      }
      expect(runner.requests).toHaveLength(1);
    },
  );

  test("D489 serializes independent SQLite processes into one durable gate attempt [Behavioral-Active, Effectual-GoodCommunication]", async () => {
    const subject = await fixtureWithDispatchBase(
      new GateDummy(),
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      false,
      false,
      undefined,
      artifactStore(),
      "sqlite",
    );
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    const configPath = path.join(subject.repositoryRoot, "parent-gate-process.json");
    const invocationMarker = path.join(subject.repositoryRoot, "gate-invocations.txt");
    const readyDirectory = path.join(subject.repositoryRoot, "process-ready");
    const firstStartedMarker = path.join(subject.repositoryRoot, "first-gate-started");
    const releaseFirstMarker = path.join(subject.repositoryRoot, "release-first-gate");
    await fs.mkdir(readyDirectory);
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        namespace: subject.backend.namespace,
        dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
        repositoryRoot: subject.repositoryRoot,
        stateDir: subject.stateDir,
        invocationMarker,
        readyDirectory,
        firstStartedMarker,
        releaseFirstMarker,
        now: "2026-08-12T20:00:00.000Z",
        input: parentGateInput(subject),
      })}\n`,
    );
    const first = spawnParentGateProcess(configPath, "first");
    await waitForD342Marker(firstStartedMarker);
    const peer = spawnParentGateProcess(configPath, "peer");
    await waitForD342Marker(path.join(readyDirectory, "peer"));
    try {
      const invocations = await observeForbiddenPeerInvocation(invocationMarker);
      expect(invocations).toEqual(["first"]);
    } finally {
      await fs.writeFile(releaseFirstMarker, "release\n");
    }
    const outcomes = await Promise.all([first, peer]);
    expect(outcomes).toMatchObject([{ exitCode: 0 }, { exitCode: 0 }]);
    expect(outcomes.map(({ stdout }) => JSON.parse(stdout))).toMatchObject([
      { ok: true, outcome: { state: "result-stored" } },
      { ok: true, outcome: { state: "result-stored" } },
    ]);
  }, 30_000);

  test("D489 cross-process cancellation settles the registered gate root before terminal publication [Behavioral-Active, Effectual-GoodCommunication]", async () => {
    const subject = await fixtureWithDispatchBase(
      new GateDummy(),
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      false,
      false,
      undefined,
      artifactStore(),
      "sqlite",
    );
    expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
    const bin = path.join(subject.repositoryRoot, "bin");
    const processMarker = path.join(subject.repositoryRoot, "registered-gate-process");
    await fs.mkdir(bin);
    await fs.writeFile(
      path.join(bin, "cq"),
      [
        "#!/bin/sh",
        "set -eu",
        `printf '%s %s\\n' "$$" "$(ps -o pgid= -p $$ | tr -d '[:space:]')" > ${JSON.stringify(processMarker)}`,
        "trap 'exit 143' TERM INT",
        "while :; do sleep 0.05; done",
        "",
      ].join("\n"),
    );
    await fs.chmod(path.join(bin, "cq"), 0o700);
    const inheritedPath = process.env["PATH"];
    if (inheritedPath === undefined || inheritedPath.trim() === "") {
      throw new Error("cross-process cancellation test requires PATH");
    }
    const configPath = path.join(subject.repositoryRoot, "parent-gate-cancellation.json");
    const readyDirectory = path.join(subject.repositoryRoot, "cancellation-ready");
    await fs.mkdir(readyDirectory);
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        namespace: subject.backend.namespace,
        dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
        repositoryRoot: subject.repositoryRoot,
        stateDir: subject.stateDir,
        invocationMarker: path.join(subject.repositoryRoot, "unused-invocations"),
        readyDirectory,
        firstStartedMarker: path.join(subject.repositoryRoot, "unused-started"),
        releaseFirstMarker: path.join(subject.repositoryRoot, "unused-release"),
        now: "2026-08-12T20:00:00.000Z",
        input: parentGateInput(subject),
        runnerKind: "registered-process",
        runtimePath: `${bin}${path.delimiter}${inheritedPath}`,
      })}\n`,
    );
    const finalizing = spawnParentGateProcess(configPath, "first");
    await waitForD342Marker(path.join(readyDirectory, "first"));
    const identity = await waitForChildIdentityMarker(processMarker);
    const terminalObservation = (async () => {
      for (;;) {
        const terminal = await subject.backend.transact(
          { kind: "handle", handle: parentGateInput(subject) },
          (store) => {
            const row = store.read(parentGateInput(subject));
            return row !== undefined && !isAttestationTombstone(row) && row.state === "aborted";
          },
        );
        if (terminal) {
          return {
            processAbsent: d342ProcessAbsent(identity.pid),
            groupAbsent: d342GroupAbsent(identity.pgid),
          };
        }
        await Bun.sleep(1);
      }
    })();
    const aborted = await subject.capability.abort({
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
      reason: "cancelled",
    });
    expect(aborted).toMatchObject({ state: "aborted", reason: "cancelled" });
    expect(await terminalObservation).toEqual({ processAbsent: true, groupAbsent: true });
    const finalized = await finalizing;
    expect(finalized).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(finalized.stdout)).toMatchObject({
      ok: true,
      outcome: { state: "aborted", result: { reason: "cancelled" } },
    });
  }, 30_000);

  test("D326 settles an admitted result after the child deadline using the submission instant [BG]", async () => {
    let current = Date.parse("2026-08-12T20:00:00.000Z");
    const runner = new ClockAdvancingGateDummy(() => {
      current += 600_001;
    });
    const subject = await fixtureWithDispatchBase(runner, "managed", () =>
      new Date(current).toISOString(),
    );
    await expect(stageAndFinalize(subject)).resolves.toMatchObject({ state: "result-stored" });
    expect(runner.requests).toHaveLength(1);
  });

  test("D326 queued admission bound derives from the overlapped serial enclosure [Behavioral-Active Blackbox-Atomic]", () => {
    expect(FIRST_EXECUTION_TIMEOUT_MS).toBe(15_000);
    expect(QUEUED_EXECUTION_TIMEOUT_MS).toBe(5_000);
    expect(ADMISSION_HOLD_MS).toBe(6_000);
    expect(D326_TEST_TIMEOUT_MS).toBe(300_000);
    // Queued admission = 30,000 ms remaining bootstrap acknowledgement after the
    // first marker + 6,000 ms hold + 40,000 ms first-run settlement + 14,000 ms margin.
    expect(QUEUED_ADMISSION_TIMEOUT_MS).toBe(
      30_000 + ADMISSION_HOLD_MS + D326_RUN_SETTLEMENT_MS + 14_000,
    );
    expect(QUEUED_ADMISSION_TIMEOUT_MS).toBe(90_000);
    // This wait overlaps the first run rather than being added again to the
    // 220,000 ms serial enclosure of two 60,000 ms launch handshakes,
    // 15,000/5,000 ms executions, and two 40,000 ms cleanups.
    expect(D326_SERIAL_ENCLOSURE_MS).toBe(2 * 60_000 + 15_000 + 5_000 + 2 * 40_000);
    expect(D326_SERIAL_ENCLOSURE_MS).toBe(220_000);
    expect(QUEUED_ADMISSION_TIMEOUT_MS).toBeLessThanOrEqual(
      D326_LAUNCH_HANDSHAKE_MS + FIRST_EXECUTION_TIMEOUT_MS + D326_RUN_SETTLEMENT_MS,
    );
    // The 300,000 ms test timeout leaves 80,000 ms margin over the enclosure.
    expect(D326_TEST_TIMEOUT_MS - D326_SERIAL_ENCLOSURE_MS).toBe(80_000);
  });

  // Regression D326: host-gate admission belongs to the supervisor, not the child budget.
  test(
    "D326 lets a second terminal store wait beyond its gate execution budget before admission [Behavioral-Active, Effectual-GoodCommunication]",
    async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), "t2082-gate-admission-"));
      roots.push(root);
      const bin = path.join(root, "bin");
      const lock = path.join(root, "exclusive-gate");
      const releaseFirst = path.join(root, "release-first");
      const firstMarker = path.join(root, "first-child-marker");
      const queuedMarker = path.join(root, "queued-child-marker");
      await fs.mkdir(bin, { recursive: true });
      const cq = path.join(bin, "cq");
      await fs.writeFile(
        cq,
        [
          "#!/bin/sh",
          "set -eu",
          'while ! mkdir "$CQ_T2082_GATE_LOCK" 2>/dev/null; do sleep 0.01; done',
          "trap 'rmdir \"$CQ_T2082_GATE_LOCK\" 2>/dev/null || true' EXIT INT TERM",
          'worktree=""',
          'while test "$#" -gt 0; do',
          '  if test "$1" = --worktree; then worktree="$2"; shift 2; continue; fi',
          "  shift",
          "done",
          'if test "$worktree" = "$CQ_T2082_FIRST_WORKTREE"; then',
          '  printf \'%s %s\\n\' "$$" "$(ps -o pgid= -p $$ | tr -d \'[:space:]\')" > "$CQ_T2082_FIRST_MARKER"',
          '  while test ! -e "$CQ_T2082_RELEASE_FIRST"; do sleep 0.01; done',
          "else",
          '  printf \'%s %s\\n\' "$$" "$(ps -o pgid= -p $$ | tr -d \'[:space:]\')" > "$CQ_T2082_QUEUED_MARKER"',
          "fi",
          "printf '1 pass\\n0 fail\\n'",
          "",
        ].join("\n"),
      );
      await fs.chmod(cq, 0o700);
      let heldWorktreePath = "";
      const phaseBoundRunner: SupervisedWorkerGateRunner = {
        run: async (request) =>
          await nodeSupervisedWorkerGateRunner.run({
            ...request,
            admissionTimeoutMs: QUEUED_ADMISSION_TIMEOUT_MS,
            executionTimeoutMs:
              request.worktreePath === heldWorktreePath
                ? FIRST_EXECUTION_TIMEOUT_MS
                : QUEUED_EXECUTION_TIMEOUT_MS,
          }),
      };
      const first = await fixture(phaseBoundRunner);
      heldWorktreePath = first.managed.handle.absolutePath;
      const second = await fixture(phaseBoundRunner);
      const priorPath = process.env["PATH"];
      const priorLock = process.env["CQ_T2082_GATE_LOCK"];
      const priorFirstWorktree = process.env["CQ_T2082_FIRST_WORKTREE"];
      const priorFirstMarker = process.env["CQ_T2082_FIRST_MARKER"];
      const priorQueuedMarker = process.env["CQ_T2082_QUEUED_MARKER"];
      const priorReleaseFirst = process.env["CQ_T2082_RELEASE_FIRST"];
      process.env["PATH"] = `${bin}${path.delimiter}${priorPath ?? ""}`;
      process.env["CQ_T2082_GATE_LOCK"] = lock;
      process.env["CQ_T2082_FIRST_WORKTREE"] = first.managed.handle.absolutePath;
      process.env["CQ_T2082_FIRST_MARKER"] = firstMarker;
      process.env["CQ_T2082_QUEUED_MARKER"] = queuedMarker;
      process.env["CQ_T2082_RELEASE_FIRST"] = releaseFirst;
      let firstStore: Promise<unknown> | undefined;
      let secondStore: Promise<unknown> | undefined;
      try {
        expect(await stage(first)).toMatchObject({ state: "gate-pending" });
        expect(await stage(second)).toMatchObject({ state: "gate-pending" });
        firstStore = finalize(first);
        const firstIdentity = await waitForChildIdentityMarker(firstMarker);
        secondStore = finalize(second);
        // The hold: the first run still blocks runner admission, so the queued
        // row claims gate-running promptly and keeps it for the complete hold.
        const holdDeadline = Date.now() + ADMISSION_HOLD_MS;
        for (;;) {
          const claimed = second.store.rows();
          expect(claimed).toHaveLength(1);
          const claimedRow = claimed[0];
          const claimedState =
            claimedRow === undefined || isAttestationTombstone(claimedRow)
              ? undefined
              : claimedRow.state;
          if (claimedState === "gate-running") break;
          expect(claimedState).toBe("gate-pending");
          if (Date.now() >= holdDeadline) {
            throw new Error("D326 queued row never claimed gate-running during the hold");
          }
          await Bun.sleep(5);
        }
        while (Date.now() < holdDeadline) {
          expect(second.store.rows()).toMatchObject([{ state: "gate-running" }]);
          await Bun.sleep(25);
        }
        expect(second.store.rows()).toMatchObject([{ state: "gate-running" }]);
        await fs.writeFile(releaseFirst, "release\n");
        await expect(Promise.all([firstStore, secondStore])).resolves.toMatchObject([
          { state: "result-stored" },
          { state: "result-stored" },
        ]);
        expect(first.store.rows()).toMatchObject([{ state: "result-stored" }]);
        expect(second.store.rows()).toMatchObject([{ state: "result-stored" }]);
        expect(first.store.rows()).toHaveLength(1);
        expect(second.store.rows()).toHaveLength(1);
        const queuedIdentity = await waitForChildIdentityMarker(queuedMarker);
        expect(await pathAbsent(lock)).toBe(true);
        for (const identity of [firstIdentity, queuedIdentity]) {
          expect(d342ProcessAbsent(identity.pid)).toBe(true);
          expect(d342GroupAbsent(identity.pgid)).toBe(true);
        }
      } finally {
        await fs.writeFile(releaseFirst, "release\n").catch(() => undefined);
        await Promise.allSettled(
          [firstStore, secondStore].filter(
            (pending): pending is Promise<unknown> => pending !== undefined,
          ),
        );
        if (priorPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = priorPath;
        if (priorLock === undefined) delete process.env["CQ_T2082_GATE_LOCK"];
        else process.env["CQ_T2082_GATE_LOCK"] = priorLock;
        if (priorFirstWorktree === undefined) delete process.env["CQ_T2082_FIRST_WORKTREE"];
        else process.env["CQ_T2082_FIRST_WORKTREE"] = priorFirstWorktree;
        if (priorFirstMarker === undefined) delete process.env["CQ_T2082_FIRST_MARKER"];
        else process.env["CQ_T2082_FIRST_MARKER"] = priorFirstMarker;
        if (priorQueuedMarker === undefined) delete process.env["CQ_T2082_QUEUED_MARKER"];
        else process.env["CQ_T2082_QUEUED_MARKER"] = priorQueuedMarker;
        if (priorReleaseFirst === undefined) delete process.env["CQ_T2082_RELEASE_FIRST"];
        else process.env["CQ_T2082_RELEASE_FIRST"] = priorReleaseFirst;
      }
    },
    D326_TEST_TIMEOUT_MS,
  );

  // D341/T2231 §6a form (c): the same host-execution-deadline detector with
  // paired inputs through the production runner; no expected-failure marker.
  test(
    "D341 pairs a deadline-killed blocking child with a prompt child under the D326 bounds [Behavioral-Active Blackbox-Atomic]",
    async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), "t2231-d341-detector-"));
      roots.push(root);
      const worktreePath = path.join(root, "worktree");
      await fs.mkdir(path.join(worktreePath, "nix", "pkg", "cq-ledgers"), { recursive: true });
      await git(worktreePath, ["init", "-q"]);
      const bin = path.join(root, "bin");
      await fs.mkdir(bin, { recursive: true });
      const markerPath = path.join(root, "blocking-child-marker");
      const cq = path.join(bin, "cq");
      await fs.writeFile(
        cq,
        [
          "#!/bin/sh",
          "set -eu",
          'if test "$CQ_D341_DETECTOR_MODE" = blocking; then',
          '  printf \'%s %s\\n\' "$$" "$(ps -o pgid= -p $$ | tr -d \'[:space:]\')" > "$CQ_D341_DETECTOR_MARKER"',
          "  exec sleep 86400",
          "fi",
          "printf '1 pass\\n0 fail\\n'",
          "",
        ].join("\n"),
      );
      await fs.chmod(cq, 0o700);
      const priorPath = process.env["PATH"];
      const priorMode = process.env["CQ_D341_DETECTOR_MODE"];
      const priorMarker = process.env["CQ_D341_DETECTOR_MARKER"];
      process.env["PATH"] = `${bin}${path.delimiter}${priorPath ?? ""}`;
      process.env["CQ_D341_DETECTOR_MARKER"] = markerPath;
      try {
        // Blocking input: 15,000 ms admission / 5,000 ms execution. The PID/PGID
        // marker must land before the exact execution-deadline diagnostic.
        process.env["CQ_D341_DETECTOR_MODE"] = "blocking";
        const blockedOutcome = nodeSupervisedWorkerGateRunner
          .run({
            worktreePath,
            admissionTimeoutMs: FIRST_EXECUTION_TIMEOUT_MS,
            executionTimeoutMs: QUEUED_EXECUTION_TIMEOUT_MS,
            cancellationSignal: new AbortController().signal,
          })
          .then(
            () => ({ kind: "completed" as const }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          );
        const identity = await waitForChildIdentityMarker(markerPath);
        const blocked = await blockedOutcome;
        if (blocked.kind !== "rejected") {
          throw new Error("D341 blocking child unexpectedly completed the supervised gate");
        }
        expect(blocked.error).toBeInstanceOf(Error);
        expect((blocked.error as Error).message).toBe(D342_DEADLINE_MESSAGE);
        expect(d342ProcessAbsent(identity.pid)).toBe(true);
        expect(d342GroupAbsent(identity.pgid)).toBe(true);

        // Prompt input: 15,000 ms execution; positive passes, zero failures.
        process.env["CQ_D341_DETECTOR_MODE"] = "prompt";
        const prompt = await nodeSupervisedWorkerGateRunner.run({
          worktreePath,
          admissionTimeoutMs: FIRST_EXECUTION_TIMEOUT_MS,
          executionTimeoutMs: FIRST_EXECUTION_TIMEOUT_MS,
          cancellationSignal: new AbortController().signal,
        });
        expect(prompt.gateExitCode).toBe(0);
        expect(prompt.passCount).toBeGreaterThan(0);
        expect(prompt.failCount).toBe(0);
      } finally {
        if (priorPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = priorPath;
        if (priorMode === undefined) delete process.env["CQ_D341_DETECTOR_MODE"];
        else process.env["CQ_D341_DETECTOR_MODE"] = priorMode;
        if (priorMarker === undefined) delete process.env["CQ_D341_DETECTOR_MARKER"];
        else process.env["CQ_D341_DETECTOR_MARKER"] = priorMarker;
        await reapD342MarkerGroup(markerPath);
      }
    },
    D326_TEST_TIMEOUT_MS,
  );

  // Regression: complete diagnostics outlive the runner's temporary JUnit file.
  test(
    "D500 retains complete redacted JUnit diagnostics through terminal retrieval after cleanup [Behavioral-Active Effectual-GoodCommunication]",
    async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), "t2346-long-output-"));
      roots.push(root);
      const sharedLongIdentity = `two distinct failures share this prefix ${"x".repeat(220)}`;
      const firstLongIdentity = `${sharedLongIdentity} alpha`;
      const secondLongIdentity = `${sharedLongIdentity} beta`;
      const secret = `sk-${"A".repeat(32)}`;
      const junit = [
        "<testsuites><testsuite>",
        '<testcase name="passing self-closing"/>',
        '<testcase name="skipped case"><skipped/></testcase>',
        `<testcase name="${firstLongIdentity}" file="packages/example/test/long.test.ts"><failure type="AssertionError" message="expected ${secret} alpha assertion to be safe" /></testcase>`,
        `<testcase name="${secondLongIdentity}" file="packages/example/test/long.test.ts"><failure type="AssertionError">${"second assertion body ".repeat(24)}beta</failure></testcase>`,
        ...Array.from(
          { length: 4 },
          (_, index) =>
            `<testcase name="cascading failure ${String(index + 3)}"><failure message="cascading assertion ${String(index + 3)}" /></testcase>`,
        ),
        "</testsuite></testsuites>",
      ].join("");
      const bin = path.join(root, "bin");
      await fs.mkdir(bin, { recursive: true });
      const cq = path.join(bin, "cq");
      await fs.writeFile(
        cq,
        [
          "#!/bin/sh",
          "set -eu",
          'test "${CQ_TEST_JUNIT_PATH:-/dev/null}" != /dev/null',
          `printf '%s\\n' '${junit}' > "$CQ_TEST_JUNIT_PATH"`,
          "printf 'packages/example/test/failure.test.ts:\\n'",
          'i=1; while test "$i" -le 6; do printf \'(fail) dependent cascading identity %s\\n\' "$i"; i=$((i + 1)); done',
          'i=1; while test "$i" -le 21; do printf \'trailing diagnostic %s\\n\' "$i"; i=$((i + 1)); done',
          "printf '6989 pass\\n288 skip\\n7 fail\\n'",
          "exit 1",
          "",
        ].join("\n"),
      );
      await fs.chmod(cq, 0o700);
      const priorPath = process.env["PATH"];
      process.env["PATH"] = `${bin}${path.delimiter}${priorPath ?? ""}`;
      const diagnosticStore = new SqliteLedgerStore({
        dbPath: path.join(root, "diagnostic-ledger.db"),
        logsDir: path.join(root, "logs"),
      });
      await diagnosticStore.init();
      const taskStore = finalizedTaskStore();
      const durableTaskStore = Object.assign(taskStore, {
        putLog: (logPath: string, content: string) => diagnosticStore.putLog(logPath, content),
        readLog: (logPath: string) => diagnosticStore.readLog(logPath),
      });
      try {
        const subject = await fixtureWithDispatchBase(
          nodeSupervisedWorkerGateRunner,
          "managed",
          () => "2026-08-12T20:00:00.000Z",
          false,
          true,
          undefined,
          artifactStore(),
          "memory",
          "final",
          "inline",
          durableTaskStore,
        );
        expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
        const rejected = await finalize(subject);
        expect(rejected).toMatchObject({
          state: "aborted",
          result: {
            reason: "gate-rejected",
            details: {
              gateExitCode: 1,
              passCount: 6989,
              failCount: 7,
              diagnosticArtifact: {
                version: 2,
                attestationId: subject.prepared.attestationId,
                generation: subject.prepared.generation,
                taskId: "T2081",
                resultCommit: subject.receipt.newHead,
              },
            },
          },
        });
        if (rejected.state !== "aborted" || rejected.result.details === undefined) {
          throw new Error("D500 gate rejection omitted terminal details");
        }
        const fetched = await subject.capability.fetch({
          attestationId: subject.prepared.attestationId,
          generation: subject.prepared.generation,
        });
        expect(fetched).toEqual(rejected.result);
        const details = rejected.result.details as Readonly<Record<string, DispatchJSONValue>>;
        const publicArtifact = details["diagnosticArtifact"] as Readonly<
          Record<string, DispatchJSONValue>
        >;
        const artifactPath = publicArtifact["artifactPath"];
        const artifactDigest = publicArtifact["artifactDigest"];
        expect(typeof artifactPath).toBe("string");
        expect(typeof artifactDigest).toBe("string");
        if (typeof artifactPath !== "string" || typeof artifactDigest !== "string") {
          throw new Error("D500 terminal diagnostic omitted its durable artifact binding");
        }
        const publicFailures = publicArtifact["failureIndex"] as readonly Readonly<
          Record<string, DispatchJSONValue>
        >[];
        expect(publicFailures).toHaveLength(6);
        for (const failure of publicFailures) {
          for (const field of ["identity", "reference", "assertion"] as const) {
            expect(Buffer.byteLength(String(failure[field]), "utf8"), field).toBeLessThanOrEqual(
              256,
            );
          }
        }

        const ledgerStore = subject.ledgerStore as LedgerStore & {
          readLog(path: string): Promise<{ readonly path: string; readonly content: string }>;
        };
        const retainedLog = await ledgerStore.readLog(artifactPath);
        expect(sha256(retainedLog.content)).toBe(artifactDigest);
        expect(retainedLog.content).not.toContain(secret);
        expect(retainedLog.content).toContain("[REDACTED:api-key]");
        const retained = JSON.parse(retainedLog.content) as {
          readonly kind: string;
          readonly attestationId: string;
          readonly generation: number;
          readonly taskId: string;
          readonly resultCommit: string;
          readonly reportDigest: string;
          readonly report: string;
          readonly failures: readonly {
            readonly identity: string;
            readonly reference: string;
            readonly assertion: string;
          }[];
        };
        expect(retained).toMatchObject({
          kind: "cq-supervised-gate-diagnostic-log",
          attestationId: subject.prepared.attestationId,
          generation: subject.prepared.generation,
          taskId: "T2081",
          resultCommit: subject.receipt.newHead,
        });
        expect(sha256(retained.report)).toBe(retained.reportDigest);
        expect(retained.report).toContain('name="passing self-closing"');
        expect(retained.report).toContain('name="skipped case"');
        expect(retained.failures).toHaveLength(6);
        expect(retained.failures[0]).toMatchObject({
          identity: firstLongIdentity,
          reference: "packages/example/test/long.test.ts",
          assertion: "expected [REDACTED:api-key] alpha assertion to be safe",
        });
        expect(retained.failures[1]).toMatchObject({
          identity: secondLongIdentity,
          reference: "packages/example/test/long.test.ts",
          assertion: `${"second assertion body ".repeat(24)}beta`,
        });
        expect(retained.failures[0]?.identity).not.toBe(retained.failures[1]?.identity);
        expect(retained.failures.map(({ identity }) => identity)).not.toContain(
          "passing self-closing",
        );
        expect(retained.failures.map(({ identity }) => identity)).not.toContain("skipped case");
      } finally {
        await diagnosticStore.dispose();
        if (priorPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = priorPath;
      }
    },
    FIRST_EXECUTION_TIMEOUT_MS,
  );

  // regression: D506 — a coordinator role identity leaked into the host gate and nested fixtures.
  test(
    "D506 host gate removes dispatch identity while preserving runtime and test settings [Behavioral-Active Effectual-GoodCommunication]",
    async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), "t2081-host-gate-environment-"));
      roots.push(root);
      const worktreePath = path.join(root, "worktree");
      await fs.mkdir(path.join(worktreePath, "nix", "pkg", "cq-ledgers"), { recursive: true });
      await git(worktreePath, ["init", "-q"]);
      const bin = path.join(root, "bin");
      await fs.mkdir(bin, { recursive: true });
      const cq = path.join(bin, "cq");
      await fs.writeFile(
        cq,
        [
          "#!/bin/sh",
          "set -eu",
          'test -z "${CQ_CODEX_ROLE_CORRELATION_ID+x}"',
          'test -z "${CQ_CODEX_ROLE_EXPECTED_RUN_ID+x}"',
          'test -z "${CQ_CODEX_PRETURN_OBSERVATION_PATH+x}"',
          'test "$CQ_TEST_PG_URL" = "postgresql://fixture/d506"',
          'test "$CQ_TEST_REQUIRE_PG" = "1"',
          'test "$NODE_OPTIONS" = "--no-warnings"',
          'test "$CQ_D506_RUNTIME_SETTING" = "retained"',
          'test "$CQ_CODEX_LEDGER_COMMAND" = "/fixture/cq"',
          'test "$CQ_CODEX_EXECUTABLE" = "/fixture/codex"',
          "printf '1 pass\\n0 fail\\n'",
          "",
        ].join("\n"),
      );
      await fs.chmod(cq, 0o700);
      const inherited = {
        PATH: process.env["PATH"],
        CQ_CODEX_ROLE_CORRELATION_ID: process.env["CQ_CODEX_ROLE_CORRELATION_ID"],
        CQ_CODEX_ROLE_EXPECTED_RUN_ID: process.env["CQ_CODEX_ROLE_EXPECTED_RUN_ID"],
        CQ_CODEX_PRETURN_OBSERVATION_PATH: process.env["CQ_CODEX_PRETURN_OBSERVATION_PATH"],
        CQ_TEST_PG_URL: process.env["CQ_TEST_PG_URL"],
        CQ_TEST_REQUIRE_PG: process.env["CQ_TEST_REQUIRE_PG"],
        NODE_OPTIONS: process.env["NODE_OPTIONS"],
        CQ_D506_RUNTIME_SETTING: process.env["CQ_D506_RUNTIME_SETTING"],
        CQ_CODEX_LEDGER_COMMAND: process.env["CQ_CODEX_LEDGER_COMMAND"],
        CQ_CODEX_EXECUTABLE: process.env["CQ_CODEX_EXECUTABLE"],
      };
      process.env["PATH"] = `${bin}${path.delimiter}${inherited.PATH ?? ""}`;
      process.env["CQ_CODEX_ROLE_CORRELATION_ID"] = "d506-coordinator";
      process.env["CQ_CODEX_ROLE_EXPECTED_RUN_ID"] = "d506-run";
      process.env["CQ_CODEX_PRETURN_OBSERVATION_PATH"] = path.join(root, "observation.json");
      process.env["CQ_TEST_PG_URL"] = "postgresql://fixture/d506";
      process.env["CQ_TEST_REQUIRE_PG"] = "1";
      process.env["NODE_OPTIONS"] = "--no-warnings";
      process.env["CQ_D506_RUNTIME_SETTING"] = "retained";
      process.env["CQ_CODEX_LEDGER_COMMAND"] = "/fixture/cq";
      process.env["CQ_CODEX_EXECUTABLE"] = "/fixture/codex";
      try {
        const result = await nodeSupervisedWorkerGateRunner.run({
          worktreePath,
          admissionTimeoutMs: FIRST_EXECUTION_TIMEOUT_MS,
          executionTimeoutMs: FIRST_EXECUTION_TIMEOUT_MS,
          cancellationSignal: new AbortController().signal,
        });
        expect(result).toMatchObject({ gateExitCode: 0, passCount: 1, failCount: 0 });
      } finally {
        for (const [key, value] of Object.entries(inherited)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
    FIRST_EXECUTION_TIMEOUT_MS,
  );

  test(
    "D342 worktree settlement rejection still settles the registered root once and retains the deadline cause",
    async () => {
      const scenario = await runD342Scenario({
        worktreeRejection: "D342 injected worktree-arm settlement rejection",
      });
      const { failure, worktreeArm, rootArm } = scenario;
      expect(failure).toBeInstanceOf(Error);
      expect(worktreeArm.calls).toBe(1);
      expect(rootArm.calls).toBe(1);
      const message = (failure as Error).message;
      expect(message).toContain("worktree settlement rejected");
      expect(message).toContain("D342 injected worktree-arm settlement rejection");
      expect(message).not.toContain("registered-root settlement rejected");
      const cause = (failure as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toBe(D342_DEADLINE_MESSAGE);
      await expectD342ObservationAndAbsence(scenario);
    },
    D342_TEST_TIMEOUT_MS,
  );

  test(
    "D342 registered-root settlement rejection retains the deadline cause after both arms settle once",
    async () => {
      const scenario = await runD342Scenario({
        rootFault: { kind: "reject", detail: "D342 injected root-arm settlement rejection" },
      });
      const { failure, worktreeArm, rootArm } = scenario;
      expect(failure).toBeInstanceOf(Error);
      expect(worktreeArm.calls).toBe(1);
      expect(rootArm.calls).toBe(1);
      const message = (failure as Error).message;
      expect(message).toContain("registered-root settlement rejected");
      expect(message).toContain("D342 injected root-arm settlement rejection");
      expect(message).not.toContain("worktree settlement rejected");
      const cause = (failure as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toBe(D342_DEADLINE_MESSAGE);
      await expectD342ObservationAndAbsence(scenario);
    },
    D342_TEST_TIMEOUT_MS,
  );

  test(
    "D342 direct-root survivors remain a concrete identifier list alongside the deadline cause",
    async () => {
      const scenario = await runD342Scenario({ rootFault: { kind: "survivors" } });
      const { failure, worktreeArm, rootArm } = scenario;
      expect(failure).toBeInstanceOf(Error);
      expect(worktreeArm.calls).toBe(1);
      expect(rootArm.calls).toBe(1);
      const registration = rootArm.observed[0];
      expect(registration).toBeDefined();
      const message = (failure as Error).message;
      expect(message).toContain("registered-root survivors:");
      expect(message).toContain(String(registration?.pgid));
      expect(rootArm.realResult?.survivors).toEqual([]);
      const cause = (failure as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toBe(D342_DEADLINE_MESSAGE);
      await expectD342ObservationAndAbsence(scenario);
    },
    D342_TEST_TIMEOUT_MS,
  );

  test(
    "D342 rejecting both settlement arms retains both bounded diagnostics and the deadline cause",
    async () => {
      const scenario = await runD342Scenario({
        worktreeRejection: "D342 injected worktree-arm settlement rejection",
        rootFault: { kind: "reject", detail: "D342 injected root-arm settlement rejection" },
      });
      const { failure, worktreeArm, rootArm } = scenario;
      expect(failure).toBeInstanceOf(Error);
      expect(worktreeArm.calls).toBe(1);
      expect(rootArm.calls).toBe(1);
      const message = (failure as Error).message;
      expect(message).toContain("worktree settlement rejected");
      expect(message).toContain("D342 injected worktree-arm settlement rejection");
      expect(message).toContain("registered-root settlement rejected");
      expect(message).toContain("D342 injected root-arm settlement rejection");
      const cause = (failure as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toBe(D342_DEADLINE_MESSAGE);
      await expectD342ObservationAndAbsence(scenario);
    },
    D342_TEST_TIMEOUT_MS,
  );
});
