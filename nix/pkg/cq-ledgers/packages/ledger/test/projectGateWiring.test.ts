/**
 * D403 / H310 — the declared `[gate]` must REACH the supervised runner.
 *
 * `createNodeSupervisedWorkerGateRunner` already honours a
 * `ProjectGateSpecification`, and `[gate]` already parses out of cq.toml, but
 * nothing joined the two: the production runner was a module singleton built
 * with CQ's own gate, so a consumer project declaring `npm test` at its root
 * would still have `bun run check` executed in a `nix/pkg/cq-ledgers` that does
 * not exist. This suite pins the missing link — resolving a root's declared
 * gate — and the compatibility arm for a project that declares none.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  CANONICAL_PROJECT_GATE,
  PROJECT_GATE_ROOT_CWD,
  requireProjectGate,
  resolveProjectGateForRoot,
  type ProjectGateSpecification,
} from "@cq/config";
import { createNodeSupervisedWorkerGateRunner } from "../src/supervisedWorkerGate.js";

const exec = promisify(execFile);
const dirs: string[] = [];
let originalXdgStateHome: string | undefined;

afterAll(async () => {
  if (originalXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = originalXdgStateHome;
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

/** A throwaway repo with one commit (the xdg backend's identity key) and a cq.toml. */
async function project(prefix: string, gateSection: string): Promise<string> {
  if (originalXdgStateHome === undefined) {
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
    const home = await fs.mkdtemp(path.join(tmpdir(), "cq-gate-wiring-home-"));
    dirs.push(home);
    process.env["XDG_STATE_HOME"] = home;
  }
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), `# repo ${prefix}\n`);
  await fs.writeFile(
    path.join(dir, "cq.toml"),
    `[ledger]\n  backend = "xdg"\n${gateSection}`,
    "utf8",
  );
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("D403 declared project gate reaches store resolution", () => {
  test("a consumer's declared gate replaces CQ's layout", async () => {
    // GitHub issue #6's shape: no `nix/pkg/cq-ledgers`, gate at the root.
    const root = await project("cq-gate-declared-", '\n[gate]\n  argv = ["npm", "test"]\n  cwd = ""\n');
    const gate = requireProjectGate(resolveProjectGateForRoot(root));
    expect(gate.argv).toEqual(["npm", "test"]);
    expect(gate.cwd).toBe(PROJECT_GATE_ROOT_CWD);
    // The whole point: the supervised runner must not be handed CQ's layout.
    expect(gate.cwd).not.toBe(CANONICAL_PROJECT_GATE.cwd);
  }, 30_000);

  // D573: no declared gate is no gate; flows refuse by name instead of running CQ's.
  test("a project declaring no gate resolves to none", async () => {
    const root = await project("cq-gate-undeclared-", "");
    expect(resolveProjectGateForRoot(root)).toBeNull();
  }, 30_000);

  test("a root with no cq.toml at all resolves to no gate rather than throwing", () => {
    // The dispatch runtime resolves from `configRoot`; a root without a
    // cq.toml must not turn gate resolution into a construction failure, and
    // it must not inherit CQ's gate either (D573).
    expect(resolveProjectGateForRoot(path.join(tmpdir(), "cq-gate-absent-root"))).toBeNull();
  });
});

