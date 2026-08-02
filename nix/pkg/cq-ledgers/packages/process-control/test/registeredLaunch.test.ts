import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchRegisteredProcessGroup,
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

  test("rejects a nonce-qualified release mismatch before the target runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-registered-launch-mismatch-"));
    roots.push(root);
    const protocolDirectory = join(root, "protocol");
    const marker = join(root, "target-ran");
    await mkdir(protocolDirectory, { mode: 0o700 });
    const bootstrap = fileURLToPath(new URL("../src/commandBootstrap.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        bootstrap,
        protocolDirectory,
        "expected-nonce",
        root,
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ],
      { cwd: root, env: process.env, detached: true, stdio: "ignore" },
    );
    if (child.pid === undefined) throw new Error("test bootstrap returned no PID");
    await writeFile(
      join(protocolDirectory, "release.json"),
      JSON.stringify({ nonce: "mismatched-nonce", pgid: child.pid }),
    );
    const outcome = await exited(child);
    expect(outcome.exitCode).toBe(1);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(join(protocolDirectory, "status.json")).exists()).toBe(false);
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
