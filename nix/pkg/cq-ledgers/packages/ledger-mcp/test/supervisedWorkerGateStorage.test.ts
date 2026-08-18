/** T2081 host-supervised worker gate storage contract. */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  CODEX_STAGED_TIMING_BASIS,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
} from "@cq/config";
import {
  SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS,
  SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
  createNodeSupervisedWorkerGateRunner,
  nodeSupervisedWorkerGateRunner,
  prepareManagedWorktree,
  settleProcessGroups,
  settleWorktreeGateCommands,
  type NodeSupervisedWorkerGateSettlement,
  type ProcessGroupRegistration,
  type SettleProcessGroupsResult,
  type SettleWorktreeGateCommandsOptions,
  type SupervisedWorkerGateRunRequest,
  type SupervisedWorkerGateRunResult,
  type SupervisedWorkerGateRunner,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const exec = promisify(execFile);
const roots: string[] = [];
let sequence = 0;

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

class ThrowingGateDummy implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  constructor(private readonly message: string) {}

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    throw new Error(this.message);
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
    await this.released;
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

async function fixtureWithDispatchBase(
  runner: SupervisedWorkerGateRunner,
  dispatchBaseMode: DispatchBaseMode,
  now: () => string = () => "2026-08-12T20:00:00.000Z",
) {
  sequence += 1;
  const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), `t2081-gate-${sequence}-`));
  roots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "-q"]);
  await fs.writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
  await git(repositoryRoot, ["add", "file.txt"]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  if ((await git(repositoryRoot, ["show", `${baseCommit}:file.txt`])) !== "before") {
    throw new Error("test seed commit does not contain the expected bytes");
  }
  const stateDir = path.join(repositoryRoot, ".manager-state");
  const managed = await prepareManagedWorktree(
    { repositoryRoot, taskId: "T2081", baseCommit },
    { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
  );
  if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
  let dispatchBaseCommit = baseCommit;
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
  const capability = createDispatchCapability({
    backend: new InMemoryAttestationBackend(store),
    promptArtifactStore: artifactStore(),
    repositoryRoot,
    worktreeStateDir: stateDir,
    supervisedWorkerGateRunner: runner,
    now,
    randomBytes: sequentialDispatchRandomBytes(sequence * 32),
  });
  const expectedChild = { childId: `child-${sequence}`, runId: `run-${sequence}` };
  const prepared = await capability.prepare({
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
    },
    idempotencyKey: `T2081-${sequence}`,
    timeoutMs: 600_000,
    expectedChild,
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
    ],
  });
  const output = {
    taskId: "T2081",
    status: "pass",
    resultCommit: receipt.newHead,
    branch: managed.handle.branch,
    actualWorktreePath: managed.handle.absolutePath,
    filesTouched: ["file.txt"],
    gitReceipts: [{ ...receipt, objectOids: [...receipt.objectOids], paths: [...receipt.paths] }],
    checkSummary: "runner-supervised gate requested",
    summary: "candidate exact tip",
    baseVerification: {
      status: "verified",
      relation: "descendant",
      baseCommit: dispatchBaseCommit,
      headCommit: receipt.newHead,
    },
  };
  return {
    capability,
    managed,
    prepared: prepared.prepared,
    receipt,
    output,
    store,
    runner,
    dispatchBaseCommit,
    expectedChild,
  };
}

async function fixture(runner: SupervisedWorkerGateRunner = new GateDummy()) {
  return await fixtureWithDispatchBase(runner, "managed");
}

