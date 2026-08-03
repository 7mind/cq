import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  nodeDispatchBaseGitRunner,
  observeDispatchBase,
  verifyDispatchBase,
} from "../src/index.js";
import type { DispatchBaseObservations, DispatchBaseVerification } from "../src/index.js";

const exec = promisify(execFile);
const BASE_COMMIT = "a".repeat(40);
const HEAD_COMMIT = "b".repeat(40);

interface VerificationCase {
  readonly name: string;
  readonly observations: DispatchBaseObservations;
  readonly expected: DispatchBaseVerification;
  readonly narrowed: string;
}

const verificationCases: readonly VerificationCase[] = [
  {
    name: "equal HEAD and base",
    observations: {
      base: { status: "commit", commit: BASE_COMMIT },
      head: { status: "commit", commit: BASE_COMMIT },
      ancestry: "equal",
    },
    expected: {
      status: "verified",
      relation: "equal",
      baseCommit: BASE_COMMIT,
      headCommit: BASE_COMMIT,
    },
    narrowed: `verified:equal:${BASE_COMMIT}:${BASE_COMMIT}`,
  },
  {
    name: "descendant HEAD",
    observations: {
      base: { status: "commit", commit: BASE_COMMIT },
      head: { status: "commit", commit: HEAD_COMMIT },
      ancestry: "ancestor",
    },
    expected: {
      status: "verified",
      relation: "descendant",
      baseCommit: BASE_COMMIT,
      headCommit: HEAD_COMMIT,
    },
    narrowed: `verified:descendant:${BASE_COMMIT}:${HEAD_COMMIT}`,
  },
  {
    name: "diverged HEAD",
    observations: {
      base: { status: "commit", commit: BASE_COMMIT },
      head: { status: "commit", commit: HEAD_COMMIT },
      ancestry: "diverged",
    },
    expected: {
      status: "rebase-required",
      relation: "diverged",
      baseCommit: BASE_COMMIT,
      headCommit: HEAD_COMMIT,
    },
    narrowed: `rebase-required:${BASE_COMMIT}:${HEAD_COMMIT}`,
  },
  {
    name: "missing base",
    observations: {
      base: { status: "missing" },
      head: { status: "commit", commit: HEAD_COMMIT },
      ancestry: "unobserved",
    },
    expected: {
      status: "unresolvable",
      reason: "base-missing",
      baseCommit: null,
      headCommit: HEAD_COMMIT,
    },
    narrowed: `unresolvable:base-missing:null:${HEAD_COMMIT}`,
  },
  {
    name: "missing HEAD",
    observations: {
      base: { status: "commit", commit: BASE_COMMIT },
      head: { status: "missing" },
      ancestry: "unobserved",
    },
    expected: {
      status: "unresolvable",
      reason: "head-missing",
      baseCommit: BASE_COMMIT,
      headCommit: null,
    },
    narrowed: `unresolvable:head-missing:${BASE_COMMIT}:null`,
  },
  {
    name: "non-commit base object",
    observations: {
      base: { status: "non-commit" },
      head: { status: "commit", commit: HEAD_COMMIT },
      ancestry: "unobserved",
    },
    expected: {
      status: "unresolvable",
      reason: "base-not-commit",
      baseCommit: null,
      headCommit: HEAD_COMMIT,
    },
    narrowed: `unresolvable:base-not-commit:null:${HEAD_COMMIT}`,
  },
  {
    name: "non-commit HEAD object",
    observations: {
      base: { status: "commit", commit: BASE_COMMIT },
      head: { status: "non-commit" },
      ancestry: "unobserved",
    },
    expected: {
      status: "unresolvable",
      reason: "head-not-commit",
      baseCommit: BASE_COMMIT,
      headCommit: null,
    },
    narrowed: `unresolvable:head-not-commit:${BASE_COMMIT}:null`,
  },
  {
    name: "unrelated histories",
    observations: {
      base: { status: "commit", commit: BASE_COMMIT },
      head: { status: "commit", commit: HEAD_COMMIT },
      ancestry: "unrelated",
    },
    expected: {
      status: "unresolvable",
      reason: "unrelated-histories",
      baseCommit: BASE_COMMIT,
      headCommit: HEAD_COMMIT,
    },
    narrowed: `unresolvable:unrelated-histories:${BASE_COMMIT}:${HEAD_COMMIT}`,
  },
];

function narrowResult(result: DispatchBaseVerification): string {
  switch (result.status) {
    case "verified":
      return `verified:${result.relation}:${result.baseCommit}:${result.headCommit}`;
    case "rebase-required":
      return `rebase-required:${result.baseCommit}:${result.headCommit}`;
    case "unresolvable":
      return `unresolvable:${result.reason}:${result.baseCommit ?? "null"}:${result.headCommit ?? "null"}`;
  }
}

// @ts-expect-error unresolvable results require a closed reason
const missingReason: DispatchBaseVerification = {
  status: "unresolvable",
  baseCommit: null,
  headCommit: null,
};
// @ts-expect-error missing base evidence cannot carry an invented commit
const inventedBaseCommit: DispatchBaseVerification = {
  status: "unresolvable",
  reason: "base-missing",
  baseCommit: BASE_COMMIT,
  headCommit: HEAD_COMMIT,
};
void missingReason;
void inventedBaseCommit;

describe("verifyDispatchBase", () => {
  it("classifies supplied commit observations with closed discriminated results", () => {
    expect(
      verificationCases.map((testCase) => {
        const result = verifyDispatchBase(testCase.observations);
        return { name: testCase.name, result, narrowed: narrowResult(result) };
      }),
    ).toEqual(
      verificationCases.map((testCase) => ({
        name: testCase.name,
        result: testCase.expected,
        narrowed: testCase.narrowed,
      })),
    );
  });
});

const repositories: string[] = [];

async function seedRepository(message: string): Promise<{ cwd: string; head: string }> {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "dispatch-base-"));
  repositories.push(cwd);
  await exec("git", ["init", "--quiet"], { cwd });
  await exec(
    "git",
    [
      "-c",
      "user.name=Dispatch Base Test",
      "-c",
      "user.email=dispatch-base@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    ],
    { cwd },
  );
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd });
  return { cwd, head: stdout.trim() };
}

afterAll(async () => {
  for (const repository of repositories) {
    await fs.rm(repository, { recursive: true, force: true });
  }
});

describe("dispatch-base Git adapter", () => {
  it("keeps the explicit cwd isolated across concurrent repositories", async () => {
    const [first, second] = await Promise.all([
      seedRepository("first repository"),
      seedRepository("second repository"),
    ]);
    const [firstObservations, secondObservations] = await Promise.all([
      observeDispatchBase(
        { cwd: first.cwd, baseRevision: "HEAD", headRevision: "HEAD" },
        nodeDispatchBaseGitRunner,
      ),
      observeDispatchBase(
        { cwd: second.cwd, baseRevision: "HEAD", headRevision: "HEAD" },
        nodeDispatchBaseGitRunner,
      ),
    ]);

    expect([verifyDispatchBase(firstObservations), verifyDispatchBase(secondObservations)]).toEqual(
      [
        {
          status: "verified",
          relation: "equal",
          baseCommit: first.head,
          headCommit: first.head,
        },
        {
          status: "verified",
          relation: "equal",
          baseCommit: second.head,
          headCommit: second.head,
        },
      ],
    );
  });
});