describe("D403 a root-level gate must be runnable, not just parseable", () => {
  const settled = { signaled: [] as number[], survivors: [] as number[] };
  const settlement = {
    settleWorktreeGateCommands: async () => settled,
    settleProcessGroups: async () => settled,
  };

  async function runGateIn(root: string, gate: ProjectGateSpecification) {
    const worktree = await fs.mkdtemp(path.join(tmpdir(), "cq-gate-worktree-"));
    dirs.push(worktree);
    // A shim `cq` that records the argv it was launched with and exits clean.
    const bin = path.join(worktree, "bin");
    await fs.mkdir(bin, { recursive: true });
    const record = path.join(worktree, "argv.txt");
    await fs.writeFile(
      path.join(bin, "cq"),
      ['#!/bin/sh', 'set -eu', `printf '%s\\n' "$@" > ${JSON.stringify(record)}`, 'exit 0', ''].join("\n"),
    );
    await fs.chmod(path.join(bin, "cq"), 0o700);
    const priorPath = process.env["PATH"];
    process.env["PATH"] = `${bin}${path.delimiter}${priorPath ?? ""}`;
    try {
      await createNodeSupervisedWorkerGateRunner(settlement, gate).run({
        worktreePath: worktree,
        admissionTimeoutMs: 30_000,
        executionTimeoutMs: 60_000,
        cancellationSignal: new AbortController().signal,
      });
      return (await fs.readFile(record, "utf8")).split("\n").filter((line) => line !== "");
    } finally {
      if (priorPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = priorPath;
    }
  }

  test("a gate declared at the repository root launches instead of being refused", async () => {
    // The supervised runner refuses an EMPTY cwd outright, so a project that
    // declares `[gate]` without a `cwd` — meaning "the worktree root", the
    // natural consumer shape — parsed cleanly and then failed at launch.
    const root = await project("cq-gate-rootlevel-", '\n[gate]\n  argv = ["npm", "test"]\n');
    const gate = requireProjectGate(resolveProjectGateForRoot(root));
    const argv = await runGateIn(root, gate);
    expect(argv.slice(-2)).toEqual(["npm", "test"]);
    // `--command-cwd` lands ON the worktree, not below it.
    const commandCwd = argv[argv.indexOf("--command-cwd") + 1];
    const worktree = argv[argv.indexOf("--worktree") + 1];
    expect(await fs.realpath(commandCwd!)).toBe(await fs.realpath(worktree!));
  }, 60_000);

  /** Run `gate` through a shim `cq` that prints `output` and exits `exitCode`. */
  async function runGatePrinting(gate: ProjectGateSpecification, output: string, exitCode: number) {
    const worktree = await fs.mkdtemp(path.join(tmpdir(), "cq-gate-counts-"));
    dirs.push(worktree);
    const bin = path.join(worktree, "bin");
    await fs.mkdir(bin, { recursive: true });
    const printed = path.join(worktree, "output.txt");
    await fs.writeFile(printed, output);
    await fs.writeFile(
      path.join(bin, "cq"),
      ['#!/bin/sh', `cat ${JSON.stringify(printed)}`, `exit ${String(exitCode)}`, ''].join("\n"),
    );
    await fs.chmod(path.join(bin, "cq"), 0o700);
    const priorPath = process.env["PATH"];
    process.env["PATH"] = `${bin}${path.delimiter}${priorPath ?? ""}`;
    try {
      return await createNodeSupervisedWorkerGateRunner(settlement, gate).run({
        worktreePath: worktree,
        admissionTimeoutMs: 30_000,
        executionTimeoutMs: 60_000,
        cancellationSignal: new AbortController().signal,
      });
    } finally {
      if (priorPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = priorPath;
    }
  }

  // regression: D605 — a later stage's stderr error survives long stdout lines in the bounded tail.
  test("a red gate's bounded output keeps the failing stage's stderr despite long stdout lines [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const worktree = await fs.mkdtemp(path.join(tmpdir(), "cq-gate-tail-"));
    dirs.push(worktree);
    const bin = path.join(worktree, "bin");
    await fs.mkdir(bin, { recursive: true });
    const stdoutFile = path.join(worktree, "stdout.txt");
    const longLine = `JOURNAL_SCALING ${JSON.stringify(Array.from({ length: 400 }, (_, index) => ({ index, payloadBytes: 2257 })))}`;
    await fs.writeFile(stdoutFile, `${Array.from({ length: 30 }, () => longLine).join("\n")}\n 209 pass\n 0 fail\n`);
    await fs.writeFile(
      path.join(bin, "cq"),
      ['#!/bin/sh', `cat ${JSON.stringify(stdoutFile)}`,
        // A realistic stage failure: many progress lines on stderr before the final cause.
        "i=0; while [ $i -lt 40 ]; do echo \"building /nix/store/$(printf %032d $i)-cq-0.0.1.drv... ($i)\" >&2; i=$((i+1)); done",
        "echo 'error: script \"check:codex-installed-gate\" exited with code 1' >&2", 'exit 1', ''].join("\n"),
    );
    await fs.chmod(path.join(bin, "cq"), 0o700);
    const gate: ProjectGateSpecification = { argv: ["bun", "run", "check"], cwd: ".", passCountPattern: null, failCountPattern: null };
    const priorPath = process.env["PATH"];
    process.env["PATH"] = `${bin}${path.delimiter}${priorPath ?? ""}`;
    try {
      const run = await createNodeSupervisedWorkerGateRunner(settlement, gate).run({
        worktreePath: worktree, admissionTimeoutMs: 30_000, executionTimeoutMs: 60_000,
        cancellationSignal: new AbortController().signal,
      });
      expect(run.gateExitCode).toBe(1);
      expect(run.outputTail).toContain('error: script "check:codex-installed-gate" exited with code 1');
    } finally {
      if (priorPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = priorPath;
    }
  }, 60_000);

  // regression: D568 — counts come from the project's declared rule, not Bun's summary format.
  test("a declared pytest count rule reads pytest's summary [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const pytest: ProjectGateSpecification = {
      argv: ["pytest"], cwd: ".",
      passCountPattern: String.raw`([0-9]+) passed`, failCountPattern: String.raw`([0-9]+) failed`,
    };
    const run = await runGatePrinting(pytest, "===== 42 passed in 0.10s =====\n", 0);
    expect({ exit: run.gateExitCode, pass: run.passCount, fail: run.failCount }).toEqual({ exit: 0, pass: 42, fail: 0 });
    const red = await runGatePrinting(pytest, "===== 2 failed, 40 passed in 0.10s =====\n", 1);
    expect({ pass: red.passCount, fail: red.failCount }).toEqual({ pass: 40, fail: 2 });
  }, 60_000);

  test("with no declared count rule the exit status alone decides [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const cargo: ProjectGateSpecification = { argv: ["cargo", "test"], cwd: ".", passCountPattern: null, failCountPattern: null };
    // `0 fail`-shaped text must not be read through a rule nobody declared.
    const run = await runGatePrinting(cargo, "test result: ok. 7 passed; 0 failed\n 3 fail\n", 0);
    expect({ exit: run.gateExitCode, pass: run.passCount, fail: run.failCount }).toEqual({ exit: 0, pass: 0, fail: 0 });
    const red = await runGatePrinting(cargo, "test result: FAILED\n", 101);
    expect(red.failCount).toBe(1);
  }, 60_000);
});
