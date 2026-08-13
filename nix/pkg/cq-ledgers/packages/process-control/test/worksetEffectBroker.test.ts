import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorksetEffectBroker,
  createStrictInMemoryWorksetEffectAdmissionProvider,
  readProcessIdentity,
  signalProcessGroup,
  type RegisteredLaunchBootstrapSpecification,
} from "../src/index.js";

const roots: string[] = [];

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function exited(
  child: ChildProcess,
): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }> {
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

function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      output += chunk;
    });
    stream.once("end", () => resolve(output));
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
    outputDrained: Promise.all([
      streamDrained(child.stdout),
      streamDrained(child.stderr),
    ]).then(() => undefined),
    resultFromTargetOutcome: (outcome: {
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => outcome,
    terminate: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(2);
  }
  throw new Error(`test file ${path} was not created`);
}

async function waitForIdentityToDisappear(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if ((await readProcessIdentity(pid)) === null) return;
    await Bun.sleep(2);
  }
  throw new Error(`test process ${String(pid)} did not settle`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workset effect broker [T1979]", () => {
  test("acquires and registers the guardian before releasing one target [BA]", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-workset-effect-order-"));
    roots.push(root);
    const targetMarker = join(root, "target-ran");
    const acquireEntered = deferred();
    const permitAcquire = deferred();
    const strict = createStrictInMemoryWorksetEffectAdmissionProvider();
    const broker = new WorksetEffectBroker({
      provider: {
        acquire: async (input) => {
          acquireEntered.resolve();
          await permitAcquire.promise;
          return await strict.acquire(input);
        },
      },
    });

    const launchPromise = broker.launch({
      kind: "child-dispatch",
      targetRef: "tasks:T1979",
      argv: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(targetMarker)}, 'ran')`,
      ],
      cwd: root,
      env: process.env,
      stdio: "ignore" as const,
      launchBootstrap: nodeBootstrap,
    });
    await acquireEntered.promise;
    expect(await Bun.file(targetMarker).exists()).toBe(false);
    permitAcquire.resolve();

    const launched = await launchPromise;
    expect(await launched.exited).toEqual({ exitCode: 0, signal: null });
    expect(await Bun.file(targetMarker).exists()).toBe(true);
    expect(strict.events()).toEqual([
      "admission-acquired",
      "process-group-registered",
      "guardian-shared",
      "process-group-settled",
      "guardian-released",
      "admission-released",
    ]);
    expect(strict.activeAdmissionCount()).toBe(0);
  });

  test("cancel settles a same-group descendant before releasing admission [Effectual-GoodCommunication]", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-workset-effect-cancel-"));
    roots.push(root);
    const descendantPidPath = join(root, "descendant-pid");
    const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const target = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: false, stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const strict = createStrictInMemoryWorksetEffectAdmissionProvider();
    const broker = new WorksetEffectBroker({
      provider: strict,
      settlement: { termGraceMs: 10, killGraceMs: 1_000, pollIntervalMs: 2 },
    });
    const launched = await broker.launch({
      kind: "worktree-remove",
      targetRef: "tasks:T1979",
      argv: [process.execPath, "-e", target],
      cwd: root,
      env: process.env,
      stdio: "ignore" as const,
      launchBootstrap: nodeBootstrap,
    });
    await waitForFile(descendantPidPath);
    const descendantPid = Number(await readFile(descendantPidPath, "utf8"));

    try {
      await launched.cancel();
      await launched.exited;
      await waitForIdentityToDisappear(descendantPid);
      expect(launched.terminationReason).toBe("cancel");
      expect(strict.activeAdmissionCount()).toBe(0);
      expect(strict.events().slice(-3)).toEqual([
        "process-group-settled",
        "guardian-released",
        "admission-released",
      ]);
    } finally {
      signalProcessGroup(launched.registration.pgid, "SIGKILL");
    }
  });

  test("timeout settles the registered group before releasing admission [Effectual-GoodCommunication]", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-workset-effect-timeout-"));
    roots.push(root);
    const strict = createStrictInMemoryWorksetEffectAdmissionProvider();
    const broker = new WorksetEffectBroker({
      provider: strict,
      settlement: { termGraceMs: 10, killGraceMs: 1_000, pollIntervalMs: 2 },
    });
    const launched = await broker.launch({
      kind: "rebase",
      targetRef: "tasks:T1979",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      env: process.env,
      stdio: "ignore" as const,
      launchBootstrap: nodeBootstrap,
      timeoutMs: 20,
    });

    await launched.exited;
    expect(launched.terminationReason).toBe("timeout");
    expect(strict.activeAdmissionCount()).toBe(0);
  });

  test("keeps opaque admission material out of process metadata and output [BA]", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-workset-effect-opaque-"));
    roots.push(root);
    const capability = "cq-secret-admission-capability-T1979";
    const strict = createStrictInMemoryWorksetEffectAdmissionProvider();
    let specification: RegisteredLaunchBootstrapSpecification<StdioOptions> | undefined;
    const pipedStdio: StdioOptions = ["ignore", "pipe", "pipe"];
    const broker = new WorksetEffectBroker({
      provider: {
        acquire: async (input) => {
          const admission = await strict.acquire(input);
          return Object.freeze({ ...admission, id: capability });
        },
      },
    });
    const launched = await broker.launch({
      kind: "branch-create",
      targetRef: "tasks:T1979",
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({ argv: process.argv, env: process.env }))",
      ],
      cwd: root,
      env: process.env,
      stdio: pipedStdio,
      launchBootstrap: (candidate) => {
        specification = candidate;
        return nodeBootstrap(candidate);
      },
    });
    if (launched.process.stdout === null || launched.process.stderr === null) {
      throw new Error("test bootstrap did not expose output pipes");
    }
    const stdout = streamText(launched.process.stdout);
    const stderr = streamText(launched.process.stderr);
    await launched.exited;

    expect(specification?.argv.some((argument) => argument.includes(capability))).toBe(false);
    expect(
      Object.values(specification?.env ?? {}).some((value) => value?.includes(capability)),
    ).toBe(false);
    expect((await stdout).includes(capability)).toBe(false);
    expect((await stderr).includes(capability)).toBe(false);
  });
});