type GateFixture = Awaited<ReturnType<typeof fixture>>;

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
  | { readonly kind: "reject"; readonly detail: string }
  | { readonly kind: "survivors" };

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
          roleVersion: 8,
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

  test("rejects caller-minted, red, zero-pass, and nonzero-fail evidence", async () => {
    const fabricated = await fixture();
    await expect(
      fabricated.capability.storeResult({
        resultCapability: fabricated.prepared.resultCapability,
        output: { ...fabricated.output, supervisedGateEvidence: {} },
      }),
    ).rejects.toThrow("caller-minted");

    for (const result of [
      { gateExitCode: 1, passCount: 16, failCount: 1 },
      { gateExitCode: 0, passCount: 0, failCount: 0 },
      { gateExitCode: 0, passCount: 17, failCount: 1 },
    ]) {
      const runner = new GateDummy({
        ...result,
        gateDurationMs: 1,
        capturedAt: "2026-08-12T20:00:01.000Z",
        outputTail: "controlled red gate",
      });
      const subject = await fixture(runner);
      expect(await stage(subject)).toMatchObject({ state: "gate-pending" });
      await expect(finalize(subject)).rejects.toThrow("supervised worker gate rejected");
    }
  });

  test("rejects dirty or moving tips and does not run the gate on replay", async () => {
    const dirtyRunner = new GateDummy();
    const dirty = await fixture(dirtyRunner);
    await fs.writeFile(path.join(dirty.managed.handle.absolutePath, "untracked.txt"), "dirty\n");
    await expect(stage(dirty)).resolves.toMatchObject({ state: "gate-pending" });
    await expect(finalize(dirty)).rejects.toThrow("clean result tree");
    expect(dirtyRunner.requests).toHaveLength(0);

    const movingRunner = new MovingTipGateDummy();
    const moving = await fixture(movingRunner);
    await expect(stage(moving)).resolves.toMatchObject({ state: "gate-pending" });
    await expect(finalize(moving)).rejects.toThrow("branch tip moved during the gate");
    expect(movingRunner.requests).toHaveLength(1);

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
    }
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

  // Regression D326: host-gate admission belongs to the supervisor, not the child budget.
  test("D326 lets a second terminal store wait beyond its gate execution budget before admission [Behavioral-Active, Effectual-GoodCommunication]", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "t2082-gate-admission-"));
    roots.push(root);
    const bin = path.join(root, "bin");
    const lock = path.join(root, "exclusive-gate");
    const releaseFirst = path.join(root, "release-first");
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
        '  : > "$CQ_T2082_FIRST_STARTED"',
        '  while test ! -e "$CQ_T2082_RELEASE_FIRST"; do sleep 0.01; done',
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
          admissionTimeoutMs: 1_000,
          executionTimeoutMs: request.worktreePath === heldWorktreePath ? 1_000 : 100,
        }),
    };
    const first = await fixture(phaseBoundRunner);
    heldWorktreePath = first.managed.handle.absolutePath;
    const second = await fixture(phaseBoundRunner);
    const firstStarted = path.join(root, "first-started");
    const priorPath = process.env["PATH"];
    const priorLock = process.env["CQ_T2082_GATE_LOCK"];
    const priorFirstWorktree = process.env["CQ_T2082_FIRST_WORKTREE"];
    const priorFirstStarted = process.env["CQ_T2082_FIRST_STARTED"];
    const priorReleaseFirst = process.env["CQ_T2082_RELEASE_FIRST"];
    process.env["PATH"] = `${bin}${path.delimiter}${priorPath ?? ""}`;
    process.env["CQ_T2082_GATE_LOCK"] = lock;
    process.env["CQ_T2082_FIRST_WORKTREE"] = first.managed.handle.absolutePath;
    process.env["CQ_T2082_FIRST_STARTED"] = firstStarted;
    process.env["CQ_T2082_RELEASE_FIRST"] = releaseFirst;
    let firstStore: Promise<unknown> | undefined;
    let secondStore: Promise<unknown> | undefined;
    try {
      expect(await stage(first)).toMatchObject({ state: "gate-pending" });
      expect(await stage(second)).toMatchObject({ state: "gate-pending" });
      firstStore = finalize(first);
      while (!(await Bun.file(firstStarted).exists())) await Bun.sleep(5);
      secondStore = finalize(second);
      await Bun.sleep(200);
      expect(second.store.rows()).toMatchObject([{ state: "gate-running" }]);
      await fs.writeFile(releaseFirst, "release\n");
      await expect(Promise.all([firstStore, secondStore])).resolves.toMatchObject([
        { state: "result-stored" },
        { state: "result-stored" },
      ]);
      expect(first.store.rows()).toHaveLength(1);
      expect(second.store.rows()).toHaveLength(1);
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
      if (priorFirstStarted === undefined) delete process.env["CQ_T2082_FIRST_STARTED"];
      else process.env["CQ_T2082_FIRST_STARTED"] = priorFirstStarted;
      if (priorReleaseFirst === undefined) delete process.env["CQ_T2082_RELEASE_FIRST"];
      else process.env["CQ_T2082_RELEASE_FIRST"] = priorReleaseFirst;
    }
  });

  // expected-failure: defects:D342
  test.failing(
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

  // expected-failure: defects:D342
  test.failing(
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

  // expected-failure: defects:D342
  test.failing(
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

  // expected-failure: defects:D342
  test.failing(
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
