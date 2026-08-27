import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  acquireWorktreeGate,
  closeWorktreeGate,
  isProcessGroupAlive,
  isRegisteredProcessGroupAlive,
  launchRegisteredGateCommand,
  readProcessIdentity,
  settleProcessGroups,
  type LaunchedGateCommand,
  type ProcessIdentity,
  type ProcessGroupRegistration,
  type WorktreeGateLease,
} from "@cq/process-control";

const HANDLE = {
  attestationId: "att_0123456789abcdefghijklmnopqrstuvwxyz",
  generation: 3,
} as const;
const DISPATCH_SCRIPT = fileURLToPath(
  new URL("../scripts/codex-role-dispatch.ts", import.meta.url),
);
const CQ_CLI_SOURCE = fileURLToPath(new URL("../../cq-cli/src/main.ts", import.meta.url));
const INSTALLED_DISPATCH = process.env["CQ_TEST_CODEX_ROLE_EXECUTABLE"];
const GIT_EXECUTABLE = process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git";
const FAKE_CODEX_SOURCE = fileURLToPath(new URL("./codexLifecycleFake.ts", import.meta.url));
const GATE_FIXTURE = fileURLToPath(new URL("./codexGateCommandFixture.ts", import.meta.url));
const ROLE_TIMEOUT_WINDOW_MS = 30_000;
const CONTROLLED_DEADLINE_MS = 2_000;

// Orchestration waits (the fake Codex publishing its group file, a gate
// command its ready file, a registered process exiting) get a generous
// wall-clock deadline in line with the role protocol's own 30 s window: under
// full-gate parallel load even simple file polls can stall without anything
// being wrong (D277 — the previous fixed 500x2 ms poll budgets collapsed
// under load). No invariant under test is timed by these waits; the tight
// CONTROLLED_DEADLINE_MS bound stays reserved for the timeout-path test.
const ORCHESTRATION_WAIT_MS = 30_000;
// Several orchestration waits sequence within one test (fixture launch, group
// publication, settlement), so the per-test timeout must cover the worst-case
// sequencing rather than a single budget.
const LIFECYCLE_TEST_TIMEOUT_MS = 2 * ORCHESTRATION_WAIT_MS;

interface ProcessGroupMemberObservation {
  readonly identity: ProcessIdentity;
  readonly pgid: number;
}

interface CodexGroupObservation {
  readonly registration: ProcessGroupRegistration;
  readonly members: readonly ProcessIdentity[];
  readonly identityHelper: string | null;
}

interface RegisteredGroupObservation {
  readonly registration: ProcessGroupRegistration;
  readonly members: readonly ProcessGroupMemberObservation[];
}

interface GateReadyRecord {
  readonly targetPid: number;
  readonly memberPid: number;
}

interface LifecycleFixture {
  readonly root: string;
  readonly worktree: string;
  readonly promptRoot: string;
  readonly fakeCodex: string;
  readonly ledgerCommand: string;
  readonly codexReady: string;
  readonly codexGroup: string;
  readonly codexSignals: string;
  readonly codexRelease: string;
  readonly gateReady: readonly [string, string];
  readonly gateSignals: readonly [string, string];
}

interface DispatchProcess {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
}

