import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GateBusyError,
  acquireWorktreeGate,
  closeWorktreeGate,
  launchRegisteredGateCommand,
  readRegisteredProcessGroups,
  readProcessIdentity,
  registerProcessGroup,
  releaseWorktreeGate,
  settleWorktreeGateCommands,
  signalProcessGroup,
  type ProcessGroupOperations,
  type ProcessIdentity,
} from "../src/index.js";

const roots: string[] = [];

async function repositoryFixture(): Promise<{ root: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "cq-gate-repo-"));
  roots.push(root);
  const init = Bun.spawnSync(["git", "init", "-q", root]);
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  const stateDir = join(root, ".gate-state");
  return { root, stateDir };
}

async function detachedSleeper(): Promise<{
  readonly pid: number;
  readonly identity: ProcessIdentity;
  readonly exited: Promise<void>;
}> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("test command did not return a pid");
  const identity = await readProcessIdentity(pid);
  if (identity === null) throw new Error("test command identity disappeared");
  return {
    pid,
    identity,
    exited: new Promise<void>((resolve) => child.once("exit", () => resolve())),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical worktree gate [Effectual-GoodCommunication]", () => {
  test("canonical-equivalent worktree paths contend for one lease", async () => {
    const { root, stateDir } = await repositoryFixture();
    const alias = `${root}-alias`;
    roots.push(alias);
    await symlink(root, alias, "dir");

    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    await expect(
      acquireWorktreeGate({ worktree: alias, commandCwd: alias, stateDir }),
    ).rejects.toBeInstanceOf(GateBusyError);
    expect(lease.worktree).toBe(await realpath(root));
    expect(await releaseWorktreeGate(lease)).toBe(true);
  });

  test("rejects a command cwd whose realpath escapes the worktree", async () => {
    const { root, stateDir } = await repositoryFixture();
    const outside = await mkdtemp(join(tmpdir(), "cq-gate-outside-"));
    roots.push(outside);
    await symlink(outside, join(root, "escape"), "dir");
    await expect(
      acquireWorktreeGate({ worktree: root, commandCwd: join(root, "escape"), stateDir }),
    ).rejects.toThrow("contained in worktree");
  });

  test("requires the matching nonce for registration and release", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const mismatched = { ...lease, nonce: "mismatched-nonce" };
    await expect(
      registerProcessGroup(mismatched, { pgid: 123, leader: { pid: 123, startTime: "1" } }),
    ).rejects.toThrow("nonce");
    expect(await releaseWorktreeGate(mismatched)).toBe(false);
    expect(await releaseWorktreeGate(lease)).toBe(true);
  });

  test("rejects a registration whose PGID has no live process group", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: false,
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("test non-leader returned no PID");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const leader = await readProcessIdentity(pid);
      if (leader === null) throw new Error("test non-leader identity disappeared");
      await expect(registerProcessGroup(lease, { pgid: pid, leader })).rejects.toThrow(
        "live process group",
      );
    } finally {
      child.kill("SIGKILL");
      await exited;
      await releaseWorktreeGate(lease);
    }
  });

  test("records an explicitly registered command group before observation", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("test command did not return a pid");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const leader = await readProcessIdentity(pid);
    if (leader === null) throw new Error("test command identity disappeared");
    const registration = { pgid: pid, leader };
    try {
      await registerProcessGroup(lease, registration);
      expect(await readRegisteredProcessGroups(lease)).toEqual([registration]);
      await closeWorktreeGate(lease);
      await exited;
    } finally {
      signalProcessGroup(pid, "SIGKILL");
    }
  });

  test("publishes command identity before the target observes its environment", async () => {
    const { root, stateDir } = await repositoryFixture();
    const marker = join(root, "registration-observed");
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const probe = [
      "const fs = require('node:fs');",
      "const gate = process.env.CQ_GATE_DIR;",
      "const nonce = process.env.CQ_GATE_NONCE;",
      "const names = fs.readdirSync(gate + '/commands');",
      "const found = names.some((name) => {",
      "  const record = JSON.parse(fs.readFileSync(gate + '/commands/' + name, 'utf8'));",
      "  return record.nonce === nonce && record.registration.leader.startTime !== '';",
      "});",
      `fs.writeFileSync(${JSON.stringify(marker)}, found ? 'registered' : 'missing');`,
      "if (!found) process.exit(17);",
    ].join("\n");
    const launched = await launchRegisteredGateCommand(lease, [process.execPath, "-e", probe]);
    const exit = await launched.exited;
    expect(exit.exitCode).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("registered");
    await closeWorktreeGate(lease);
  });

  test("rejects a bootstrap barrier whose nonce does not match", async () => {
    const { root } = await repositoryFixture();
    const marker = join(root, "mismatched-bootstrap-ran");
    const protocolDirectory = join(root, "bootstrap-protocol");
    await mkdir(protocolDirectory);
    const bootstrap = fileURLToPath(new URL("../src/commandBootstrap.ts", import.meta.url));
    const launcher = await readProcessIdentity(process.pid);
    if (launcher === null) throw new Error("test launcher identity disappeared");
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
        `await Bun.write(${JSON.stringify(marker)}, "ran")`,
      ],
      {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error("test bootstrap did not return a pid");
    await writeFile(
      join(protocolDirectory, "release.json"),
      JSON.stringify({ nonce: "mismatched-nonce", pgid: pid, launcher }),
    );
    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    expect(exitCode).toBe(1);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("does not claim an unregistered detached descendant", async () => {
    const { root, stateDir } = await repositoryFixture();
    const marker = join(root, "detached-pid");
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const detach = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
      "  { detached: true, stdio: 'ignore' });",
      "child.unref();",
      `fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
    ].join("\n");
    const launched = await launchRegisteredGateCommand(lease, [process.execPath, "-e", detach]);
    await launched.exited;
    const detachedPid = Number(await readFile(marker, "utf8"));
    const identity = await readProcessIdentity(detachedPid);
    if (identity === null) throw new Error("detached test process exited unexpectedly");
    try {
      await closeWorktreeGate(lease);
      expect(await readProcessIdentity(detachedPid)).toEqual(identity);
    } finally {
      signalProcessGroup(detachedPid, "SIGKILL");
    }
  });

  test("reclaims a dead holder but refuses a live holder", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    await expect(
      acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir }),
    ).rejects.toBeInstanceOf(GateBusyError);
    const holderPath = join(lease.gateDir, "holder.json");
    const holder = JSON.parse(await Bun.file(holderPath).text()) as Record<string, unknown>;
    await writeFile(
      holderPath,
      JSON.stringify({ ...holder, holder: { pid: 999_999_999, startTime: "dead" } }),
    );
    const reclaimed = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    expect(reclaimed.nonce).not.toBe(lease.nonce);
    await closeWorktreeGate(reclaimed, { termGraceMs: 0, killGraceMs: 0 });
  });

  test("settles registered command groups before reclaiming a dead holder", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("test command did not return a pid");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const leader = await readProcessIdentity(pid);
      if (leader === null) throw new Error("test command identity disappeared");
      await registerProcessGroup(lease, { pgid: pid, leader });
      await writeFile(join(lease.gateDir, "closing.json"), JSON.stringify({ nonce: lease.nonce }));
      const holderPath = join(lease.gateDir, "holder.json");
      const holder = JSON.parse(await readFile(holderPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        holderPath,
        JSON.stringify({ ...holder, holder: { pid: 999_999_999, startTime: "dead" } }),
      );

      const reclaimed = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
      expect(await readProcessIdentity(pid)).toBeNull();
      await closeWorktreeGate(reclaimed, { termGraceMs: 0, killGraceMs: 0 });
    } finally {
      signalProcessGroup(pid, "SIGKILL");
      await exited;
    }
  });

  test("settles live-holder command groups and repeats idempotently", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const { pid, identity, exited } = await detachedSleeper();
    try {
      await registerProcessGroup(lease, { pgid: pid, leader: identity });

      expect(
        await settleWorktreeGateCommands({
          worktree: root,
          stateDir,
          termGraceMs: 0,
          killGraceMs: 1_000,
        }),
      ).toEqual({ signaled: [pid], survivors: [] });
      await exited;
      expect(
        await settleWorktreeGateCommands({
          worktree: root,
          stateDir,
          termGraceMs: 0,
          killGraceMs: 0,
        }),
      ).toEqual({ signaled: [], survivors: [] });
      await expect(
        acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir }),
      ).rejects.toBeInstanceOf(GateBusyError);
    } finally {
      signalProcessGroup(pid, "SIGKILL");
      await releaseWorktreeGate(lease);
      await exited;
    }
  });

  test("a registered command can settle sibling groups without terminating its own gate", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    try {
      const processControl = fileURLToPath(new URL("../src/index.ts", import.meta.url));
      const probe = [
        `const { settleWorktreeGateCommands } = await import(${JSON.stringify(processControl)});`,
        `const result = await settleWorktreeGateCommands(${JSON.stringify({ worktree: root, stateDir })});`,
        `if (result.signaled.length !== 0 || result.survivors.length !== 0) process.exit(2);`,
      ].join("\n");
      const launched = await launchRegisteredGateCommand(lease, [process.execPath, "-e", probe]);

      expect(await launched.exited).toEqual({ exitCode: 0, signal: null });
    } finally {
      await closeWorktreeGate(lease);
    }
  });

  test("returns idempotently when the canonical worktree has no active gate", async () => {
    const { root, stateDir } = await repositoryFixture();
    expect(await settleWorktreeGateCommands({ worktree: root, stateDir })).toEqual({
      signaled: [],
      survivors: [],
    });
  });

  test("publishes a complete closing marker across concurrent settlement", async () => {
    const { root, stateDir } = await repositoryFixture();
    const acquired = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const holderPath = join(acquired.gateDir, "holder.json");
    const holder = JSON.parse(await readFile(holderPath, "utf8")) as Record<string, unknown>;
    const publicationNonce = "x".repeat(1024 * 1024);
    await writeFile(holderPath, JSON.stringify({ ...holder, nonce: publicationNonce }));
    const lease = { ...acquired, nonce: publicationNonce };
    try {
      const processControl = fileURLToPath(new URL("../src/index.ts", import.meta.url));
      const readyDirectory = join(root, "settlement-probes-ready");
      const startPath = join(root, "settlement-probes-start");
      await mkdir(readyDirectory);
      const probe = [
        `const { writeFile } = await import("node:fs/promises");`,
        `const { settleWorktreeGateCommands } = await import(${JSON.stringify(processControl)});`,
        `await writeFile(${JSON.stringify(`${readyDirectory}/`)} + process.pid, "ready");`,
        `while (!(await Bun.file(${JSON.stringify(startPath)}).exists())) await Bun.sleep(1);`,
        `await settleWorktreeGateCommands(${JSON.stringify({ worktree: root, stateDir })});`,
      ].join("\n");
      const probes = Array.from({ length: 32 }, () =>
        Bun.spawn([process.execPath, "-e", probe], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        }),
      );
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if ((await readdir(readyDirectory)).length === probes.length) break;
        await Bun.sleep(1);
      }
      expect((await readdir(readyDirectory)).length).toBe(probes.length);
      await writeFile(startPath, "start");
      const outcomes = await Promise.all(
        probes.map(async (child) => ({
          exitCode: await child.exited,
          stderr: await new Response(child.stderr).text(),
        })),
      );
      expect(outcomes).toEqual(Array.from({ length: 32 }, () => ({ exitCode: 0, stderr: "" })));
    } finally {
      await releaseWorktreeGate(lease);
    }
  });

  test("returns idempotently when the live holder closes during settlement", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    await writeFile(join(lease.gateDir, "closing.json"), JSON.stringify({ nonce: lease.nonce }));

    const settlements = Array.from({ length: 32 }, () =>
      settleWorktreeGateCommands({ worktree: root, stateDir }),
    );
    const outcomes = await Promise.all([...settlements, closeWorktreeGate(lease)]);
    expect(
      outcomes.every((outcome) => outcome.signaled.length === 0 && outcome.survivors.length === 0),
    ).toBe(true);
  });

  test("rejects a command record whose nonce does not match the live holder", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const { pid, identity, exited } = await detachedSleeper();
    try {
      await registerProcessGroup(lease, { pgid: pid, leader: identity });
      const commandName = (await readdir(join(lease.gateDir, "commands"))).find((name) =>
        name.endsWith(".json"),
      );
      if (commandName === undefined) throw new Error("test command registration disappeared");
      const commandPath = join(lease.gateDir, "commands", commandName);
      const record = JSON.parse(await readFile(commandPath, "utf8")) as Record<string, unknown>;
      await writeFile(commandPath, JSON.stringify({ ...record, nonce: "mismatched-nonce" }));

      await expect(settleWorktreeGateCommands({ worktree: root, stateDir })).rejects.toThrow(
        "command identity nonce mismatch",
      );
      expect(await readProcessIdentity(pid)).toEqual(identity);
    } finally {
      signalProcessGroup(pid, "SIGKILL");
      await releaseWorktreeGate(lease);
      await exited;
    }
  });

  test("does not signal a command group whose leader identity was reused", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const { pid, identity, exited } = await detachedSleeper();
    try {
      await registerProcessGroup(lease, { pgid: pid, leader: identity });
      const commandName = (await readdir(join(lease.gateDir, "commands"))).find((name) =>
        name.endsWith(".json"),
      );
      if (commandName === undefined) throw new Error("test command registration disappeared");
      const commandPath = join(lease.gateDir, "commands", commandName);
      const record = JSON.parse(await readFile(commandPath, "utf8")) as {
        readonly version: number;
        readonly nonce: string;
        readonly registration: {
          readonly pgid: number;
          readonly leader: { readonly pid: number; readonly startTime: string };
        };
      };
      await writeFile(
        commandPath,
        JSON.stringify({
          ...record,
          registration: {
            ...record.registration,
            leader: {
              ...record.registration.leader,
              startTime: `${identity.startTime}-reused`,
            },
          },
        }),
      );

      expect(await settleWorktreeGateCommands({ worktree: root, stateDir })).toEqual({
        signaled: [],
        survivors: [],
      });
      expect(await readProcessIdentity(pid)).toEqual(identity);
    } finally {
      signalProcessGroup(pid, "SIGKILL");
      await releaseWorktreeGate(lease);
      await exited;
    }
  });

  test("closes concurrent registration before settling published command groups", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const { pid, identity, exited } = await detachedSleeper();
    let observedPublishedGroup = false;
    const operations: ProcessGroupOperations = {
      isAlive: async () => {
        observedPublishedGroup = true;
        return false;
      },
      signal: () => {
        throw new Error("dead controlled group must not be signaled");
      },
      delay: async () => {
        throw new Error("dead controlled group must not delay");
      },
    };
    try {
      await registerProcessGroup(lease, { pgid: pid, leader: identity });
      const pendingPath = join(lease.gateDir, "commands", ".pending-controlled-test");
      await writeFile(pendingPath, "publication in progress");
      const settlement = settleWorktreeGateCommands({
        worktree: root,
        stateDir,
        termGraceMs: 0,
        killGraceMs: 1_000,
        operations,
      });
      const closingPath = join(lease.gateDir, "closing.json");
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (await Bun.file(closingPath).exists()) break;
        await Bun.sleep(1);
      }
      expect(await Bun.file(closingPath).exists()).toBe(true);
      await Bun.sleep(10);
      expect(observedPublishedGroup).toBe(false);
      await expect(registerProcessGroup(lease, { pgid: pid, leader: identity })).rejects.toThrow(
        "after close",
      );
      await rm(pendingPath);
      expect(await settlement).toEqual({ signaled: [], survivors: [] });
      expect(observedPublishedGroup).toBe(true);
    } finally {
      signalProcessGroup(pid, "SIGKILL");
      await rm(join(lease.gateDir, "commands", ".pending-controlled-test"), { force: true });
      await releaseWorktreeGate(lease);
      await exited;
    }
  });

  test("returns within configured bounds when an owned command group survives", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const { pid, identity, exited } = await detachedSleeper();
    const signals: NodeJS.Signals[] = [];
    const operations: ProcessGroupOperations = {
      isAlive: async () => true,
      signal: (_registration, signal) => {
        signals.push(signal);
      },
      delay: async () => {
        throw new Error("zero-duration settlement must not delay");
      },
    };
    try {
      await registerProcessGroup(lease, { pgid: pid, leader: identity });
      const startedAt = Date.now();
      await expect(
        settleWorktreeGateCommands({
          worktree: root,
          stateDir,
          termGraceMs: 0,
          killGraceMs: 0,
          operations,
        }),
      ).rejects.toThrow(`process groups did not settle: ${pid}`);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(signals).toEqual(["SIGTERM", "SIGSTOP", "SIGKILL"]);
    } finally {
      signalProcessGroup(pid, "SIGKILL");
      await releaseWorktreeGate(lease);
      await exited;
    }
  });

  test("close never observes a partially published command identity", async () => {
    const { root, stateDir } = await repositoryFixture();
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd: root, stateDir });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("test command did not return a pid");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const leader = await readProcessIdentity(pid);
      if (leader === null) throw new Error("test command identity disappeared");
      const publicationPadding = "x".repeat(1024 * 1024);
      const registration = {
        pgid: pid,
        leader,
        toJSON: () => ({ pgid: pid, leader, publicationPadding }),
      };
      const commandsDirectory = join(lease.gateDir, "commands");
      const observerReady = join(root, "observer-ready");
      const observerScript = [
        "const fs = require('node:fs');",
        "const directory = process.argv[1];",
        "fs.writeFileSync(process.argv[2], 'ready');",
        "const deadline = Date.now() + 3000;",
        "while (Date.now() < deadline) {",
        "  const name = fs.readdirSync(directory).find((entry) => entry.endsWith('.json'));",
        "  if (name !== undefined) {",
        "    try { JSON.parse(fs.readFileSync(directory + '/' + name, 'utf8')); process.exit(0); }",
        "    catch { process.exit(17); }",
        "  }",
        "}",
        "process.exit(18);",
      ].join("\n");
      const observer = spawn(
        process.execPath,
        ["-e", observerScript, commandsDirectory, observerReady],
        {
          stdio: "ignore",
        },
      );
      const observerExit = new Promise<number | null>((resolve) =>
        observer.once("exit", (exitCode) => resolve(exitCode)),
      );
      while (!(await Bun.file(observerReady).exists())) await Bun.sleep(1);
      const registrations = Array.from({ length: 4 }, () =>
        registerProcessGroup(lease, registration),
      );
      const registrationOutcomes = Promise.allSettled(registrations);
      expect(await observerExit).toBe(0);
      await closeWorktreeGate(lease, { termGraceMs: 0, killGraceMs: 1_000 });
      await registrationOutcomes;
      await exited;
    } finally {
      signalProcessGroup(pid, "SIGKILL");
      await releaseWorktreeGate(lease);
      await exited;
    }
  });

  test("validates an existing in-worktree command directory separately", async () => {
    const { root, stateDir } = await repositoryFixture();
    const commandCwd = join(root, "nested");
    await mkdir(commandCwd);
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd, stateDir });
    expect(lease.commandCwd).toBe(await realpath(commandCwd));
    await releaseWorktreeGate(lease);
  });
});
