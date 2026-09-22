import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createHash } from "node:crypto";
import {
  isProcessGroupAlive, settleProcessGroups, settleWorktreeGateCommands,
  createStrictInMemoryWorksetEffectAdmissionProvider,
  type ProcessGroupRegistration,
} from "@cq/process-control";
import { createNodeSupervisedWorkerCommandRunner } from "../src/supervisedWorkerGate.js";

const TEST_TIMEOUT_MS = 30_000;
const ADMISSION_TIMEOUT_MS = 5_000;
const EXECUTION_TIMEOUT_MS = 10_000;

test("cohort commands hold all-member admission through registered process settlement [Behavioral-Active Effectual-GoodCommunication]", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cq-cohort-command-admission-"));
  const worktree = join(directory, "worktree");
  const bin = join(directory, "bin");
  await mkdir(worktree);
  await mkdir(bin);
  const init = Bun.spawn(["git", "init", "-q", worktree], { stdout: "ignore", stderr: "pipe" });
  expect(await init.exited).toBe(0);
  const cq = join(bin, "cq");
  await writeFile(cq, '#!/bin/sh\nset -eu\nwhile test "$1" != --; do shift; done\nshift\nexec "$@"\n');
  await chmod(cq, 0o700);
  const provider = createStrictInMemoryWorksetEffectAdmissionProvider();
  const runner = createNodeSupervisedWorkerCommandRunner({
    settleWorktreeGateCommands: async (options) => {
      expect(provider.activeAdmissionCount()).toBe(1);
      return settleWorktreeGateCommands(options);
    },
    settleProcessGroups,
  });
  try {
    const request = {
      worktreePath: worktree, admissionTimeoutMs: ADMISSION_TIMEOUT_MS,
      executionTimeoutMs: EXECUTION_TIMEOUT_MS, cancellationSignal: new AbortController().signal,
      effectAdmission: { provider, targetRef: `cq-cohort-effect:v1:${"a".repeat(64)}` },
      command: { argv: [process.execPath, "-e", 'process.stdout.write("admitted");'], cwd: ".",
        environment: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } },
    };
    const result = await runner.run(request);
    expect(result.gateExitCode).toBe(0);
    expect(provider.events()).toEqual([
      "admission-acquired", "process-group-registered", "guardian-shared",
      "process-group-settled", "guardian-released", "admission-released",
    ]);
    expect(provider.activeAdmissionCount()).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

test("cohort commands capture real output and settle cancellation before successor admission [Behavioral-Active Effectual-GoodCommunication]", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cq-cohort-command-"));
  const worktree = join(directory, "worktree");
  const bin = join(directory, "bin");
  const marker = join(directory, "started");
  await mkdir(worktree);
  await mkdir(bin);
  const init = Bun.spawn(["git", "init", "-q", worktree], { stdout: "ignore", stderr: "pipe" });
  expect(await init.exited).toBe(0);
  const cq = join(bin, "cq");
  await writeFile(cq, '#!/bin/sh\nset -eu\nwhile test "$1" != --; do shift; done\nshift\nexec "$@"\n');
  await chmod(cq, 0o700);
  let worktreeSettlements = 0;
  let rootSettlements = 0;
  const registrations: ProcessGroupRegistration[] = [];
  const runner = createNodeSupervisedWorkerCommandRunner({
    settleWorktreeGateCommands: async (options) => {
      worktreeSettlements += 1;
      return settleWorktreeGateCommands(options);
    },
    settleProcessGroups: async (roots) => {
      rootSettlements += 1;
      registrations.push(...roots);
      return settleProcessGroups(roots);
    },
  });
  const cancellation = new AbortController();
  const request = { worktreePath: worktree, admissionTimeoutMs: ADMISSION_TIMEOUT_MS,
    executionTimeoutMs: EXECUTION_TIMEOUT_MS, cancellationSignal: cancellation.signal };
  const environment = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  const blocked = runner.run({ ...request, command: {
    argv: [process.execPath, "-e", "await Bun.write(process.argv[1], 'started'); setInterval(() => {}, 1000);", marker],
    cwd: ".", environment,
  } });
  const observed = blocked.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    const deadline = Date.now() + ADMISSION_TIMEOUT_MS;
    while (true) {
      try { if ((await readFile(marker, "utf8")) === "started") break; }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline) throw new Error("registered command did not publish its startup marker");
      await Bun.sleep(10);
    }
    cancellation.abort();
    const result = await observed;
    expect(result).toHaveProperty("error");
    if (!("error" in result)) throw new Error("cancelled command unexpectedly succeeded");
    expect(String(result.error)).toContain("cancelled");
    expect(worktreeSettlements).toBe(1);
    expect(rootSettlements).toBe(1);
    expect(registrations).toHaveLength(1);
    for (const registration of registrations) expect(isProcessGroupAlive(registration.pgid)).toBe(false);
    const successor = await runner.run({ ...request, cancellationSignal: new AbortController().signal,
      command: { argv: [process.execPath, "-e", 'process.stdout.write("focused-output");'], cwd: ".", environment } });
    expect(successor.gateExitCode).toBe(0);
    expect(successor.outputDigest).toBe(createHash("sha256").update("focused-output\n").digest("hex"));
    expect(successor.executionId.length).toBeGreaterThan(0);
    expect(worktreeSettlements).toBe(2);
    expect(rootSettlements).toBe(2);
    const outside = join(directory, "outside");
    await mkdir(outside);
    await symlink(outside, join(worktree, "escaped"));
    await expect(runner.run({ ...request, cancellationSignal: new AbortController().signal,
      command: { argv: [process.execPath, "-e", "process.exit(0)"], cwd: "escaped", environment },
    })).rejects.toThrow("escapes its managed worktree");
    expect(rootSettlements).toBe(2);
  } finally {
    cancellation.abort();
    await observed;
    await rm(directory, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);
