import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  signalProcessGroup,
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
    const leader = await readProcessIdentity(process.pid);
    if (leader === null) throw new Error("test holder identity disappeared");
    await expect(registerProcessGroup(lease, { pgid: process.pid, leader })).rejects.toThrow(
      "live process group",
    );
    await releaseWorktreeGate(lease);
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
      "const pgid = Number(process.env.CQ_GATE_COMMAND_PGID);",
      "const names = fs.readdirSync(gate + '/commands');",
      "const found = names.some((name) => {",
      "  const record = JSON.parse(fs.readFileSync(gate + '/commands/' + name, 'utf8'));",
      "  return record.nonce === nonce && record.registration.pgid === pgid;",
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
    const barrier = join(root, "barrier.json");
    const bootstrap = fileURLToPath(new URL("../src/commandBootstrap.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        "run",
        bootstrap,
        barrier,
        root,
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, "ran")`,
      ],
      {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CQ_GATE_NONCE: "expected-nonce" },
      },
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error("test bootstrap did not return a pid");
    await writeFile(barrier, JSON.stringify({ nonce: "mismatched-nonce", pgid: pid }));
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

  test("validates an existing in-worktree command directory separately", async () => {
    const { root, stateDir } = await repositoryFixture();
    const commandCwd = join(root, "nested");
    await mkdir(commandCwd);
    const lease = await acquireWorktreeGate({ worktree: root, commandCwd, stateDir });
    expect(lease.commandCwd).toBe(await realpath(commandCwd));
    await releaseWorktreeGate(lease);
  });
});
