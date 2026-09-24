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
  resolveProjectGateForRoot,
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
    const gate = resolveProjectGateForRoot(root);
    expect(gate.argv).toEqual(["npm", "test"]);
    expect(gate.cwd).toBe(PROJECT_GATE_ROOT_CWD);
    // The whole point: the supervised runner must not be handed CQ's layout.
    expect(gate.cwd).not.toBe(CANONICAL_PROJECT_GATE.cwd);
  }, 30_000);

  test("a project declaring no gate keeps the documented compatibility fallback", async () => {
    const root = await project("cq-gate-undeclared-", "");
    expect(resolveProjectGateForRoot(root)).toEqual(CANONICAL_PROJECT_GATE);
  }, 30_000);

  test("a root with no cq.toml at all resolves rather than throwing", () => {
    // The dispatch runtime resolves from `configRoot`; a fixture root without
    // a cq.toml must not turn gate resolution into a construction failure.
    expect(resolveProjectGateForRoot(path.join(tmpdir(), "cq-gate-absent-root"))).toEqual(
      CANONICAL_PROJECT_GATE,
    );
  });
});

describe("D403 a root-level gate must be runnable, not just parseable", () => {
  const settled = { signaled: [] as number[], survivors: [] as number[] };
  const settlement = {
    settleWorktreeGateCommands: async () => settled,
    settleProcessGroups: async () => settled,
  };

  async function runGateIn(root: string, gate: { argv: readonly string[]; cwd: string }) {
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
    const gate = resolveProjectGateForRoot(root);
    const argv = await runGateIn(root, gate);
    expect(argv.slice(-2)).toEqual(["npm", "test"]);
    // `--command-cwd` lands ON the worktree, not below it.
    const commandCwd = argv[argv.indexOf("--command-cwd") + 1];
    const worktree = argv[argv.indexOf("--worktree") + 1];
    expect(await fs.realpath(commandCwd!)).toBe(await fs.realpath(worktree!));
  }, 60_000);
});
