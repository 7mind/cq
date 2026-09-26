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
  implementConflictResolverSidecar,
  implementWorkerSidecar,
  isAttestationTombstone,
  serializeWipArtifact,
  sequentialDispatchRandomBytes,
  type AttestationEnvelope,
  type AttestationNamespace,
  type DispatchJSONValue,
  type DispatchGitChangeReceipt,
  type ImplementationQueueEnrollment,
  type DispatchJournalRecoveryClaim,
} from "@cq/config";
import {
  SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS,
  SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
  InMemoryCurrentRecoverySealJournalStore,
  WORKTREE_MANAGE_TOOL_SPEC,
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
  type DispatchRecoveryResolution,
  type DispatchStagedRebaseResolution,
  type GitRebaseConflictState,
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
const RECOVERY_BACKEND_CASE_TIMEOUT_MS = 30_000;
const roots: string[] = [];
let sequence = 0;

function taskReceipt(receipt: DispatchGitChangeReceipt): Extract<DispatchGitChangeReceipt, { version: 1 }> {
  if (receipt.version !== 1) throw new Error("task fixture received a cohort Git receipt");
  return receipt;
}

function taskEnrollment(enrollment: ImplementationQueueEnrollment): Extract<ImplementationQueueEnrollment, { version: 1 }> {
  if (enrollment.version !== 1) throw new Error("task fixture received a cohort enrollment");
  return enrollment;
}

function taskRecoveryClaim(claim: DispatchJournalRecoveryClaim): Extract<DispatchJournalRecoveryClaim, { version: 1 }> {
  if (claim.version !== 1) throw new Error("task fixture received a cohort recovery claim");
  return claim;
}

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
  const workerMetadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const,
    promptDigest,
    schemaVersion: implementWorkerSidecar.version,
  };
  const resolverMetadata = {
    roleId: "implement-conflict-resolver",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-conflict-resolver.md",
    sidecarSchemaRoleId: "implement-conflict-resolver",
    promptSurface: "codex" as const,
    promptDigest,
    schemaVersion: implementConflictResolverSidecar.version,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [workerMetadata, resolverMetadata],
      promptSurface: "codex",
      catalogHash: "b".repeat(64),
    }),
    readRole: (roleId) => ({
      metadata: roleId === "implement-conflict-resolver" ? resolverMetadata : workerMetadata,
      bytes: roleBytes,
    }),
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
    // D588: the queue coordinator resolves a leased front's task archive-aware.
    fetch: (ledgerId: string) => ({
      id: ledgerId,
      schema: { terminalStatuses: ["done", "abandoned"] },
      milestones: [{ id: task.milestoneId, items: ledgerId === "tasks" ? [task] : [] }],
      archivePointers: [],
    }),
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

class ParentLossThenRedThenGreenGateDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      throw new Error("controlled parent loss after qualification");
    }
    if (this.requests.length === 2) {
      return {
        gateExitCode: 1,
        passCount: 61,
        failCount: 1,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:09.000Z",
        outputTail: "(fail) recovered guarded candidate\n61 pass\n1 fail",
      };
    }
    return {
      gateExitCode: 0,
      passCount: 62,
      failCount: 0,
      gateDurationMs: 1,
      capturedAt: "2026-08-12T20:00:12.000Z",
      outputTail: "62 pass\n0 fail",
    };
  }
}

