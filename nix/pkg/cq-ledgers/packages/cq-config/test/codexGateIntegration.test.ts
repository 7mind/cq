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
  launchRegisteredGateCommand,
  readProcessIdentity,
  releaseWorktreeGate,
  settleProcessGroups,
  type LaunchedGateCommand,
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

interface LifecycleFixture {
  readonly root: string;
  readonly worktree: string;
  readonly equivalentWorktree: string;
  readonly promptRoot: string;
  readonly fakeCodex: string;
  readonly codexReady: string;
  readonly codexSignals: string;
  readonly gateReady: string;
  readonly gateSignals: string;
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
    codexSignals: join(root, "codex.signals"),
    gateReady: join(root, "gate.ready"),
    gateSignals: join(root, "gate.signals"),
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

async function waitForDead(registration: ProcessGroupRegistration): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const observed = await readProcessIdentity(registration.leader.pid);
    if (observed === null || observed.startTime !== registration.leader.startTime) return;
    await Bun.sleep(2);
  }
  throw new Error(`process ${String(registration.leader.pid)} remained alive`);
}

async function launchGate(
  fixture: LifecycleFixture,
): Promise<{ readonly lease: WorktreeGateLease; readonly command: LaunchedGateCommand }> {
  const lease = await acquireWorktreeGate({
    worktree: fixture.worktree,
    commandCwd: fixture.worktree,
  });
  const command = await launchRegisteredGateCommand(lease, [
    process.execPath,
    "run",
    GATE_FIXTURE,
    fixture.gateReady,
    fixture.gateSignals,
  ]);
  await waitForPid(fixture.gateReady);
  return { lease, command };
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
      expect(await readProcessIdentity(gate.command.registration.leader.pid)).toEqual(
        gate.command.registration.leader,
      );

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
    let rootRegistration: ProcessGroupRegistration | undefined;
    let dispatch: DispatchProcess | undefined;
    try {
      gate = await launchGate(fixture);
      dispatch = launchDispatch(fixture, "wait", 30_000);
      const codexPid = await waitForPid(fixture.codexReady);
      const codexIdentity = await readProcessIdentity(codexPid);
      if (codexIdentity === null) throw new Error("fake Codex exited before signal delivery");
      rootRegistration = { pgid: codexPid, leader: codexIdentity };

      dispatch.child.kill("SIGINT");
      await Bun.sleep(2);
      dispatch.child.kill("SIGTERM");
      await Bun.sleep(2);
      dispatch.child.kill("SIGINT");
      expect(await dispatch.child.exited).toBe(1);
      expect(await dispatch.stdout).toBe("");
      expect(await dispatch.stderr).toMatch(/wrapper received SIG(?:INT|TERM)/u);
      await waitForDead(rootRegistration);
      await waitForDead(gate.command.registration);
      expect(await readSignals(fixture.codexSignals)).toEqual(["SIGTERM"]);
      expect(await readSignals(fixture.gateSignals)).toEqual(["SIGTERM"]);
    } finally {
      if (rootRegistration !== undefined) await settleRegistration(rootRegistration);
      if (gate !== undefined) await releaseWorktreeGate(gate.lease);
      dispatch?.child.kill("SIGKILL");
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("timeout removes the Codex root and every registered gate process group", async () => {
    const fixture = await createLifecycleFixture();
    let gate: Awaited<ReturnType<typeof launchGate>> | undefined;
    let rootRegistration: ProcessGroupRegistration | undefined;
    let dispatch: DispatchProcess | undefined;
    try {
      gate = await launchGate(fixture);
      dispatch = launchDispatch(fixture, "wait", 200);
      const codexPid = await waitForPid(fixture.codexReady);
      const codexIdentity = await readProcessIdentity(codexPid);
      if (codexIdentity === null) throw new Error("fake Codex exited before timeout");
      rootRegistration = { pgid: codexPid, leader: codexIdentity };

      expect(await dispatch.child.exited).toBe(1);
      expect(await dispatch.stdout).toBe("");
      expect(await dispatch.stderr).toContain("child exceeded its 200 ms window");
      await waitForDead(rootRegistration);
      await waitForDead(gate.command.registration);
    } finally {
      if (rootRegistration !== undefined) await settleRegistration(rootRegistration);
      if (gate !== undefined) await releaseWorktreeGate(gate.lease);
      dispatch?.child.kill("SIGKILL");
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