async function createLifecycleFixture(): Promise<LifecycleFixture> {
  const root = await mkdtemp(join(tmpdir(), "cq-codex-lifecycle-"));
  const worktree = join(root, "worktree");
  const promptRoot = join(root, "prompts");
  const fakeCodex = join(root, "fake-codex");
  const ledgerCommand = join(root, "cq");
  await mkdir(worktree);
  await writeFile(join(worktree, "cq.toml"), '[ledger]\nbackend = "fs"\n');
  const git = spawnSync(GIT_EXECUTABLE, ["init", "--quiet", worktree], {
    encoding: "utf8",
  });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
  await mkdir(join(promptRoot, "roles"), { recursive: true });
  await writeFile(join(promptRoot, "roles", "implement-worker.md"), "Store one result.\n");
  await writeFile(
    fakeCodex,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(FAKE_CODEX_SOURCE)}\n`,
  );
  await chmod(fakeCodex, 0o700);
  await writeFile(
    ledgerCommand,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(CQ_CLI_SOURCE)} "$@"\n`,
  );
  await chmod(ledgerCommand, 0o700);
  return {
    root,
    worktree,
    promptRoot,
    fakeCodex,
    ledgerCommand,
    codexReady: join(root, "codex.ready"),
    codexGroup: join(root, "codex.group.json"),
    codexSignals: join(root, "codex.signals"),
    codexRelease: join(root, "codex.release"),
    gateReady: [join(root, "gate-0.ready"), join(root, "gate-1.ready")],
    gateSignals: [join(root, "gate-0.signals"), join(root, "gate-1.signals")],
  };
}

function invocation(fixture: LifecycleFixture, timeoutMs: number): string {
  return `${JSON.stringify({
    roleId: "implement-worker",
    handle: HANDLE,
    inputCapability: {
      scope: "fetch-input",
      token: "cq_input_0123456789abcdefghijklmnopqrstuvwxyz",
    },
    resultCapability: {
      scope: "store-result",
      token: "cq_result_0123456789abcdefghijklmnopqrstuvwxyz",
    },
    gitChangeCapability: {
      scope: "git-change",
      token: "cq_git_0123456789abcdefghijklmnopqrstuvwxyz",
    },
    effectTargetRef: "tasks:T1983",
    cwd: fixture.worktree,
    ledgerCwd: fixture.worktree,
    model: "fake-model",
    reasoningEffort: "high",
    sandboxMode: "danger-full-access",
    timeoutMs,
  })}\n`;
}

