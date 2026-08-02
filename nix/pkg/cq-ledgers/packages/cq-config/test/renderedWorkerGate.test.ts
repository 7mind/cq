import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const WORKER_PROMPT = path.join(
  REPO_ROOT,
  "nix",
  "pkg",
  "cq-assets",
  "agents",
  "implement-worker.md",
);
const EXACT_GATE =
  'cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check';
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("D244/D243 rendered worker gate and history contract", () => {
  it("renders exactly the cq gate wrapper and removes reset-based repair", () => {
    const prompt = readFileSync(WORKER_PROMPT, "utf8");
    expect(prompt.split(EXACT_GATE)).toHaveLength(2);
    expect(prompt).not.toContain("git reset --hard");
    expect(prompt).not.toContain("From the worktree root run `bun run check`");
  });

  it("executes the real rendered gate from a fresh worktree root", () => {
    const worktree = temporaryDirectory("cq-t1629-gate-");
    const packageDirectory = path.join(worktree, "nix", "pkg", "cq-ledgers");
    mkdirSync(packageDirectory, { recursive: true });
    run(["git", "init", "--quiet"], worktree);
    run(["git", "config", "user.email", "cq-test@example.invalid"], worktree);
    run(["git", "config", "user.name", "CQ test"], worktree);
    writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "cq-t1629-gate-fixture",
        private: true,
        scripts: { check: "bun test gate.fixture.test.ts" },
      }),
    );
    writeFileSync(
      path.join(packageDirectory, "gate.fixture.test.ts"),
      'import { expect, test } from "bun:test";\n' +
        'test("real package check", () => expect(process.cwd()).toBe(import.meta.dir));\n',
    );
    run(["git", "add", "."], worktree);
    run(["git", "commit", "--quiet", "-m", "gate fixture"], worktree);
    const result = Bun.spawnSync(["sh", "-c", EXACT_GATE], {
      cwd: worktree,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = [
      new TextDecoder().decode(result.stdout),
      new TextDecoder().decode(result.stderr),
    ].join("\n");
    expect(result.exitCode).toBe(0);
    expect(output).toContain("real package check");
    expect(output).toContain("1 pass");
  });

  it("rejects a sibling result and accepts a result descending from the round start", () => {
    const repository = temporaryDirectory("cq-t1629-history-");
    run(["git", "init", "--quiet"], repository);
    run(["git", "config", "user.email", "cq-test@example.invalid"], repository);
    run(["git", "config", "user.name", "CQ test"], repository);
    writeFileSync(path.join(repository, "fixture.txt"), "base\n");
    run(["git", "add", "fixture.txt"], repository);
    run(["git", "commit", "--quiet", "-m", "B"], repository);
    const base = run(["git", "rev-parse", "HEAD"], repository);

    writeFileSync(path.join(repository, "fixture.txt"), "base\nprior\n");
    run(["git", "commit", "--quiet", "-am", "P"], repository);
    const startingCommit = run(["git", "rev-parse", "HEAD"], repository);
    run(["git", "checkout", "--quiet", "-b", "sibling", base], repository);
    writeFileSync(path.join(repository, "fixture.txt"), "base\nsibling\n");
    run(["git", "commit", "--quiet", "-am", "S"], repository);
    const sibling = run(["git", "rev-parse", "HEAD"], repository);
    const currentHead = run(["git", "rev-parse", "HEAD"], repository);
    run(["git", "checkout", "--quiet", "-b", "result", startingCommit], repository);
    writeFileSync(path.join(repository, "fixture.txt"), "base\nprior\nresult\n");
    run(["git", "commit", "--quiet", "-am", "R"], repository);
    const resultCommit = run(["git", "rev-parse", "HEAD"], repository);

    expect(
      Bun.spawnSync(["git", "merge-base", "--is-ancestor", base, sibling], {
        cwd: repository,
      }).exitCode,
    ).toBe(0);
    expect(currentHead).toBe(sibling);
    expect(currentHead).not.toBe(startingCommit);
    const workerEntryAccepted =
      currentHead === startingCommit &&
      Bun.spawnSync(["git", "merge-base", "--is-ancestor", base, currentHead], {
        cwd: repository,
      }).exitCode === 0;
    expect(workerEntryAccepted).toBe(false);
    expect(
      Bun.spawnSync(["git", "merge-base", "--is-ancestor", startingCommit, resultCommit], {
        cwd: repository,
      }).exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync(["git", "merge-base", "--is-ancestor", startingCommit, sibling], {
        cwd: repository,
      }).exitCode,
    ).not.toBe(0);
  });
});