class ParentLossThenTwoGreenThenRedThenGreenGateDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      throw new Error("controlled parent loss after qualification");
    }
    if (this.requests.length === 4) {
      return {
        gateExitCode: 1,
        passCount: 61,
        failCount: 1,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:13.000Z",
        outputTail: "(fail) recovered cancelled continuation\n61 pass\n1 fail",
      };
    }
    return {
      gateExitCode: 0,
      passCount: 62,
      failCount: 0,
      gateDurationMs: 1,
      capturedAt: "2026-08-12T20:00:14.000Z",
      outputTail: "62 pass\n0 fail",
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
  const commandWorkspace = path.join(repositoryRoot, "nix", "pkg", "cq-ledgers");
  await fs.mkdir(commandWorkspace, { recursive: true });
  await fs.writeFile(path.join(commandWorkspace, "package.json"), '{"private":true}\n');
  await git(repositoryRoot, ["add", "file.txt", "nix/pkg/cq-ledgers/package.json"]);
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
  const receipt = taskReceipt(await capability.gitCommit({
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
  }));
  if (receipt.version !== 1) throw new Error("task fixture received a cohort Git receipt");
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

for (const attestationBackend of ["memory", "sqlite"] as const) {
  test(`cancelled focused recovery composes through a consumed failure into an ordinary continuation (${attestationBackend})`, async () => {
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
      "focused-only",
    );
    if (
      subject.capability.resolveRecovery === undefined ||
      subject.capability.resolveContinuation === undefined ||
      subject.capability.qualifyImplementationCandidate === undefined ||
      subject.capability.coordinateImplementationCandidate === undefined
    ) {
      throw new Error("cancelled recovery composition operations are unavailable");
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
    if (binding === null) throw new Error("cancelled recovery composition lost its binding");
    expect(
      await subject.capability.storeResult({
        resultCapability: subject.prepared.resultCapability,
        output: subject.output,
      }),
    ).toMatchObject({ state: "gate-pending" });
    expect(
      await subject.capability.qualifyImplementationCandidate({
        attestationId: subject.prepared.attestationId,
        generation: subject.prepared.generation,
        roleId: "implement-worker",
        correlationId: subject.expectedChild.childId.slice("implement-worker#".length),
        childThreadId: `cancelled-focused-thread-${attestationBackend}`,
        expectedRunId: subject.expectedChild.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt: "2026-08-12T20:00:01.000Z",
        promptDigest: subject.prepared.promptProvenance.promptDigest,
      }),
    ).toMatchObject({ state: "queued" });
    expect(
      await subject.capability.abort({ ...subject.prepared, reason: "cancelled" }),
    ).toMatchObject({ state: "aborted", reason: "cancelled" });

    const recovery = await subject.capability.resolveRecovery(binding, subject.receipt.newHead);
    if (recovery.preparation.kind !== "current") {
      throw new Error("cancelled focused worker did not produce current recovery authority");
    }
    const recoveredChild = {
      childId: `implement-worker#cancelled-failure-${attestationBackend}-${String(sequence)}`,
      runId: `cancelled-failure-${attestationBackend}-${String(sequence)}`,
    };
    const recovered = await subject.capability.prepare({
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
        validationIntent: "focused-only",
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-cancelled-failure-${attestationBackend}`,
      timeoutMs: 600_000,
      expectedChild: recoveredChild,
      recoveryPreparation: recovery.preparation.recoveryPreparation,
    });
    if (!recovered.accepted) throw new Error(recovered.detail);
    await subject.capability.fetchInput({
      ...recovered.handle,
      inputCapability: recovered.prepared.inputCapability,
    });
    expect(
      await subject.capability.storeResult({
        resultCapability: recovered.prepared.resultCapability,
        output: {
          ...subject.output,
          status: "fail",
          resultCommit: null,
          gitReceipts: [],
          checkSummary: "cancelled recovery failed intentionally",
          summary: "the recovered focused worker reports a controlled failure",
          blockedReason: "controlled recovered failure",
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    const recoveredObservation = {
      attestationId: recovered.handle.attestationId,
      generation: recovered.handle.generation,
      roleId: "implement-worker" as const,
      correlationId: recoveredChild.childId.slice("implement-worker#".length),
      childThreadId: `cancelled-failure-thread-${attestationBackend}`,
      expectedRunId: recoveredChild.runId,
      outcome: "completed" as const,
      exitStatus: 0,
      observedAt: "2026-08-12T20:00:02.000Z",
      promptDigest: recovered.prepared.promptProvenance.promptDigest,
    };
    expect(
      await subject.capability.qualifyImplementationCandidate(recoveredObservation),
    ).toMatchObject({ state: "consumed" });

    const continuation = await subject.capability.resolveContinuation(
      binding,
      subject.receipt.newHead,
    );
    const continuedChild = {
      childId: `implement-worker#cancelled-continuation-${attestationBackend}-${String(sequence)}`,
      runId: `cancelled-continuation-${attestationBackend}-${String(sequence)}`,
    };
    const continued = await subject.capability.prepare({
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
        validationIntent: "focused-only",
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-cancelled-continuation-${attestationBackend}`,
      timeoutMs: 600_000,
      expectedChild: continuedChild,
      continuation: continuation.continuationReference,
    });
    if (!continued.accepted) throw new Error(continued.detail);
    await subject.capability.fetchInput({
      ...continued.handle,
      inputCapability: continued.prepared.inputCapability,
    });
    expect(
      await subject.capability.storeResult({
        resultCapability: continued.prepared.resultCapability,
        output: {
          ...subject.output,
          resultCommit: subject.receipt.newHead,
          gitReceipts: [],
          checkSummary: "ordinary continuation after recovered failure checks passed",
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    const continuedObservation = {
      attestationId: continued.handle.attestationId,
      generation: continued.handle.generation,
      roleId: "implement-worker" as const,
      correlationId: continuedChild.childId.slice("implement-worker#".length),
      childThreadId: `cancelled-continuation-thread-${attestationBackend}`,
      expectedRunId: continuedChild.runId,
      outcome: "completed" as const,
      exitStatus: 0,
      observedAt: "2026-08-12T20:00:03.000Z",
      promptDigest: continued.prepared.promptProvenance.promptDigest,
    };
    const rejectLineageMutation = async (
      handle: { readonly attestationId: string; readonly generation: number },
      mutate: (row: AttestationEnvelope) => AttestationEnvelope,
    ): Promise<void> => {
      const retained = await subject.backend.transact({ kind: "handle", handle }, (store) => {
        const row = store.read(handle);
        if (row === undefined || isAttestationTombstone(row)) {
          throw new Error("cancelled recovery composition row disappeared");
        }
        return row;
      });
      const rowCount = subject.backend.storedRows().length;
      await subject.backend.transact({ kind: "handle", handle }, (store) => {
        const current = store.read(handle);
        if (current === undefined) throw new Error("cancelled recovery mutation lost its row");
        store.replace(current, mutate(retained));
      });
      try {
        await expect(
          subject.capability.qualifyImplementationCandidate!(continuedObservation),
        ).rejects.toThrow("cannot be resurrected");
        expect(subject.backend.storedRows()).toHaveLength(rowCount);
        expect(runner.requests).toHaveLength(0);
      } finally {
        await subject.backend.transact({ kind: "handle", handle }, (store) => {
          const current = store.read(handle);
          if (current === undefined) throw new Error("cancelled recovery restore lost its row");
          store.replace(current, retained);
        });
      }
    };
    await rejectLineageMutation(subject.prepared, (row) => ({
      ...row,
      terminalDigest: "0".repeat(64),
    }));
    await rejectLineageMutation(subject.prepared, (row) => ({
      ...row,
      implementationQueue: {
        ...row.implementationQueue!,
        terminal: { ...row.implementationQueue!.terminal!, detailsDigest: "0".repeat(64) },
      },
    }));
    await rejectLineageMutation(recovered.handle, (row) => ({
      ...row,
      dispatchJournalRecoveryClaim: {
        ...row.dispatchJournalRecoveryClaim!,
        sourceTerminalDigest: "0".repeat(64),
      },
    }));
    await rejectLineageMutation(recovered.handle, (row) => ({
      ...row,
      terminalDigest: "0".repeat(64),
    }));
    await rejectLineageMutation(continued.handle, (row) => ({
      ...row,
      dispatchContinuationClaim: {
        ...row.dispatchContinuationClaim!,
        source: {
          ...row.dispatchContinuationClaim!.source,
          generation: continued.handle.generation,
        },
      },
    }));
    const qualified = await subject.capability.qualifyImplementationCandidate(continuedObservation);
    if (qualified.state !== "queued") throw new Error("ordinary continuation did not qualify");
    expect(
      await subject.capability.coordinateImplementationCandidate({
        partitionKey: qualified.partitionKey,
        holderId: `cancelled-continuation-${attestationBackend}`,
      }),
    ).toMatchObject({ state: "completed", handle: continued.handle });
    expect(runner.requests).toHaveLength(0);
    await subject.backend.close();
  }, RECOVERY_BACKEND_CASE_TIMEOUT_MS);
}

for (const attestationBackend of ["memory", "sqlite"] as const) {
  test(`terminal generation 3 composes through authenticated cancellations and failures into generation 27 (${attestationBackend})`, async () => {
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
    const capability = createDispatchCapability({
      ...subject.capabilityOptions,
      recoveryJournal: new InMemoryCurrentRecoverySealJournalStore(),
    });
    if (
      capability.resolveRecovery === undefined ||
      capability.resolveContinuation === undefined ||
      capability.qualifyImplementationCandidate === undefined ||
      capability.coordinateImplementationCandidate === undefined
    ) {
      throw new Error("long authenticated recovery composition operations are unavailable");
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
    if (binding === null) throw new Error("long recovery composition lost its binding");
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
        childThreadId: `long-recovery-${attestationBackend}-${String(prepared.generation)}`,
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
    if (sourceQualified.state !== "queued") throw new Error("long recovery source did not queue");
    await expect(
      capability.coordinateImplementationCandidate({
        partitionKey: sourceQualified.partitionKey,
        holderId: `long-recovery-source-${attestationBackend}`,
      }),
    ).rejects.toThrow("controlled parent loss after qualification");

    const firstRecovery = await capability.resolveRecovery(binding, subject.receipt.newHead);
    if (firstRecovery.preparation.kind !== "current") {
      throw new Error("parent-lost source did not produce current recovery authority");
    }
    const cancelledChild = {
      childId: `implement-worker#long-cancelled-${attestationBackend}-${String(sequence)}`,
      runId: `long-cancelled-${attestationBackend}-${String(sequence)}`,
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
      idempotencyKey: `T2081-${String(sequence)}-long-cancelled-${attestationBackend}`,
      timeoutMs: 600_000,
      expectedChild: cancelledChild,
      recoveryPreparation: firstRecovery.preparation.recoveryPreparation,
    });
    if (!cancelled.accepted) throw new Error(cancelled.detail);
    expect(cancelled.handle.generation).toBe(2);
    await capability.fetchInput({
      ...cancelled.handle,
      inputCapability: cancelled.prepared.inputCapability,
    });
    expect(await capability.abort({ ...cancelled.handle, reason: "cancelled" })).toMatchObject({
      state: "aborted",
      reason: "cancelled",
    });

    const secondRecovery = await capability.resolveRecovery(binding, subject.receipt.newHead);
    if (secondRecovery.preparation.kind !== "current") {
      throw new Error("cancelled successor did not promote current recovery authority");
    }
    const terminalChild = {
      childId: `implement-worker#long-terminal-${attestationBackend}-${String(sequence)}`,
      runId: `long-terminal-${attestationBackend}-${String(sequence)}`,
    };
    const terminal = await capability.prepare({
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
      idempotencyKey: `T2081-${String(sequence)}-long-terminal-${attestationBackend}`,
      timeoutMs: 600_000,
      expectedChild: terminalChild,
      recoveryPreparation: secondRecovery.preparation.recoveryPreparation,
    });
    if (!terminal.accepted) throw new Error(terminal.detail);
    expect(terminal.handle.generation).toBe(3);
    await capability.fetchInput({
      ...terminal.handle,
      inputCapability: terminal.prepared.inputCapability,
    });
    expect(
      await capability.storeResult({
        resultCapability: terminal.prepared.resultCapability,
        output: {
          ...subject.output,
          resultCommit: subject.receipt.newHead,
          gitReceipts: [],
          checkSummary: "terminal generation 3 checks passed",
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    const terminalQualified = await qualify(
      terminal.prepared,
      terminalChild,
      "2026-08-12T20:00:03.000Z",
    );
    if (terminalQualified.state !== "queued") {
      throw new Error("terminal generation 3 did not qualify");
    }
    expect(
      await capability.coordinateImplementationCandidate({
        partitionKey: terminalQualified.partitionKey,
        holderId: `long-terminal-${attestationBackend}`,
      }),
    ).toMatchObject({ state: "completed", handle: terminal.handle });

    let firstRepeatedCancelledHandle:
      { readonly attestationId: string; readonly generation: number } | undefined;
    let firstRepeatedFailureHandle:
      { readonly attestationId: string; readonly generation: number } | undefined;
    let lastRepeatedCancelledHandle:
      { readonly attestationId: string; readonly generation: number } | undefined;
    for (let cancelledGeneration = 4; cancelledGeneration <= 26; cancelledGeneration += 2) {
      const continuation = await capability.resolveContinuation(binding, subject.receipt.newHead);
      const repeatedCancelledChild = {
        childId: `implement-worker#long-cancelled-${attestationBackend}-${String(cancelledGeneration)}-${String(sequence)}`,
        runId: `long-cancelled-${attestationBackend}-${String(cancelledGeneration)}-${String(sequence)}`,
      };
      const repeatedCancelled = await capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: subject.dispatchBaseCommit,
          round: cancelledGeneration - 1,
          startingCommit: subject.receipt.newHead,
          validationIntent: "final",
          priorResultCommit: subject.receipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-long-cancelled-${attestationBackend}-${String(cancelledGeneration)}`,
        timeoutMs: 600_000,
        expectedChild: repeatedCancelledChild,
        continuation: continuation.continuationReference,
      });
      if (!repeatedCancelled.accepted) throw new Error(repeatedCancelled.detail);
      expect(repeatedCancelled.handle.generation).toBe(cancelledGeneration);
      firstRepeatedCancelledHandle ??= repeatedCancelled.handle;
      lastRepeatedCancelledHandle = repeatedCancelled.handle;
      await capability.fetchInput({
        ...repeatedCancelled.handle,
        inputCapability: repeatedCancelled.prepared.inputCapability,
      });
      expect(
        await capability.abort({ ...repeatedCancelled.handle, reason: "cancelled" }),
      ).toMatchObject({ state: "aborted", reason: "cancelled" });

      const recovery = await capability.resolveRecovery(binding, subject.receipt.newHead);
      if (recovery.preparation.kind !== "current") {
        throw new Error("repeated cancellation did not produce current recovery authority");
      }
      const recoveryGeneration = cancelledGeneration + 1;
      const recoveredChild = {
        childId: `implement-worker#long-recovered-${attestationBackend}-${String(recoveryGeneration)}-${String(sequence)}`,
        runId: `long-recovered-${attestationBackend}-${String(recoveryGeneration)}-${String(sequence)}`,
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
          round: recoveryGeneration - 1,
          startingCommit: subject.receipt.newHead,
          validationIntent: "final",
          priorResultCommit: subject.receipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-long-recovered-${attestationBackend}-${String(recoveryGeneration)}`,
        timeoutMs: 600_000,
        expectedChild: recoveredChild,
        recoveryPreparation: recovery.preparation.recoveryPreparation,
      });
      if (!recovered.accepted) throw new Error(recovered.detail);
      expect(recovered.handle.generation).toBe(recoveryGeneration);
      if (recoveryGeneration === 5) firstRepeatedFailureHandle = recovered.handle;
      await capability.fetchInput({
        ...recovered.handle,
        inputCapability: recovered.prepared.inputCapability,
      });
      const finalRecovery = recoveryGeneration === 27;
      expect(
        await capability.storeResult({
          resultCapability: recovered.prepared.resultCapability,
          output: finalRecovery
            ? {
                ...subject.output,
                resultCommit: subject.receipt.newHead,
                gitReceipts: [],
                checkSummary: "generation 27 recovery checks passed",
              }
            : {
                ...subject.output,
                status: "fail",
                resultCommit: null,
                gitReceipts: [],
                checkSummary: "repeated recovery failed intentionally",
                summary: "the repeated recovery reports a controlled failure",
                blockedReason: "controlled repeated recovery failure",
              },
        }),
      ).toMatchObject({ state: "gate-pending" });
      const observedAt = `2026-08-12T20:00:${String(recoveryGeneration + 10).padStart(2, "0")}.000Z`;
      if (finalRecovery) {
        if (
          firstRepeatedCancelledHandle === undefined ||
          firstRepeatedFailureHandle === undefined ||
          lastRepeatedCancelledHandle === undefined
        ) {
          throw new Error("long recovery mutation handles are unavailable");
        }
        const rejectLineageMutation = async (
          handle: { readonly attestationId: string; readonly generation: number },
          mutate: (row: AttestationEnvelope) => AttestationEnvelope,
        ): Promise<void> => {
          const retained = await subject.backend.transact({ kind: "handle", handle }, (store) => {
            const row = store.read(handle);
            if (row === undefined || isAttestationTombstone(row)) {
              throw new Error("long recovery composition row disappeared");
            }
            return row;
          });
          const rowCount = subject.backend.storedRows().length;
          await subject.backend.transact({ kind: "handle", handle }, (store) => {
            const current = store.read(handle);
            if (current === undefined) throw new Error("long recovery mutation lost its row");
            store.replace(current, mutate(retained));
          });
          try {
            await expect(qualify(recovered.prepared, recoveredChild, observedAt)).rejects.toThrow();
            expect(subject.backend.storedRows()).toHaveLength(rowCount);
            expect(runner.requests).toHaveLength(2);
            expect(
              await subject.backend.transact(
                { kind: "handle", handle: recovered.handle },
                (store) => store.read(recovered.handle),
              ),
            ).not.toHaveProperty("implementationQueue");
          } finally {
            await subject.backend.transact({ kind: "handle", handle }, (store) => {
              const current = store.read(handle);
              if (current === undefined) throw new Error("long recovery restore lost its row");
              store.replace(current, retained);
            });
          }
        };
        await rejectLineageMutation(firstRepeatedCancelledHandle, (row) => {
          const { dispatchContinuationClaim: _claim, ...withoutClaim } = row;
          return withoutClaim;
        });
        await rejectLineageMutation(firstRepeatedFailureHandle, (row) => ({
          ...row,
          dispatchJournalRecoveryClaim: {
            ...row.dispatchJournalRecoveryClaim!,
            sourceTerminalDigest: "0".repeat(64),
          },
        }));
        await rejectLineageMutation(firstRepeatedFailureHandle, (row) => ({
          ...row,
          gitEffectBinding: { ...row.gitEffectBinding!, repositoryId: "0".repeat(64) },
        }));
        await rejectLineageMutation(lastRepeatedCancelledHandle, (row) => ({
          ...row,
          terminalDigest: "0".repeat(64),
        }));
        await rejectLineageMutation(recovered.handle, (row) => ({
          ...row,
          input: {
            ...(row.input as Readonly<Record<string, DispatchJSONValue>>),
            taskId: "T9999",
          },
        }));
        await rejectLineageMutation(recovered.handle, (row) => ({
          ...row,
          gitEffectBinding: {
            ...row.gitEffectBinding!,
            inheritedGitReceipts: row.gitEffectBinding!.inheritedGitReceipts!.map(
              (receipt, index) =>
                index === 0 ? { ...receipt, requestDigest: "0".repeat(64) } : receipt,
            ),
          },
        }));
      }
      const recoveredQualified = await qualify(recovered.prepared, recoveredChild, observedAt);
      if (!finalRecovery) {
        expect(recoveredQualified).toMatchObject({ state: "consumed" });
        continue;
      }
      if (recoveredQualified.state !== "queued") {
        throw new Error("generation 27 recovery did not qualify");
      }
      expect(
        await capability.coordinateImplementationCandidate({
          partitionKey: recoveredQualified.partitionKey,
          holderId: `long-recovered-${attestationBackend}-${String(recoveryGeneration)}`,
        }),
      ).toMatchObject({ state: "completed", handle: recovered.handle });
    }
    expect(runner.requests).toHaveLength(3);
    await subject.backend.close();
  }, 30_000);
}

for (const attestationBackend of ["memory", "sqlite"] as const) {
  // regression: tasks:T6573 — retained parent-lost attempts must compose without a private-store repair.
  test(`qualified generation 3 composes through consecutive unenrolled parent losses into generation 29 (${attestationBackend})`, async () => {
    const runner = new ParentLossThenGreenGateDummy();
    const subject = await fixtureWithDispatchBase(
      runner,
      "managed",
      () => "2026-08-12T20:00:00.000Z",
      "exact",
      true,
      undefined,
      artifactStore(),
      attestationBackend,
    );
    const capability = createDispatchCapability({
      ...subject.capabilityOptions,
      recoveryJournal: new InMemoryCurrentRecoverySealJournalStore(),
    });
    if (
      capability.resolveRecovery === undefined ||
      capability.resolveContinuation === undefined ||
      capability.qualifyImplementationCandidate === undefined ||
      capability.coordinateImplementationCandidate === undefined ||
      capability.gitCommit === undefined
    ) {
      throw new Error("consecutive parent-loss recovery operations are unavailable");
    }
    const gitCommit = capability.gitCommit;
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: subject.repositoryRoot,
        taskId: subject.managed.handle.taskId,
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
      },
      { stateDir: subject.stateDir },
    );
    if (binding === null) throw new Error("consecutive parent-loss binding disappeared");
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
        childThreadId: `consecutive-parent-loss-${attestationBackend}-${String(prepared.generation)}`,
        expectedRunId: child.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt,
        promptDigest: prepared.promptProvenance.promptDigest,
      });
    let lineageBaseCommit = subject.dispatchBaseCommit;
    const prepareRecovery = async (
      generation: number,
      liveTip: string,
      recovery: DispatchRecoveryResolution,
    ) => {
      if (recovery.preparation.kind !== "current") {
        throw new Error(`generation ${String(generation)} lacks current recovery authority`);
      }
      const child = {
        childId: `implement-worker#consecutive-parent-loss-${attestationBackend}-${String(generation)}-${String(sequence)}`,
        runId: `consecutive-parent-loss-${attestationBackend}-${String(generation)}-${String(sequence)}`,
      };
      const prepared = await capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: lineageBaseCommit,
          round: generation - 1,
          startingCommit: liveTip,
          validationIntent: "final",
          priorResultCommit: liveTip,
        },
        idempotencyKey: `T2081-${String(sequence)}-consecutive-parent-loss-${attestationBackend}-${String(generation)}`,
        timeoutMs: 600_000,
        expectedChild: child,
        recoveryPreparation: recovery.preparation.recoveryPreparation,
      });
      if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
        throw new Error(
          `generation ${String(generation)} recovery refused: ${prepared.accepted ? "missing Git authority" : prepared.detail}`,
        );
      }
      expect(prepared.handle.generation).toBe(generation);
      await capability.fetchInput({
        ...prepared.handle,
        inputCapability: prepared.prepared.inputCapability,
      });
      return { ...prepared, child };
    };

    expect(await capability.abort({ ...subject.prepared, reason: "parent-lost" })).toMatchObject({
      state: "aborted",
      reason: "parent-lost",
    });
    const secondRecovery = await capability.resolveRecovery(binding, subject.receipt.newHead);
    if (secondRecovery.preparation.kind !== "current") {
      throw new Error("generation 1 did not produce current recovery authority");
    }
    const second = await prepareRecovery(2, subject.receipt.newHead, secondRecovery);
    expect(await capability.abort({ ...second.handle, reason: "parent-lost" })).toMatchObject({
      state: "aborted",
      reason: "parent-lost",
    });

    const thirdRecovery = await capability.resolveRecovery(binding, subject.receipt.newHead);
    if (thirdRecovery.preparation.kind !== "current") {
      throw new Error("generation 2 did not produce current recovery authority");
    }
    const third = await prepareRecovery(3, subject.receipt.newHead, thirdRecovery);
    expect(
      await capability.storeResult({
        resultCapability: third.prepared.resultCapability,
        output: {
          ...subject.output,
          gitReceipts: [],
          checkSummary: "generation 3 awaits its first ordinary gate",
          summary: "generation 3 establishes the qualified parent-loss source",
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    const sourceQualified = await qualify(third.prepared, third.child, "2026-08-12T20:00:03.000Z");
    if (sourceQualified.state !== "queued") {
      throw new Error("generation 3 parent-loss source did not qualify");
    }
    await expect(
      capability.coordinateImplementationCandidate({
        partitionKey: sourceQualified.partitionKey,
        holderId: `consecutive-parent-loss-source-${attestationBackend}`,
      }),
    ).rejects.toThrow("controlled parent loss after qualification");
    expect(runner.requests).toHaveLength(1);
    expect(
      await subject.backend.transact({ kind: "handle", handle: third.handle }, (store) =>
        store.read(third.handle),
      ),
    ).toMatchObject({
      state: "aborted",
      abortReason: "parent-lost",
      implementationQueue: { state: "terminal", terminal: { reason: "parent-lost" } },
    });

    const prepareContinuation = async (
      generation: number,
      liveTip: string,
      continuation: Awaited<
        ReturnType<NonNullable<typeof capability.resolveContinuation>>
      >["continuationReference"],
    ) => {
      const child = {
        childId: `implement-worker#consecutive-parent-loss-${attestationBackend}-${String(generation)}-${String(sequence)}`,
        runId: `consecutive-parent-loss-${attestationBackend}-${String(generation)}-${String(sequence)}`,
      };
      const prepared = await capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: lineageBaseCommit,
          round: generation - 1,
          startingCommit: liveTip,
          validationIntent: "final",
          priorResultCommit: liveTip,
        },
        idempotencyKey: `T2081-${String(sequence)}-consecutive-parent-loss-${attestationBackend}-${String(generation)}`,
        timeoutMs: 600_000,
        expectedChild: child,
        continuation,
      });
      if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
        throw new Error(
          `generation ${String(generation)} continuation refused: ${prepared.accepted ? "missing Git authority" : prepared.detail}`,
        );
      }
      expect(prepared.handle.generation).toBe(generation);
      await capability.fetchInput({
        ...prepared.handle,
        inputCapability: prepared.prepared.inputCapability,
      });
      return { ...prepared, child };
    };
    const persistPassingWip = async (
      resumed: Awaited<ReturnType<typeof prepareRecovery>>,
      generation: number,
      liveTip: string,
    ) => {
      const gitChangeCapability = resumed.prepared.gitChangeCapability;
      if (gitChangeCapability === undefined) {
        throw new Error(`generation ${String(generation)} lost Git authority`);
      }
      const wipPath = `WIP-${subject.managed.handle.taskId}.md`;
      const oldWip = await fs.readFile(
        path.join(subject.managed.handle.absolutePath, wipPath),
        "utf8",
      );
      const newWip = wipFixtureBody(
        subject.managed.handle.taskId,
        subject.dispatchBaseCommit,
        `Resumed generation ${String(generation)} after authenticated parent loss.\n`,
      );
      await fs.writeFile(path.join(subject.managed.handle.absolutePath, wipPath), newWip);
      const receipt = taskReceipt(await gitCommit({
        ...resumed.handle,
        gitChangeCapability,
        operationId: `T2081-${String(sequence)}-consecutive-parent-loss-${attestationBackend}-${String(generation)}-commit`,
        expectedHead: liveTip,
        message: `resume parent-lost generation ${String(generation)}`,
        changes: [
          {
            kind: "modify",
            path: wipPath,
            oldState: { mode: "100644", digest: sha256(oldWip) },
            newState: { mode: "100644", digest: sha256(newWip) },
          },
        ],
      }));
      expect(
        await capability.storeResult({
          resultCapability: resumed.prepared.resultCapability,
          output: {
            ...subject.output,
            resultCommit: receipt.newHead,
            gitReceipts: [
              {
                ...receipt,
                objectOids: [...receipt.objectOids],
                paths: [...receipt.paths],
              },
            ],
            checkSummary: `generation ${String(generation)} resumed WIP checks passed`,
            summary: "the resumed worker preserves its authenticated recovery lineage",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: lineageBaseCommit,
              headCommit: receipt.newHead,
            },
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      return receipt.newHead;
    };
    const storePassingExactTip = async (
      resumed: Awaited<ReturnType<typeof prepareRecovery>>,
      generation: number,
      liveTip: string,
    ): Promise<void> => {
      expect(
        await capability.storeResult({
          resultCapability: resumed.prepared.resultCapability,
          output: {
            ...subject.output,
            resultCommit: liveTip,
            gitReceipts: [],
            checkSummary: `generation ${String(generation)} exact-tip checks passed`,
            summary: "the resumed worker preserves its authenticated recovery lineage",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: lineageBaseCommit,
              headCommit: liveTip,
            },
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
    };

    let liveTip = subject.receipt.newHead;
    for (let generation = 4; generation <= 7; generation += 1) {
      const recovery = await capability.resolveRecovery(binding, liveTip);
      if (recovery.preparation.kind !== "current") {
        throw new Error(`generation ${String(generation - 1)} did not preserve current recovery`);
      }
      const resumed = await prepareRecovery(generation, liveTip, recovery);
      expect(await capability.abort({ ...resumed.handle, reason: "parent-lost" })).toMatchObject({
        state: "aborted",
        reason: "parent-lost",
      });
    }

    const eighthRecovery = await capability.resolveRecovery(binding, liveTip);
    if (eighthRecovery.preparation.kind !== "current") {
      throw new Error("generation 7 did not preserve current recovery");
    }
    const eighth = await prepareRecovery(8, liveTip, eighthRecovery);
    liveTip = await persistPassingWip(eighth, 8, liveTip);
    const eighthQualified = await qualify(
      eighth.prepared,
      eighth.child,
      "2026-08-12T20:00:08.000Z",
    );
    if (eighthQualified.state !== "queued") {
      throw new Error("generation 8 recovery did not qualify");
    }
    expect(
      await capability.coordinateImplementationCandidate({
        partitionKey: eighthQualified.partitionKey,
        holderId: `consecutive-parent-loss-eighth-${attestationBackend}`,
      }),
    ).toMatchObject({ state: "completed", handle: eighth.handle });
    expect(runner.requests).toHaveLength(2);

    const ninthContinuation = await capability.resolveContinuation(binding, liveTip);
    const ninth = await prepareContinuation(9, liveTip, ninthContinuation.continuationReference);
    expect(await capability.abort({ ...ninth.handle, reason: "cancelled" })).toMatchObject({
      state: "aborted",
      reason: "cancelled",
    });

    let twentySixth: Awaited<ReturnType<typeof prepareRecovery>> | undefined;
    for (let generation = 10; generation <= 26; generation += 1) {
      const recovery = await capability.resolveRecovery(binding, liveTip);
      if (recovery.preparation.kind !== "current") {
        throw new Error(`generation ${String(generation - 1)} did not preserve current recovery`);
      }
      const resumed = await prepareRecovery(generation, liveTip, recovery);
      if (generation === 26) {
        liveTip = await persistPassingWip(resumed, generation, liveTip);
      }
      expect(await capability.abort({ ...resumed.handle, reason: "parent-lost" })).toMatchObject({
        state: "aborted",
        reason: "parent-lost",
      });
      if (generation === 26) twentySixth = resumed;
    }
    if (twentySixth === undefined) {
      throw new Error("generation 26 parent-loss handle is unavailable");
    }

    await fs.writeFile(path.join(subject.repositoryRoot, "parent-loss-integration.txt"), "onto\n");
    await git(subject.repositoryRoot, ["add", "parent-loss-integration.txt"]);
    await git(subject.repositoryRoot, ["commit", "-q", "-m", "advance parent-loss integration"]);
    const ontoCommit = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);
    const rebase = await runGuardedRebase({
      binding,
      operationId: `t2081-consecutive-parent-loss-${attestationBackend}-${String(sequence)}`,
      ontoCommit,
      stateDir: subject.stateDir,
      runEffect: async () => {
        await git(subject.managed.handle.absolutePath, ["rebase", ontoCommit]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    if (rebase.kind !== "finalized") {
      throw new Error("generation 26 guarded transition did not finalize");
    }
    const twentySeventhChild = {
      childId: `implement-worker#consecutive-parent-loss-${attestationBackend}-27-${String(sequence)}`,
      runId: `consecutive-parent-loss-${attestationBackend}-27-${String(sequence)}`,
    };
    const twentySeventh = await capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: rebase.bridge.ontoCommit,
        round: 26,
        startingCommit: rebase.bridge.rebasedStartCommit,
        validationIntent: "final",
        priorResultCommit: liveTip,
      },
      idempotencyKey: `T2081-${String(sequence)}-consecutive-parent-loss-${attestationBackend}-27`,
      timeoutMs: 600_000,
      expectedChild: twentySeventhChild,
      reprepareOf: twentySixth.handle,
      guardedRebase: rebase.reference,
    });
    if (!twentySeventh.accepted) throw new Error(twentySeventh.detail);
    expect(twentySeventh.handle.generation).toBe(27);
    await capability.fetchInput({
      ...twentySeventh.handle,
      inputCapability: twentySeventh.prepared.inputCapability,
    });
    expect(
      await capability.abort({ ...twentySeventh.handle, reason: "parent-lost" }),
    ).toMatchObject({ state: "aborted", reason: "parent-lost" });
    lineageBaseCommit = rebase.bridge.ontoCommit;
    liveTip = rebase.bridge.rebasedStartCommit;

    const twentyEighthRecovery = await capability.resolveRecovery(binding, liveTip);
    if (twentyEighthRecovery.preparation.kind !== "current") {
      throw new Error("generation 27 did not preserve current recovery");
    }
    const twentyEighth = await prepareRecovery(28, liveTip, twentyEighthRecovery);
    expect(await capability.abort({ ...twentyEighth.handle, reason: "parent-lost" })).toMatchObject(
      { state: "aborted", reason: "parent-lost" },
    );

    const twentyNinthRecovery = await capability.resolveRecovery(binding, liveTip);
    if (twentyNinthRecovery.preparation.kind !== "current") {
      throw new Error("generation 28 did not preserve current recovery");
    }
    const twentyNinth = await prepareRecovery(29, liveTip, twentyNinthRecovery);
    await storePassingExactTip(twentyNinth, 29, liveTip);

    const rejectLineageMutation = async (
      handle: { readonly attestationId: string; readonly generation: number },
      mutate: (row: AttestationEnvelope) => AttestationEnvelope,
      observedAt: string,
    ): Promise<void> => {
      const retained = await subject.backend.transact({ kind: "handle", handle }, (store) => {
        const row = store.read(handle);
        if (row === undefined || isAttestationTombstone(row)) {
          throw new Error("consecutive parent-loss evidence disappeared");
        }
        return row;
      });
      const rowCount = subject.backend.storedRows().length;
      await subject.backend.transact({ kind: "handle", handle }, (store) => {
        const current = store.read(handle);
        if (current === undefined) throw new Error("parent-loss mutation lost its row");
        store.replace(current, mutate(retained));
      });
      try {
        await expect(qualify(twentyNinth.prepared, twentyNinth.child, observedAt)).rejects.toThrow(
          "cannot be resurrected",
        );
        expect(subject.backend.storedRows()).toHaveLength(rowCount);
        expect(runner.requests).toHaveLength(2);
      } finally {
        await subject.backend.transact({ kind: "handle", handle }, (store) => {
          const current = store.read(handle);
          if (current === undefined) throw new Error("parent-loss restore lost its row");
          store.replace(current, retained);
        });
      }
    };
    await rejectLineageMutation(
      twentyEighth.handle,
      (row) => ({ ...row, terminalDigest: "0".repeat(64) }),
      "2026-08-12T20:01:29.100Z",
    );
    await rejectLineageMutation(
      twentyEighth.handle,
      (row) => ({
        ...row,
        dispatchJournalRecoveryClaim: {
          ...row.dispatchJournalRecoveryClaim!,
          sourceTerminalDigest: "0".repeat(64),
        },
      }),
      "2026-08-12T20:01:29.200Z",
    );
    await rejectLineageMutation(
      twentyEighth.handle,
      (row) => ({
        ...row,
        gitEffectBinding: { ...row.gitEffectBinding!, repositoryId: "0".repeat(64) },
      }),
      "2026-08-12T20:01:29.300Z",
    );
    await rejectLineageMutation(
      twentySeventh.handle,
      (row) => ({ ...row, abortDetailsDigest: "0".repeat(64) }),
      "2026-08-12T20:01:29.400Z",
    );
    const qualified = await qualify(
      twentyNinth.prepared,
      twentyNinth.child,
      "2026-08-12T20:01:29.500Z",
    );
    if (qualified.state !== "queued") {
      throw new Error("generation 29 recovery did not qualify");
    }
    expect(
      await capability.coordinateImplementationCandidate({
        partitionKey: qualified.partitionKey,
        holderId: `consecutive-parent-loss-target-${attestationBackend}`,
      }),
    ).toMatchObject({ state: "completed", handle: twentyNinth.handle });
    expect(runner.requests).toHaveLength(3);
    await subject.backend.close();
  }, 60_000);
}

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
      expected: "broker receipt task/cohort subject does not match the dispatch binding",
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
  const secondReceipt = taskReceipt(await subject.capability.gitCommit({
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
  }));
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
    // defects:D538: the launcher now verifies the attested prompt digest against
    // the role instructions under its prompt root before spawning. The shared
    // fixture's artifact store records a synthetic digest ("a" x 64 over bytes
    // [1]) that no file can hash to, so this test — which is about argv privacy
    // and foreign-handle rejection, not prompt provenance — supplies a real role
    // body and binds the prepared dispatch to the digest its bytes produce.
    const successorRoleInstructions = "# implement-worker (T2081 successor fixture)\n";
    await fs.mkdir(path.join(controlRoot, "roles"), { recursive: true });
    await fs.writeFile(
      path.join(controlRoot, "roles", "implement-worker.md"),
      successorRoleInstructions,
    );
    const launchInput = {
      prepared: {
        ...subject.prepared,
        promptProvenance: {
          ...subject.prepared.promptProvenance,
          promptDigest: createHash("sha256").update(successorRoleInstructions).digest("hex"),
        },
      },
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

  test.each(["memory", "sqlite"] as const)(
    "a fresh production coordinator replays one persisted conflict without gating or relaunching it (%s)",
    async (attestationBackend) => {
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
      const protectedHead = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);

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
      if (first.state !== "blocked" || !("sourceReference" in first)) {
        throw new Error("conflicted retirement did not return its staged-source handoff");
      }
      let activeBackend = subject.backend;
      const readPersisted = async (handle: {
        readonly attestationId: string;
        readonly generation: number;
      }) => await activeBackend.transact({ kind: "handle", handle }, (store) => store.read(handle));
      const sourceReference = first.sourceReference;
      expect(runner.requests).toHaveLength(0);
      const retired = await readPersisted(subject.prepared);
      expect(retired?.implementationQueue).toMatchObject({
        state: "staged-rebase-retired",
        stagedRebaseDisposition: { state: "conflict-pending" },
      });
      const persistedControl = retired?.implementationQueue;

      const reopenSqliteBackend = async (): Promise<void> => {
        if (attestationBackend !== "sqlite") return;
        await activeBackend.close();
        activeBackend = new SqliteAttestationBackend({
          namespace: subject.backend.namespace,
          dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
        });
      };
      await reopenSqliteBackend();

      const restarted = createDispatchCapability({
        backend: activeBackend,
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

      if (restarted.resolveStagedRebase === undefined) {
        throw new Error("public staged-rebase recovery is unavailable");
      }
      const pendingRecovery = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
          resolveStagedRebase: restarted.resolveStagedRebase,
        },
        {
          operation: "resolve-staged-rebase",
          handle: subject.managed.handle,
          sourceDispatch: first.front,
          sourceReference,
        },
      )) as unknown as DispatchStagedRebaseResolution;
      expect(pendingRecovery).toEqual({
        status: "staged-rebase-conflict-pending",
        taskId: subject.managed.handle.taskId,
        liveTip: expect.any(String),
        source: first.front,
        sourceReference,
        guardedRebase: expect.stringMatching(/^cq-guarded-rebase:v1:/u),
      });
      expect(
        (await WORKTREE_MANAGE_TOOL_SPEC.run(
          subject.ledgerStore,
          {
            repositoryRoot: subject.repositoryRoot,
            deps: { stateDir: subject.stateDir },
            resolveStagedRebase: restarted.resolveStagedRebase,
          },
          {
            operation: "resolve-staged-rebase",
            handle: subject.managed.handle,
            sourceDispatch: first.front,
            sourceReference,
          },
        )) as unknown as DispatchStagedRebaseResolution,
      ).toEqual(pendingRecovery);
      await expect(
        WORKTREE_MANAGE_TOOL_SPEC.run(
          subject.ledgerStore,
          {
            repositoryRoot: subject.repositoryRoot,
            deps: { stateDir: subject.stateDir },
            resolveStagedRebase: restarted.resolveStagedRebase,
          },
          {
            operation: "resolve-staged-rebase",
            handle: subject.managed.handle,
            sourceDispatch: { ...first.front, generation: first.front.generation + 1 },
            sourceReference,
          },
        ),
      ).rejects.toThrow("source handle or reference changed");
      await expect(
        WORKTREE_MANAGE_TOOL_SPEC.run(
          subject.ledgerStore,
          {
            repositoryRoot: subject.repositoryRoot,
            deps: { stateDir: subject.stateDir },
            resolveStagedRebase: restarted.resolveStagedRebase,
          },
          {
            operation: "resolve-staged-rebase",
            handle: subject.managed.handle,
            sourceDispatch: first.front,
            sourceReference: `cq-staged-rebase-source:v1:${"d".repeat(64)}`,
          },
        ),
      ).rejects.toThrow("staged-rebase source does not resolve to one durable checkpoint");
      await expect(
        WORKTREE_MANAGE_TOOL_SPEC.run(
          subject.ledgerStore,
          {
            repositoryRoot: subject.repositoryRoot,
            deps: { stateDir: subject.stateDir },
            resolveStagedRebase: restarted.resolveStagedRebase,
          },
          {
            operation: "resolve-staged-rebase",
            handle: {
              ...subject.managed.handle,
              branch: `${subject.managed.handle.branch}-foreign`,
            },
            sourceDispatch: first.front,
            sourceReference,
          },
        ),
      ).rejects.toThrow();

      const replay = await restarted.coordinateImplementationCandidate({
        partitionKey: qualified.partitionKey,
        holderId: "restarted-conflict-coordinator",
      });

      expect(replay).toEqual(first);
      expect(runner.requests).toHaveLength(0);
      expect((await readPersisted(subject.prepared))?.implementationQueue).toEqual(
        persistedControl,
      );

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
      await reopenSqliteBackend();
      const finalizedRestart = createDispatchCapability({
        backend: activeBackend,
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

      if (finalizedRestart.resolveStagedRebase === undefined) {
        throw new Error("finalized staged-rebase recovery is unavailable");
      }
      const recovered = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
          resolveStagedRebase: finalizedRestart.resolveStagedRebase,
        },
        {
          operation: "resolve-staged-rebase",
          handle: subject.managed.handle,
          sourceDispatch: first.front,
          sourceReference,
        },
      )) as unknown as DispatchStagedRebaseResolution;
      if (recovered.status !== "staged-rebase-preparation-ready") {
        throw new Error("terminal staged-rebase recovery did not return preparation authority");
      }
      const recoveredGuardedRebase = recovered.guardedRebase;
      expect(recovered).toMatchObject({
        status: "staged-rebase-preparation-ready",
        taskId: subject.managed.handle.taskId,
        source: first.front,
        sourceReference,
        guardedRebase: recoveredGuardedRebase,
        preparation: {
          kind: "guarded-rebase",
          reprepareOf: first.front,
          guardedRebase: recoveredGuardedRebase,
        },
      });
      expect(recovered.preparation.guardedRebase).toMatch(/^cq-guarded-rebase:v1:[0-9a-f]{64}$/u);
      expect(
        (await WORKTREE_MANAGE_TOOL_SPEC.run(
          subject.ledgerStore,
          {
            repositoryRoot: subject.repositoryRoot,
            deps: { stateDir: subject.stateDir },
            resolveStagedRebase: finalizedRestart.resolveStagedRebase,
          },
          {
            operation: "resolve-staged-rebase",
            handle: subject.managed.handle,
            sourceDispatch: first.front,
            sourceReference,
          },
        )) as unknown as DispatchStagedRebaseResolution,
      ).toEqual(recovered);
      if (
        retired === undefined ||
        isAttestationTombstone(retired) ||
        retired.input === null ||
        typeof retired.input !== "object" ||
        Array.isArray(retired.input)
      ) {
        throw new Error("retired source input is unavailable");
      }
      const successor = await finalizedRestart.prepare({
        roleId: "implement-worker",
        input: {
          ...retired.input,
          baseCommit: protectedHead,
          startingCommit: recovered.liveTip,
          priorResultCommit: subject.receipt.newHead,
          round: 1,
        },
        idempotencyKey: "t6573-public-staged-rebase-successor",
        timeoutMs: 600_000,
        expectedChild: subject.expectedChild,
        reprepareOf: recovered.preparation.reprepareOf,
        guardedRebase: recovered.preparation.guardedRebase,
      });
      if (!successor.accepted) throw new Error(successor.detail);
      const successorInput = await finalizedRestart.fetchInput({
        ...successor.handle,
        inputCapability: successor.prepared.inputCapability,
      });
      expect(successorInput.input).toMatchObject({
        baseCommit: protectedHead,
        startingCommit: recovered.liveTip,
        priorResultCommit: subject.receipt.newHead,
        round: 1,
        guardedRebaseLineage: {
          guardedRebase: recovered.guardedRebase,
          ontoCommit: protectedHead,
          rebasedStartCommit: recovered.liveTip,
        },
      });
      expect(
        (await WORKTREE_MANAGE_TOOL_SPEC.run(
          subject.ledgerStore,
          {
            repositoryRoot: subject.repositoryRoot,
            deps: { stateDir: subject.stateDir },
            resolveStagedRebase: finalizedRestart.resolveStagedRebase,
          },
          {
            operation: "resolve-staged-rebase",
            handle: subject.managed.handle,
            sourceDispatch: first.front,
            sourceReference,
          },
        )) as unknown as DispatchStagedRebaseResolution,
      ).toEqual({
        status: "staged-rebase-successor-bound",
        taskId: subject.managed.handle.taskId,
        liveTip: recovered.liveTip,
        source: first.front,
        sourceReference,
        guardedRebase: recovered.guardedRebase,
        successor: successor.handle,
      });

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
          attestationId: successor.handle.attestationId,
          generation: successor.handle.generation,
        },
      });
      expect(runner.requests).toHaveLength(0);
      expect(await readPersisted(successor.handle)).toMatchObject({
        attestationId: successor.handle.attestationId,
        generation: successor.handle.generation,
      });
      expect(
        await readPersisted({
          attestationId: successor.handle.attestationId,
          generation: successor.handle.generation + 1,
        }),
      ).toBeUndefined();
      if (
        finalizedRestart.gitCommit === undefined ||
        successor.prepared.gitChangeCapability === undefined
      ) {
        throw new Error("successor Git authority is unavailable");
      }
      const successorBody = "successor completed\n";
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "successor.txt"),
        successorBody,
      );
      const successorReceipt = taskReceipt(await finalizedRestart.gitCommit({
        ...successor.handle,
        gitChangeCapability: successor.prepared.gitChangeCapability,
        operationId: "t6573-public-staged-rebase-successor-result",
        expectedHead: recovered.liveTip,
        message: "complete recovered staged-rebase successor",
        changes: [
          {
            kind: "add",
            path: "successor.txt",
            newState: { mode: "100644", digest: sha256(successorBody) },
          },
        ],
      }));
      const successorInputRecord = successorInput.input as Readonly<
        Record<string, DispatchJSONValue>
      >;
      const guardedLineage = successorInputRecord["guardedRebaseLineage"];
      if (
        guardedLineage === null ||
        typeof guardedLineage !== "object" ||
        Array.isArray(guardedLineage)
      ) {
        throw new Error("successor guarded lineage is unavailable");
      }
      const guardedLineageRecord = guardedLineage as Readonly<Record<string, DispatchJSONValue>>;
      const changedPaths = (
        await git(subject.managed.handle.absolutePath, [
          "diff",
          "--name-only",
          "--no-renames",
          protectedHead,
          successorReceipt.newHead,
          "--",
        ])
      )
        .split("\n")
        .filter((entry) => entry !== "")
        .sort();
      expect(
        await finalizedRestart.storeResult({
          resultCapability: successor.prepared.resultCapability,
          output: {
            taskId: subject.managed.handle.taskId,
            status: "pass",
            resultCommit: successorReceipt.newHead,
            branch: subject.managed.handle.branch,
            actualWorktreePath: subject.managed.handle.absolutePath,
            filesTouched: changedPaths,
            gitReceipts: [successorReceipt],
            gitLineage: {
              kind: "guarded-rebase",
              guardedRebase: guardedLineageRecord["guardedRebase"],
              ontoCommit: guardedLineageRecord["ontoCommit"],
              rebasedStartCommit: guardedLineageRecord["rebasedStartCommit"],
              exactTip: guardedLineageRecord["exactTip"],
            },
            checkSummary: "trusted gate delegated after recovered successor completion",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: protectedHead,
              headCommit: successorReceipt.newHead,
            },
            summary: "completed the receipt-backed recovered successor",
          } as unknown as DispatchJSONValue,
        }),
      ).toMatchObject({ state: "gate-pending" });
      if (
        finalizedRestart.finalizeParentGate === undefined ||
        successor.prepared.parentGateCapability === undefined
      ) {
        throw new Error("successor parent gate authority is unavailable");
      }
      expect(
        await finalizedRestart.finalizeParentGate({
          ...successor.handle,
          parentGateCapability: successor.prepared.parentGateCapability,
        }),
      ).toMatchObject({ state: "result-stored" });
      expect(runner.requests).toHaveLength(1);
      expect(
        await finalizedRestart.confirmCompletion({
          ...successor.handle,
          nativeCompletion: {
            kind: "native-completion",
            actor: "trusted-parent",
            childId: subject.expectedChild.childId,
            runId: subject.expectedChild.runId,
            completedAt: "2026-08-12T20:00:03.000Z",
          },
          expectedProvenance: {
            roleId: successor.prepared.promptProvenance.roleId,
            version: successor.prepared.promptProvenance.version,
            promptDigest: successor.prepared.promptProvenance.promptDigest,
            inputDigest: successor.prepared.promptProvenance.inputDigest,
          },
        }),
      ).toMatchObject({ state: "consumed" });
      expect(await readPersisted(subject.prepared)).toMatchObject({
        state: "aborted",
        abortReason: "staged-rebase",
        implementationQueue: {
          state: "staged-rebase-retired",
          terminal: { reason: "staged-rebase" },
          stagedRebaseSource: {
            source: first.front,
            sourceReference,
            successor: successor.handle,
          },
        },
      });
      expect(
        await readPersisted({
          attestationId: successor.handle.attestationId,
          generation: successor.handle.generation + 1,
        }),
      ).toBeUndefined();
      await activeBackend.close();
    },
    RECOVERY_BACKEND_CASE_TIMEOUT_MS,
  );

  async function exerciseAutomaticStagedRebaseLineage(
    mode: "refs-only-continuation" | "gate-rejected-correction",
  ): Promise<void> {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
      const runner =
        mode === "refs-only-continuation"
          ? new GateDummy()
          : new GateSequenceDummy([
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
                outputTail: "(fail) automatic continuation rejection\n16 pass\n1 fail",
              },
            ]);
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
      expect(
        await subject.capability.abort({
          ...subject.prepared,
          reason: "parent-lost",
        }),
      ).toMatchObject({ state: "aborted", reason: "parent-lost" });
      if (subject.capability.resolveRecovery === undefined || subject.ledgerStore === undefined) {
        throw new Error("sealed recovery fixture is unavailable");
      }
      const currentRecovery = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
          resolveDispatchRecovery: subject.capability.resolveRecovery,
        },
        { operation: "resolve-dispatch-recovery", handle: subject.managed.handle },
      )) as unknown as DispatchRecoveryResolution;
      if (currentRecovery.preparation.kind !== "current") {
        throw new Error("source did not produce a current recovery seal");
      }
      const sealedChild = {
        childId: `implement-worker#sealed-conflict-${String(sequence)}`,
        runId: `sealed-conflict-run-${String(sequence)}`,
      };
      const sealedWorkerInput = {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        round: 1,
        startingCommit: subject.receipt.newHead,
        validationIntent: "final" as const,
        priorResultCommit: subject.receipt.newHead,
      };
      const sealed = await subject.capability.prepare({
        roleId: "implement-worker",
        input: sealedWorkerInput,
        idempotencyKey: `T2081-${String(sequence)}-sealed-conflict-source`,
        timeoutMs: 600_000,
        expectedChild: sealedChild,
        recoveryPreparation: currentRecovery.preparation.recoveryPreparation,
      });
      if (!sealed.accepted) throw new Error(`sealed worker refused: ${sealed.detail}`);
      await subject.capability.fetchInput({
        ...sealed.handle,
        inputCapability: sealed.prepared.inputCapability,
      });
      expect(
        await subject.capability.storeResult({
          resultCapability: sealed.prepared.resultCapability,
          output: {
            ...subject.output,
            gitReceipts: [],
            checkSummary: "sealed source requests queue coordination",
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      if (
        subject.capability.qualifyImplementationCandidate === undefined ||
        subject.capability.coordinateImplementationCandidate === undefined
      ) {
        throw new Error("sealed source coordinator is unavailable");
      }
      const qualified = await subject.capability.qualifyImplementationCandidate({
        ...sealed.handle,
        roleId: "implement-worker",
        correlationId: sealedChild.childId.slice("implement-worker#".length),
        childThreadId: `sealed-conflict-thread-${String(sequence)}`,
        expectedRunId: sealedChild.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt: "2026-08-12T20:00:02.000Z",
        promptDigest: sealed.prepared.promptProvenance.promptDigest,
      });
      if (qualified.state !== "queued") throw new Error("sealed source did not qualify");

      await fs.writeFile(path.join(subject.repositoryRoot, "file.txt"), "protected\n");
      await git(subject.repositoryRoot, ["add", "file.txt"]);
      await git(subject.repositoryRoot, ["commit", "-q", "-m", "advance protected head"]);
      const protectedHead = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);
      const retired = await subject.capability.coordinateImplementationCandidate({
        partitionKey: qualified.partitionKey,
        holderId: `sealed-conflict-coordinator-${attestationBackend}`,
      });
      expect(retired).toMatchObject({
        state: "blocked",
        front: sealed.handle,
        frontState: "staged-rebase-retired",
      });
      if (retired.state !== "blocked" || !("sourceReference" in retired)) {
        throw new Error("sealed source did not return a conflict handoff");
      }
      expect(runner.requests).toHaveLength(0);

      let activeBackend = subject.backend;
      const reopenBackend = async (): Promise<void> => {
        if (attestationBackend !== "sqlite") return;
        await activeBackend.close();
        activeBackend = new SqliteAttestationBackend({
          namespace: subject.backend.namespace,
          dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
        });
      };
      await reopenBackend();
      const restarted = createDispatchCapability({
        backend: activeBackend,
        promptArtifactStore: artifactStore(),
        ledgerStore: subject.ledgerStore,
        implementationEvidenceStore: subject.implementationEvidenceStore,
        repositoryRoot: subject.repositoryRoot,
        worktreeStateDir: subject.stateDir,
        supervisedWorkerGateRunner: runner,
        now: () => "2026-08-12T20:00:00.000Z",
        randomBytes: sequentialDispatchRandomBytes(sequence * 32 + 128),
      });
      if (restarted.resolveStagedRebase === undefined) {
        throw new Error("sealed staged-rebase recovery is unavailable");
      }
      const pending = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
          resolveStagedRebase: restarted.resolveStagedRebase,
        },
        {
          operation: "resolve-staged-rebase",
          handle: subject.managed.handle,
          sourceDispatch: retired.front,
          sourceReference: retired.sourceReference,
        },
      )) as unknown as DispatchStagedRebaseResolution;
      expect(pending).toMatchObject({
        status: "staged-rebase-conflict-pending",
        source: sealed.handle,
        sourceReference: retired.sourceReference,
      });
      const observed = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
        },
        { operation: "observe-conflict", handle: subject.managed.handle },
      )) as unknown as {
        readonly status: "conflict-observed";
        readonly conflictState: GitRebaseConflictState;
      };
      expect(observed.status).toBe("conflict-observed");
      const conflictingFiles = [
        ...new Set(observed.conflictState.conflicts.map((entry) => entry.path)),
      ].sort();
      const resolverInput = {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "resolve the authenticated staged-rebase conflict",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        validationIntent: "focused-only" as const,
        conflictingFiles,
        conflictState: observed.conflictState,
      };
      const resolverRequest = {
        roleId: "implement-conflict-resolver" as const,
        input: JSON.parse(JSON.stringify(resolverInput)) as DispatchJSONValue,
        idempotencyKey: `T2081-${String(sequence)}-sealed-conflict-resolver`,
        timeoutMs: 600_000,
        expectedChild: {
          childId: `implement-conflict-resolver#sealed-${String(sequence)}`,
          runId: `sealed-conflict-resolver-run-${String(sequence)}`,
        },
      };
      const rowCount = async (): Promise<number> =>
        await activeBackend.transact({ kind: "namespace" }, (store) => store.rows().length);
      const beforeNegativeControls = await rowCount();
      for (const changed of [
        {
          ...resolverRequest,
          idempotencyKey: `${resolverRequest.idempotencyKey}-foreign-task`,
          input: JSON.parse(
            JSON.stringify({ ...resolverInput, taskId: "T9999" }),
          ) as DispatchJSONValue,
        },
        {
          ...resolverRequest,
          idempotencyKey: `${resolverRequest.idempotencyKey}-changed-conflict`,
          input: JSON.parse(
            JSON.stringify({
              ...resolverInput,
              conflictState: { ...observed.conflictState, currentHead: "f".repeat(40) },
            }),
          ) as DispatchJSONValue,
        },
        {
          ...resolverRequest,
          idempotencyKey: `${resolverRequest.idempotencyKey}-changed-onto`,
          input: JSON.parse(
            JSON.stringify({
              ...resolverInput,
              conflictState: {
                ...observed.conflictState,
                sequencer: { ...observed.conflictState.sequencer, onto: "e".repeat(40) },
              },
            }),
          ) as DispatchJSONValue,
        },
        {
          ...resolverRequest,
          idempotencyKey: `${resolverRequest.idempotencyKey}-foreign-worktree`,
          input: JSON.parse(
            JSON.stringify({
              ...resolverInput,
              worktreePath: `${subject.managed.handle.absolutePath}-foreign`,
            }),
          ) as DispatchJSONValue,
        },
        {
          ...resolverRequest,
          idempotencyKey: `${resolverRequest.idempotencyKey}-substituted-authority`,
          reprepareOf: sealed.handle,
        },
      ]) {
        expect(await restarted.prepare(changed)).toMatchObject({ accepted: false });
      }
      expect(await rowCount()).toBe(beforeNegativeControls);

      const resolver = await restarted.prepare(resolverRequest);
      if (!resolver.accepted || resolver.prepared.gitConflictCapability === undefined) {
        throw new Error(
          `sealed conflict resolver refused: ${
            resolver.accepted ? "missing Git authority" : `${resolver.reason}: ${resolver.detail}`
          }`,
        );
      }
      expect(await restarted.prepare(resolverRequest)).toEqual(resolver);
      await restarted.fetchInput({
        ...resolver.handle,
        inputCapability: resolver.prepared.inputCapability,
      });
      const resolvedBody = "protected + sealed candidate\n";
      await fs.writeFile(path.join(subject.managed.handle.absolutePath, "file.txt"), resolvedBody);
      if (restarted.gitResolveContinue === undefined) {
        throw new Error("sealed resolver continuation is unavailable");
      }
      const conflictReceipt = await restarted.gitResolveContinue({
        ...resolver.handle,
        gitConflictCapability: resolver.prepared.gitConflictCapability,
        operationId: `T2081-${String(sequence)}-sealed-conflict-resolution`,
        expectedState: observed.conflictState,
        resolutions: [
          {
            kind: "regular",
            path: "file.txt",
            newState: { mode: "100644", digest: sha256(resolvedBody) },
          },
        ],
      });
      expect(conflictReceipt.outcome).toMatchObject({ kind: "terminal" });
      expect(
        await restarted.storeResult({
          resultCapability: resolver.prepared.resultCapability,
          output: {
            taskId: "T2081",
            status: "pass",
            resultCommit: conflictReceipt.newHead,
            filesResolved: conflictingFiles,
            checkSummary: "authenticated conflict continuation completed",
            focusedChecks: [
              {
                command: "bun test sealed-conflict-resolver.test.ts",
                exitCode: 0,
                passCount: 1,
                failCount: 0,
              },
            ],
            summary: "continued the exact manager-observed guarded conflict",
            actualWorktreePath: subject.managed.handle.absolutePath,
            branch: subject.managed.handle.branch,
            conflictReceipts: [conflictReceipt],
          } as unknown as DispatchJSONValue,
        }),
      ).toMatchObject({ state: "result-stored" });

      await reopenBackend();
      const finalized = createDispatchCapability({
        backend: activeBackend,
        promptArtifactStore: artifactStore(),
        ledgerStore: subject.ledgerStore,
        implementationEvidenceStore: subject.implementationEvidenceStore,
        repositoryRoot: subject.repositoryRoot,
        worktreeStateDir: subject.stateDir,
        supervisedWorkerGateRunner: runner,
        now: () => "2026-08-12T20:00:00.000Z",
        randomBytes: sequentialDispatchRandomBytes(sequence * 32 + 160),
      });
      if (finalized.resolveStagedRebase === undefined) {
        throw new Error("finalized sealed staged-rebase recovery is unavailable");
      }
      const recovered = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
          resolveStagedRebase: finalized.resolveStagedRebase,
        },
        {
          operation: "resolve-staged-rebase",
          handle: subject.managed.handle,
          sourceDispatch: retired.front,
          sourceReference: retired.sourceReference,
        },
      )) as unknown as DispatchStagedRebaseResolution;
      if (recovered.status !== "staged-rebase-preparation-ready") {
        throw new Error("sealed conflict did not produce guarded worker preparation");
      }
      const successor = await finalized.prepare({
        roleId: "implement-worker",
        input: {
          ...sealedWorkerInput,
          baseCommit: protectedHead,
          round: 2,
          startingCommit: recovered.liveTip,
          priorResultCommit: subject.receipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-sealed-conflict-successor`,
        timeoutMs: 600_000,
        expectedChild: sealedChild,
        reprepareOf: recovered.preparation.reprepareOf,
        guardedRebase: recovered.preparation.guardedRebase,
      });
      if (!successor.accepted) throw new Error(`guarded successor refused: ${successor.detail}`);
      const successorInput = await finalized.fetchInput({
        ...successor.handle,
        inputCapability: successor.prepared.inputCapability,
      });
      expect(successorInput).toMatchObject({
        input: {
          baseCommit: protectedHead,
          startingCommit: recovered.liveTip,
          guardedRebaseLineage: {
            guardedRebase: recovered.preparation.guardedRebase,
            ontoCommit: protectedHead,
          },
        },
      });
      const successorInputRecord = successorInput.input as Readonly<
        Record<string, DispatchJSONValue>
      >;
      const successorLineage = successorInputRecord["guardedRebaseLineage"];
      if (
        successorLineage === null ||
        typeof successorLineage !== "object" ||
        Array.isArray(successorLineage)
      ) {
        throw new Error("automatic staged-rebase successor omitted its guarded lineage");
      }
      const successorLineageRecord = successorLineage as Readonly<
        Record<string, DispatchJSONValue>
      >;
      if (
        finalized.gitCommit === undefined ||
        successor.prepared.gitChangeCapability === undefined
      ) {
        throw new Error("automatic staged-rebase successor omitted Git authority");
      }
      const successorBody = "automatic staged-rebase successor\n";
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "automatic-successor.txt"),
        successorBody,
      );
      const successorReceipt = taskReceipt(await finalized.gitCommit({
        ...successor.handle,
        gitChangeCapability: successor.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-automatic-successor-change`,
        expectedHead: recovered.liveTip,
        message: "complete automatic staged-rebase successor",
        changes: [
          {
            kind: "add",
            path: "automatic-successor.txt",
            newState: { mode: "100644", digest: sha256(successorBody) },
          },
        ],
      }));
      expect(
        await finalized.storeResult({
          resultCapability: successor.prepared.resultCapability,
          output: {
            taskId: "T2081",
            status: "pass",
            resultCommit: successorReceipt.newHead,
            branch: subject.managed.handle.branch,
            actualWorktreePath: subject.managed.handle.absolutePath,
            filesTouched: ["automatic-successor.txt", "file.txt"],
            gitReceipts: [successorReceipt],
            gitLineage: {
              kind: "guarded-rebase",
              guardedRebase: successorLineageRecord["guardedRebase"],
              ontoCommit: successorLineageRecord["ontoCommit"],
              rebasedStartCommit: successorLineageRecord["rebasedStartCommit"],
              exactTip: successorLineageRecord["exactTip"],
            },
            checkSummary: "automatic staged-rebase successor requests its ordinary gate",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: protectedHead,
              headCommit: successorReceipt.newHead,
            },
            summary: "completed the exact automatic staged-rebase successor",
          } as unknown as DispatchJSONValue,
        }),
      ).toMatchObject({ state: "gate-pending" });
      if (
        finalized.qualifyImplementationCandidate === undefined ||
        finalized.coordinateImplementationCandidate === undefined
      ) {
        throw new Error("automatic successor coordinator is unavailable");
      }
      const successorQualification = await finalized.qualifyImplementationCandidate({
        ...successor.handle,
        roleId: "implement-worker",
        correlationId: sealedChild.childId.slice("implement-worker#".length),
        childThreadId: `automatic-successor-thread-${String(sequence)}`,
        expectedRunId: sealedChild.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt: "2026-08-12T20:00:03.000Z",
        promptDigest: successor.prepared.promptProvenance.promptDigest,
      });
      if (successorQualification.state !== "queued") {
        throw new Error("automatic staged-rebase successor did not qualify");
      }
      expect(
        await finalized.coordinateImplementationCandidate({
          partitionKey: successorQualification.partitionKey,
          holderId: `automatic-successor-coordinator-${attestationBackend}`,
        }),
      ).toEqual({ state: "completed", handle: successor.handle });
      expect(runner.requests).toHaveLength(1);

      await reopenBackend();
      const continuationRuntime = createDispatchCapability({
        ...subject.capabilityOptions,
        backend: activeBackend,
        now: () => "2026-08-12T20:00:00.000Z",
        randomBytes: sequentialDispatchRandomBytes(sequence * 32 + 192),
      });
      if (
        continuationRuntime.resolveContinuation === undefined ||
        continuationRuntime.qualifyImplementationCandidate === undefined ||
        continuationRuntime.coordinateImplementationCandidate === undefined
      ) {
        throw new Error("automatic successor continuation runtime is unavailable");
      }
      const firstAuthority = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
          resolveDispatchContinuation: continuationRuntime.resolveContinuation,
        },
        { operation: "resolve-dispatch-continuation", handle: subject.managed.handle },
      )) as unknown as {
        readonly status: "dispatch-continuation-resolved";
        readonly continuationReference: string;
        readonly liveTip: string;
      };
      expect(firstAuthority).toMatchObject({
        status: "dispatch-continuation-resolved",
        liveTip: successorReceipt.newHead,
      });
      const firstContinuationSpec = {
        ...sealedWorkerInput,
        baseCommit: protectedHead,
        round: 3,
        startingCommit: successorReceipt.newHead,
        priorResultCommit: successorReceipt.newHead,
      };
      const firstContinuationEnvelope = {
        idempotencyKey: `T2081-${String(sequence)}-automatic-continuation-one`,
        timeoutMs: 600_000,
        expectedChild: {
          childId: `implement-worker#automatic-continuation-one-${String(sequence)}`,
          runId: `automatic-continuation-one-run-${String(sequence)}`,
        },
        continuation: firstAuthority.continuationReference,
      };
      const firstContinuationRequest =
        mode === "refs-only-continuation"
          ? {
              ...firstContinuationEnvelope,
              refs: {
                roleId: "implement-worker" as const,
                surface: "codex" as const,
                projectKey: subject.backend.namespace.projectKey,
                taskId: "T2081",
                coordinates: {
                  worktreePath: subject.managed.handle.absolutePath,
                  branch: subject.managed.handle.branch,
                  baseCommit: protectedHead,
                },
                round: 3,
                startingCommit: successorReceipt.newHead,
                validationIntent: "final" as const,
                priorResultCommit: successorReceipt.newHead,
              },
            }
          : {
              ...firstContinuationEnvelope,
              roleId: "implement-worker" as const,
              input: firstContinuationSpec,
            };
      if (mode === "refs-only-continuation") {
        const rowsBeforeContinuationDiagnostics = await activeBackend.transact(
          { kind: "namespace" },
          (store) => store.rows().length,
        );
        const changedSpecificationRefusal = await continuationRuntime.prepare({
          roleId: "implement-worker",
          input: {
            ...firstContinuationSpec,
            headline: "changed task specification",
          },
          idempotencyKey: `${firstContinuationEnvelope.idempotencyKey}-changed-specification`,
          timeoutMs: firstContinuationEnvelope.timeoutMs,
          expectedChild: firstContinuationEnvelope.expectedChild,
          continuation: firstContinuationEnvelope.continuation,
        });
        expect(changedSpecificationRefusal).toMatchObject({
          accepted: false,
          reason: "journal-recovery-required",
          detail:
            "the managed task lineage is sealed for journal recovery; stage=continuation-specification; reason=task-specification-mismatch",
          allocated: false,
        });
        const unresolvedReferenceRefusal = await continuationRuntime.prepare({
          ...firstContinuationRequest,
          idempotencyKey: `${firstContinuationEnvelope.idempotencyKey}-unresolved-reference`,
          continuation: `cq-dispatch-continuation:v1:${"f".repeat(64)}`,
        });
        expect(unresolvedReferenceRefusal).toMatchObject({
          accepted: false,
          reason: "journal-recovery-required",
          detail:
            "the managed task lineage is sealed for journal recovery; stage=continuation-reference; reason=unresolved",
          allocated: false,
        });
        expect(
          await activeBackend.transact({ kind: "namespace" }, (store) => store.rows().length),
        ).toBe(rowsBeforeContinuationDiagnostics);
        const encodedContinuationRefusals = JSON.stringify([
          changedSpecificationRefusal,
          unresolvedReferenceRefusal,
        ]);
        for (const secret of [
          firstAuthority.continuationReference,
          subject.managed.handle.token,
          subject.managed.handle.absolutePath,
          protectedHead,
        ]) {
          expect(encodedContinuationRefusals).not.toContain(secret);
        }
      }
      const firstContinuation = await continuationRuntime.prepare(firstContinuationRequest);
      if (!firstContinuation.accepted) {
        throw new Error(
          `automatic ${mode} refused: ${firstContinuation.reason}: ${firstContinuation.detail}`,
        );
      }
      expect(await continuationRuntime.prepare(firstContinuationRequest)).toEqual(
        firstContinuation,
      );
      const firstContinuationInput = await continuationRuntime.fetchInput({
        ...firstContinuation.handle,
        inputCapability: firstContinuation.prepared.inputCapability,
      });
      const firstContinuationRecord = firstContinuationInput.input as Readonly<
        Record<string, DispatchJSONValue>
      >;
      const firstContinuationLineage = firstContinuationRecord["guardedRebaseLineage"];
      if (
        firstContinuationLineage === null ||
        typeof firstContinuationLineage !== "object" ||
        Array.isArray(firstContinuationLineage)
      ) {
        throw new Error("first automatic continuation omitted its guarded lineage");
      }
      const firstContinuationLineageRecord = firstContinuationLineage as Readonly<
        Record<string, DispatchJSONValue>
      >;
      if (
        continuationRuntime.gitCommit === undefined ||
        firstContinuation.prepared.gitChangeCapability === undefined
      ) {
        throw new Error("first automatic continuation omitted Git authority");
      }
      const firstContinuationBody = "first authenticated continuation\n";
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "automatic-continuation-one.txt"),
        firstContinuationBody,
      );
      const firstContinuationReceipt = taskReceipt(await continuationRuntime.gitCommit({
        ...firstContinuation.handle,
        gitChangeCapability: firstContinuation.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-automatic-continuation-one-change`,
        expectedHead: successorReceipt.newHead,
        message: "complete first authenticated continuation",
        changes: [
          {
            kind: "add",
            path: "automatic-continuation-one.txt",
            newState: { mode: "100644", digest: sha256(firstContinuationBody) },
          },
        ],
      }));
      expect(
        await continuationRuntime.storeResult({
          resultCapability: firstContinuation.prepared.resultCapability,
          output: {
            taskId: "T2081",
            status: "pass",
            resultCommit: firstContinuationReceipt.newHead,
            branch: subject.managed.handle.branch,
            actualWorktreePath: subject.managed.handle.absolutePath,
            filesTouched: ["automatic-continuation-one.txt", "automatic-successor.txt", "file.txt"],
            gitReceipts: [firstContinuationReceipt],
            gitLineage: {
              kind: "guarded-rebase",
              guardedRebase: firstContinuationLineageRecord["guardedRebase"],
              ontoCommit: firstContinuationLineageRecord["ontoCommit"],
              rebasedStartCommit: firstContinuationLineageRecord["rebasedStartCommit"],
              exactTip: firstContinuationLineageRecord["exactTip"],
            },
            checkSummary: "first authenticated continuation requests its ordinary gate",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: protectedHead,
              headCommit: firstContinuationReceipt.newHead,
            },
            summary: "completed the first authenticated continuation",
          } as unknown as DispatchJSONValue,
        }),
      ).toMatchObject({ state: "gate-pending" });
      const firstContinuationQualification =
        await continuationRuntime.qualifyImplementationCandidate({
          ...firstContinuation.handle,
          roleId: "implement-worker",
          correlationId: firstContinuationEnvelope.expectedChild.childId.slice(
            "implement-worker#".length,
          ),
          childThreadId: `automatic-continuation-one-thread-${String(sequence)}`,
          expectedRunId: firstContinuationEnvelope.expectedChild.runId,
          outcome: "completed",
          exitStatus: 0,
          observedAt: "2026-08-12T20:00:04.000Z",
          promptDigest: firstContinuation.prepared.promptProvenance.promptDigest,
        });
      if (firstContinuationQualification.state !== "queued") {
        throw new Error("first automatic continuation did not qualify");
      }
      const firstContinuationCoordination = continuationRuntime.coordinateImplementationCandidate({
        partitionKey: firstContinuationQualification.partitionKey,
        holderId: `automatic-continuation-one-coordinator-${attestationBackend}`,
      });
      if (mode === "gate-rejected-correction") {
        await expect(firstContinuationCoordination).rejects.toThrow();
        expect(runner.requests).toHaveLength(2);
        expect(
          await activeBackend.transact(
            { kind: "handle", handle: firstContinuation.handle },
            (store) => store.read(firstContinuation.handle),
          ),
        ).toMatchObject({
          state: "aborted",
          abortReason: "gate-rejected",
          implementationQueue: {
            state: "terminal",
            terminal: { reason: "gate-rejected" },
          },
        });
        const correctionInput = {
          ...firstContinuationSpec,
          round: 4,
          startingCommit: firstContinuationReceipt.newHead,
          priorResultCommit: firstContinuationReceipt.newHead,
          validationIntent: "focused-only" as const,
        };
        const correctionRequest = {
          roleId: "implement-worker" as const,
          input: correctionInput,
          idempotencyKey: `T2081-${String(sequence)}-automatic-gate-correction`,
          timeoutMs: 600_000,
          expectedChild: {
            childId: `implement-worker#automatic-gate-correction-${String(sequence)}`,
            runId: `automatic-gate-correction-run-${String(sequence)}`,
          },
          reprepareOf: firstContinuation.handle,
        };
        const rowsBeforeCorrectionRefusals = await activeBackend.transact(
          { kind: "namespace" },
          (store) => store.rows().length,
        );
        for (const changed of [
          {
            ...correctionRequest,
            idempotencyKey: `${correctionRequest.idempotencyKey}-changed-specification`,
            input: { ...correctionInput, headline: "changed task specification" },
          },
          {
            ...correctionRequest,
            idempotencyKey: `${correctionRequest.idempotencyKey}-foreign-source`,
            reprepareOf: successor.handle,
          },
          {
            ...correctionRequest,
            idempotencyKey: `${correctionRequest.idempotencyKey}-stale-tip`,
            input: {
              ...correctionInput,
              startingCommit: successorReceipt.newHead,
              priorResultCommit: successorReceipt.newHead,
            },
          },
        ]) {
          expect(await continuationRuntime.prepare(changed)).toMatchObject({
            accepted: false,
            reason: "journal-recovery-required",
          });
        }
        expect(
          await activeBackend.transact({ kind: "namespace" }, (store) => store.rows().length),
        ).toBe(rowsBeforeCorrectionRefusals);
        const correction = await continuationRuntime.prepare(correctionRequest);
        if (!correction.accepted || correction.prepared.gitChangeCapability === undefined) {
          throw new Error(
            `case C changed focused correction refused: ${
              correction.accepted ? "missing Git authority" : correction.detail
            }`,
          );
        }
        expect(await continuationRuntime.prepare(correctionRequest)).toEqual(correction);
        expect(
          await continuationRuntime.prepare({
            ...correctionRequest,
            input: { ...correctionInput, headline: "changed task specification" },
          }),
        ).toMatchObject({ accepted: false, reason: "journal-recovery-required" });
        await activeBackend.transact({ kind: "handle", handle: correction.handle }, (store) => {
          const row = store.read(correction.handle);
          if (
            row === undefined ||
            isAttestationTombstone(row) ||
            row.gateRejectedCorrectionClaim === undefined
          ) {
            throw new Error("current correction omitted its persisted rejection claim");
          }
          // The retained r3fp producer bound this claim in prepareRequestDigest but omitted the field.
          const { gateRejectedCorrectionClaim: _legacyOmission, ...legacyEncodedRow } = row;
          store.replace(row, legacyEncodedRow);
        });
        const correctionMaterialized = await continuationRuntime.fetchInput({
          ...correction.handle,
          inputCapability: correction.prepared.inputCapability,
        });
        const correctionRecord = correctionMaterialized.input as Readonly<
          Record<string, DispatchJSONValue>
        >;
        const correctionLineage = correctionRecord["guardedRebaseLineage"];
        if (
          correctionLineage === null ||
          typeof correctionLineage !== "object" ||
          Array.isArray(correctionLineage)
        ) {
          throw new Error("automatic gate correction omitted its guarded lineage");
        }
        const correctionLineageRecord = correctionLineage as Readonly<
          Record<string, DispatchJSONValue>
        >;
        if (continuationRuntime.gitCommit === undefined) {
          throw new Error("automatic gate correction omitted Git authority");
        }
        const correctionBody = "changed focused correction\n";
        await fs.writeFile(
          path.join(subject.managed.handle.absolutePath, "automatic-gate-correction.txt"),
          correctionBody,
        );
        const correctionReceipt = taskReceipt(await continuationRuntime.gitCommit({
          ...correction.handle,
          gitChangeCapability: correction.prepared.gitChangeCapability,
          operationId: `T2081-${String(sequence)}-automatic-gate-correction-change`,
          expectedHead: firstContinuationReceipt.newHead,
          message: "correct automatic rejected continuation",
          changes: [
            {
              kind: "add",
              path: "automatic-gate-correction.txt",
              newState: { mode: "100644", digest: sha256(correctionBody) },
            },
          ],
        }));
        const correctionFiles = (
          await git(subject.managed.handle.absolutePath, [
            "diff",
            "--name-only",
            protectedHead,
            correctionReceipt.newHead,
            "--",
          ])
        )
          .split("\n")
          .filter((entry) => entry !== "")
          .sort();
        expect(
          await continuationRuntime.storeResult({
            resultCapability: correction.prepared.resultCapability,
            output: {
              taskId: "T2081",
              status: "pass",
              resultCommit: correctionReceipt.newHead,
              branch: subject.managed.handle.branch,
              actualWorktreePath: subject.managed.handle.absolutePath,
              filesTouched: correctionFiles,
              gitReceipts: [correctionReceipt],
              gitLineage: {
                kind: "guarded-rebase",
                guardedRebase: correctionLineageRecord["guardedRebase"],
                ontoCommit: correctionLineageRecord["ontoCommit"],
                rebasedStartCommit: correctionLineageRecord["rebasedStartCommit"],
                exactTip: correctionLineageRecord["exactTip"],
              },
              checkSummary: "changed focused correction checks passed",
              focusedChecks: [
                {
                  command: "bun test automatic-gate-correction.test.ts",
                  exitCode: 0,
                  passCount: 1,
                  failCount: 0,
                },
              ],
              baseVerification: {
                status: "verified",
                relation: "descendant",
                baseCommit: protectedHead,
                headCommit: correctionReceipt.newHead,
              },
              summary: "changed correction retains the rejected automatic continuation",
            } as unknown as DispatchJSONValue,
          }),
        ).toMatchObject({ state: "gate-pending" });
        const correctionQualified = await continuationRuntime.qualifyImplementationCandidate({
          ...correction.handle,
          roleId: "implement-worker",
          correlationId: correctionRequest.expectedChild.childId.slice("implement-worker#".length),
          childThreadId: `automatic-gate-correction-thread-${String(sequence)}`,
          expectedRunId: correctionRequest.expectedChild.runId,
          outcome: "completed",
          exitStatus: 0,
          observedAt: "2026-08-12T20:00:08.000Z",
          promptDigest: correction.prepared.promptProvenance.promptDigest,
        });
        if (correctionQualified.state !== "queued") {
          throw new Error("changed focused correction did not qualify");
        }
        expect(
          await continuationRuntime.coordinateImplementationCandidate({
            partitionKey: correctionQualified.partitionKey,
            holderId: `automatic-gate-correction-coordinator-${attestationBackend}`,
          }),
        ).toEqual({ state: "completed", handle: correction.handle });
        expect(runner.requests).toHaveLength(2);
        await reopenBackend();
        const correctionContinuationRuntime = createDispatchCapability({
          ...subject.capabilityOptions,
          backend: activeBackend,
          now: () => "2026-08-12T20:00:00.000Z",
          randomBytes: sequentialDispatchRandomBytes(sequence * 32 + 224),
        });
        if (correctionContinuationRuntime.resolveContinuation === undefined) {
          throw new Error("reopened correction continuation runtime is unavailable");
        }
        const correctionAuthority = (await WORKTREE_MANAGE_TOOL_SPEC.run(
          subject.ledgerStore,
          {
            repositoryRoot: subject.repositoryRoot,
            deps: { stateDir: subject.stateDir },
            resolveDispatchContinuation: correctionContinuationRuntime.resolveContinuation,
          },
          { operation: "resolve-dispatch-continuation", handle: subject.managed.handle },
        )) as unknown as {
          readonly status: "dispatch-continuation-resolved";
          readonly continuationReference: string;
          readonly liveTip: string;
        };
        expect(correctionAuthority).toMatchObject({
          status: "dispatch-continuation-resolved",
          liveTip: correctionReceipt.newHead,
        });
        const resumedCorrection = await correctionContinuationRuntime.prepare({
          roleId: "implement-worker",
          input: {
            ...firstContinuationSpec,
            round: 5,
            startingCommit: correctionReceipt.newHead,
            priorResultCommit: correctionReceipt.newHead,
          },
          idempotencyKey: `T2081-${String(sequence)}-automatic-gate-correction-continuation`,
          timeoutMs: firstContinuationEnvelope.timeoutMs,
          expectedChild: {
            childId: `implement-worker#automatic-gate-correction-continuation-${String(sequence)}`,
            runId: `automatic-gate-correction-continuation-run-${String(sequence)}`,
          },
          continuation: correctionAuthority.continuationReference,
        });
        if (!resumedCorrection.accepted) {
          throw new Error(
            `case C ordinary continuation refused: ${resumedCorrection.reason}: ${resumedCorrection.detail}`,
          );
        }
        await activeBackend.close();
        continue;
      }
      expect(await firstContinuationCoordination).toEqual({
        state: "completed",
        handle: firstContinuation.handle,
      });

      const secondAuthority = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
          resolveDispatchContinuation: continuationRuntime.resolveContinuation,
        },
        { operation: "resolve-dispatch-continuation", handle: subject.managed.handle },
      )) as unknown as {
        readonly status: "dispatch-continuation-resolved";
        readonly continuationReference: string;
        readonly liveTip: string;
      };
      expect(secondAuthority).toMatchObject({
        status: "dispatch-continuation-resolved",
        liveTip: firstContinuationReceipt.newHead,
      });
      const secondContinuationRequest = {
        roleId: "implement-worker" as const,
        input: {
          ...firstContinuationSpec,
          round: 4,
          startingCommit: firstContinuationReceipt.newHead,
          priorResultCommit: firstContinuationReceipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-automatic-continuation-two`,
        timeoutMs: firstContinuationEnvelope.timeoutMs,
        expectedChild: {
          childId: `implement-worker#automatic-continuation-two-${String(sequence)}`,
          runId: `automatic-continuation-two-run-${String(sequence)}`,
        },
        continuation: secondAuthority.continuationReference,
      };
      const secondContinuation = await continuationRuntime.prepare(secondContinuationRequest);
      if (!secondContinuation.accepted) {
        throw new Error(
          `automatic continuation two refused: ${secondContinuation.reason}: ${secondContinuation.detail}`,
        );
      }
      expect(secondContinuation.handle).toEqual({
        attestationId: successor.handle.attestationId,
        generation: successor.handle.generation + 2,
      });
      const rowsAfterSecondContinuation = await activeBackend.transact(
        { kind: "namespace" },
        (store) => store.rows().length,
      );
      const { continuation: _continuation, ...unrelatedHigherGenerationRequest } =
        secondContinuationRequest;
      expect(
        await continuationRuntime.prepare({
          ...unrelatedHigherGenerationRequest,
          idempotencyKey: `${secondContinuationRequest.idempotencyKey}-unrelated-high-generation`,
          reprepareOf: {
            attestationId: successor.handle.attestationId,
            generation: successor.handle.generation + 100,
          },
        }),
      ).toMatchObject({ accepted: false });
      expect(
        await activeBackend.transact({ kind: "namespace" }, (store) => store.rows().length),
      ).toBe(rowsAfterSecondContinuation);
      expect(runner.requests).toHaveLength(2);
      await activeBackend.close();
    }
  }

  // regression: tasks:T6573 — case A preserves the canonical refs-only lineage.
  test("case A: an automatic staged-rebase successor retains repeated authenticated continuations", async () => {
    await exerciseAutomaticStagedRebaseLineage("refs-only-continuation");
  }, 90_000);

  // regression: tasks:T6573 — case C corrects the rejected continuation, not the fence anchor.
  test("case C: an automatic staged-rebase continuation admits one changed focused correction", async () => {
    await exerciseAutomaticStagedRebaseLineage("gate-rejected-correction");
  }, 90_000);

  // regression: tasks:T6573 — case B binds a resolver to one pending manual journal.
  test("case B: a cancelled sealed source admits its exact pending manual conflict resolver", async () => {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
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
      expect(
        await subject.capability.abort({
          ...subject.prepared,
          reason: "parent-lost",
        }),
      ).toMatchObject({ state: "aborted", reason: "parent-lost" });
      if (subject.capability.resolveRecovery === undefined || subject.ledgerStore === undefined) {
        throw new Error("pending manual conflict recovery fixture is unavailable");
      }
      const currentRecovery = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
          resolveDispatchRecovery: subject.capability.resolveRecovery,
        },
        { operation: "resolve-dispatch-recovery", handle: subject.managed.handle },
      )) as unknown as DispatchRecoveryResolution;
      if (currentRecovery.preparation.kind !== "current") {
        throw new Error("manual conflict source did not produce a current recovery seal");
      }
      const cancelledInput = {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        round: 1,
        startingCommit: subject.receipt.newHead,
        validationIntent: "final" as const,
        priorResultCommit: subject.receipt.newHead,
      };
      const cancelled = await subject.capability.prepare({
        roleId: "implement-worker",
        input: cancelledInput,
        idempotencyKey: `T2081-${String(sequence)}-pending-manual-conflict-source`,
        timeoutMs: 600_000,
        expectedChild: {
          childId: `implement-worker#pending-manual-conflict-${String(sequence)}`,
          runId: `pending-manual-conflict-run-${String(sequence)}`,
        },
        recoveryPreparation: currentRecovery.preparation.recoveryPreparation,
      });
      if (!cancelled.accepted || cancelled.prepared.gitChangeCapability === undefined) {
        throw new Error(
          `sealed source refused: ${cancelled.accepted ? "missing Git authority" : cancelled.detail}`,
        );
      }
      await subject.capability.fetchInput({
        ...cancelled.handle,
        inputCapability: cancelled.prepared.inputCapability,
      });
      if (subject.capability.gitCommit === undefined) {
        throw new Error("pending manual conflict source omitted Git authority");
      }
      const cancelledBody = "cancelled recovered worker\n";
      await fs.writeFile(path.join(subject.managed.handle.absolutePath, "file.txt"), cancelledBody);
      const cancelledReceipt = taskReceipt(await subject.capability.gitCommit({
        ...cancelled.handle,
        gitChangeCapability: cancelled.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-pending-manual-conflict-source-change`,
        expectedHead: subject.receipt.newHead,
        message: "persist cancelled recovered worker change",
        changes: [
          {
            kind: "modify",
            path: "file.txt",
            oldState: { mode: "100644", digest: sha256("after\n") },
            newState: { mode: "100644", digest: sha256(cancelledBody) },
          },
        ],
      }));
      expect(
        await subject.capability.abort({ ...cancelled.handle, reason: "cancelled" }),
      ).toMatchObject({ state: "aborted", reason: "cancelled" });

      await fs.writeFile(path.join(subject.repositoryRoot, "file.txt"), "protected\n");
      await git(subject.repositoryRoot, ["add", "file.txt"]);
      await git(subject.repositoryRoot, ["commit", "-q", "-m", "conflict protected head"]);
      const protectedHead = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);
      const binding = await resolveManagedWorktreeDispatchBinding(
        {
          repositoryRoot: subject.repositoryRoot,
          taskId: subject.managed.handle.taskId,
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
        },
        { stateDir: subject.stateDir },
      );
      if (binding === null) throw new Error("pending manual conflict binding disappeared");
      const rebase = await runGuardedRebase({
        binding,
        operationId: `t6573-pending-manual-conflict-${attestationBackend}`,
        ontoCommit: protectedHead,
        stateDir: subject.stateDir,
        runEffect: async () => {
          const child = Bun.spawn(["git", "rebase", protectedHead], {
            cwd: binding.worktreePath,
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
            stdout: "pipe",
            stderr: "pipe",
          });
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { code, stdout, stderr };
        },
      });
      if (rebase.kind !== "conflict-pending") {
        throw new Error("manual guarded rebase unexpectedly reached a terminal tip");
      }
      expect(await subject.capability.fetch(cancelled.handle)).toMatchObject({
        state: "aborted",
        reason: "cancelled",
      });
      expect(
        await subject.backend.transact({ kind: "namespace" }, (store) =>
          store
            .rows()
            .filter(
              (row) =>
                !isAttestationTombstone(row) &&
                (row.implementationQueue?.state === "staged-rebase-retired" ||
                  row.stagedRebaseSourceBinding !== undefined),
            ),
        ),
      ).toEqual([]);
      expect(runner.requests).toHaveLength(0);

      let activeBackend = subject.backend;
      if (attestationBackend === "sqlite") {
        await activeBackend.close();
        activeBackend = new SqliteAttestationBackend({
          namespace: subject.backend.namespace,
          dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
        });
      }
      const restarted = createDispatchCapability({
        backend: activeBackend,
        promptArtifactStore: artifactStore(),
        ledgerStore: subject.ledgerStore,
        implementationEvidenceStore: subject.implementationEvidenceStore,
        repositoryRoot: subject.repositoryRoot,
        worktreeStateDir: subject.stateDir,
        supervisedWorkerGateRunner: runner,
        now: () => "2026-08-12T20:00:00.000Z",
        randomBytes: sequentialDispatchRandomBytes(sequence * 32 + 128),
      });
      const observed = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
        },
        { operation: "observe-conflict", handle: subject.managed.handle },
      )) as unknown as {
        readonly status: "conflict-observed";
        readonly conflictState: GitRebaseConflictState;
      };
      expect(observed).toMatchObject({
        status: "conflict-observed",
        conflictState: {
          sequencer: {
            onto: protectedHead,
            originalTip: cancelledReceipt.newHead,
          },
        },
      });
      const conflictingFiles = [
        ...new Set(observed.conflictState.conflicts.map((entry) => entry.path)),
      ].sort();
      const resolverInput = {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "resolve the exact pending manual guarded conflict",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        validationIntent: "focused-only" as const,
        conflictingFiles,
        conflictState: observed.conflictState,
      };
      const resolverRequest = {
        roleId: "implement-conflict-resolver" as const,
        input: JSON.parse(JSON.stringify(resolverInput)) as DispatchJSONValue,
        idempotencyKey: `T2081-${String(sequence)}-pending-manual-conflict-resolver`,
        timeoutMs: 600_000,
        expectedChild: {
          childId: `implement-conflict-resolver#pending-manual-${String(sequence)}`,
          runId: `pending-manual-resolver-run-${String(sequence)}`,
        },
      };
      const rowsBeforePendingConflictDiagnostics = await activeBackend.transact(
        { kind: "namespace" },
        (store) => store.rows().length,
      );
      const changedSnapshotRefusal = await restarted.prepare({
        ...resolverRequest,
        idempotencyKey: `${resolverRequest.idempotencyKey}-diagnostic-changed-conflict`,
        input: JSON.parse(
          JSON.stringify({
            ...resolverInput,
            conflictState: { ...observed.conflictState, currentHead: "f".repeat(40) },
          }),
        ) as DispatchJSONValue,
      });
      expect(changedSnapshotRefusal).toMatchObject({
        accepted: false,
        reason: "journal-recovery-required",
        detail:
          "the managed task lineage is sealed for journal recovery; stage=pending-conflict-journal; reason=caught-exception",
        allocated: false,
      });
      const substitutedAuthorityRefusal = await restarted.prepare({
        ...resolverRequest,
        idempotencyKey: `${resolverRequest.idempotencyKey}-diagnostic-substituted-authority`,
        reprepareOf: cancelled.handle,
      });
      expect(substitutedAuthorityRefusal).toMatchObject({
        accepted: false,
        reason: "journal-recovery-required",
        detail:
          "the managed task lineage is sealed for journal recovery; stage=pending-conflict-request; reason=authority-combination-invalid",
        allocated: false,
      });
      expect(
        await activeBackend.transact({ kind: "namespace" }, (store) => store.rows().length),
      ).toBe(rowsBeforePendingConflictDiagnostics);
      const encodedPendingConflictRefusals = JSON.stringify([
        changedSnapshotRefusal,
        substitutedAuthorityRefusal,
      ]);
      for (const secret of [
        subject.managed.handle.token,
        subject.managed.handle.absolutePath,
        protectedHead,
        cancelledReceipt.newHead,
      ]) {
        expect(encodedPendingConflictRefusals).not.toContain(secret);
      }
      const resolver = await restarted.prepare(resolverRequest);
      if (!resolver.accepted || resolver.prepared.gitConflictCapability === undefined) {
        throw new Error(
          `pending manual conflict resolver refused: ${
            resolver.accepted ? "missing Git authority" : `${resolver.reason}: ${resolver.detail}`
          }`,
        );
      }
      expect(await restarted.prepare(resolverRequest)).toEqual(resolver);
      const rowsAfterResolver = await activeBackend.transact(
        { kind: "namespace" },
        (store) => store.rows().length,
      );
      for (const changed of [
        {
          ...resolverRequest,
          idempotencyKey: `${resolverRequest.idempotencyKey}-foreign-task`,
          input: JSON.parse(
            JSON.stringify({ ...resolverInput, taskId: "T9999" }),
          ) as DispatchJSONValue,
        },
        {
          ...resolverRequest,
          idempotencyKey: `${resolverRequest.idempotencyKey}-changed-conflict`,
          input: JSON.parse(
            JSON.stringify({
              ...resolverInput,
              conflictState: { ...observed.conflictState, currentHead: "f".repeat(40) },
            }),
          ) as DispatchJSONValue,
        },
        {
          ...resolverRequest,
          idempotencyKey: `${resolverRequest.idempotencyKey}-substituted-authority`,
          reprepareOf: cancelled.handle,
        },
      ]) {
        expect(await restarted.prepare(changed)).toMatchObject({ accepted: false });
      }
      expect(
        await activeBackend.transact({ kind: "namespace" }, (store) => store.rows().length),
      ).toBe(rowsAfterResolver);
      expect(runner.requests).toHaveLength(0);
      await activeBackend.close();
    }
  }, 90_000);

  // regression: tasks:T6573 — continuation must retain its sealed manual-rebase ancestry.
  test("a cancelled sealed successor composes one authenticated manual guarded rebase into continuation", async () => {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
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
      expect(
        await subject.capability.abort({
          ...subject.prepared,
          reason: "parent-lost",
        }),
      ).toMatchObject({ state: "aborted", reason: "parent-lost" });
      if (subject.capability.resolveRecovery === undefined || subject.ledgerStore === undefined) {
        throw new Error("manual guarded-rebase recovery fixture is unavailable");
      }
      const currentRecovery = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
          resolveDispatchRecovery: subject.capability.resolveRecovery,
        },
        { operation: "resolve-dispatch-recovery", handle: subject.managed.handle },
      )) as unknown as DispatchRecoveryResolution;
      if (currentRecovery.preparation.kind !== "current") {
        throw new Error("source did not produce a current recovery seal");
      }
      const cancelledInput = {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: subject.dispatchBaseCommit,
        round: 1,
        startingCommit: subject.receipt.newHead,
        validationIntent: "final" as const,
        priorResultCommit: subject.receipt.newHead,
      };
      const cancelled = await subject.capability.prepare({
        roleId: "implement-worker",
        input: cancelledInput,
        idempotencyKey: `T2081-${String(sequence)}-cancelled-sealed-successor`,
        timeoutMs: 600_000,
        expectedChild: {
          childId: `implement-worker#cancelled-sealed-${String(sequence)}`,
          runId: `cancelled-sealed-run-${String(sequence)}`,
        },
        recoveryPreparation: currentRecovery.preparation.recoveryPreparation,
      });
      if (!cancelled.accepted || cancelled.prepared.gitChangeCapability === undefined) {
        throw new Error(
          `sealed successor refused: ${cancelled.accepted ? "missing Git authority" : cancelled.detail}`,
        );
      }
      await subject.capability.fetchInput({
        ...cancelled.handle,
        inputCapability: cancelled.prepared.inputCapability,
      });
      const sourcePath = "manual-guarded-source.txt";
      const sourceBytes = "manual guarded source\n";
      await fs.writeFile(path.join(subject.managed.handle.absolutePath, sourcePath), sourceBytes);
      if (subject.capability.gitCommit === undefined) throw new Error("git_commit unavailable");
      const cancelledReceipt = taskReceipt(await subject.capability.gitCommit({
        ...cancelled.handle,
        gitChangeCapability: cancelled.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-manual-guarded-source`,
        expectedHead: subject.receipt.newHead,
        message: "persist manual guarded source",
        changes: [
          {
            kind: "add",
            path: sourcePath,
            newState: { mode: "100644", digest: sha256(sourceBytes) },
          },
        ],
      }));
      expect(
        await subject.capability.abort({ ...cancelled.handle, reason: "cancelled" }),
      ).toMatchObject({ state: "aborted", reason: "cancelled" });

      await fs.writeFile(path.join(subject.repositoryRoot, "protected.txt"), "protected\n");
      await git(subject.repositoryRoot, ["add", "protected.txt"]);
      await git(subject.repositoryRoot, ["commit", "-q", "-m", "advance protected head"]);
      const protectedHead = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);
      const binding = await resolveManagedWorktreeDispatchBinding(
        {
          repositoryRoot: subject.repositoryRoot,
          taskId: subject.managed.handle.taskId,
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
        },
        { stateDir: subject.stateDir },
      );
      if (binding === null) throw new Error("manual guarded-rebase binding disappeared");
      const rebase = await runGuardedRebase({
        binding,
        operationId: `t6573-manual-guarded-rebase-${attestationBackend}`,
        ontoCommit: protectedHead,
        stateDir: subject.stateDir,
        runEffect: async () => {
          const child = Bun.spawn(["git", "rebase", protectedHead], {
            cwd: binding.worktreePath,
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
            stdout: "pipe",
            stderr: "pipe",
          });
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { code, stdout, stderr };
        },
      });
      if (rebase.kind !== "finalized") throw new Error("manual guarded rebase did not finalize");
      expect(rebase.bridge.exactTip).toBe(true);
      expect(
        await subject.backend.transact({ kind: "namespace" }, (store) =>
          store
            .rows()
            .filter(
              (row) =>
                !isAttestationTombstone(row) &&
                (row.implementationQueue?.state === "staged-rebase-retired" ||
                  row.stagedRebaseSourceBinding !== undefined),
            ),
        ),
      ).toEqual([]);

      const guardedChild = {
        childId: `implement-worker#manual-guarded-${String(sequence)}`,
        runId: `manual-guarded-run-${String(sequence)}`,
      };
      const guarded = await subject.capability.prepare({
        roleId: "implement-worker",
        input: {
          ...cancelledInput,
          baseCommit: protectedHead,
          round: 2,
          startingCommit: rebase.bridge.rebasedStartCommit,
          priorResultCommit: cancelledReceipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-manual-guarded-successor`,
        timeoutMs: 600_000,
        expectedChild: guardedChild,
        reprepareOf: cancelled.handle,
        guardedRebase: rebase.reference,
      });
      if (!guarded.accepted) throw new Error(`manual guarded successor refused: ${guarded.detail}`);
      const guardedInput = await subject.capability.fetchInput({
        ...guarded.handle,
        inputCapability: guarded.prepared.inputCapability,
      });
      const guardedInputRecord = guardedInput.input as Readonly<Record<string, DispatchJSONValue>>;
      const guardedLineage = guardedInputRecord["guardedRebaseLineage"];
      if (
        guardedLineage === null ||
        typeof guardedLineage !== "object" ||
        Array.isArray(guardedLineage)
      ) {
        throw new Error("manual guarded successor omitted its authenticated lineage");
      }
      const guardedLineageRecord = guardedLineage as Readonly<Record<string, DispatchJSONValue>>;
      const changedPaths = (
        await git(subject.managed.handle.absolutePath, [
          "diff",
          "--name-only",
          protectedHead,
          rebase.bridge.rebasedStartCommit,
          "--",
        ])
      )
        .split("\n")
        .filter((entry) => entry !== "")
        .sort();
      expect(
        await subject.capability.storeResult({
          resultCapability: guarded.prepared.resultCapability,
          output: {
            taskId: "T2081",
            status: "pass",
            resultCommit: rebase.bridge.rebasedStartCommit,
            branch: subject.managed.handle.branch,
            actualWorktreePath: subject.managed.handle.absolutePath,
            filesTouched: changedPaths,
            gitReceipts: [],
            gitLineage: {
              kind: "guarded-rebase",
              guardedRebase: guardedLineageRecord["guardedRebase"],
              ontoCommit: guardedLineageRecord["ontoCommit"],
              rebasedStartCommit: guardedLineageRecord["rebasedStartCommit"],
              exactTip: guardedLineageRecord["exactTip"],
            },
            checkSummary: "manual guarded successor requests one ordinary gate",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: protectedHead,
              headCommit: rebase.bridge.rebasedStartCommit,
            },
            mutationTable: [
              {
                mutation: "omit the predecessor's durable receipt closure",
                observed: "the recovery fence rejects the manual guarded continuation",
                restored: "the exact receipt closure admits the continuation",
              },
            ],
            summary: "completed the authenticated manual guarded successor",
          } as unknown as DispatchJSONValue,
        }),
      ).toMatchObject({ state: "gate-pending" });
      if (
        subject.capability.qualifyImplementationCandidate === undefined ||
        subject.capability.coordinateImplementationCandidate === undefined
      ) {
        throw new Error("manual guarded successor coordinator is unavailable");
      }
      const qualified = await subject.capability.qualifyImplementationCandidate({
        ...guarded.handle,
        roleId: "implement-worker",
        correlationId: guardedChild.childId.slice("implement-worker#".length),
        childThreadId: `manual-guarded-thread-${String(sequence)}`,
        expectedRunId: guardedChild.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt: "2026-08-12T20:00:02.000Z",
        promptDigest: guarded.prepared.promptProvenance.promptDigest,
      });
      if (qualified.state !== "queued") throw new Error("manual guarded successor did not qualify");
      expect(
        await subject.capability.coordinateImplementationCandidate({
          partitionKey: qualified.partitionKey,
          holderId: `manual-guarded-coordinator-${attestationBackend}`,
        }),
      ).toMatchObject({ state: "completed", handle: guarded.handle });
      expect(runner.requests).toHaveLength(1);
      expect(await subject.capability.fetch(cancelled.handle)).toMatchObject({
        state: "aborted",
        reason: "cancelled",
      });

      let activeBackend = subject.backend;
      if (attestationBackend === "sqlite") {
        await activeBackend.close();
        activeBackend = new SqliteAttestationBackend({
          namespace: subject.backend.namespace,
          dbPath: path.join(subject.repositoryRoot, "attestations.sqlite"),
        });
      }
      const restarted = createDispatchCapability({
        backend: activeBackend,
        promptArtifactStore: artifactStore(),
        ledgerStore: subject.ledgerStore,
        implementationEvidenceStore: subject.implementationEvidenceStore,
        repositoryRoot: subject.repositoryRoot,
        worktreeStateDir: subject.stateDir,
        supervisedWorkerGateRunner: runner,
        now: () => "2026-08-12T20:00:00.000Z",
        randomBytes: sequentialDispatchRandomBytes(sequence * 192),
      });
      if (restarted.resolveContinuation === undefined) {
        throw new Error("manual guarded continuation resolver is unavailable");
      }
      const continuation = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        subject.ledgerStore,
        {
          repositoryRoot: subject.repositoryRoot,
          deps: { stateDir: subject.stateDir },
          resolveDispatchContinuation: restarted.resolveContinuation,
        },
        { operation: "resolve-dispatch-continuation", handle: subject.managed.handle },
      )) as unknown as {
        readonly status: "dispatch-continuation-resolved";
        readonly continuationReference: string;
        readonly liveTip: string;
      };
      expect(continuation).toMatchObject({
        status: "dispatch-continuation-resolved",
        liveTip: rebase.bridge.rebasedStartCommit,
      });
      const continuedRequest = {
        roleId: "implement-worker" as const,
        input: {
          ...cancelledInput,
          baseCommit: protectedHead,
          round: 3,
          startingCommit: rebase.bridge.rebasedStartCommit,
          priorResultCommit: rebase.bridge.rebasedStartCommit,
        },
        idempotencyKey: `T2081-${String(sequence)}-post-manual-guarded-continuation`,
        timeoutMs: 600_000,
        expectedChild: {
          childId: `implement-worker#post-manual-guarded-${String(sequence)}`,
          runId: `post-manual-guarded-run-${String(sequence)}`,
        },
        continuation: continuation.continuationReference,
      };
      const continued = await restarted.prepare(continuedRequest);
      if (!continued.accepted) {
        throw new Error(
          `manual guarded continuation refused: ${continued.reason}: ${continued.detail}`,
        );
      }
      expect(await restarted.prepare(continuedRequest)).toEqual(continued);
      const rowCount = async (): Promise<number> =>
        await activeBackend.transact({ kind: "namespace" }, (store) => store.rows().length);
      const rowsAfterContinuation = await rowCount();
      for (const changed of [
        {
          ...continuedRequest,
          input: { ...continuedRequest.input, headline: "changed task specification" },
        },
        {
          ...continuedRequest,
          idempotencyKey: `${continuedRequest.idempotencyKey}-second-successor`,
        },
        {
          ...continuedRequest,
          idempotencyKey: `${continuedRequest.idempotencyKey}-foreign-authority`,
          continuation: `cq-dispatch-continuation:v1:${"f".repeat(64)}`,
        },
      ]) {
        expect(await restarted.prepare(changed)).toMatchObject({ accepted: false });
      }
      expect(await rowCount()).toBe(rowsAfterContinuation);
      expect(continued.handle).toEqual({
        attestationId: guarded.handle.attestationId,
        generation: guarded.handle.generation + 1,
      });
      expect(
        await activeBackend.transact({ kind: "namespace" }, (store) =>
          store
            .rows()
            .filter(
              (row) =>
                !isAttestationTombstone(row) &&
                (row.implementationQueue?.state === "staged-rebase-retired" ||
                  row.stagedRebaseSourceBinding !== undefined),
            ),
        ),
      ).toEqual([]);
      expect(runner.requests).toHaveLength(1);
      await activeBackend.close();
    }
  }, 90_000);

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
    const correctionReceipt = taskReceipt(await subject.capability.gitCommit({
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
    }));
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
  }, RECOVERY_BACKEND_CASE_TIMEOUT_MS);

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
    const correctionReceipt = taskReceipt(await subject.capability.gitCommit({
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
    }));
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
  }, RECOVERY_BACKEND_CASE_TIMEOUT_MS);

  async function exerciseRecoveredGuardedRedCorrection(
    attestationBackend: "memory" | "sqlite",
    freshGuardedReceipt: boolean,
  ): Promise<void> {
    const runner = new ParentLossThenRedThenGreenGateDummy();
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
    const capability = createDispatchCapability({
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
      throw new Error("recovered guarded correction runtime is unavailable");
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
    if (binding === null) throw new Error("recovered guarded correction binding disappeared");
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
        childThreadId: `recovered-guarded-red-${String(prepared.generation)}`,
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
    if (sourceQualified.state !== "queued") throw new Error("recovery source did not qualify");
    await expect(
      capability.coordinateImplementationCandidate({
        partitionKey: sourceQualified.partitionKey,
        holderId: `recovered-source-${attestationBackend}`,
      }),
    ).rejects.toThrow("controlled parent loss after qualification");

    const recovery = await capability.resolveRecovery(binding, subject.receipt.newHead);
    if (recovery.preparation.kind !== "current") {
      throw new Error("parent-lost source did not produce current recovery authority");
    }
    const anchorChild = {
      childId: `implement-worker#recovery-anchor-${attestationBackend}-${String(sequence)}`,
      runId: `recovery-anchor-${attestationBackend}-run-${String(sequence)}`,
    };
    const anchor = await capability.prepare({
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
      idempotencyKey: `T2081-${String(sequence)}-${attestationBackend}-recovery-anchor`,
      timeoutMs: 600_000,
      expectedChild: anchorChild,
      recoveryPreparation: recovery.preparation.recoveryPreparation,
    });
    if (!anchor.accepted) throw new Error(anchor.detail);
    await capability.fetchInput({
      ...anchor.handle,
      inputCapability: anchor.prepared.inputCapability,
    });
    expect(await capability.abort({ ...anchor.handle, reason: "cancelled" })).toMatchObject({
      state: "aborted",
      reason: "cancelled",
    });
    const promotedRecovery = await capability.resolveRecovery(binding, subject.receipt.newHead);
    if (promotedRecovery.preparation.kind !== "current") {
      throw new Error("cancelled anchor did not promote current recovery authority");
    }
    const recoveredChild = {
      childId: `implement-worker#recovered-source-${attestationBackend}-${String(sequence)}`,
      runId: `recovered-source-${attestationBackend}-run-${String(sequence)}`,
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
        startingCommit: subject.receipt.newHead,
        validationIntent: "final",
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-${attestationBackend}-recovered-source`,
      timeoutMs: 600_000,
      expectedChild: recoveredChild,
      recoveryPreparation: promotedRecovery.preparation.recoveryPreparation,
    });
    if (!recovered.accepted || recovered.prepared.gitChangeCapability === undefined) {
      throw new Error(
        recovered.accepted ? "recovered source lacks Git authority" : recovered.detail,
      );
    }
    await capability.fetchInput({
      ...recovered.handle,
      inputCapability: recovered.prepared.inputCapability,
    });
    const recoveredBytes = `current recovered source ${attestationBackend}\n`;
    await fs.writeFile(path.join(subject.managed.handle.absolutePath, "file.txt"), recoveredBytes);
    const recoveredReceipt = taskReceipt(await capability.gitCommit({
      ...recovered.handle,
      gitChangeCapability: recovered.prepared.gitChangeCapability,
      operationId: `T2081-${String(sequence)}-${attestationBackend}-recovered-source`,
      expectedHead: subject.receipt.newHead,
      message: "advance current recovered source",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("after\n") },
          newState: { mode: "100644", digest: sha256(recoveredBytes) },
        },
      ],
    }));
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
          checkSummary: "current-recovered candidate awaits protected-head comparison",
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
      "2026-08-12T20:00:05.000Z",
    );
    if (recoveredQualified.state !== "queued") {
      throw new Error("current-recovered source did not qualify");
    }

    await fs.writeFile(path.join(subject.repositoryRoot, "integration.txt"), "advanced\n");
    await git(subject.repositoryRoot, ["add", "integration.txt"]);
    await git(subject.repositoryRoot, ["commit", "-q", "-m", "advance protected head"]);
    await git(subject.repositoryRoot, ["config", "user.name", "T2081"]);
    await git(subject.repositoryRoot, ["config", "user.email", "t2081@example.invalid"]);
    const ontoCommit = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);
    expect(
      await capability.coordinateImplementationCandidate({
        partitionKey: recoveredQualified.partitionKey,
        holderId: `retire-recovered-source-${attestationBackend}`,
      }),
    ).toMatchObject({
      state: "successor-queued",
      source: recovered.handle,
      successor: {
        attestationId: recovered.handle.attestationId,
        generation: recovered.handle.generation + 1,
      },
    });
    const guarded = launchedSuccessor;
    if (guarded === undefined) throw new Error("recovered retirement did not launch a successor");
    const guardedInput = await capability.fetchInput({
      ...guarded.prepared,
      inputCapability: guarded.prepared.inputCapability,
    });
    if (guardedInput.state !== "input-materialized") {
      throw new Error("recovered guarded input did not materialize");
    }
    const guardedRecord = guardedInput.input as Readonly<Record<string, DispatchJSONValue>>;
    const guardedLineage = guardedRecord["guardedRebaseLineage"] as Readonly<
      Record<string, DispatchJSONValue>
    >;
    const guardedStart = guardedRecord["startingCommit"];
    const guardedBase = guardedRecord["baseCommit"];
    const guardedRebase = guardedLineage["guardedRebase"];
    const exactTip = guardedLineage["exactTip"];
    if (
      typeof guardedStart !== "string" ||
      typeof guardedBase !== "string" ||
      typeof guardedRebase !== "string" ||
      typeof exactTip !== "boolean"
    ) {
      throw new Error("recovered guarded lineage is incomplete");
    }
    expect(guardedBase).toBe(ontoCommit);
    let redTip = guardedStart;
    let redReceipts: readonly DispatchJSONValue[] = [];
    if (freshGuardedReceipt) {
      if (guarded.prepared.gitChangeCapability === undefined) {
        throw new Error("fresh guarded red worker lacks Git authority");
      }
      const bytes = `fresh recovered guarded red ${attestationBackend}\n`;
      await fs.writeFile(path.join(subject.managed.handle.absolutePath, "guarded-red.txt"), bytes);
      const receipt = taskReceipt(await capability.gitCommit({
        ...guarded.prepared,
        gitChangeCapability: guarded.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-${attestationBackend}-guarded-red`,
        expectedHead: guardedStart,
        message: "persist recovered guarded red candidate",
        changes: [
          {
            kind: "add",
            path: "guarded-red.txt",
            newState: { mode: "100644", digest: sha256(bytes) },
          },
        ],
      }));
      redTip = receipt.newHead;
      redReceipts = [
        {
          ...receipt,
          objectOids: [...receipt.objectOids],
          paths: [...receipt.paths],
        },
      ];
    } else {
      expect(exactTip).toBe(true);
    }
    const redFiles = (
      await git(subject.managed.handle.absolutePath, [
        "diff",
        "--name-only",
        `${guardedBase}..${redTip}`,
      ])
    )
      .split("\n")
      .filter((entry) => entry !== "")
      .sort();
    expect(
      await capability.storeResult({
        resultCapability: guarded.prepared.resultCapability,
        output: {
          taskId: "T2081",
          status: "pass",
          resultCommit: redTip,
          branch: subject.managed.handle.branch,
          actualWorktreePath: subject.managed.handle.absolutePath,
          filesTouched: redFiles,
          gitReceipts: redReceipts,
          gitLineage: {
            kind: "guarded-rebase",
            guardedRebase,
            ontoCommit,
            rebasedStartCommit: guardedStart,
            exactTip,
          },
          checkSummary: "recovered guarded candidate awaits its controlled red gate",
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit: guardedBase,
            headCommit: redTip,
          },
          mutationTable: [
            {
              mutation: "remove the recovered guarded ancestry edge",
              observed: "the changed correction is rejected before any new gate",
              restored: "the exact correction reaches its ordinary gate",
            },
          ],
          summary: "guarded successor retains the journal-recovered staged source",
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    const redQualified = await qualify(
      guarded.prepared,
      guarded.expectedChild,
      "2026-08-12T20:00:08.000Z",
    );
    if (redQualified.state !== "queued") throw new Error("recovered guarded row did not qualify");
    await expect(
      capability.coordinateImplementationCandidate({
        partitionKey: redQualified.partitionKey,
        holderId: `recovered-guarded-red-${attestationBackend}`,
      }),
    ).rejects.toThrow();
    expect(runner.requests).toHaveLength(2);

    const correctionChild = {
      childId: `implement-worker#recovered-guarded-correction-${attestationBackend}-${String(sequence)}`,
      runId: `recovered-guarded-correction-${attestationBackend}-run-${String(sequence)}`,
    };
    const correctionRequest = {
      roleId: "implement-worker" as const,
      input: {
        taskId: "T2081",
        headline: "supervise exact tip",
        description: "run the full gate outside the workspace-write sandbox",
        acceptance: "only a green exact tip becomes consumable",
        worktreePath: subject.managed.handle.absolutePath,
        branch: subject.managed.handle.branch,
        baseCommit: guardedBase,
        round: 3,
        startingCommit: redTip,
        validationIntent: "final" as const,
        priorResultCommit: redTip,
      },
      idempotencyKey: `T2081-${String(sequence)}-${attestationBackend}-${freshGuardedReceipt ? "fresh" : "zero"}-red-correction`,
      timeoutMs: 600_000,
      expectedChild: correctionChild,
      reprepareOf: guarded.prepared,
    };
    const retainedRecovered = await subject.backend.transact(
      { kind: "handle", handle: recovered.handle },
      (store) => store.read(recovered.handle),
    );
    const retainedRed = await subject.backend.transact(
      { kind: "handle", handle: guarded.prepared },
      (store) => store.read(guarded.prepared),
    );
    if (
      retainedRecovered === undefined ||
      isAttestationTombstone(retainedRecovered) ||
      retainedRecovered.stagedRebaseSourceBinding === undefined ||
      retainedRecovered.implementationQueue === undefined ||
      retainedRed === undefined ||
      isAttestationTombstone(retainedRed) ||
      retainedRed.gitEffectBinding?.guardedRebaseBridge === undefined
    ) {
      throw new Error("recovered guarded correction ancestry disappeared");
    }
    const rowsBeforeControls = await subject.backend.transact(
      { kind: "namespace" },
      (store) => store.rows().length,
    );
    const rejectPrepareMutation = async (
      handle: { readonly attestationId: string; readonly generation: number },
      retained: AttestationEnvelope,
      mutate: (row: AttestationEnvelope) => AttestationEnvelope,
    ) => {
      await subject.backend.transact({ kind: "handle", handle }, (store) => {
        const current = store.read(handle);
        if (current === undefined) throw new Error("recovered guarded evidence disappeared");
        store.replace(current, mutate(retained));
      });
      try {
        expect(await capability.prepare(correctionRequest)).toMatchObject({
          accepted: false,
          reason: "journal-recovery-required",
        });
        expect(
          await subject.backend.transact({ kind: "namespace" }, (store) => store.rows().length),
        ).toBe(rowsBeforeControls);
        expect(runner.requests).toHaveLength(2);
      } finally {
        await subject.backend.transact({ kind: "handle", handle }, (store) => {
          const current = store.read(handle);
          if (current === undefined) throw new Error("recovered guarded evidence disappeared");
          store.replace(current, retained);
        });
      }
    };
    await rejectPrepareMutation(recovered.handle, retainedRecovered, (row) => ({
      ...row,
      stagedRebaseSourceBinding: {
        ...row.stagedRebaseSourceBinding!,
        source: {
          ...row.stagedRebaseSourceBinding!.source,
          generation: row.stagedRebaseSourceBinding!.source.generation + 1,
        },
      },
    }));
    await rejectPrepareMutation(recovered.handle, retainedRecovered, (row) => ({
      ...row,
      implementationQueue: {
        ...row.implementationQueue!,
        enrollment: {
          ...taskEnrollment(row.implementationQueue!.enrollment),
          finalizedManifestDigest: "0".repeat(64),
        },
      },
    }));
    await rejectPrepareMutation(recovered.handle, retainedRecovered, (row) => ({
      ...row,
      stagedRebaseSourceBinding: {
        ...row.stagedRebaseSourceBinding!,
        gitReceiptLineageDigest: "0".repeat(64),
      },
    }));
    await rejectPrepareMutation(guarded.prepared, retainedRed, (row) => ({
      ...row,
      prepareRequestDigest: "0".repeat(64),
    }));
    await rejectPrepareMutation(guarded.prepared, retainedRed, (row) => ({
      ...row,
      gitEffectBinding: { ...row.gitEffectBinding!, repositoryId: "0".repeat(64) },
    }));
    await rejectPrepareMutation(guarded.prepared, retainedRed, (row) => ({
      ...row,
      gitEffectBinding: {
        ...row.gitEffectBinding!,
        guardedRebaseBridge: {
          ...row.gitEffectBinding!.guardedRebaseBridge!,
          requestDigest: "0".repeat(64),
          guardedRebase: `cq-guarded-rebase:v1:${"0".repeat(64)}`,
        },
      },
    }));
    const correction = await capability.prepare(correctionRequest);
    if (!correction.accepted || correction.prepared.gitChangeCapability === undefined) {
      throw new Error(
        `recovered guarded red correction refused: ${
          correction.accepted ? "missing Git authority" : correction.detail
        }`,
      );
    }
    const correctionInput = await capability.fetchInput({
      ...correction.handle,
      inputCapability: correction.prepared.inputCapability,
    });
    if (correctionInput.state !== "input-materialized") {
      throw new Error("recovered guarded correction input did not materialize");
    }
    const correctionRecord = correctionInput.input as Readonly<Record<string, DispatchJSONValue>>;
    const correctionLineage = correctionRecord["guardedRebaseLineage"] as Readonly<
      Record<string, DispatchJSONValue>
    >;
    const correctionGuardedRebase = correctionLineage["guardedRebase"];
    const correctionOntoCommit = correctionLineage["ontoCommit"];
    const correctionRebasedStartCommit = correctionLineage["rebasedStartCommit"];
    const correctionExactTip = correctionLineage["exactTip"];
    if (
      typeof correctionGuardedRebase !== "string" ||
      typeof correctionOntoCommit !== "string" ||
      typeof correctionRebasedStartCommit !== "string" ||
      typeof correctionExactTip !== "boolean"
    ) {
      throw new Error("recovered guarded correction lineage is incomplete");
    }
    const correctionBody = `correct recovered guarded red ${attestationBackend}\n`;
    await fs.writeFile(
      path.join(subject.managed.handle.absolutePath, "recovered-guarded-correction.txt"),
      correctionBody,
    );
    const correctionReceipt = taskReceipt(await capability.gitCommit({
      ...correction.handle,
      gitChangeCapability: correction.prepared.gitChangeCapability,
      operationId: `T2081-${String(sequence)}-${attestationBackend}-recovered-red-correction`,
      expectedHead: redTip,
      message: "correct recovered guarded rejection",
      changes: [
        {
          kind: "add",
          path: "recovered-guarded-correction.txt",
          newState: { mode: "100644", digest: sha256(correctionBody) },
        },
      ],
    }));
    const correctionFiles = (
      await git(subject.managed.handle.absolutePath, [
        "diff",
        "--name-only",
        `${guardedBase}..${correctionReceipt.newHead}`,
      ])
    )
      .split("\n")
      .filter((entry) => entry !== "")
      .sort();
    expect(
      await capability.storeResult({
        resultCapability: correction.prepared.resultCapability,
        output: {
          taskId: "T2081",
          status: "pass",
          resultCommit: correctionReceipt.newHead,
          branch: subject.managed.handle.branch,
          actualWorktreePath: subject.managed.handle.absolutePath,
          filesTouched: correctionFiles,
          gitReceipts: [
            {
              ...correctionReceipt,
              objectOids: [...correctionReceipt.objectOids],
              paths: [...correctionReceipt.paths],
            },
          ],
          gitLineage: {
            kind: "guarded-rebase",
            guardedRebase: correctionGuardedRebase,
            ontoCommit: correctionOntoCommit,
            rebasedStartCommit: correctionRebasedStartCommit,
            exactTip: correctionExactTip,
          },
          checkSummary: "changed recovered-red correction awaits its ordinary gate",
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit: guardedBase,
            headCommit: correctionReceipt.newHead,
          },
          mutationTable: [
            {
              mutation: "remove the recovered guarded ancestry edge",
              observed: "the changed correction is rejected before any new gate",
              restored: "the exact correction reaches its ordinary gate",
            },
          ],
          summary: "changed correction retains the recovered guarded rejection",
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
    const correctionQualified = await qualify(
      correction.prepared,
      correctionChild,
      "2026-08-12T20:00:11.000Z",
    );
    if (correctionQualified.state !== "queued") {
      throw new Error("changed recovered guarded correction did not qualify");
    }
    expect(
      await capability.coordinateImplementationCandidate({
        partitionKey: correctionQualified.partitionKey,
        holderId: `recovered-guarded-correction-${attestationBackend}`,
      }),
    ).toMatchObject({ state: "completed", handle: correction.handle });
    expect(await capability.fetch(correction.handle)).toMatchObject({
      state: "consumed",
      output: { resultCommit: correctionReceipt.newHead },
    });
    expect(runner.requests).toHaveLength(3);
    await subject.backend.close();
  }

  test("a recovered zero-fresh guarded red worker admits its exact changed correction", async () => {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
      await exerciseRecoveredGuardedRedCorrection(attestationBackend, false);
    }
  }, 30_000);

  test("a recovered fresh guarded red worker admits its exact changed correction", async () => {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
      await exerciseRecoveredGuardedRedCorrection(attestationBackend, true);
    }
  }, 30_000);

  async function exerciseCurrentRecoveredStagedRetirement(
    attestationBackend: "memory" | "sqlite",
    abortOrdinaryContinuation: boolean,
  ): Promise<void> {
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
      const correctionReceipt = taskReceipt(await capability.gitCommit({
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
      }));
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
      const recoveredReceipt = taskReceipt(await capability.gitCommit({
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
      }));
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
              ...taskEnrollment(row.implementationQueue!.enrollment),
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
      const freshGuardedReceipt = taskReceipt(await capability.gitCommit({
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
      }));
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
      const resumedReceipt = taskReceipt(await capability.gitCommit({
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
      }));
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
      const resumedQualified = await qualify(
        resumed.prepared,
        resumedChild,
        "2026-08-12T20:00:14.000Z",
      );
      expect(resumedQualified).toMatchObject({ state: "queued" });
      if (abortOrdinaryContinuation) {
        if (resumedQualified.state !== "queued") {
          throw new Error("resumed repeated-guarded worker did not qualify");
        }
        expect(
          await capability.coordinateImplementationCandidate({
            partitionKey: resumedQualified.partitionKey,
            holderId: `t6580-consume-repeated-resumed-${attestationBackend}`,
          }),
        ).toMatchObject({ state: "completed" });
        if (capability.resolveContinuation === undefined) {
          throw new Error("repeated-guarded worker omitted continuation authority");
        }
        const continuation = await capability.resolveContinuation(
          binding,
          resumedReceipt.newHead,
        );
        const ordinary = await capability.prepare({
          roleId: "implement-worker",
          input: {
            taskId: "T2081",
            headline: "supervise exact tip",
            description: "run the full gate outside the workspace-write sandbox",
            acceptance: "only a green exact tip becomes consumable",
            worktreePath: subject.managed.handle.absolutePath,
            branch: subject.managed.handle.branch,
            baseCommit: secondBaseCommit,
            round: 6,
            startingCommit: resumedReceipt.newHead,
            validationIntent: "final",
            priorResultCommit: resumedReceipt.newHead,
          },
          idempotencyKey: `T2081-${String(sequence)}-${attestationBackend}-ordinary-after-repeated-guarded`,
          timeoutMs: 600_000,
          expectedChild: {
            childId: `implement-worker#t6580-ordinary-${attestationBackend}-${String(sequence)}`,
            runId: `t6580-ordinary-${attestationBackend}-run-${String(sequence)}`,
          },
          continuation: continuation.continuationReference,
        });
        if (!ordinary.accepted) throw new Error(ordinary.detail);
        await capability.fetchInput({
          ...ordinary.handle,
          inputCapability: ordinary.prepared.inputCapability,
        });
        expect(
          await capability.abort({ ...ordinary.handle, reason: "parent-lost" }),
        ).toMatchObject({ state: "aborted", reason: "parent-lost" });
        expect(
          await capability.resolveRecovery(binding, resumedReceipt.newHead),
        ).toMatchObject({
          status: "dispatch-recovery-resolved",
          liveTip: resumedReceipt.newHead,
          preparation: { kind: "current" },
        });
      }
      await reopenedBackend.close();
  }

  test.each(["memory", "sqlite"] as const)(
    "current-recovered staged retirement admits its exact guarded successor despite older terminal enrollment history (%s)",
    async (attestationBackend) => {
      await exerciseCurrentRecoveredStagedRetirement(attestationBackend, false);
    },
    RECOVERY_BACKEND_CASE_TIMEOUT_MS,
  );

  test(
    "parent-lost ordinary continuation retains authenticated repeated guarded transitions",
    async () => {
      for (const attestationBackend of ["memory", "sqlite"] as const) {
        await exerciseCurrentRecoveredStagedRetirement(attestationBackend, true);
      }
    },
    30_000,
  );

  async function exerciseCancelledRecoveryContinuation(
    continuationKind: "ordinary" | "guarded-rebase",
    cancelGuardedSuccessor: boolean,
    attestationBackend: "memory" | "sqlite",
    guardedFreshReceiptCount: 0 | 1 | 2,
    exerciseReceiptJournalControls: boolean,
    reproduction:
      | "none"
      | "cancelled-current-manual-guarded"
      | "zero-fresh-failure"
      | "guarded-ordinary-empty-cancel" = "none",
  ): Promise<void> {
    const runner =
      reproduction === "guarded-ordinary-empty-cancel"
        ? new ParentLossThenTwoGreenThenRedThenGreenGateDummy()
        : new ParentLossThenGreenGateDummy();
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

    if (reproduction === "cancelled-current-manual-guarded") {
      await fs.writeFile(path.join(subject.repositoryRoot, "manual-integration.txt"), "advanced\n");
      await git(subject.repositoryRoot, ["add", "manual-integration.txt"]);
      await git(subject.repositoryRoot, ["commit", "-q", "-m", "advance manual integration"]);
      await git(subject.repositoryRoot, ["config", "user.name", "T2081"]);
      await git(subject.repositoryRoot, ["config", "user.email", "t2081@example.invalid"]);
      const ontoCommit = await git(subject.repositoryRoot, ["rev-parse", "HEAD"]);
      const rebase = await runGuardedRebase({
        binding,
        operationId: `t2081-cancelled-current-manual-${String(sequence)}`,
        ontoCommit,
        stateDir: subject.stateDir,
        runEffect: async () => {
          await git(subject.managed.handle.absolutePath, ["rebase", ontoCommit]);
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      if (rebase.kind !== "finalized") {
        throw new Error("cancelled current recovery manual rebase did not finalize");
      }
      const manualChild = {
        childId: `implement-worker#sealed-manual-${String(sequence)}`,
        runId: `sealed-manual-run-${String(sequence)}`,
      };
      const manual = await capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: rebase.bridge.ontoCommit,
          round: 2,
          startingCommit: rebase.bridge.rebasedStartCommit,
          validationIntent: "final",
          priorResultCommit: subject.receipt.newHead,
        },
        idempotencyKey: `T2081-${String(sequence)}-cancelled-current-manual`,
        timeoutMs: 600_000,
        expectedChild: manualChild,
        reprepareOf: cancelled.handle,
        guardedRebase: rebase.reference,
      });
      if (!manual.accepted) throw new Error(manual.detail);
      await capability.fetchInput({
        ...manual.handle,
        inputCapability: manual.prepared.inputCapability,
      });
      expect(await capability.abort({ ...manual.handle, reason: "cancelled" })).toMatchObject({
        state: "aborted",
        reason: "cancelled",
      });
      const manualEvidence = await subject.backend.transact(
        { kind: "handle", handle: manual.handle },
        (store) => {
          const row = store.read(manual.handle);
          if (row === undefined || isAttestationTombstone(row)) {
            throw new Error("manual guarded successor evidence disappeared");
          }
          return {
            journalClaim: row.dispatchJournalRecoveryClaim !== undefined,
            continuationClaim: row.dispatchContinuationClaim !== undefined,
            bridge: row.gitEffectBinding?.guardedRebaseBridge !== undefined,
            inheritedLength: row.gitEffectBinding?.inheritedGitReceipts?.length ?? 0,
          };
        },
      );
      expect(manualEvidence).toEqual({
        journalClaim: false,
        continuationClaim: false,
        bridge: true,
        inheritedLength: 0,
      });
      const recoveryBeforeMutations = await recoveryJournal.read("T2081");
      const rejectRecoveryMutation = async (
        handle: { readonly attestationId: string; readonly generation: number },
        mutate: (row: AttestationEnvelope) => AttestationEnvelope,
      ) => {
        const retained = await subject.backend.transact({ kind: "handle", handle }, (store) => {
          const row = store.read(handle);
          if (row === undefined || isAttestationTombstone(row)) {
            throw new Error("manual recovery evidence disappeared");
          }
          return row;
        });
        await subject.backend.transact({ kind: "handle", handle }, (store) => {
          const current = store.read(handle);
          if (current === undefined) throw new Error("manual recovery mutation lost its row");
          store.replace(current, mutate(retained));
        });
        try {
          await expect(
            capability.resolveRecovery!(binding, rebase.bridge.rebasedStartCommit),
          ).rejects.toThrow();
          expect(await recoveryJournal.read("T2081")).toEqual(recoveryBeforeMutations);
        } finally {
          await subject.backend.transact({ kind: "handle", handle }, (store) => {
            const current = store.read(handle);
            if (current === undefined) throw new Error("manual recovery restore lost its row");
            store.replace(current, retained);
          });
        }
      };
      await rejectRecoveryMutation(cancelled.handle, (row) => {
        const { dispatchJournalRecoveryClaim: _claim, ...withoutClaim } = row;
        return withoutClaim;
      });
      await rejectRecoveryMutation(manual.handle, (row) => ({
        ...row,
        gitEffectBinding: {
          ...row.gitEffectBinding!,
          guardedRebaseBridge: {
            ...row.gitEffectBinding!.guardedRebaseBridge!,
            requestDigest: "0".repeat(64),
            guardedRebase: `cq-guarded-rebase:v1:${"0".repeat(64)}`,
          },
        },
      }));
      const recaptured = await capability.resolveRecovery(
        binding,
        rebase.bridge.rebasedStartCommit,
      );
      expect(recaptured.preparation.kind).toBe("current");
      if (recaptured.preparation.kind !== "current") {
        throw new Error("manual guarded cancellation did not recapture current recovery");
      }
      const recoveredChild = {
        childId: `implement-worker#sealed-manual-recovered-${String(sequence)}`,
        runId: `sealed-manual-recovered-run-${String(sequence)}`,
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
          baseCommit: rebase.bridge.ontoCommit,
          round: 3,
          startingCommit: rebase.bridge.rebasedStartCommit,
          validationIntent: "final",
          priorResultCommit: rebase.bridge.rebasedStartCommit,
        },
        idempotencyKey: `T2081-${String(sequence)}-cancelled-manual-recovered`,
        timeoutMs: 600_000,
        expectedChild: recoveredChild,
        recoveryPreparation: recaptured.preparation.recoveryPreparation,
      });
      if (!recovered.accepted || recovered.prepared.gitChangeCapability === undefined) {
        throw new Error("manual guarded recovery successor did not receive Git authority");
      }
      await capability.fetchInput({
        ...recovered.handle,
        inputCapability: recovered.prepared.inputCapability,
      });
      const priorBytes = await fs.readFile(
        path.join(subject.managed.handle.absolutePath, "file.txt"),
        "utf8",
      );
      const recoveredBytes = "after cancelled manual guarded recovery\n";
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "file.txt"),
        recoveredBytes,
      );
      const recoveredReceipt = taskReceipt(await capability.gitCommit({
        ...recovered.handle,
        gitChangeCapability: recovered.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-cancelled-manual-recovered-commit`,
        expectedHead: rebase.bridge.rebasedStartCommit,
        message: "resume cancelled manual guarded recovery",
        changes: [
          {
            kind: "modify",
            path: "file.txt",
            oldState: { mode: "100644", digest: sha256(priorBytes) },
            newState: { mode: "100644", digest: sha256(recoveredBytes) },
          },
        ],
      }));
      expect(
        await capability.storeResult({
          resultCapability: recovered.prepared.resultCapability,
          output: {
            ...subject.output,
            resultCommit: recoveredReceipt.newHead,
            gitReceipts: [
              {
                ...recoveredReceipt,
                objectOids: [...recoveredReceipt.objectOids],
                paths: [...recoveredReceipt.paths],
              },
            ],
            filesTouched: ["file.txt"],
            checkSummary: "manual guarded recovery successor awaits its ordinary gate",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: rebase.bridge.ontoCommit,
              headCommit: recoveredReceipt.newHead,
            },
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      const rejectUnenrolledMutation = async (
        handle: { readonly attestationId: string; readonly generation: number },
        mutate: (row: AttestationEnvelope) => AttestationEnvelope,
        observedAt: string,
      ) => {
        const retained = await subject.backend.transact({ kind: "handle", handle }, (store) => {
          const row = store.read(handle);
          if (row === undefined || isAttestationTombstone(row)) {
            throw new Error("unenrolled recovery evidence disappeared");
          }
          return row;
        });
        await subject.backend.transact({ kind: "handle", handle }, (store) => {
          const current = store.read(handle);
          if (current === undefined) throw new Error("unenrolled recovery mutation lost its row");
          store.replace(current, mutate(retained));
        });
        try {
          await expect(qualify(recovered.prepared, recoveredChild, observedAt)).rejects.toThrow(
            "cannot be resurrected",
          );
        } finally {
          await subject.backend.transact({ kind: "handle", handle }, (store) => {
            const current = store.read(handle);
            if (current === undefined) throw new Error("unenrolled recovery restore lost its row");
            store.replace(current, retained);
          });
        }
      };
      await rejectUnenrolledMutation(
        cancelled.handle,
        (row) => {
          const { dispatchJournalRecoveryClaim: _claim, ...withoutClaim } = row;
          return withoutClaim;
        },
        "2026-08-12T20:00:08.100Z",
      );
      await rejectUnenrolledMutation(
        manual.handle,
        (row) => ({
          ...row,
          gitEffectBinding: {
            ...row.gitEffectBinding!,
            repositoryId: "0".repeat(64),
          },
        }),
        "2026-08-12T20:00:08.200Z",
      );
      await rejectUnenrolledMutation(
        manual.handle,
        (row) => ({
          ...row,
          gitEffectBinding: {
            ...row.gitEffectBinding!,
            guardedRebaseBridge: {
              ...row.gitEffectBinding!.guardedRebaseBridge!,
              requestDigest: "0".repeat(64),
              guardedRebase: `cq-guarded-rebase:v1:${"0".repeat(64)}`,
            },
          },
        }),
        "2026-08-12T20:00:08.300Z",
      );
      expect(
        await qualify(recovered.prepared, recoveredChild, "2026-08-12T20:00:09.000Z"),
      ).toMatchObject({ state: "queued" });
      expect(runner.requests).toHaveLength(1);
      await subject.backend.close();
      return;
    }

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
    const successorReceipt = taskReceipt(await capability.gitCommit({
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
    }));
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
    if (cancelGuardedSuccessor && reproduction !== "zero-fresh-failure") {
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
      const resumedBytes = `resumed after staged guarded cancellation ${attestationBackend}\n`;
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "staged-resumed.txt"),
        resumedBytes,
      );
      const resumedReceipt = taskReceipt(await activeCapability.gitCommit!({
        ...resumed.handle,
        gitChangeCapability: resumed.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-${attestationBackend}-staged-resumed-commit`,
        expectedHead: guardedTip,
        message: "resume staged guarded recovery",
        changes: [
          {
            kind: "add",
            path: "staged-resumed.txt",
            newState: { mode: "100644", digest: sha256(resumedBytes) },
          },
        ],
      }));
      expect(
        await activeCapability.abort({ ...resumed.handle, reason: "cancelled" }),
      ).toMatchObject({ state: "aborted", reason: "cancelled" });
      const resumedRecovery = await activeCapability.resolveRecovery!(
        binding,
        resumedReceipt.newHead,
      );
      expect(resumedRecovery).toMatchObject({
        status: "dispatch-recovery-resolved",
        liveTip: resumedReceipt.newHead,
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
        const receipt = taskReceipt(await activeCapability.gitCommit!({
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
        }));
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
      if (reproduction === "zero-fresh-failure") {
        const failureEvidence = await reopenedBackend.transact(
          { kind: "handle", handle: resumed.handle },
          (store) => {
            const row = store.read(resumed.handle);
            if (row === undefined || isAttestationTombstone(row)) {
              throw new Error("zero-fresh recovery evidence disappeared");
            }
            const startingCommit = (row.input as Readonly<Record<string, DispatchJSONValue>>)[
              "startingCommit"
            ];
            const inherited = row.gitEffectBinding?.inheritedGitReceipts ?? [];
            return {
              inheritedLength: inherited.length,
              transition: row.gitEffectBinding?.receiptChainTransition !== undefined,
              bridge: row.gitEffectBinding?.guardedRebaseBridge !== undefined,
              startingIsReceiptEndpoint: inherited.some(
                (receipt) =>
                  receipt.oldHead === startingCommit || receipt.newHead === startingCommit,
              ),
            };
          },
        );
        expect(failureEvidence).toEqual({
          inheritedLength: 2,
          transition: true,
          bridge: false,
          startingIsReceiptEndpoint: false,
        });
        expect(
          await activeCapability.storeResult({
            resultCapability: resumed.prepared.resultCapability,
            output: {
              taskId: "T2081",
              status: "fail",
              resultCommit: null,
              branch: subject.managed.handle.branch,
              actualWorktreePath: subject.managed.handle.absolutePath,
              filesTouched: ["file.txt"],
              gitReceipts: [],
              checkSummary: "zero-fresh guarded recovery failed intentionally",
              summary: "the verified guarded boundary retained no fresh receipts",
              blockedReason: "controlled zero-fresh failure",
              baseVerification: {
                status: "unresolvable",
                reason: "head-missing",
                baseCommit: guardedRecoveryBase,
                headCommit: null,
              },
            },
          }),
        ).toMatchObject({ state: "gate-pending" });
        expect(
          await qualify(resumed.prepared, resumedChild, "2026-08-12T20:00:12.500Z"),
        ).toMatchObject({ state: "consumed" });
        const consumedFailureEvidence = await reopenedBackend.transact(
          { kind: "handle", handle: resumed.handle },
          (store) => {
            const row = store.read(resumed.handle);
            if (row === undefined || isAttestationTombstone(row)) {
              throw new Error("consumed zero-fresh failure evidence disappeared");
            }
            const startingCommit = (row.input as Readonly<Record<string, DispatchJSONValue>>)[
              "startingCommit"
            ];
            const receipts = row.dispatchContinuationBinding?.gitReceipts ?? [];
            return {
              receiptLength: receipts.length,
              startingIsReceiptEndpoint: receipts.some(
                (receipt) =>
                  receipt.oldHead === startingCommit || receipt.newHead === startingCommit,
              ),
            };
          },
        );
        expect(consumedFailureEvidence).toEqual({
          receiptLength: 2,
          startingIsReceiptEndpoint: false,
        });
        expect(runner.requests).toHaveLength(2);
        await reopenedBackend.close();
        return;
      }
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "resumed.txt"),
        "resumed after guarded recovery\n",
      );
      const resumedReceipt = taskReceipt(await activeCapability.gitCommit!({
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
      }));
      expect(
        await activeCapability.storeResult({
          resultCapability: resumed.prepared.resultCapability,
          output: {
            ...subject.output,
            resultCommit: resumedReceipt.newHead,
            filesTouched: ["file.txt", "resumed.txt"],
            gitReceipts: [
              {
                ...resumedReceipt,
                objectOids: [...resumedReceipt.objectOids],
                paths: [...resumedReceipt.paths],
              },
            ],
            checkSummary: "resumed guarded recovery checks passed",
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
            ...taskEnrollment(row.implementationQueue!.enrollment),
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
    const nextQualified = await qualify(next.prepared, nextChild, "2026-08-12T20:00:11.000Z");
    expect(nextQualified).toMatchObject({ state: "queued" });
    if (reproduction === "guarded-ordinary-empty-cancel") {
      if (
        continuationKind !== "guarded-rebase" ||
        guardedSuccessorTip === undefined ||
        guardedRecoveryBase === undefined ||
        nextQualified.state !== "queued" ||
        activeCapability.resolveContinuation === undefined
      ) {
        throw new Error("guarded empty-continuation reproduction is unavailable");
      }
      expect(
        await activeCapability.coordinateImplementationCandidate!({
          partitionKey: nextQualified.partitionKey,
          holderId: "sealed-guarded-before-empty-continuation",
        }),
      ).toMatchObject({ state: "completed" });
      const continuation = await activeCapability.resolveContinuation(binding, guardedSuccessorTip);
      const ordinaryChild = {
        childId: `implement-worker#sealed-empty-ordinary-${String(sequence)}`,
        runId: `sealed-empty-ordinary-run-${String(sequence)}`,
      };
      const legacyProducer = createDispatchCapability({
        ...subject.capabilityOptions,
        backend: reopenedBackend,
        implementationSuccessorLauncher,
      });
      const ordinary = await legacyProducer.prepare({
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
          startingCommit: guardedSuccessorTip,
          validationIntent: "final",
          priorResultCommit: guardedSuccessorTip,
        },
        idempotencyKey: `T2081-${String(sequence)}-guarded-empty-ordinary`,
        timeoutMs: 600_000,
        expectedChild: ordinaryChild,
        continuation: continuation.continuationReference,
      });
      if (!ordinary.accepted) throw new Error(ordinary.detail);
      await legacyProducer.fetchInput({
        ...ordinary.handle,
        inputCapability: ordinary.prepared.inputCapability,
      });
      expect(await legacyProducer.abort({ ...ordinary.handle, reason: "cancelled" })).toMatchObject(
        { state: "aborted", reason: "cancelled" },
      );
      const recaptured = await activeCapability.resolveRecovery!(binding, guardedSuccessorTip);
      expect(recaptured.preparation.kind).toBe("current");
      if (recaptured.preparation.kind !== "current") {
        throw new Error("empty ordinary cancellation did not recapture current recovery");
      }
      const recoveredChild = {
        childId: `implement-worker#sealed-empty-ordinary-recovered-${String(sequence)}`,
        runId: `sealed-empty-ordinary-recovered-run-${String(sequence)}`,
      };
      const recovered = await activeCapability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: guardedRecoveryBase,
          round: 5,
          startingCommit: guardedSuccessorTip,
          validationIntent: "final",
          priorResultCommit: guardedSuccessorTip,
        },
        idempotencyKey: `T2081-${String(sequence)}-guarded-empty-ordinary-recovered`,
        timeoutMs: 600_000,
        expectedChild: recoveredChild,
        recoveryPreparation: recaptured.preparation.recoveryPreparation,
      });
      if (!recovered.accepted) throw new Error(recovered.detail);
      await activeCapability.fetchInput({
        ...recovered.handle,
        inputCapability: recovered.prepared.inputCapability,
      });
      expect(
        await activeCapability.storeResult({
          resultCapability: recovered.prepared.resultCapability,
          output: {
            taskId: "T2081",
            status: "pass",
            resultCommit: guardedSuccessorTip,
            branch: subject.managed.handle.branch,
            actualWorktreePath: subject.managed.handle.absolutePath,
            filesTouched: ["file.txt"],
            gitReceipts: [],
            checkSummary: "recovered empty ordinary continuation awaits its gate",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: guardedRecoveryBase,
              headCommit: guardedSuccessorTip,
            },
            summary: "ordinary recovery preserves the guarded empty component",
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      const retainedOrdinary = await reopenedBackend.transact(
        { kind: "handle", handle: ordinary.handle },
        (store) => store.read(ordinary.handle),
      );
      const retainedRecovered = await reopenedBackend.transact(
        { kind: "handle", handle: recovered.handle },
        (store) => store.read(recovered.handle),
      );
      if (
        retainedOrdinary === undefined ||
        isAttestationTombstone(retainedOrdinary) ||
        retainedRecovered === undefined ||
        isAttestationTombstone(retainedRecovered)
      ) {
        throw new Error("empty ordinary recovery evidence disappeared");
      }
      const rejectLineageMutation = async (
        handle: typeof ordinary.handle,
        retained: AttestationEnvelope,
        mutate: (row: AttestationEnvelope) => AttestationEnvelope,
        observedAt: string,
      ) => {
        await reopenedBackend.transact({ kind: "handle", handle }, (store) => {
          const current = store.read(handle);
          if (current === undefined || isAttestationTombstone(current)) {
            throw new Error("empty ordinary recovery evidence disappeared");
          }
          store.replace(current, mutate(current));
        });
        try {
          await expect(qualify(recovered.prepared, recoveredChild, observedAt)).rejects.toThrow();
          expect(runner.requests).toHaveLength(3);
          expect(
            await reopenedBackend.transact({ kind: "handle", handle: recovered.handle }, (store) =>
              store.read(recovered.handle),
            ),
          ).not.toHaveProperty("implementationQueue");
        } finally {
          await reopenedBackend.transact({ kind: "handle", handle }, (store) => {
            const current = store.read(handle);
            if (current === undefined) {
              throw new Error("empty ordinary recovery evidence disappeared");
            }
            store.replace(current, retained);
          });
        }
      };
      await rejectLineageMutation(
        ordinary.handle,
        retainedOrdinary,
        (row) => {
          const { dispatchContinuationClaim: _claim, ...withoutClaim } = row;
          return withoutClaim;
        },
        "2026-08-12T20:00:11.100Z",
      );
      await rejectLineageMutation(
        ordinary.handle,
        retainedOrdinary,
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
        "2026-08-12T20:00:11.200Z",
      );
      await rejectLineageMutation(
        ordinary.handle,
        retainedOrdinary,
        (row) => ({ ...row, prepareRequestDigest: "0".repeat(64) }),
        "2026-08-12T20:00:11.300Z",
      );
      await rejectLineageMutation(
        ordinary.handle,
        retainedOrdinary,
        (row) => ({ ...row, terminalDigest: "0".repeat(64) }),
        "2026-08-12T20:00:11.400Z",
      );
      await rejectLineageMutation(
        recovered.handle,
        retainedRecovered,
        (row) => ({
          ...row,
          gitEffectBinding: {
            ...row.gitEffectBinding!,
            inheritedGitReceipts: [...row.gitEffectBinding!.inheritedGitReceipts!].reverse(),
          },
        }),
        "2026-08-12T20:00:11.500Z",
      );
      await rejectLineageMutation(
        recovered.handle,
        retainedRecovered,
        (row) => ({
          ...row,
          gitEffectBinding: {
            ...row.gitEffectBinding!,
            receiptChainTransition: {
              ...row.gitEffectBinding!.receiptChainTransition!,
              guardedRebase: `cq-guarded-rebase:v1:${"0".repeat(64)}`,
              requestDigest: "0".repeat(64),
            },
          },
        }),
        "2026-08-12T20:00:11.600Z",
      );
      const recoveredQualified = await qualify(
        recovered.prepared,
        recoveredChild,
        "2026-08-12T20:00:12.000Z",
      );
      expect(recoveredQualified).toMatchObject({ state: "queued" });
      if (recoveredQualified.state !== "queued") {
        throw new Error("recovered empty ordinary continuation did not qualify");
      }
      await expect(
        activeCapability.coordinateImplementationCandidate!({
          partitionKey: recoveredQualified.partitionKey,
          holderId: "sealed-empty-ordinary-recovered",
        }),
      ).rejects.toThrow();
      expect(runner.requests).toHaveLength(4);
      expect(
        await reopenedBackend.transact({ kind: "handle", handle: recovered.handle }, (store) =>
          store.read(recovered.handle),
        ),
      ).toMatchObject({
        state: "aborted",
        abortReason: "gate-rejected",
        implementationQueue: {
          state: "terminal",
          terminal: { reason: "gate-rejected" },
        },
      });

      const correctionChild = {
        childId: `implement-worker#sealed-empty-ordinary-correction-${String(sequence)}`,
        runId: `sealed-empty-ordinary-correction-run-${String(sequence)}`,
      };
      const correctionRequest = {
        roleId: "implement-worker" as const,
        input: {
          taskId: "T2081",
          headline: "supervise exact tip",
          description: "run the full gate outside the workspace-write sandbox",
          acceptance: "only a green exact tip becomes consumable",
          worktreePath: subject.managed.handle.absolutePath,
          branch: subject.managed.handle.branch,
          baseCommit: guardedRecoveryBase,
          round: 6,
          startingCommit: guardedSuccessorTip,
          validationIntent: "final" as const,
          priorResultCommit: guardedSuccessorTip,
        },
        idempotencyKey: `T2081-${String(sequence)}-guarded-empty-ordinary-correction`,
        timeoutMs: 600_000,
        expectedChild: correctionChild,
        reprepareOf: recovered.handle,
      };
      const rowsBeforeCorrectionControls = await reopenedBackend.transact(
        { kind: "namespace" },
        (store) => store.rows().length,
      );
      const rejectCorrectionMutation = async (
        handle: typeof recovered.handle,
        name: string,
        mutate: (row: AttestationEnvelope) => AttestationEnvelope,
      ) => {
        const retained = await reopenedBackend.transact({ kind: "handle", handle }, (store) => {
          const row = store.read(handle);
          if (row === undefined || isAttestationTombstone(row)) {
            throw new Error("cancelled recovery correction evidence disappeared");
          }
          return row;
        });
        await reopenedBackend.transact({ kind: "handle", handle }, (store) => {
          const current = store.read(handle);
          if (current === undefined) {
            throw new Error("cancelled recovery correction mutation lost its row");
          }
          store.replace(current, mutate(retained));
        });
        try {
          expect(
            await activeCapability.prepare({
              ...correctionRequest,
              idempotencyKey: `${correctionRequest.idempotencyKey}-${name}`,
            }),
          ).toMatchObject({ accepted: false, reason: "journal-recovery-required" });
          expect(
            await reopenedBackend.transact({ kind: "namespace" }, (store) => store.rows().length),
          ).toBe(rowsBeforeCorrectionControls);
          expect(runner.requests).toHaveLength(4);
        } finally {
          await reopenedBackend.transact({ kind: "handle", handle }, (store) => {
            const current = store.read(handle);
            if (current === undefined) {
              throw new Error("cancelled recovery correction restore lost its row");
            }
            store.replace(current, retained);
          });
        }
      };
      await rejectCorrectionMutation(recovered.handle, "claim", (row) => ({
        ...row,
        dispatchJournalRecoveryClaim: {
          ...row.dispatchJournalRecoveryClaim!,
          selectedSource: {
            ...row.dispatchJournalRecoveryClaim!.selectedSource,
            generation: row.dispatchJournalRecoveryClaim!.selectedSource.generation - 1,
          },
        },
      }));
      await rejectCorrectionMutation(recovered.handle, "task", (row) => ({
        ...row,
        input: {
          ...(row.input as Readonly<Record<string, DispatchJSONValue>>),
          taskId: "T9999",
        },
      }));
      await rejectCorrectionMutation(recovered.handle, "manifest", (row) => ({
        ...row,
        implementationQueue: {
          ...row.implementationQueue!,
          enrollment: {
            ...taskEnrollment(row.implementationQueue!.enrollment),
            finalizedManifestDigest: "0".repeat(64),
          },
        },
      }));
      await rejectCorrectionMutation(recovered.handle, "manager", (row) => ({
        ...row,
        gitEffectBinding: { ...row.gitEffectBinding!, repositoryId: "0".repeat(64) },
      }));
      await rejectCorrectionMutation(recovered.handle, "prepare", (row) => ({
        ...row,
        prepareRequestDigest: "0".repeat(64),
      }));
      await rejectCorrectionMutation(recovered.handle, "receipt", (row) => ({
        ...row,
        gitEffectBinding: {
          ...row.gitEffectBinding!,
          inheritedGitReceipts: [...row.gitEffectBinding!.inheritedGitReceipts!].reverse(),
        },
      }));
      await rejectCorrectionMutation(next.handle, "bridge", (row) => ({
        ...row,
        gitEffectBinding: {
          ...row.gitEffectBinding!,
          guardedRebaseBridge: {
            ...row.gitEffectBinding!.guardedRebaseBridge!,
            requestDigest: "0".repeat(64),
            guardedRebase: `cq-guarded-rebase:v1:${"0".repeat(64)}`,
          },
        },
      }));
      await rejectCorrectionMutation(recovered.handle, "epoch", (row) => ({
        ...row,
        dispatchJournalRecoveryClaim: {
          ...row.dispatchJournalRecoveryClaim!,
          lineageMaximumGeneration: row.dispatchJournalRecoveryClaim!.lineageMaximumGeneration + 1,
        },
      }));
      expect(
        await activeCapability.prepare({
          ...correctionRequest,
          input: { ...correctionRequest.input, startingCommit: "0".repeat(40) },
          idempotencyKey: `${correctionRequest.idempotencyKey}-stale-tip`,
        }),
      ).toMatchObject({ accepted: false });
      expect(
        await activeCapability.prepare({
          ...correctionRequest,
          idempotencyKey: `${correctionRequest.idempotencyKey}-substituted-source`,
          reprepareOf: ordinary.handle,
        }),
      ).toMatchObject({ accepted: false, reason: "journal-recovery-required" });
      expect(
        await reopenedBackend.transact({ kind: "namespace" }, (store) => store.rows().length),
      ).toBe(rowsBeforeCorrectionControls);
      expect(runner.requests).toHaveLength(4);
      const correction = await activeCapability.prepare(correctionRequest);
      if (!correction.accepted || correction.prepared.gitChangeCapability === undefined) {
        throw new Error(
          correction.accepted
            ? "recovered correction lacks Git authority"
            : `recovered correction refused: ${correction.detail}`,
        );
      }
      await activeCapability.fetchInput({
        ...correction.handle,
        inputCapability: correction.prepared.inputCapability,
      });
      const correctionBytes = `correct recovered cancelled continuation ${attestationBackend}\n`;
      await fs.writeFile(
        path.join(subject.managed.handle.absolutePath, "cancelled-recovery-correction.txt"),
        correctionBytes,
      );
      const correctionReceipt = taskReceipt(await activeCapability.gitCommit!({
        ...correction.handle,
        gitChangeCapability: correction.prepared.gitChangeCapability,
        operationId: `T2081-${String(sequence)}-${attestationBackend}-cancelled-recovery-correction`,
        expectedHead: guardedSuccessorTip,
        message: "correct recovered cancelled continuation",
        changes: [
          {
            kind: "add",
            path: "cancelled-recovery-correction.txt",
            newState: { mode: "100644", digest: sha256(correctionBytes) },
          },
        ],
      }));
      const correctionFiles = (
        await git(subject.managed.handle.absolutePath, [
          "diff",
          "--name-only",
          `${guardedRecoveryBase}..${correctionReceipt.newHead}`,
        ])
      )
        .split("\n")
        .filter((entry) => entry !== "")
        .sort();
      expect(
        await activeCapability.storeResult({
          resultCapability: correction.prepared.resultCapability,
          output: {
            taskId: "T2081",
            status: "pass",
            resultCommit: correctionReceipt.newHead,
            branch: subject.managed.handle.branch,
            actualWorktreePath: subject.managed.handle.absolutePath,
            filesTouched: correctionFiles,
            gitReceipts: [
              {
                ...correctionReceipt,
                objectOids: [...correctionReceipt.objectOids],
                paths: [...correctionReceipt.paths],
              },
            ],
            checkSummary: "changed cancelled-recovery correction awaits its gate",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: guardedRecoveryBase,
              headCommit: correctionReceipt.newHead,
            },
            summary: "changed correction retains the cancelled recovery ancestry",
          },
        }),
      ).toMatchObject({ state: "gate-pending" });
      const correctionQualified = await qualify(
        correction.prepared,
        correctionChild,
        "2026-08-12T20:00:14.000Z",
      );
      if (correctionQualified.state !== "queued") {
        throw new Error("changed cancelled-recovery correction did not qualify");
      }
      expect(
        await activeCapability.coordinateImplementationCandidate!({
          partitionKey: correctionQualified.partitionKey,
          holderId: "sealed-empty-ordinary-correction",
        }),
      ).toMatchObject({ state: "completed", handle: correction.handle });
      expect(await activeCapability.fetch(correction.handle)).toMatchObject({
        state: "consumed",
        output: { resultCommit: correctionReceipt.newHead },
      });
      expect(runner.requests).toHaveLength(5);
    }
    await reopenedBackend.close();
  }

  test("a cancelled sealed recovery successor composes into an ordinary consumed continuation", async () => {
    await exerciseCancelledRecoveryContinuation("ordinary", false, "sqlite", 0, false);
  }, RECOVERY_BACKEND_CASE_TIMEOUT_MS);

  test("a cancelled sealed recovery successor composes into an authenticated guarded rebase", async () => {
    await exerciseCancelledRecoveryContinuation("guarded-rebase", false, "sqlite", 0, false);
  }, RECOVERY_BACKEND_CASE_TIMEOUT_MS);

  test("a sealed recovery successor admits one exact changed gate correction", async () => {
    const runner = new GateSequenceDummy([
      {
        gateExitCode: 1,
        passCount: 68,
        failCount: 1,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:03.000Z",
        outputTail: "(fail) sealed recovery successor\n68 pass\n1 fail",
      },
      {
        gateExitCode: 0,
        passCount: 69,
        failCount: 0,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:06.000Z",
        outputTail: "69 pass\n0 fail",
      },
    ]);
    const subject = await fixture(runner, true);
    const source = {
      attestationId: subject.prepared.attestationId,
      generation: subject.prepared.generation,
    };
    expect(await subject.capability.abort({ ...source, reason: "parent-lost" })).toMatchObject({
      state: "aborted",
      reason: "parent-lost",
    });
    expect(subject.store.read(source)).not.toHaveProperty("implementationQueue");

    const recovery = await resolveRecovery(subject);
    if (recovery.preparation.kind !== "current") {
      throw new Error("sealed source did not return current recovery authority");
    }
    const successorChild = {
      childId: `implement-worker#sealed-successor-${String(sequence)}`,
      runId: `sealed-successor-run-${String(sequence)}`,
    };
    const successor = await subject.capability.prepare({
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
      idempotencyKey: `T2081-${String(sequence)}-sealed-successor`,
      timeoutMs: 600_000,
      expectedChild: successorChild,
      recoveryPreparation: recovery.preparation.recoveryPreparation,
    });
    if (!successor.accepted) throw new Error(successor.detail);
    await subject.capability.fetchInput({
      ...successor.handle,
      inputCapability: successor.prepared.inputCapability,
    });
    expect(
      await subject.capability.storeResult({
        resultCapability: successor.prepared.resultCapability,
        output: {
          ...subject.output,
          gitReceipts: [],
          checkSummary: "sealed successor requests its first queue gate",
        },
      }),
    ).toMatchObject({ state: "gate-pending" });
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
        childThreadId: `sealed-correction-thread-${String(prepared.generation)}`,
        expectedRunId: expectedChild.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt,
        promptDigest: prepared.promptProvenance.promptDigest,
      });
    const successorQualified = await qualify(
      successor.prepared,
      successorChild,
      "2026-08-12T20:00:02.000Z",
    );
    if (successorQualified.state !== "queued") {
      throw new Error("sealed recovery successor did not qualify");
    }
    await expect(
      subject.capability.coordinateImplementationCandidate({
        partitionKey: successorQualified.partitionKey,
        holderId: "t6573-sealed-red-successor",
      }),
    ).rejects.toThrow();
    expect(runner.requests).toHaveLength(1);
    expect(subject.store.read(successor.handle)).toMatchObject({
      state: "aborted",
      abortReason: "gate-rejected",
      implementationQueue: {
        state: "terminal",
        terminal: { reason: "gate-rejected" },
      },
    });

    const correctionChild = {
      childId: `implement-worker#sealed-correction-${String(sequence)}`,
      runId: `sealed-correction-run-${String(sequence)}`,
    };
    const correctionRequest = {
      roleId: "implement-worker" as const,
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
        validationIntent: "final" as const,
        priorResultCommit: subject.receipt.newHead,
      },
      idempotencyKey: `T2081-${String(sequence)}-sealed-correction`,
      timeoutMs: 600_000,
      expectedChild: correctionChild,
      reprepareOf: successor.handle,
    };
    const correction = await subject.capability.prepare(correctionRequest);
    if (!correction.accepted || correction.prepared.gitChangeCapability === undefined) {
      throw new Error(
        `sealed red successor correction refused: ${
          correction.accepted ? "missing Git authority" : correction.detail
        }`,
      );
    }
    expect(await subject.capability.prepare(correctionRequest)).toEqual(correction);
    expect(
      await subject.capability.prepare({
        ...correctionRequest,
        input: { ...correctionRequest.input, headline: "changed task specification" },
      }),
    ).toMatchObject({ accepted: false, reason: "journal-recovery-required" });
    expect(
      await subject.capability.prepare({
        ...correctionRequest,
        idempotencyKey: `${correctionRequest.idempotencyKey}-foreign-source`,
        reprepareOf: source,
      }),
    ).toMatchObject({ accepted: false, reason: "journal-recovery-required" });
    expect(
      await subject.capability.prepare({
        ...correctionRequest,
        idempotencyKey: `${correctionRequest.idempotencyKey}-mixed-authority`,
        continuation: `cq-dispatch-continuation:v1:${"f".repeat(64)}`,
      }),
    ).toMatchObject({ accepted: false, reason: "journal-recovery-required" });

    await subject.capability.fetchInput({
      ...correction.handle,
      inputCapability: correction.prepared.inputCapability,
    });
    await fs.writeFile(path.join(subject.managed.handle.absolutePath, "file.txt"), "corrected\n");
    if (subject.capability.gitCommit === undefined) throw new Error("git_commit unavailable");
    const correctionReceipt = taskReceipt(await subject.capability.gitCommit({
      ...correction.handle,
      gitChangeCapability: correction.prepared.gitChangeCapability,
      operationId: `T2081-${String(sequence)}-sealed-correction-commit`,
      expectedHead: subject.receipt.newHead,
      message: "correct sealed red successor",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("after\n") },
          newState: { mode: "100644", digest: sha256("corrected\n") },
        },
      ],
    }));
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
          checkSummary: "changed sealed correction checks passed",
          summary: "changed correction retains the sealed red predecessor",
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
    if (correctionQualified.state !== "queued") {
      throw new Error("changed sealed correction did not qualify");
    }
    expect(
      await subject.capability.coordinateImplementationCandidate({
        partitionKey: correctionQualified.partitionKey,
        holderId: "t6573-sealed-green-correction",
      }),
    ).toMatchObject({ state: "completed", handle: correction.handle });
    expect(runner.requests).toHaveLength(2);
    expect(subject.store.read(successor.handle)).toMatchObject({
      state: "aborted",
      abortReason: "gate-rejected",
    });
  }, 30_000);
  for (const attestationBackend of ["memory", "sqlite"] as const) {
    test(`a staged-retired recovery source and its cancelled guarded successor advance the current seal (${attestationBackend})`, async () => {
      await exerciseCancelledRecoveryContinuation(
        "guarded-rebase",
        true,
        attestationBackend,
        0,
        false,
      );
    }, RECOVERY_BACKEND_CASE_TIMEOUT_MS);
  }

  test("cancelled guarded recovery workers retain zero one or multiple fresh receipt components after reopen", async () => {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
      for (const receiptCount of [0, 1, 2] as const) {
        await exerciseCancelledRecoveryContinuation(
          "guarded-rebase",
          true,
          attestationBackend,
          receiptCount,
          receiptCount === 1,
        );
      }
    }
  }, 30_000);

  test("cancelled current recovery composes through its exact manual guarded successor", async () => {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
      await exerciseCancelledRecoveryContinuation(
        "ordinary",
        false,
        attestationBackend,
        0,
        false,
        "cancelled-current-manual-guarded",
      );
    }
  }, 30_000);

  test("zero-fresh current recovery failure authenticates its guarded transition vertex", async () => {
    for (const attestationBackend of ["memory", "sqlite"] as const) {
      await exerciseCancelledRecoveryContinuation(
        "guarded-rebase",
        true,
        attestationBackend,
        0,
        false,
        "zero-fresh-failure",
      );
    }
  }, 30_000);

  for (const attestationBackend of ["memory", "sqlite"] as const) {
    test(`ordinary zero-change cancellation after a guarded continuation retains its empty component (${attestationBackend})`, async () => {
      await exerciseCancelledRecoveryContinuation(
        "guarded-rebase",
        false,
        attestationBackend,
        0,
        false,
        "guarded-ordinary-empty-cancel",
      );
    }, 30_000);
  }

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
        const bridgeRounds = 2;
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
            const receipt = taskReceipt(await activeCapability.gitCommit({
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
            }));
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
              `manual guarded successor ${attestationBackend}/${String(freshReceiptCount)}/${String(bridgeRound)} refused: ${guarded.accepted ? "missing Git authority" : guarded.detail}`,
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
            const receipt = taskReceipt(await activeCapability.gitCommit!({
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
            }));
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
            const exactSuccessor = await activeBackend.transact(
              { kind: "handle", handle: guarded.handle },
              (store) => store.read(guarded.handle),
            );
            if (
              exactSource === undefined ||
              isAttestationTombstone(exactSource) ||
              exactSource.gitEffectBinding === undefined ||
              exactSource.dispatchJournalRecoveryClaim === undefined ||
              exactSuccessor === undefined ||
              isAttestationTombstone(exactSuccessor)
            ) {
              throw new Error("manual recovery source lost its authenticated context");
            }
            const journalBeforeControls = await recoveryJournal.read("T2081");
            const rowsBeforeControls = await activeBackend.transact(
              { kind: "namespace" },
              (store) => store.rows().length,
            );
            const rejectSourceMutation = async (
              cause: string,
              mutate: (row: AttestationEnvelope) => AttestationEnvelope,
            ): Promise<void> => {
              await activeBackend.transact({ kind: "handle", handle: source.handle }, (store) => {
                const current = store.read(source.handle);
                if (current === undefined) throw new Error("manual recovery source disappeared");
                store.replace(current, mutate(exactSource));
              });
              await expect(activeCapability.resolveRecovery!(binding, guardedTip)).rejects.toThrow(
                cause,
              );
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
            for (const [cause, mutate] of [
              [
                "cause=retained-source-prepare-digest-mismatch",
                (row: AttestationEnvelope): AttestationEnvelope => ({
                  ...row,
                  prepareRequestDigest: "0".repeat(64),
                }),
              ],
              [
                "cause=source-terminal-mismatch",
                (row: AttestationEnvelope): AttestationEnvelope => ({
                  ...row,
                  terminalDigest: "0".repeat(64),
                }),
              ],
              [
                "journal recovery successor carries a foreign or stale managed binding",
                (row: AttestationEnvelope): AttestationEnvelope => ({
                  ...row,
                  gitEffectBinding: { ...row.gitEffectBinding!, repositoryId: "0".repeat(64) },
                }),
              ],
              [
                "cause=retained-claim-binding-mismatch",
                (row: AttestationEnvelope): AttestationEnvelope => ({
                  ...row,
                  dispatchJournalRecoveryClaim: {
                    ...taskRecoveryClaim(row.dispatchJournalRecoveryClaim!),
                    taskId: "T9999",
                  },
                }),
              ],
              [
                "cause=retained-source-prepare-digest-mismatch",
                (row: AttestationEnvelope): AttestationEnvelope => ({
                  ...row,
                  dispatchJournalRecoveryClaim: {
                    ...taskRecoveryClaim(row.dispatchJournalRecoveryClaim!),
                    goalRef: "goals:G9999",
                  },
                }),
              ],
              [
                "cause=retained-seed-task-mismatch",
                (row: AttestationEnvelope): AttestationEnvelope => ({
                  ...row,
                  dispatchJournalRecoveryClaim: {
                    ...taskRecoveryClaim(row.dispatchJournalRecoveryClaim!),
                    finalizedManifestDigest: "0".repeat(64),
                  },
                }),
              ],
              [
                "cause=retained-claim-binding-mismatch",
                (row: AttestationEnvelope): AttestationEnvelope => ({
                  ...row,
                  dispatchJournalRecoveryClaim: {
                    ...row.dispatchJournalRecoveryClaim!,
                    gitReceiptsDigest: "0".repeat(64),
                  },
                }),
              ],
            ] as const) {
              await rejectSourceMutation(cause, mutate);
            }
            await activeBackend.transact({ kind: "handle", handle: guarded.handle }, (store) => {
              const current = store.read(guarded.handle);
              if (current === undefined) throw new Error("manual guarded successor disappeared");
              store.replace(current, {
                ...exactSuccessor,
                prepareRequestDigest: "0".repeat(64),
              });
            });
            await expect(activeCapability.resolveRecovery!(binding, guardedTip)).rejects.toThrow(
              "cause=successor-prepare-digest-mismatch",
            );
            expect(await recoveryJournal.read("T2081")).toEqual(journalBeforeControls);
            await activeBackend.transact({ kind: "handle", handle: guarded.handle }, (store) => {
              const current = store.read(guarded.handle);
              if (current === undefined) throw new Error("mutated guarded successor disappeared");
              store.replace(current, exactSuccessor);
            });
            expect(
              await activeBackend.transact({ kind: "namespace" }, (store) => store.rows().length),
            ).toBe(rowsBeforeControls);
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

    // D405: pre-merge WIP CLOSURE and terminal DISPOSAL are different gates.
    // The projection above closes the reserved parent-owned checkpoint, so
    // closure holds at this tip — but the artifact is still IN the tree that
    // release fast-forwards into integration, which is exactly how completed
    // artifacts used to land there permanently.
    const retained = await releaseManagedWorktree(
      {
        handle: subject.managed.handle,
        terminalDisposition: "done",
        resultCommit: subject.receipt.newHead,
      },
      { stateDir: subject.stateDir },
    );
    expect(retained).toMatchObject({ status: "refused", reason: "wip-retained" });

    // Disposing the artifact and committing that deletion releases cleanly,
    // and the checkpoint commit stays reachable behind the disposal tip.
    await git(subject.managed.handle.absolutePath, [
      "rm",
      "-q",
      `WIP-${subject.managed.handle.taskId}.md`,
    ]);
    await git(subject.managed.handle.absolutePath, [
      "commit",
      "-q",
      "-m",
      `dispose WIP-${subject.managed.handle.taskId}.md`,
    ]);
    const disposedTip = await git(subject.managed.handle.absolutePath, ["rev-parse", "HEAD"]);
    expect(disposedTip).not.toBe(subject.receipt.newHead);

    const released = await releaseManagedWorktree(
      {
        handle: subject.managed.handle,
        terminalDisposition: "done",
        resultCommit: disposedTip,
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
    const rejected = await finalize(subject);
    expect(rejected).toMatchObject({
      state: "aborted",
      result: {
        reason: "invalid-output",
        details: { phase: "supervised-gate-preflight", code: "wip-open" },
      },
    });
    expect(await subject.capability.fetch(subject.prepared)).toMatchObject({
      state: "aborted",
      reason: "invalid-output",
      details: { phase: "supervised-gate-preflight", code: "wip-open" },
    });
    await expect(resolveRecovery(subject)).rejects.toThrow(
      "no parent-lost dispatch recovery is bound to this managed handle and live tip",
    );
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
    expect(await finalize(subject)).toMatchObject({
      state: "aborted",
      result: { reason: "invalid-output", details: { code: "wip-open" } },
    });
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
    expect(await finalize(subject)).toMatchObject({
      state: "aborted",
      result: { reason: "invalid-output", details: { code: "wip-open" } },
    });
    expect(runner.requests).toEqual([]);
  });

  test.each(["memory", "sqlite"] as const)(
    "D521 current recovery corrects rejected WIP before its first gate (%s) [Behavioral-Progression Effectual-GoodCommunication]",
    async (attestationBackend) => {
      const runner = new GateDummy();
      const subject = await fixtureWithDispatchBase(
        runner,
        "managed",
        () => "2026-08-12T20:00:00.000Z",
        "inherited-current-open",
        true,
        undefined,
        artifactStore(),
        attestationBackend,
      );
      const capability = createDispatchCapability({
        ...subject.capabilityOptions,
        recoveryJournal: new InMemoryCurrentRecoverySealJournalStore(),
      });
      if (
        capability.qualifyImplementationCandidate === undefined ||
        capability.coordinateImplementationCandidate === undefined ||
        capability.gitCommit === undefined
      ) throw new Error("D521 fixture lacks the production candidate runtime");
      const qualify = async (
        prepared: typeof subject.prepared,
        child: typeof subject.expectedChild,
      ) => {
        const qualified = await capability.qualifyImplementationCandidate!({
          attestationId: prepared.attestationId,
          generation: prepared.generation,
          roleId: "implement-worker",
          correlationId: child.childId.slice("implement-worker#".length),
          childThreadId: `d521-${attestationBackend}-${String(prepared.generation)}`,
          expectedRunId: child.runId,
          outcome: "completed",
          exitStatus: 0,
          observedAt: "2026-08-12T20:00:02.000Z",
          promptDigest: prepared.promptProvenance.promptDigest,
        });
        if (qualified.state !== "queued") throw new Error("D521 candidate was not queued");
        return qualified;
      };
      try {
        expect(await capability.storeResult({
          resultCapability: subject.prepared.resultCapability,
          output: subject.output,
        })).toMatchObject({ state: "gate-pending" });
        const initial = await qualify(subject.prepared, subject.expectedChild);
        await expect(capability.coordinateImplementationCandidate({
          partitionKey: initial.partitionKey,
          holderId: `d521-rejected-${attestationBackend}`,
        })).rejects.toThrow();
        expect(await capability.fetch(subject.prepared)).toMatchObject({
          state: "aborted",
          reason: "invalid-output",
          details: { phase: "supervised-gate-preflight", code: "wip-open" },
        });
        expect(runner.requests).toHaveLength(0);
        const recovered = await resolveRecovery({ ...subject, capability });
        if (recovered.preparation.kind !== "current") {
          throw new Error("D521 finalized task did not obtain current recovery preparation");
        }
        const child = {
          childId: `implement-worker#d521-correction-${attestationBackend}-${String(sequence)}`,
          runId: `d521-correction-${attestationBackend}-${String(sequence)}`,
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
            priorResultCommit: subject.receipt.newHead,
            validationIntent: "final",
          },
          idempotencyKey: `d521-correction-${attestationBackend}-${String(sequence)}`,
          timeoutMs: 600_000,
          expectedChild: child,
          recoveryPreparation: recovered.preparation.recoveryPreparation,
        });
        if (!correction.accepted) throw new Error(correction.detail);
        if (correction.prepared.gitChangeCapability === undefined) {
          throw new Error("D521 correction lacks broker authority");
        }
        await capability.fetchInput({
          ...correction.handle,
          inputCapability: correction.prepared.inputCapability,
        });
        const wipPath = "WIP-T2081.md";
        const absoluteWip = path.join(subject.managed.handle.absolutePath, wipPath);
        const before = await fs.readFile(absoluteWip, "utf8");
        const after = wipFixtureBody("T2081", subject.dispatchBaseCommit, "Implementation corrected.\n");
        await fs.writeFile(absoluteWip, after);
        const receipt = taskReceipt(await capability.gitCommit({
          ...correction.handle,
          gitChangeCapability: correction.prepared.gitChangeCapability,
          operationId: `d521-correct-${attestationBackend}-${String(sequence)}`,
          expectedHead: subject.receipt.newHead,
          message: "correct incomplete WIP before the first gate",
          changes: [{
            kind: "modify",
            path: wipPath,
            oldState: { mode: "100644", digest: sha256(before) },
            newState: { mode: "100644", digest: sha256(after) },
          }],
        }));
        expect(await capability.storeResult({
          resultCapability: correction.prepared.resultCapability,
          output: {
            ...subject.output,
            resultCommit: receipt.newHead,
            filesTouched: ["file.txt", wipPath].sort(),
            gitReceipts: [{ ...receipt, objectOids: [...receipt.objectOids], paths: [...receipt.paths] }],
            baseVerification: { ...subject.output.baseVerification, headCommit: receipt.newHead },
          },
        })).toMatchObject({ state: "gate-pending" });
        const qualified = await qualify(correction.prepared, child);
        expect(await capability.coordinateImplementationCandidate({
          partitionKey: qualified.partitionKey,
          holderId: `d521-corrected-${attestationBackend}`,
        })).toMatchObject({ state: "completed" });
        expect(await capability.fetch(correction.handle)).toMatchObject({
          state: "consumed",
          output: { resultCommit: receipt.newHead },
        });
        expect(runner.requests).toHaveLength(1);
      } finally {
        await subject.backend.close();
      }
    },
    RECOVERY_BACKEND_CASE_TIMEOUT_MS,
  );

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
    expect(await finalize(malformed)).toMatchObject({
      state: "aborted",
      result: { reason: "invalid-output", details: { code: "wip-malformed" } },
    });
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
