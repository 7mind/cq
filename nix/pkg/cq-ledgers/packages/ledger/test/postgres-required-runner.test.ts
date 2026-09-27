/**
 * G192/T6627 — offline contract for the required-PostgreSQL Bun runner.
 *
 * Classifier mode is exercised over synthetic transcripts; run mode is
 * exercised only with a nonexistent path, which must fail before any
 * PostgreSQL discovery or provisioning. Neither needs a PostgreSQL server.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const RUNNER = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "scripts",
  "lib",
  "postgres-required-bun-test.sh",
);
const MISSING_TEST_FILE = "packages/ledger/test/does-not-exist.test.ts";
const NONEXISTENT_POSTGRES_BIN = "/nonexistent";
const temporaryDirectories: string[] = [];

interface RunnerOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runRunner(args: readonly string[], env: Record<string, string>): RunnerOutcome {
  const result = Bun.spawnSync(["bash", RUNNER, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function transcript(lines: readonly string[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cq-required-pg-runner-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "transcript.log");
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

function classify(lines: readonly string[], expectedFiles: number): RunnerOutcome {
  return runRunner(["--classify", transcript(lines), String(expectedFiles)], {});
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("postgres-required-bun-test.sh classifier", () => {
  it("accepts a plural multi-file transcript", () => {
    const outcome = classify(
      [" 120 pass", " 0 fail", " 431 expect() calls", "Ran 120 tests across 3 files. [4.21s]"],
      3,
    );
    expect(outcome.exitCode).toBe(0);
  });

  it("accepts the singular one-file transcript", () => {
    const outcome = classify(
      [" 35 pass", " 0 fail", " 88 expect() calls", "Ran 35 tests across 1 file. [2.02s]"],
      1,
    );
    expect(outcome.exitCode).toBe(0);
  });

  it("rejects a skipped test", () => {
    const outcome = classify(
      [" 34 pass", " 1 skip", " 0 fail", "Ran 35 tests across 1 file. [2.02s]"],
      1,
    );
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toContain("skipped or deferred");
  });

  it("rejects a todo test", () => {
    const outcome = classify(
      [" 33 pass", " 2 todo", " 0 fail", "Ran 35 tests across 1 file. [2.02s]"],
      1,
    );
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toContain("skipped or deferred");
  });

  it("rejects a file-count mismatch", () => {
    const outcome = classify(
      [" 120 pass", " 0 fail", "Ran 120 tests across 2 files. [4.21s]"],
      3,
    );
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toContain("covered 2 files; expected 3");
  });

  it("rejects a transcript without a Ran summary line", () => {
    const outcome = classify([" 120 pass", " 0 fail"], 3);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toContain("no 'Ran ... across ...' summary");
  });

  it("rejects a transcript without a pass line", () => {
    const outcome = classify([" 0 fail", "Ran 0 tests across 1 file. [0.01s]"], 1);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toContain("no passing tests");
  });
});

describe("postgres-required-bun-test.sh run mode", () => {
  it("rejects a missing test path before PostgreSQL discovery or provisioning", () => {
    const outcome = runRunner([MISSING_TEST_FILE], {
      CQ_TEST_POSTGRES_BIN: NONEXISTENT_POSTGRES_BIN,
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toContain(`missing test file: ${MISSING_TEST_FILE}`);
    expect(outcome.stderr).not.toContain("PostgreSQL executable is unavailable");
  });
});
