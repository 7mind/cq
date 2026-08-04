import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchRegisteredProcessGroup,
  isProcessGroupAlive,
  REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS,
  readProcessIdentity,
  settleProcessGroups,
  signalProcessGroup,
  type ProcessGroupRegistration,
  type RegisteredLaunchBootstrapSpecification,
} from "../src/index.js";

const roots: string[] = [];

function exited(
  child: ChildProcess,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function streamDrained(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (stream === null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
}

function nodeBootstrap(specification: RegisteredLaunchBootstrapSpecification<StdioOptions>) {
  const child = spawn(specification.argv[0], specification.argv.slice(1), {
    cwd: specification.cwd,
    env: specification.env,
    detached: specification.detached,
    stdio: specification.stdio,
  });
  return {
    process: child,
    pid: child.pid,
    exited: exited(child),
    outputDrained: Promise.all([streamDrained(child.stdout), streamDrained(child.stderr)]).then(
      () => {},
    ),
    resultFromTargetOutcome: (outcome: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }) => outcome,
    terminate: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

async function waitForIdentityToDisappear(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if ((await readProcessIdentity(pid)) === null) return;
    await Bun.sleep(2);
  }
  throw new Error(`test process ${pid} did not exit`);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(2);
  }
  throw new Error(`test file ${path} was not created`);
}

// Orchestration waits (a helper process reaching a point in the protocol
// round-trip) get a generous wall-clock deadline in line with the protocol's
// own 30 s identity/handshake budgets: under full-gate parallel load the
// round-trip exceeds any tight fixed budget without anything being wrong.
// The tight REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS bound stays reserved for
// the settlement invariant under test.
const ORCHESTRATION_WAIT_MS = 30_000;

async function waitForFileBy(path: string, deadline: number): Promise<void> {
  for (;;) {
    if (await Bun.file(path).exists()) return;
    if (Date.now() >= deadline) {
      throw new Error(`test file ${path} was not created before its orchestration deadline`);
    }
    await Bun.sleep(2);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForPathToDisappearBy(path: string, deadline: number): Promise<number> {
  for (;;) {
    if (!(await pathExists(path))) return Date.now();
    if (Date.now() >= deadline) {
      throw new Error(`test path ${path} still existed at its settlement deadline`);
    }
    await Bun.sleep(2);
  }
}

async function readLinuxProcessState(pid: number): Promise<string | null> {
  try {
    const processStat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    const commandEnd = processStat.lastIndexOf(")");
    if (commandEnd < 0) throw new Error(`malformed /proc stat for test process ${String(pid)}`);
    return (
      processStat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/u)[0] ?? null
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function waitForLinuxProcessState(pid: number, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if ((await readLinuxProcessState(pid)) === expected) return;
    await Bun.sleep(2);
  }
  throw new Error(`test process ${String(pid)} did not reach state ${expected}`);
}

async function completeBootstrapIfTargetRan(
  child: ChildProcess,
  protocolDirectory: string,
  nonce: string,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) throw new Error("test bootstrap returned no PID");
  const statusPath = join(protocolDirectory, "status.json");
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (await pathExists(statusPath)) {
      const status = JSON.parse(await readFile(statusPath, "utf8")) as {
        readonly state?: string;
      };
      if (status.state === "exited") {
        await writeFile(
          join(protocolDirectory, "completion.json"),
          JSON.stringify({ nonce, pgid: pid }),
        );
        return;
      }
    }
    await Bun.sleep(2);
  }
  throw new Error("test bootstrap neither rejected the mutation nor ran the target");
}

function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      text += chunk;
    });
    stream.once("end", () => resolve(text));
    stream.once("error", reject);
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("registered process-group launch bootstrap [T1624]", () => {
  // Regression origin: D260 left a live target and its bootstrap behind when
  // the authenticated launcher disappeared before the target exited.
  test.skipIf(process.platform !== "linux")(
    "settles a running target when its authenticated launcher exits [Whitebox-GoodCommunication]",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-running-orphan-"));
      roots.push(root);
      const launcherStatePath = join(root, "launcher-state.json");
      const targetPidPath = join(root, "target-pid");
      const registeredLaunchUrl = new URL("../src/registeredLaunch.ts", import.meta.url).href;
      const targetSource = [
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(targetPidPath)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const launcherSource = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const { launchRegisteredProcessGroup } = await import(${JSON.stringify(registeredLaunchUrl)});`,
        "let protocolDirectory;",
        "const launched = await launchRegisteredProcessGroup({",
        `  argv: [process.execPath, '-e', ${JSON.stringify(targetSource)}],`,
        `  cwd: ${JSON.stringify(root)},`,
        "  env: process.env,",
        "  stdio: ['ignore', 'ignore', 'inherit'],",
        "  register: async () => {},",
        "  launchBootstrap: (specification) => {",
        "    protocolDirectory = specification.argv[2];",
        "    const child = spawn(specification.argv[0], specification.argv.slice(1), {",
        "      cwd: specification.cwd,",
        "      env: specification.env,",
        "      detached: specification.detached,",
        "      stdio: specification.stdio,",
        "    });",
        "    return {",
        "      process: child,",
        "      pid: child.pid,",
        "      exited: new Promise((resolve, reject) => {",
        "        child.once('error', reject);",
        "        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));",
        "      }),",
        "      outputDrained: Promise.resolve(),",
        "      resultFromTargetOutcome: (outcome) => outcome,",
        "      terminate: (signal) => child.kill(signal),",
        "    };",
        "  },",
        "});",
        `writeFileSync(${JSON.stringify(launcherStatePath)}, JSON.stringify({`,
        "  protocolDirectory,",
        "  registration: launched.registration,",
        "}));",
        "await launched.exited;",
      ].join("\n");
      const launcher = spawn(process.execPath, ["-e", launcherSource], {
        cwd: root,
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const launcherPid = launcher.pid;
      if (launcherPid === undefined) throw new Error("test launcher returned no PID");
      if (launcher.stderr === null) throw new Error("test launcher returned no stderr pipe");
      const launcherExited = exited(launcher);
      const bootstrapStderr = streamText(launcher.stderr);
      let protocolDirectory: string | undefined;
      let registration: ProcessGroupRegistration | undefined;
      let targetPid: number | undefined;

      try {
        await waitForFile(launcherStatePath);
        const launcherState = JSON.parse(await readFile(launcherStatePath, "utf8")) as {
          readonly protocolDirectory: string;
          readonly registration: ProcessGroupRegistration;
        };
        protocolDirectory = launcherState.protocolDirectory;
        registration = launcherState.registration;
        await waitForFile(targetPidPath);
        targetPid = Number(await readFile(targetPidPath, "utf8"));
        expect(await readProcessIdentity(registration.leader.pid)).toEqual(registration.leader);
        expect(await readProcessIdentity(targetPid)).not.toBeNull();
        expect(isProcessGroupAlive(registration.pgid)).toBe(true);
        expect(await pathExists(protocolDirectory)).toBe(true);
        expect(await pathExists(join(protocolDirectory, "completion.json"))).toBe(false);

        const settlementStarted = Date.now();
        launcher.kill("SIGKILL");
        expect(await launcherExited).toEqual({ exitCode: null, signal: "SIGKILL" });
        const deadline = settlementStarted + REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS;
        let settlementObservedAt: number | undefined;
        for (;;) {
          const observedIdentity = await readProcessIdentity(registration.leader.pid);
          const identityAlive =
            observedIdentity !== null &&
            observedIdentity.startTime === registration.leader.startTime;
          const groupAlive = isProcessGroupAlive(registration.pgid);
          const directoryAlive = await pathExists(protocolDirectory);
          if (!identityAlive && !groupAlive && !directoryAlive) {
            settlementObservedAt = Date.now();
            break;
          }
          if (Date.now() >= deadline) {
            expect({ identityAlive, groupAlive, directoryAlive }).toEqual({
              identityAlive: false,
              groupAlive: false,
              directoryAlive: false,
            });
          }
          await Bun.sleep(2);
        }
        expect(settlementObservedAt).toBeDefined();
        expect(settlementObservedAt! - settlementStarted).toBeLessThanOrEqual(
          REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS,
        );
        expect(await readProcessIdentity(targetPid)).toBeNull();
        expect(await bootstrapStderr).toContain("completion writer identity disappeared");
      } finally {
        if (launcher.exitCode === null && launcher.signalCode === null) {
          launcher.kill("SIGKILL");
          await launcherExited;
        }
        if (registration !== undefined) {
          signalProcessGroup(registration.pgid, "SIGKILL");
          await waitForIdentityToDisappear(registration.leader.pid);
        }
        if (protocolDirectory !== undefined) {
          await rm(protocolDirectory, { recursive: true, force: true });
        }
      }
    },
  );

  // Regression origin: D260 exposed unauthenticated completion-writer cancellation.
  test.skipIf(process.platform !== "linux")(
    "settles an exited bootstrap while its killed completion writer remains unreaped [Whitebox-GoodCommunication]",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-orphan-"));
      roots.push(root);
      const launcherPidPath = join(root, "launcher-pid");
      const launcherStatePath = join(root, "launcher-state.json");
      const descendantPidPath = join(root, "same-group-descendant-pid");
      const registeredLaunchUrl = new URL("../src/registeredLaunch.ts", import.meta.url).href;
      const targetSource = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {",
        "  detached: false,",
        "  stdio: 'ignore',",
        "});",
        "child.unref();",
        `writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
      ].join("\n");
      const launcherSource = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const { launchRegisteredProcessGroup } = await import(${JSON.stringify(registeredLaunchUrl)});`,
        "let protocolDirectory;",
        "const launched = await launchRegisteredProcessGroup({",
        `  argv: [process.execPath, '-e', ${JSON.stringify(targetSource)}],`,
        `  cwd: ${JSON.stringify(root)},`,
        "  env: process.env,",
        "  stdio: ['ignore', 'ignore', 'inherit'],",
        "  register: async () => {},",
        "  onTargetExit: async () => new Promise(() => {}),",
        "  launchBootstrap: (specification) => {",
        "    protocolDirectory = specification.argv[2];",
        "    const child = spawn(specification.argv[0], specification.argv.slice(1), {",
        "      cwd: specification.cwd,",
        "      env: specification.env,",
        "      detached: specification.detached,",
        "      stdio: specification.stdio,",
        "    });",
        "    return {",
        "      process: child,",
        "      pid: child.pid,",
        "      exited: new Promise((resolve, reject) => {",
        "        child.once('error', reject);",
        "        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));",
        "      }),",
        "      outputDrained: Promise.resolve(),",
        "      resultFromTargetOutcome: (outcome) => outcome,",
        "      terminate: (signal) => child.kill(signal),",
        "    };",
        "  },",
        "});",
        `writeFileSync(${JSON.stringify(launcherStatePath)}, JSON.stringify({`,
        "  protocolDirectory,",
        "  registration: launched.registration,",
        "}));",
        "setInterval(() => {}, 1000);",
        "await launched.exited;",
      ].join("\n");
      const launcherParentSource = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const launcher = spawn(process.execPath, ['-e', ${JSON.stringify(launcherSource)}], {`,
        `  cwd: ${JSON.stringify(root)},`,
        "  env: process.env,",
        "  stdio: ['ignore', 'ignore', 'inherit'],",
        "});",
        `writeFileSync(${JSON.stringify(launcherPidPath)}, String(launcher.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const launcherParent = spawn(process.execPath, ["-e", launcherParentSource], {
        cwd: root,
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const launcherParentPid = launcherParent.pid;
      if (launcherParentPid === undefined) throw new Error("test launcher parent returned no PID");
      if (launcherParent.stderr === null) {
        throw new Error("test launcher parent returned no stderr pipe");
      }
      const launcherParentExited = exited(launcherParent);
      const bootstrapStderr = streamText(launcherParent.stderr);
      let launcherPid: number | undefined;
      let descendantPid: number | undefined;
      let protocolDirectory: string | undefined;
      let registration: ProcessGroupRegistration | undefined;

      try {
        await waitForFile(launcherPidPath);
        launcherPid = Number(await readFile(launcherPidPath, "utf8"));
        await waitForFile(launcherStatePath);
        const launcherState = JSON.parse(await readFile(launcherStatePath, "utf8")) as {
          readonly protocolDirectory: string;
          readonly registration: ProcessGroupRegistration;
        };
        protocolDirectory = launcherState.protocolDirectory;
        registration = launcherState.registration;
        await waitForFile(descendantPidPath);
        descendantPid = Number(await readFile(descendantPidPath, "utf8"));
        const statusPath = join(protocolDirectory, "status.json");
        for (let attempt = 0; attempt < 1_000; attempt += 1) {
          if (await Bun.file(statusPath).exists()) {
            const status = JSON.parse(await readFile(statusPath, "utf8")) as {
              readonly state?: string;
            };
            if (status.state === "exited") break;
          }
          if (attempt === 999) throw new Error("target did not publish exited status");
          await Bun.sleep(2);
        }
        expect(await Bun.file(join(protocolDirectory, "completion.json")).exists()).toBe(false);

        process.kill(launcherParentPid, "SIGSTOP");
        await waitForLinuxProcessState(launcherParentPid, "T");
        const settlementStarted = Date.now();
        process.kill(launcherPid, "SIGKILL");
        await waitForLinuxProcessState(launcherPid, "Z");
        const deadline = settlementStarted + REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS;
        let settlementObservedAt: number | undefined;
        for (;;) {
          const observedIdentity = await readProcessIdentity(registration.leader.pid);
          const identityAlive =
            observedIdentity !== null &&
            observedIdentity.startTime === registration.leader.startTime;
          const groupAlive = isProcessGroupAlive(registration.pgid);
          const directoryAlive = await pathExists(protocolDirectory);
          if (!identityAlive && !groupAlive && !directoryAlive) {
            settlementObservedAt = Date.now();
            break;
          }
          if (Date.now() >= deadline) {
            expect({ identityAlive, groupAlive, directoryAlive }).toEqual({
              identityAlive: false,
              groupAlive: false,
              directoryAlive: false,
            });
          }
          await Bun.sleep(2);
        }
        expect(await readLinuxProcessState(launcherPid)).toBe("Z");
        expect(settlementObservedAt).toBeDefined();
        expect(settlementObservedAt! - settlementStarted).toBeLessThanOrEqual(
          REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS,
        );
        expect(await readProcessIdentity(descendantPid)).toBeNull();
        launcherParent.kill("SIGKILL");
        await launcherParentExited;
        expect(await bootstrapStderr).toContain("completion writer identity disappeared");
      } finally {
        if (launcherPid !== undefined && (await readLinuxProcessState(launcherPid)) !== null) {
          process.kill(launcherPid, "SIGKILL");
        }
        if (launcherParent.exitCode === null && launcherParent.signalCode === null) {
          launcherParent.kill("SIGKILL");
          await launcherParentExited;
        }
        if (registration !== undefined) {
          signalProcessGroup(registration.pgid, "SIGKILL");
          await waitForIdentityToDisappear(registration.leader.pid);
        }
        if (protocolDirectory !== undefined) {
          await rm(protocolDirectory, { recursive: true, force: true });
        }
      }
    },
  );

  // Regression origin: D265 left the nonce protocol directory stranded when the
  // launcher died after the bootstrap's final liveness check but before the
  // launcher's own cleanup finally ran.
  test.skipIf(process.platform !== "linux")(
    "removes the nonce protocol directory when the launcher hard-exits as completion is consumed [Whitebox-GoodCommunication]",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-completion-window-"));
      roots.push(root);
      const launcherStatePath = join(root, "launcher-state.json");
      const hardExitMarkerPath = join(root, "hard-exit-observed");
      const registeredLaunchUrl = new URL("../src/registeredLaunch.ts", import.meta.url).href;
      const launcherSource = [
        "const { spawn } = require('node:child_process');",
        "const { existsSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        `const { launchRegisteredProcessGroup } = await import(${JSON.stringify(registeredLaunchUrl)});`,
        "let protocolDirectory;",
        "const launched = await launchRegisteredProcessGroup({",
        "  argv: [process.execPath, '-e', 'process.exit(0)'],",
        `  cwd: ${JSON.stringify(root)},`,
        "  env: process.env,",
        "  stdio: ['ignore', 'ignore', 'inherit'],",
        "  register: async () => {},",
        "  launchBootstrap: (specification) => {",
        "    protocolDirectory = specification.argv[2];",
        "    const child = spawn(specification.argv[0], specification.argv.slice(1), {",
        "      cwd: specification.cwd,",
        "      env: specification.env,",
        "      detached: specification.detached,",
        "      stdio: specification.stdio,",
        "    });",
        "    return {",
        "      process: child,",
        "      pid: child.pid,",
        "      exited: new Promise((resolve, reject) => {",
        "        child.once('error', reject);",
        "        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));",
        "      }),",
        "      outputDrained: Promise.resolve(),",
        "      resultFromTargetOutcome: (outcome) => outcome,",
        "      terminate: (signal) => child.kill(signal),",
        "    };",
        "  },",
        "});",
        `writeFileSync(${JSON.stringify(launcherStatePath)}, JSON.stringify({`,
        "  protocolDirectory,",
        "  registration: launched.registration,",
        "}));",
        // The completion file disappears only when the bootstrap consumes it,
        // which happens strictly after the bootstrap's final launcher-liveness
        // check (the D265 window); hard-exit there so the cleanup finally in
        // registeredLaunch.ts never runs. Wait for its appearance first so the
        // poll observes disappearance, not the pre-write phase.
        "const completionPath = join(protocolDirectory, 'completion.json');",
        `const orchestrationDeadline = Date.now() + ${String(ORCHESTRATION_WAIT_MS)};`,
        "while (!existsSync(completionPath)) {",
        "  if (Date.now() >= orchestrationDeadline) {",
        "    console.error('completion.json did not appear before the orchestration deadline');",
        "    process.exit(1);",
        "  }",
        "  await new Promise((resolve) => setTimeout(resolve, 2));",
        "}",
        "for (;;) {",
        "  if (!existsSync(completionPath)) {",
        `    writeFileSync(${JSON.stringify(hardExitMarkerPath)}, String(process.pid));`,
        "    process.exit(0);",
        "  }",
        "  if (Date.now() >= orchestrationDeadline) {",
        "    console.error('completion.json was not consumed before the orchestration deadline');",
        "    process.exit(1);",
        "  }",
        "  await new Promise((resolve) => setTimeout(resolve, 2));",
        "}",
      ].join("\n");
      const launcher = spawn(process.execPath, ["-e", launcherSource], {
        cwd: root,
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const launcherPid = launcher.pid;
      if (launcherPid === undefined) throw new Error("test launcher returned no PID");
      if (launcher.stderr === null) throw new Error("test launcher returned no stderr pipe");
      const launcherExited = exited(launcher);
      const bootstrapStderr = streamText(launcher.stderr);
      let protocolDirectory: string | undefined;
      let registration: ProcessGroupRegistration | undefined;

      try {
        const orchestrationDeadline = Date.now() + ORCHESTRATION_WAIT_MS;
        await waitForFileBy(launcherStatePath, orchestrationDeadline);
        const launcherState = JSON.parse(await readFile(launcherStatePath, "utf8")) as {
          readonly protocolDirectory: string;
          readonly registration: ProcessGroupRegistration;
        };
        protocolDirectory = launcherState.protocolDirectory;
        registration = launcherState.registration;

        await waitForFileBy(hardExitMarkerPath, orchestrationDeadline);
        expect(await launcherExited).toEqual({ exitCode: 0, signal: null });
        expect(await readProcessIdentity(launcherPid)).toBeNull();
        expect(await bootstrapStderr).toBe("");

        const deadline = Date.now() + REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS;
        for (;;) {
          const leaderIdentity = await readProcessIdentity(registration.leader.pid);
          const directoryAlive = await pathExists(protocolDirectory);
          if (leaderIdentity === null && !directoryAlive) break;
          if (Date.now() >= deadline) {
            expect({
              leaderGone: leaderIdentity === null,
              directoryAlive,
              statusAlive: await pathExists(join(protocolDirectory, "status.json")),
            }).toEqual({ leaderGone: true, directoryAlive: false, statusAlive: false });
          }
          await Bun.sleep(2);
        }
        expect(await readProcessIdentity(registration.leader.pid)).toBeNull();
        expect(await pathExists(protocolDirectory)).toBe(false);
      } finally {
        if (launcher.exitCode === null && launcher.signalCode === null) {
          launcher.kill("SIGKILL");
          await launcherExited;
        }
        if (registration !== undefined) {
          signalProcessGroup(registration.pgid, "SIGKILL");
          await waitForIdentityToDisappear(registration.leader.pid);
        }
        if (protocolDirectory !== undefined) {
          await rm(protocolDirectory, { recursive: true, force: true });
        }
      }
    },
    ORCHESTRATION_WAIT_MS + REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS + 5_000,
  );

  // Regression origin: a reused bootstrap PID must not authorize signaling its numeric PGID.
  test("refuses to signal a process group after its bootstrap identity is reused [Whitebox-GoodCommunication]", async () => {
    const reaperExecutable = fileURLToPath(
      new URL("../src/orphanProcessGroupReaper.ts", import.meta.url),
    );
    const reusedGroup = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const reusedGroupPid = reusedGroup.pid;
    if (reusedGroupPid === undefined) throw new Error("test process group returned no PID");
    const reusedGroupExited = exited(reusedGroup);
    const reusedIdentity = await readProcessIdentity(reusedGroupPid);
    if (reusedIdentity === null) throw new Error("test process group identity disappeared");

    try {
      const reaper = spawn(
        process.execPath,
        [
          reaperExecutable,
          String(reusedIdentity.pid),
          `${reusedIdentity.startTime}-reused`,
          process.env["CQ_PROCESS_IDENTITY_HELPER"] ?? "",
          String(Date.now() + REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS),
        ],
        { stdio: "ignore" },
      );
      expect(await exited(reaper)).toEqual({ exitCode: 0, signal: null });
      expect(await readProcessIdentity(reusedGroupPid)).toEqual(reusedIdentity);
    } finally {
      signalProcessGroup(reusedGroupPid, "SIGKILL");
      await reusedGroupExited;
    }
  });

  test("keeps the bootstrap alive through a delayed target-exit hook [Effectual-GoodCommunication]", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-target-exit-hook-"));
    roots.push(root);
    let hookCalls = 0;
    let finishHook: (() => void) | undefined;
    const launched = await launchRegisteredProcessGroup({
      argv: [process.execPath, "-e", "process.exit(0)"],
      cwd: root,
      env: process.env,
      stdio: "ignore" as const,
      register: async () => {},
      onTargetExit: async () => {
        hookCalls += 1;
        await new Promise<void>((resolve) => {
          finishHook = resolve;
        });
      },
      launchBootstrap: nodeBootstrap,
    });
    let completed = false;
    void launched.exited.then(() => {
      completed = true;
    });

    for (let attempt = 0; attempt < 100 && hookCalls === 0; attempt += 1) {
      await Bun.sleep(2);
    }
    expect(hookCalls).toBe(1);
    expect(completed).toBe(false);
    await Bun.sleep(REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS + 100);
    expect(await readProcessIdentity(launched.registration.leader.pid)).toEqual(
      launched.registration.leader,
    );
    expect(completed).toBe(false);
    if (finishHook === undefined) throw new Error("target-exit hook did not expose completion");
    finishHook();
    expect(await launched.exited).toEqual({ exitCode: 0, signal: null });
  });

  test("registers a fenced leader before an immediate target exit can orphan its same-group fork", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-"));
    roots.push(root);
    const descendantMarker = join(root, "descendant-pid");
    const target = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
      "  { detached: false, stdio: 'ignore' });",
      "child.unref();",
      `writeFileSync(${JSON.stringify(descendantMarker)}, String(child.pid));`,
    ].join("\n");
    const registrations: ProcessGroupRegistration[] = [];
    let identityWired = false;
    const launched = await launchRegisteredProcessGroup({
      argv: [process.execPath, "-e", target],
      cwd: root,
      env: process.env,
      stdio: "ignore" as const,
      register: async (registration) => {
        // Deterministically opens the 75 ms identity-capture window that lost
        // an unfenced immediate-exit target in the T1625/T1626 review probe.
        await Bun.sleep(75);
        registrations.push(registration);
        identityWired =
          JSON.stringify(await readProcessIdentity(registration.leader.pid)) ===
          JSON.stringify(registration.leader);
      },
      launchBootstrap: nodeBootstrap,
    });

    expect(registrations).toEqual([launched.registration]);
    expect(launched.registration.leader.startTime).not.toBe("");
    expect(identityWired).toBe(true);
    await launched.exited;
    const descendantPid = Number(await readFile(descendantMarker, "utf8"));
    expect(await readProcessIdentity(descendantPid)).not.toBeNull();
    try {
      const result = await settleProcessGroups([launched.registration], {
        termGraceMs: 0,
        killGraceMs: 1_000,
      });
      expect(result.survivors).toEqual([]);
      await waitForIdentityToDisappear(descendantPid);
    } finally {
      signalProcessGroup(launched.registration.pgid, "SIGKILL");
    }
  });

  test("fails closed and settles the fenced leader when registration rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-register-failure-"));
    roots.push(root);
    const marker = join(root, "target-ran");
    const registrations: ProcessGroupRegistration[] = [];
    await expect(
      launchRegisteredProcessGroup({
        argv: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
        cwd: root,
        env: process.env,
        stdio: "ignore" as const,
        register: async (candidate) => {
          registrations.push(candidate);
          throw new Error("controlled registration refusal");
        },
        launchBootstrap: nodeBootstrap,
      }),
    ).rejects.toThrow("controlled registration refusal");
    expect(registrations).toHaveLength(1);
    await waitForIdentityToDisappear(registrations[0]!.leader.pid);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("fails closed when release publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-release-failure-"));
    roots.push(root);
    const marker = join(root, "target-ran");
    let protocolDirectory: string | undefined;
    const registrations: ProcessGroupRegistration[] = [];
    await expect(
      launchRegisteredProcessGroup({
        argv: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
        cwd: root,
        env: process.env,
        stdio: "ignore" as const,
        register: async (candidate) => {
          registrations.push(candidate);
          if (protocolDirectory === undefined)
            throw new Error("test did not observe protocol path");
          await chmod(protocolDirectory, 0o500);
        },
        launchBootstrap: (specification) => {
          protocolDirectory = specification.argv[2];
          return nodeBootstrap(specification);
        },
      }),
    ).rejects.toThrow();
    expect(registrations).toHaveLength(1);
    await waitForIdentityToDisappear(registrations[0]!.leader.pid);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("acknowledges target launch failures only after cleaning up the registered group", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-target-failure-"));
    roots.push(root);
    const registrations: ProcessGroupRegistration[] = [];
    await expect(
      launchRegisteredProcessGroup({
        argv: [join(root, "executable-does-not-exist"), "exact-argument"],
        cwd: root,
        env: process.env,
        stdio: "ignore" as const,
        register: async (candidate) => {
          registrations.push(candidate);
        },
        launchBootstrap: nodeBootstrap,
      }),
    ).rejects.toThrow("target launch failed");
    expect(registrations).toHaveLength(1);
    await waitForIdentityToDisappear(registrations[0]!.leader.pid);
  });

  test("rejects a launcher identity that differs from its initial parent [Whitebox-GoodCommunication]", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-parent-mismatch-"));
    roots.push(root);
    const bootstrap = fileURLToPath(new URL("../src/commandBootstrap.ts", import.meta.url));
    const launcher = await readProcessIdentity(process.pid);
    if (launcher === null) throw new Error("test launcher identity disappeared");
    const mutations = [
      {
        name: "launcher PID mismatch",
        launcher: { ...launcher, pid: launcher.pid + 1 },
        expectedError: "launcher PID does not match initial parent",
      },
      {
        name: "simulated PID-reuse start-time mismatch",
        launcher: { ...launcher, startTime: `${launcher.startTime}-reused` },
        expectedError: "launcher start-time identity mismatch",
      },
    ];

    for (const mutation of mutations) {
      const protocolDirectory = join(root, mutation.name.replaceAll(" ", "-"));
      const marker = join(protocolDirectory, "target-ran");
      await mkdir(protocolDirectory, { mode: 0o700 });
      const cleanupStarted = Date.now();
      const child = spawn(
        process.execPath,
        [
          bootstrap,
          protocolDirectory,
          "expected-nonce",
          String(mutation.launcher.pid),
          mutation.launcher.startTime,
          process.env["CQ_PROCESS_IDENTITY_HELPER"] ?? "",
          root,
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
        { cwd: root, env: process.env, detached: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      if (child.pid === undefined) throw new Error("test bootstrap returned no PID");
      if (child.stderr === null) throw new Error("test bootstrap returned no stderr pipe");
      const outcomePromise = exited(child);
      const stderr = streamText(child.stderr);
      await writeFile(
        join(protocolDirectory, "release.json"),
        JSON.stringify({
          nonce: "expected-nonce",
          pgid: child.pid,
          launcher: mutation.launcher,
        }),
      );
      await completeBootstrapIfTargetRan(child, protocolDirectory, "expected-nonce");
      const outcome = await outcomePromise;
      expect(outcome.exitCode, mutation.name).toBe(1);
      expect(await stderr, mutation.name).toContain(mutation.expectedError);
      expect(await pathExists(marker), mutation.name).toBe(false);
      expect(await pathExists(join(protocolDirectory, "status.json")), mutation.name).toBe(false);
      const cleanupObserved = await waitForPathToDisappearBy(
        protocolDirectory,
        cleanupStarted + REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS,
      );
      expect(cleanupObserved - cleanupStarted, mutation.name).toBeLessThanOrEqual(
        REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS,
      );
    }
  });

  test("rejects nonce/launcher release mutations [Whitebox-GoodCommunication]", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-mismatch-"));
    roots.push(root);
    const bootstrap = fileURLToPath(new URL("../src/commandBootstrap.ts", import.meta.url));
    const launcher = await readProcessIdentity(process.pid);
    if (launcher === null) throw new Error("test launcher identity disappeared");
    const mutations = [
      {
        name: "nonce mismatch",
        release: { nonce: "mismatched-nonce", launcher },
      },
      {
        name: "launcher PID mismatch",
        release: { nonce: "expected-nonce", launcher: { ...launcher, pid: launcher.pid + 1 } },
      },
      {
        name: "launcher start-time mismatch",
        release: {
          nonce: "expected-nonce",
          launcher: { ...launcher, startTime: `${launcher.startTime}-reused` },
        },
      },
    ];

    for (const mutation of mutations) {
      const protocolDirectory = join(root, mutation.name.replaceAll(" ", "-"));
      const marker = join(protocolDirectory, "target-ran");
      await mkdir(protocolDirectory, { mode: 0o700 });
      const child = spawn(
        process.execPath,
        [
          bootstrap,
          protocolDirectory,
          "expected-nonce",
          String(launcher.pid),
          launcher.startTime,
          process.env["CQ_PROCESS_IDENTITY_HELPER"] ?? "",
          root,
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
        { cwd: root, env: process.env, detached: true, stdio: "ignore" },
      );
      if (child.pid === undefined) throw new Error("test bootstrap returned no PID");
      const outcomePromise = exited(child);
      await writeFile(
        join(protocolDirectory, "release.json"),
        JSON.stringify({ ...mutation.release, pgid: child.pid }),
      );
      await completeBootstrapIfTargetRan(child, protocolDirectory, "expected-nonce");
      const outcome = await outcomePromise;
      expect(outcome.exitCode, mutation.name).toBe(1);
      expect(await pathExists(marker), mutation.name).toBe(false);
      expect(await pathExists(join(protocolDirectory, "status.json")), mutation.name).toBe(false);
    }
  });

  test("preserves exact argv, cwd, env, and Node stdin/stdout/stderr pipes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-semantics-"));
    roots.push(root);
    const cwd = join(root, "nested cwd");
    await mkdir(cwd);
    const target = [
      "const chunks = [];",
      "process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "process.stdin.on('end', () => {",
      "  const input = Buffer.concat(chunks).toString();",
      "  process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), env: process.env, input }));",
      "  process.stderr.write('stderr:' + input);",
      "});",
    ].join("\n");
    const env = {
      T1624_VALUE: "value with spaces",
      T1624_EMPTY: "",
    };
    const launched = await launchRegisteredProcessGroup({
      argv: [process.execPath, "-e", target, "argument with spaces", "", "--literal"],
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"] as const,
      register: async () => {},
      launchBootstrap: nodeBootstrap,
    });
    if (
      launched.process.stdin === null ||
      launched.process.stdout === null ||
      launched.process.stderr === null
    ) {
      throw new Error("test bootstrap did not expose all three pipes");
    }
    const stdout = streamText(launched.process.stdout);
    const stderr = streamText(launched.process.stderr);
    launched.process.stdin.end("stdin payload");
    const [outcome, stdoutText, stderrText] = await Promise.all([launched.exited, stdout, stderr]);
    expect(outcome.exitCode).toBe(0);
    expect(JSON.parse(stdoutText)).toEqual({
      argv: ["argument with spaces", "", "--literal"],
      cwd,
      env,
      input: "stdin payload",
    });
    expect(stderrText).toBe("stderr:stdin payload");
  });

  // Regression origin: D260 used different Darwin identity backends across the exact-env boundary.
  test("preserves a different exact target helper while authenticating Darwin launcher identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-darwin-exact-env-"));
    roots.push(root);
    const identityHelper = join(root, "identity-helper");
    await writeFile(identityHelper, "#!/bin/sh\nprintf '%s.0\\n' \"$1\"\n");
    await chmod(identityHelper, 0o755);
    const targetIdentityHelper = join(root, "target-identity-helper");
    await writeFile(targetIdentityHelper, "#!/bin/sh\nprintf '%s.1\\n' \"$1\"\n");
    await chmod(targetIdentityHelper, 0o755);
    const originalPlatform = process.platform;
    const originalIdentityHelper = process.env["CQ_PROCESS_IDENTITY_HELPER"];
    const env = {
      PATH: process.env["PATH"],
      CQ_PROCESS_IDENTITY_HELPER: targetIdentityHelper,
      T1694_TARGET_ONLY: "exact-target-environment",
    };

    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env["CQ_PROCESS_IDENTITY_HELPER"] = identityHelper;
    try {
      let bootstrapStderr: Promise<string> | undefined;
      const bootstrap = fileURLToPath(new URL("../src/commandBootstrap.ts", import.meta.url));
      const bootstrapUrl = new URL("../src/commandBootstrap.ts", import.meta.url).href;
      const wrapper = [
        "Object.defineProperty(process, 'platform', { value: 'darwin' });",
        `process.argv = [process.argv[0], ${JSON.stringify(bootstrap)}, ...process.argv.slice(1)];`,
        `await import(${JSON.stringify(bootstrapUrl)});`,
      ].join("\n");
      const launched = await launchRegisteredProcessGroup({
        argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"] as StdioOptions,
        register: async () => {},
        launchBootstrap: (specification) => {
          const child = spawn(
            specification.argv[0],
            ["-e", wrapper, ...specification.argv.slice(2)],
            {
              cwd: specification.cwd,
              env: specification.env,
              detached: specification.detached,
              stdio: specification.stdio,
            },
          );
          if (child.stderr !== null) bootstrapStderr = streamText(child.stderr);
          return {
            process: child,
            pid: child.pid,
            exited: exited(child),
            outputDrained: Promise.all([
              streamDrained(child.stdout),
              bootstrapStderr ?? Promise.resolve(""),
            ]).then(() => {}),
            resultFromTargetOutcome: (outcome: {
              exitCode: number | null;
              signal: NodeJS.Signals | null;
            }) => outcome,
            terminate: (signal: NodeJS.Signals) => {
              child.kill(signal);
            },
          };
        },
      }).catch(async (error: unknown) => {
        const diagnostic = bootstrapStderr === undefined ? "unavailable" : await bootstrapStderr;
        throw new Error(`bootstrap stderr: ${diagnostic}`, { cause: error });
      });
      if (launched.process.stdout === null || launched.process.stderr === null) {
        throw new Error("test bootstrap did not expose stdout and stderr pipes");
      }
      const stdout = streamText(launched.process.stdout);
      expect(await launched.exited).toEqual({ exitCode: 0, signal: null });
      expect(await bootstrapStderr).toBe("");
      expect(JSON.parse(await stdout)).toEqual(env);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      if (originalIdentityHelper === undefined) {
        delete process.env["CQ_PROCESS_IDENTITY_HELPER"];
      } else {
        process.env["CQ_PROCESS_IDENTITY_HELPER"] = originalIdentityHelper;
      }
    }
  });

  test("preserves the target signal outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-signal-"));
    roots.push(root);
    const launched = await launchRegisteredProcessGroup({
      argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
      cwd: root,
      env: process.env,
      stdio: "ignore" as const,
      register: async () => {},
      launchBootstrap: nodeBootstrap,
    });

    expect(await launched.exited).toEqual({ exitCode: null, signal: "SIGTERM" });
  });

  test("keeps the registered supervisor alive until settlement drains inherited pipes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-supervisor-"));
    roots.push(root);
    const writerReady = join(root, "writer-ready");
    const targetPidPath = join(root, "target-pid");
    const writer = [
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('writer-stdout\\n');",
      "process.stderr.write('writer-stderr\\n');",
      `writeFileSync(${JSON.stringify(writerReady)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const target = [
      "const { spawn } = require('node:child_process');",
      "const { existsSync, writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(targetPidPath)}, String(process.pid));`,
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {`,
      "  detached: false,",
      "  stdio: ['ignore', 'inherit', 'inherit'],",
      "});",
      "child.unref();",
      "const ready = setInterval(() => {",
      `  if (!existsSync(${JSON.stringify(writerReady)})) return;`,
      "  clearInterval(ready);",
      "  process.stdout.write('target-stdout\\n');",
      "  process.stderr.write('target-stderr\\n');",
      "  process.exitCode = 23;",
      "}, 2);",
    ].join("\n");
    const launched = await launchRegisteredProcessGroup({
      argv: ["node", "-e", target],
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"] as const,
      register: async () => {},
      launchBootstrap: nodeBootstrap,
    });
    if (launched.process.stdout === null || launched.process.stderr === null) {
      throw new Error("test bootstrap did not expose output pipes");
    }
    const stdout = streamText(launched.process.stdout);
    const stderr = streamText(launched.process.stderr);
    let writerPid = 0;
    try {
      await waitForFile(targetPidPath);
      await waitForFile(writerReady);
      writerPid = Number(await readFile(writerReady, "utf8"));
      await waitForIdentityToDisappear(Number(await readFile(targetPidPath, "utf8")));

      expect(
        await Promise.race([
          launched.exited.then(() => "completed" as const),
          Bun.sleep(250).then(() => "pending" as const),
        ]),
      ).toBe("pending");
      expect(await readProcessIdentity(launched.registration.leader.pid)).toEqual(
        launched.registration.leader,
      );
      expect(await readProcessIdentity(writerPid)).not.toBeNull();

      expect(
        await settleProcessGroups([launched.registration], {
          termGraceMs: 50,
          killGraceMs: 1_000,
          pollIntervalMs: 2,
        }),
      ).toEqual({ signaled: [launched.registration.pgid], survivors: [] });
      await waitForIdentityToDisappear(writerPid);
      await waitForIdentityToDisappear(launched.registration.leader.pid);
      const [outcome, stdoutText, stderrText] = await Promise.all([
        launched.exited,
        stdout,
        stderr,
      ]);

      expect(outcome).toEqual({ exitCode: 23, signal: null });
      expect(stdoutText).toBe("writer-stdout\ntarget-stdout\n");
      expect(stderrText).toBe("writer-stderr\ntarget-stderr\n");
    } finally {
      signalProcessGroup(launched.registration.pgid, "SIGKILL");
      if (writerPid > 1) await waitForIdentityToDisappear(writerPid);
      await launched.exited.catch(() => {});
    }
  });

  test("completion implies stdout and stderr EOF with every buffered payload byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-drain-"));
    roots.push(root);
    const holderReady = join(root, "drain-holder-ready");
    const holderRelease = join(root, "drain-holder-release");
    const targetPidPath = join(root, "drain-target-pid");
    const bufferSize = 16 * 1024;
    const bufferCount = 64;
    const holder = [
      "const { existsSync, writeFileSync, writeSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(holderReady)}, String(process.pid));`,
      "const timer = setInterval(() => {",
      `  if (!existsSync(${JSON.stringify(holderRelease)})) return;`,
      "  clearInterval(timer);",
      `  const size = ${bufferSize};`,
      `  const count = ${bufferCount};`,
      "  for (let index = 0; index < count; index += 1) {",
      "    writeSync(1, Buffer.alloc(size, 65 + (index % 26)));",
      "    writeSync(2, Buffer.alloc(size, 97 + (index % 26)));",
      "  }",
      "}, 2);",
    ].join("\n");
    const target = [
      "const { spawn } = require('node:child_process');",
      "const { existsSync, writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(targetPidPath)}, String(process.pid));`,
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(holder)}], {`,
      "  detached: false,",
      "  stdio: ['ignore', 'inherit', 'inherit'],",
      "});",
      "child.unref();",
      "const timer = setInterval(() => {",
      `  if (existsSync(${JSON.stringify(holderReady)})) clearInterval(timer);`,
      "}, 2);",
    ].join("\n");
    const expectedStdout = Array.from({ length: bufferCount }, (_, index) =>
      String.fromCharCode(65 + (index % 26)).repeat(bufferSize),
    ).join("");
    const expectedStderr = Array.from({ length: bufferCount }, (_, index) =>
      String.fromCharCode(97 + (index % 26)).repeat(bufferSize),
    ).join("");
    const launched = await launchRegisteredProcessGroup({
      argv: [process.execPath, "-e", target],
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"] as const,
      register: async () => {},
      launchBootstrap: nodeBootstrap,
    });
    if (launched.process.stdout === null || launched.process.stderr === null) {
      throw new Error("test bootstrap did not expose output pipes");
    }
    let stdoutEnded = false;
    let stderrEnded = false;
    launched.process.stdout.once("end", () => {
      stdoutEnded = true;
    });
    launched.process.stderr.once("end", () => {
      stderrEnded = true;
    });
    const stdout = streamText(launched.process.stdout);
    const stderr = streamText(launched.process.stderr);
    await waitForFile(targetPidPath);
    await waitForFile(holderReady);
    await waitForIdentityToDisappear(Number(await readFile(targetPidPath, "utf8")));
    const delayedRelease = Bun.sleep(250).then(() => writeFile(holderRelease, "release"));

    await launched.exited;
    const eofAtCompletion = { stdout: stdoutEnded, stderr: stderrEnded };
    await delayedRelease;
    const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);

    expect(eofAtCompletion).toEqual({ stdout: true, stderr: true });
    expect(stdoutText).toBe(expectedStdout);
    expect(stderrText).toBe(expectedStderr);
  });

  test("maps the same bootstrap specification onto Bun adapter pipes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-bun-"));
    roots.push(root);
    const target = "process.stdout.write(process.env.T1624_BUN + ':' + process.argv[1])";
    const launched = await launchRegisteredProcessGroup({
      argv: [process.execPath, "-e", target, "exact bun argument"],
      cwd: root,
      env: { T1624_BUN: "bun-pipe" },
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" } as const,
      register: async () => {},
      launchBootstrap: (specification) => {
        const child = Bun.spawn([...specification.argv], {
          cwd: specification.cwd,
          env: specification.env,
          detached: specification.detached,
          stdin: specification.stdio.stdin,
          stdout: specification.stdio.stdout,
          stderr: specification.stdio.stderr,
        });
        const stdout = new Response(child.stdout).text();
        const stderr = new Response(child.stderr).text();
        return {
          process: { subprocess: child, stdout, stderr },
          pid: child.pid,
          exited: child.exited,
          outputDrained: Promise.all([stdout, stderr]).then(() => {}),
          resultFromTargetOutcome: (outcome: {
            exitCode: number | null;
            signal: NodeJS.Signals | null;
          }) => {
            if (outcome.exitCode !== null) return outcome.exitCode;
            if (outcome.signal === null) return 1;
            return 128 + (constants.signals[outcome.signal] ?? 1);
          },
          terminate: (signal: NodeJS.Signals) => {
            child.kill(signal);
          },
        };
      },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      launched.exited,
      launched.process.stdout,
      launched.process.stderr,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("bun-pipe:exact bun argument");
    expect(stderr).toBe("");
  });

  test("settlement excludes an unrelated setsid descendant", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-setsid-"));
    roots.push(root);
    const marker = join(root, "setsid-pid");
    const target = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
      "  { detached: true, stdio: 'ignore' });",
      "child.unref();",
      `writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
    ].join("\n");
    const launched = await launchRegisteredProcessGroup({
      argv: [process.execPath, "-e", target],
      cwd: root,
      env: process.env,
      stdio: "ignore" as const,
      register: async () => {},
      launchBootstrap: nodeBootstrap,
    });
    await launched.exited;
    const setsidPid = Number(await readFile(marker, "utf8"));
    const identity = await readProcessIdentity(setsidPid);
    if (identity === null) throw new Error("unrelated setsid process exited unexpectedly");
    try {
      expect(
        await settleProcessGroups([launched.registration], {
          termGraceMs: 0,
          killGraceMs: 1_000,
        }),
      ).toEqual({ signaled: [], survivors: [] });
      expect(await readProcessIdentity(setsidPid)).toEqual(identity);
    } finally {
      signalProcessGroup(setsidPid, "SIGKILL");
    }
  });
});
