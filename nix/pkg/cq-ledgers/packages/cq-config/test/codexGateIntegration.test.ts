import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  GateBusyError,
  acquireWorktreeGate,
  closeWorktreeGate,
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
const INSTALLED_DISPATCH = process.env["CQ_TEST_CODEX_ROLE_EXECUTABLE"];
const GIT_EXECUTABLE = process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git";
const FAKE_CODEX_SOURCE = fileURLToPath(new URL("./codexLifecycleFake.ts", import.meta.url));
const GATE_FIXTURE = fileURLToPath(
  new URL("./codexGateCommandFixture.ts", import.meta.url),
);
const ROLE_TIMEOUT_WINDOW_MS = 30_000;

interface CodexGroupObservation {
  readonly registration: ProcessGroupRegistration;
  readonly members: readonly ProcessIdentity[];
  readonly identityHelper: string | null;
}

interface LifecycleFixture {
  readonly root: string;
  readonly worktree: string;
  readonly equivalentWorktree: string;
  readonly promptRoot: string;
  readonly fakeCodex: string;
  readonly codexReady: string;
  readonly codexGroup: string;
  readonly codexSignals: string;
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
  const equivalentWorktree = join(root, "worktree-link");
  const promptRoot = join(root, "prompts");
  const fakeCodex = join(root, "fake-codex");
  await mkdir(worktree);
  const git = spawnSync(GIT_EXECUTABLE, ["init", "--quiet", worktree], {
    encoding: "utf8",
  });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
  await symlink(worktree, equivalentWorktree, "dir");
  await mkdir(join(promptRoot, "roles"), { recursive: true });
  await writeFile(join(promptRoot, "roles", "implement-worker.md"), "Store one result.\n");
  await writeFile(fakeCodex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(FAKE_CODEX_SOURCE)}\n`);
  await chmod(fakeCodex, 0o700);
  return {
    root,
    worktree,
    equivalentWorktree,
    promptRoot,
    fakeCodex,
    codexReady: join(root, "codex.ready"),
    codexGroup: join(root, "codex.group.json"),
    codexSignals: join(root, "codex.signals"),
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
  mode: "success" | "wait",
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
      CQ_CODEX_LEDGER_COMMAND: "cq-not-invoked-by-fake",
      CQ_TEST_CODEX_MODE: mode,
      CQ_TEST_CODEX_READY: fixture.codexReady,
      CQ_TEST_CODEX_GROUP: fixture.codexGroup,
      CQ_TEST_CODEX_SIGNALS: fixture.codexSignals,
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

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await Bun.sleep(2);
  }
  throw new Error(`process did not publish ${path}`);
}

async function waitForCodexGroup(path: string): Promise<CodexGroupObservation> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as CodexGroupObservation;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await Bun.sleep(2);
  }
  throw new Error(`Codex group did not publish ${path}`);
}

async function waitForIdentityDead(identity: ProcessIdentity): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const observed = await readProcessIdentity(identity.pid);
    if (observed === null || observed.startTime !== identity.startTime) return;
    await Bun.sleep(2);
  }
  throw new Error(`process ${String(identity.pid)} remained alive`);
}

async function expectCodexGroupDead(observation: CodexGroupObservation): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (!(await isRegisteredProcessGroupAlive(observation.registration))) break;
    await Bun.sleep(2);
  }
  expect(await isRegisteredProcessGroupAlive(observation.registration)).toBe(false);
  await Promise.all(observation.members.map(waitForIdentityDead));
}

async function launchGate(
  fixture: LifecycleFixture,
): Promise<{
  readonly lease: WorktreeGateLease;
  readonly commands: readonly LaunchedGateCommand[];
}> {
  const lease = await acquireWorktreeGate({
    worktree: fixture.worktree,
    commandCwd: fixture.worktree,
  });
  try {
    const commands: LaunchedGateCommand[] = [];
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
      await waitForPid(ready);
    }
    return { lease, commands };
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
  test("successful stored-result completion emits only its handle and preserves a yielded gate", async () => {
    const fixture = await createLifecycleFixture();
    let gate: Awaited<ReturnType<typeof launchGate>> | undefined;
    try {
      gate = await launchGate(fixture);
      const dispatch = launchDispatch(fixture, "success", 30_000);
      expect(await dispatch.child.exited).toBe(0);
      expect(await dispatch.stdout).toBe(`${JSON.stringify(HANDLE)}\n`);
      expect(await dispatch.stderr).toBe("");
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
      for (const command of gate.commands) {
        expect(await readProcessIdentity(command.registration.leader.pid)).toEqual(
          command.registration.leader,
        );
      }

      const sentinel = join(fixture.root, "second-gate-sentinel");
      const attemptSecondGate = async (): Promise<void> => {
        const secondLease = await acquireWorktreeGate({
          worktree: fixture.equivalentWorktree,
          commandCwd: fixture.equivalentWorktree,
        });
        try {
          await launchRegisteredGateCommand(secondLease, [
            process.execPath,
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "launched")`,
          ]);
        } finally {
          await closeWorktreeGate(secondLease);
        }
      };
      await expect(
        attemptSecondGate(),
      ).rejects.toBeInstanceOf(GateBusyError);
      await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (gate !== undefined) await closeWorktreeGate(gate.lease);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("repeated wrapper termination signals settle Codex and gate groups once", async () => {
    const fixture = await createLifecycleFixture();
    let gate: Awaited<ReturnType<typeof launchGate>> | undefined;
    let codexGroup: CodexGroupObservation | undefined;
    let dispatch: DispatchProcess | undefined;
    try {
      gate = await launchGate(fixture);
      dispatch = launchDispatch(fixture, "wait", ROLE_TIMEOUT_WINDOW_MS);
      codexGroup = await waitForCodexGroup(fixture.codexGroup);
      expect(codexGroup.registration.leader.pid).toBe(codexGroup.registration.pgid);
      expect(codexGroup.members).toHaveLength(2);
      expect(codexGroup.members.map(({ pid }) => pid)).not.toContain(codexGroup.registration.pgid);

      dispatch.child.kill("SIGINT");
      await Bun.sleep(2);
      dispatch.child.kill("SIGTERM");
      await Bun.sleep(2);
      dispatch.child.kill("SIGINT");
      expect(await dispatch.child.exited).toBe(1);
      expect(await dispatch.stdout).toBe("");
      expect(await dispatch.stderr).toMatch(/wrapper received SIG(?:INT|TERM)/u);
      await expectCodexGroupDead(codexGroup);
      await Promise.all(
        gate.commands.map(({ registration }) => waitForIdentityDead(registration.leader)),
      );
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
  });

  test("timeout removes the Codex root and every registered gate process group", async () => {
    const fixture = await createLifecycleFixture();
    let gate: Awaited<ReturnType<typeof launchGate>> | undefined;
    let codexGroup: CodexGroupObservation | undefined;
    let dispatch: DispatchProcess | undefined;
    try {
      gate = await launchGate(fixture);
      dispatch = launchDispatch(fixture, "wait", ROLE_TIMEOUT_WINDOW_MS);
      codexGroup = await waitForCodexGroup(fixture.codexGroup);
      expect(codexGroup.registration.leader.pid).toBe(codexGroup.registration.pgid);
      expect(codexGroup.members).toHaveLength(2);
      dispatch.child.kill("SIGALRM");

      expect(await dispatch.child.exited).toBe(1);
      expect(await dispatch.stdout).toBe("");
      expect(await dispatch.stderr).toContain(
        `child exceeded its ${String(ROLE_TIMEOUT_WINDOW_MS)} ms window`,
      );
      await expectCodexGroupDead(codexGroup);
      await Promise.all(
        gate.commands.map(({ registration }) => waitForIdentityDead(registration.leader)),
      );
    } finally {
      await settleDispatchFixture(dispatch);
      if (codexGroup !== undefined) await settleRegistration(codexGroup.registration);
      if (gate !== undefined) await closeWorktreeGate(gate.lease);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