function launchDispatch(
  fixture: LifecycleFixture,
  mode: "invalid-result" | "success" | "wait",
  timeoutMs: number,
): DispatchProcess {
  const argv =
    INSTALLED_DISPATCH === undefined
      ? [process.execPath, "run", DISPATCH_SCRIPT]
      : [INSTALLED_DISPATCH];
  const child = Bun.spawn(argv, {
    cwd: fixture.worktree,
    env: {
      ...process.env,
      CQ_PROMPT_ROOT: fixture.promptRoot,
      CQ_CODEX_EXECUTABLE: fixture.fakeCodex,
      CQ_CODEX_LEDGER_COMMAND: fixture.ledgerCommand,
      CQ_TEST_CODEX_MODE: mode,
      CQ_TEST_CODEX_READY: fixture.codexReady,
      CQ_TEST_CODEX_GROUP: fixture.codexGroup,
      CQ_TEST_CODEX_SIGNALS: fixture.codexSignals,
      CQ_TEST_CODEX_RELEASE: fixture.codexRelease,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(invocation(fixture, timeoutMs));
  child.stdin.end();
  return {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

async function waitForGateReady(path: string): Promise<GateReadyRecord> {
  const deadline = Date.now() + ORCHESTRATION_WAIT_MS;
  for (;;) {
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as GateReadyRecord;
      if (
        Number.isSafeInteger(record.targetPid) &&
        record.targetPid > 1 &&
        Number.isSafeInteger(record.memberPid) &&
        record.memberPid > 1
      ) {
        return record;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`gate command did not publish ${path} before its orchestration deadline`);
    }
    await Bun.sleep(2);
  }
}

async function waitForCodexGroup(path: string): Promise<CodexGroupObservation> {
  const deadline = Date.now() + ORCHESTRATION_WAIT_MS;
  for (;;) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as CodexGroupObservation;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Codex group did not publish ${path} before its orchestration deadline`);
    }
    await Bun.sleep(2);
  }
}

async function waitForIdentityDead(identity: ProcessIdentity): Promise<void> {
  const deadline = Date.now() + ORCHESTRATION_WAIT_MS;
  for (;;) {
    const observed = await readProcessIdentity(identity.pid);
    if (observed === null || observed.startTime !== identity.startTime) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `process ${String(identity.pid)} remained alive past its orchestration deadline`,
      );
    }
    await Bun.sleep(2);
  }
}

async function readProcessGroup(pid: number): Promise<number> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) throw new Error(`process ${String(pid)} exposed malformed stat data`);
    const processGroup = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u)[2];
    if (processGroup === undefined) {
      throw new Error(`process ${String(pid)} exposed no process group`);
    }
    return Number.parseInt(processGroup, 10);
  }
  const processGroup = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (processGroup.status !== 0 || processGroup.stdout.trim() === "") {
    throw new Error(`could not resolve process group for ${String(pid)}`);
  }
  return Number.parseInt(processGroup.stdout.trim(), 10);
}

async function observeRegisteredGroup(
  registration: ProcessGroupRegistration,
  members: readonly ProcessIdentity[],
): Promise<RegisteredGroupObservation> {
  return {
    registration,
    members: await Promise.all(
      members.map(async (identity) => ({
        identity,
        pgid: await readProcessGroup(identity.pid),
      })),
    ),
  };
}

async function expectRegisteredGroupAlive(observation: RegisteredGroupObservation): Promise<void> {
  expect(observation.registration.leader.pid).toBe(observation.registration.pgid);
  expect(await isRegisteredProcessGroupAlive(observation.registration)).toBe(true);
  expect(await readProcessIdentity(observation.registration.leader.pid)).toEqual(
    observation.registration.leader,
  );
  for (const member of observation.members) {
    expect(member.pgid).toBe(observation.registration.pgid);
    expect(await readProcessIdentity(member.identity.pid)).toEqual(member.identity);
  }
}

async function expectRegisteredGroupDead(observation: RegisteredGroupObservation): Promise<void> {
  const deadline = Date.now() + ORCHESTRATION_WAIT_MS;
  while (isProcessGroupAlive(observation.registration.pgid) && Date.now() < deadline) {
    await Bun.sleep(2);
  }
  expect(isProcessGroupAlive(observation.registration.pgid)).toBe(false);
  expect(await isRegisteredProcessGroupAlive(observation.registration)).toBe(false);
  await Promise.all([
    waitForIdentityDead(observation.registration.leader),
    ...observation.members.map(({ identity }) => waitForIdentityDead(identity)),
  ]);
}

async function launchGate(fixture: LifecycleFixture): Promise<{
  readonly lease: WorktreeGateLease;
  readonly commands: readonly LaunchedGateCommand[];
  readonly groups: readonly RegisteredGroupObservation[];
}> {
  const lease = await acquireWorktreeGate({
    worktree: fixture.worktree,
    commandCwd: fixture.worktree,
  });
  try {
    const commands: LaunchedGateCommand[] = [];
    const groups: RegisteredGroupObservation[] = [];
    for (let index = 0; index < fixture.gateReady.length; index += 1) {
      const ready = fixture.gateReady[index];
      const signals = fixture.gateSignals[index];
      if (ready === undefined || signals === undefined) {
        throw new Error(`gate fixture ${String(index)} has incomplete paths`);
      }
      const command = await launchRegisteredGateCommand(lease, [
        process.execPath,
        "run",
        GATE_FIXTURE,
        ready,
        signals,
      ]);
      commands.push(command);
      const readyRecord = await waitForGateReady(ready);
      const target = await readProcessIdentity(readyRecord.targetPid);
      const member = await readProcessIdentity(readyRecord.memberPid);
      if (target === null || member === null) {
        throw new Error(`gate fixture ${String(index)} exposed a dead target or member`);
      }
      groups.push(await observeRegisteredGroup(command.registration, [target, member]));
    }
    return { lease, commands, groups };
  } catch (error) {
    await closeWorktreeGate(lease);
    throw error;
  }
}

async function readSignals(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function settleRegistration(registration: ProcessGroupRegistration): Promise<void> {
  await settleProcessGroups([registration], { termGraceMs: 100, killGraceMs: 1_000 });
}

async function settleDispatchFixture(dispatch: DispatchProcess | undefined): Promise<void> {
  if (dispatch === undefined) return;
  dispatch.child.kill("SIGTERM");
  const exited = await Promise.race([
    dispatch.child.exited.then(() => true),
    Bun.sleep(6_000).then(() => false),
  ]);
  if (exited) return;
  dispatch.child.kill("SIGKILL");
  await dispatch.child.exited;
}

describe("T1625 Codex and canonical-worktree gate lifecycle [Effectual-GoodCommunication]", () => {
  test("the test process boundary disables inherited Git fsmonitor", () => {
    const configured = spawnSync(
      GIT_EXECUTABLE,
      ["config", "--default", "false", "--get", "--bool", "core.fsmonitor"],
      { encoding: "utf8" },
    );
    expect(configured.status).toBe(0);
    expect(configured.stdout.trim()).toBe("false");
  });

  test(
    "a stored-result handle with a live gate emits nothing and settles only owned groups",
    async () => {
      const fixture = await createLifecycleFixture();
      const unrelatedFixture = await createLifecycleFixture();
      let gate: Awaited<ReturnType<typeof launchGate>> | undefined;
      let unrelatedGate: Awaited<ReturnType<typeof launchGate>> | undefined;
      try {
        gate = await launchGate(fixture);
        unrelatedGate = await launchGate(unrelatedFixture);
        const dispatch = launchDispatch(fixture, "success", 30_000);
        expect(await dispatch.child.exited).toBe(1);
        expect(await dispatch.stdout).toBe("");
        expect(await dispatch.stderr).toContain("live registered gate at child completion");
        const codexGroup = await waitForCodexGroup(fixture.codexGroup);
        expect(codexGroup.registration.leader.pid).toBe(codexGroup.registration.pgid);
        expect(codexGroup.members).toHaveLength(1);
        expect(codexGroup.members[0]?.pid).not.toBe(codexGroup.registration.pgid);
        if (INSTALLED_DISPATCH !== undefined) {
          expect(codexGroup.identityHelper).not.toBeNull();
        }
        if (INSTALLED_DISPATCH !== undefined && process.platform === "darwin") {
          expect(codexGroup.registration.leader.startTime).toMatch(/^\d+\.\d+$/u);
        }
        expect(gate.commands).toHaveLength(2);
        for (const group of gate.groups) {
          await expectRegisteredGroupDead(group);
        }
        for (const group of unrelatedGate.groups) await expectRegisteredGroupAlive(group);
      } finally {
        if (unrelatedGate !== undefined) await closeWorktreeGate(unrelatedGate.lease);
        if (gate !== undefined) await closeWorktreeGate(gate.lease);
        await rm(unrelatedFixture.root, { recursive: true, force: true });
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    LIFECYCLE_TEST_TIMEOUT_MS,
  );

  test(
    "repeated wrapper termination signals settle Codex and gate groups once",
    async () => {
      const fixture = await createLifecycleFixture();
      let gate: Awaited<ReturnType<typeof launchGate>> | undefined;
      let codexGroup: CodexGroupObservation | undefined;
      let dispatch: DispatchProcess | undefined;
      try {
        gate = await launchGate(fixture);
        dispatch = launchDispatch(fixture, "wait", ROLE_TIMEOUT_WINDOW_MS);
        codexGroup = await waitForCodexGroup(fixture.codexGroup);
        expect(codexGroup.members).toHaveLength(2);
        const observedCodexGroup = await observeRegisteredGroup(
          codexGroup.registration,
          codexGroup.members,
        );
        await expectRegisteredGroupAlive(observedCodexGroup);
        for (const group of gate.groups) await expectRegisteredGroupAlive(group);

        dispatch.child.kill("SIGINT");
        await Bun.sleep(2);
        dispatch.child.kill("SIGTERM");
        await Bun.sleep(2);
        dispatch.child.kill("SIGINT");
        expect(await dispatch.child.exited).toBe(1);
        expect(await dispatch.stdout).toBe("");
        expect(await dispatch.stderr).toMatch(/wrapper received SIG(?:INT|TERM)/u);
        await expectRegisteredGroupDead(observedCodexGroup);
        for (const group of gate.groups) await expectRegisteredGroupDead(group);
        expect(await readSignals(fixture.codexSignals)).toEqual(["SIGTERM"]);
        for (const signals of fixture.gateSignals) {
          expect(await readSignals(signals)).toEqual(["SIGTERM"]);
        }
      } finally {
        await settleDispatchFixture(dispatch);
        if (codexGroup !== undefined) await settleRegistration(codexGroup.registration);
        if (gate !== undefined) await closeWorktreeGate(gate.lease);
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    LIFECYCLE_TEST_TIMEOUT_MS,
  );

  test(
    "an installed early interception failure settles Codex and every gate group",
    async () => {
      const fixture = await createLifecycleFixture();
      let gate: Awaited<ReturnType<typeof launchGate>> | undefined;
      let codexGroup: CodexGroupObservation | undefined;
      let dispatch: DispatchProcess | undefined;
      try {
        gate = await launchGate(fixture);
        dispatch = launchDispatch(fixture, "invalid-result", ROLE_TIMEOUT_WINDOW_MS);
        codexGroup = await waitForCodexGroup(fixture.codexGroup);
        expect(codexGroup.members).toHaveLength(1);
        const observedCodexGroup = await observeRegisteredGroup(
          codexGroup.registration,
          codexGroup.members,
        );
        await expectRegisteredGroupAlive(observedCodexGroup);
        for (const group of gate.groups) await expectRegisteredGroupAlive(group);

        await writeFile(fixture.codexRelease, "release\n");
        expect(await dispatch.child.exited).toBe(1);
        expect(await dispatch.stdout).toBe("");
        expect(await dispatch.stderr).toContain("handle-only contract");
        await expectRegisteredGroupDead(observedCodexGroup);
        for (const group of gate.groups) await expectRegisteredGroupDead(group);
      } finally {
        await settleDispatchFixture(dispatch);
        if (codexGroup !== undefined) await settleRegistration(codexGroup.registration);
        if (gate !== undefined) await closeWorktreeGate(gate.lease);
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    LIFECYCLE_TEST_TIMEOUT_MS,
  );

  test(
    "timeout removes the Codex root and every registered gate process group",
    async () => {
      const fixture = await createLifecycleFixture();
      let gate: Awaited<ReturnType<typeof launchGate>> | undefined;
      let codexGroup: CodexGroupObservation | undefined;
      let dispatch: DispatchProcess | undefined;
      try {
        gate = await launchGate(fixture);
        dispatch = launchDispatch(fixture, "wait", CONTROLLED_DEADLINE_MS);
        codexGroup = await waitForCodexGroup(fixture.codexGroup);
        expect(codexGroup.members).toHaveLength(2);
        const observedCodexGroup = await observeRegisteredGroup(
          codexGroup.registration,
          codexGroup.members,
        );
        await expectRegisteredGroupAlive(observedCodexGroup);
        for (const group of gate.groups) await expectRegisteredGroupAlive(group);

        expect(await dispatch.child.exited).toBe(1);
        expect(await dispatch.stdout).toBe("");
        expect(await dispatch.stderr).toContain(
          `child exceeded its ${String(CONTROLLED_DEADLINE_MS)} ms window`,
        );
        await expectRegisteredGroupDead(observedCodexGroup);
        for (const group of gate.groups) await expectRegisteredGroupDead(group);
      } finally {
        await settleDispatchFixture(dispatch);
        if (codexGroup !== undefined) await settleRegistration(codexGroup.registration);
        if (gate !== undefined) await closeWorktreeGate(gate.lease);
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    LIFECYCLE_TEST_TIMEOUT_MS,
  );
});
