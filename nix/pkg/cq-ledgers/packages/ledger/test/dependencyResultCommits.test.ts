import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  resolveDependencyResultCommits,
  resolveDependencyResultCommitsForDispatch,
} from "../src/index.js";
import type {
  DependencyResultCommitResolution,
  DependencyTaskSnapshot,
  DependencyTaskSnapshotReader,
  DispatchBaseGitResult,
  DispatchBaseGitRunner,
} from "../src/index.js";

const exec = promisify(execFile);
const COMMIT_1 = "1".repeat(40);
const COMMIT_2 = "2".repeat(40);
const COMMIT_3 = "3".repeat(40);
const DISPATCH_BASE = "a".repeat(40);

function task(
  taskId: string,
  status: string,
  dependsOn: readonly string[],
  resultCommit: string | null,
  archived: boolean,
): DependencyTaskSnapshot {
  return { taskId, status, dependsOn, resultCommit, archived };
}

function resolve(
  rootTaskRef: string,
  taskSnapshots: readonly DependencyTaskSnapshot[],
): DependencyResultCommitResolution {
  return resolveDependencyResultCommits({ rootTaskRef, taskSnapshots });
}

describe("resolveDependencyResultCommits", () => {
  it("walks direct and transitive task dependencies in deterministic topological order", () => {
    const root = task("T9", "planned", ["tasks:T3", "T2"], null, false);
    const first = task("T1", "done", [], COMMIT_1, true);
    const second = task("T2", "done", ["T1"], COMMIT_2, false);
    const third = task("T3", "done", ["tasks:T1"], COMMIT_3, true);
    const expected: DependencyResultCommitResolution = {
      status: "ready",
      dependencyResultCommits: [
        { dependencyRef: "tasks:T1", resultCommit: COMMIT_1 },
        { dependencyRef: "tasks:T2", resultCommit: COMMIT_2 },
        { dependencyRef: "tasks:T3", resultCommit: COMMIT_3 },
      ],
    };

    expect([
      resolve("T9", [root, third, first, second]),
      resolve("tasks:T9", [second, root, third, first]),
    ]).toEqual([expected, expected]);
  });

  it("returns the first deterministic metadata blocker with a closed reason", () => {
    const cases: readonly {
      readonly name: string;
      readonly root: DependencyTaskSnapshot;
      readonly dependencies: readonly DependencyTaskSnapshot[];
      readonly expected: DependencyResultCommitResolution;
    }[] = [
      {
        name: "cycle",
        root: task("T9", "planned", ["T1"], null, false),
        dependencies: [
          task("T1", "done", ["T2"], COMMIT_1, false),
          task("T2", "done", ["T1"], COMMIT_2, false),
        ],
        expected: {
          status: "unresolvable",
          reason: "dependency-cycle",
          dependencyRef: "tasks:T1",
          cycle: ["tasks:T1", "tasks:T2", "tasks:T1"],
        },
      },
      {
        name: "active dependency",
        root: task("T9", "planned", ["T1"], null, false),
        dependencies: [task("T1", "wip", [], null, false)],
        expected: {
          status: "unresolvable",
          reason: "dependency-not-satisfied",
          dependencyRef: "tasks:T1",
          dependencyStatus: "wip",
          archived: false,
        },
      },
      {
        name: "archived non-satisfying terminal dependency",
        root: task("T9", "planned", ["T1"], null, false),
        dependencies: [task("T1", "abandoned", [], COMMIT_1, true)],
        expected: {
          status: "unresolvable",
          reason: "dependency-not-satisfied",
          dependencyRef: "tasks:T1",
          dependencyStatus: "abandoned",
          archived: true,
        },
      },
      {
        name: "missing result commit",
        root: task("T9", "planned", ["T1"], null, false),
        dependencies: [task("T1", "done", [], null, true)],
        expected: {
          status: "unresolvable",
          reason: "result-commit-missing",
          dependencyRef: "tasks:T1",
        },
      },
      {
        name: "malformed result commit",
        root: task("T9", "planned", ["T1"], null, false),
        dependencies: [task("T1", "done", [], "deadbeef", false)],
        expected: {
          status: "unresolvable",
          reason: "result-commit-malformed",
          dependencyRef: "tasks:T1",
          resultCommit: "deadbeef",
        },
      },
      {
        name: "missing dependency snapshot",
        root: task("T9", "planned", ["T404"], null, false),
        dependencies: [],
        expected: {
          status: "unresolvable",
          reason: "dependency-not-found",
          dependencyRef: "tasks:T404",
        },
      },
      {
        name: "malformed dependency ref",
        root: task("T9", "planned", ["not-a-task-ref"], null, false),
        dependencies: [],
        expected: {
          status: "unresolvable",
          reason: "dependency-ref-invalid",
          dependencyRef: "not-a-task-ref",
        },
      },
    ];

    const blockers = cases.map(({ name, root, dependencies }) => ({
      name,
      result: resolve("T9", [root, ...dependencies]),
    }));
    const archivedDone = resolve("T9", [
      task("T9", "planned", ["T1"], null, false),
      task("T1", "done", [], COMMIT_1, true),
    ]);

    expect({ blockers, archivedDone }).toEqual({
      blockers: cases.map(({ name, expected }) => ({ name, result: expected })),
      archivedDone: {
        status: "ready",
        dependencyResultCommits: [{ dependencyRef: "tasks:T1", resultCommit: COMMIT_1 }],
      },
    });
  });
});

class MutableTaskSnapshotReader implements DependencyTaskSnapshotReader {
  constructor(public taskSnapshots: readonly DependencyTaskSnapshot[]) {}

  async readTaskSnapshots(): Promise<readonly DependencyTaskSnapshot[]> {
    return this.taskSnapshots;
  }
}

type MemoryRelation = "ancestor" | "diverged" | "unrelated";

class MemoryGit {
  readonly objects = new Map<string, "commit" | "non-commit">();
  readonly relations = new Map<string, MemoryRelation>();

  readonly run: DispatchBaseGitRunner = async (_cwd, args) => {
    const [command, ...rest] = args;
    if (command === "rev-parse") return this.revParse(rest);
    if (command === "merge-base") return this.mergeBase(rest);
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };

  private revParse(args: readonly string[]): DispatchBaseGitResult {
    const revision = args.at(-1);
    if (revision === undefined) throw new Error("missing revision");
    const commitSuffix = "^{commit}";
    const objectSuffix = "^{object}";
    const raw = revision.endsWith(commitSuffix)
      ? revision.slice(0, -commitSuffix.length)
      : revision.endsWith(objectSuffix)
        ? revision.slice(0, -objectSuffix.length)
        : revision;
    const kind = this.objects.get(raw);
    const exists = revision.endsWith(commitSuffix) ? kind === "commit" : kind !== undefined;
    return this.result(exists ? 0 : 1, exists ? `${raw}\n` : "");
  }

  private mergeBase(args: readonly string[]): DispatchBaseGitResult {
    const isAncestor = args[0] === "--is-ancestor";
    const base = args[isAncestor ? 1 : 0];
    const head = args[isAncestor ? 2 : 1];
    if (base === undefined || head === undefined) throw new Error("missing merge-base revisions");
    const relation = base === head ? "ancestor" : this.relations.get(`${base}:${head}`);
    if (isAncestor) return this.result(relation === "ancestor" ? 0 : 1, "");
    return this.result(relation === "unrelated" || relation === undefined ? 1 : 0, "common\n");
  }

  private result(code: number, stdout: string): DispatchBaseGitResult {
    return { code, stdout, stderr: "" };
  }
}

describe("dependency result commit ledger/Git adapter", () => {
  it("maps Git evidence through the dispatch-base predicate and re-evaluates every retry", async () => {
    const reader = new MutableTaskSnapshotReader([
      task("T9", "planned", ["T1"], null, false),
      task("T1", "done", [], null, true),
    ]);
    const git = new MemoryGit();
    git.objects.set(DISPATCH_BASE, "commit");

    const request = {
      cwd: "/repository",
      rootTaskRef: "T9",
      proposedDispatchBase: DISPATCH_BASE,
    } as const;

    const missingMetadata = await resolveDependencyResultCommitsForDispatch(
      request,
      reader,
      git.run,
    );

    const gitCases: readonly {
      readonly name: string;
      readonly commit: string;
      readonly kind: "missing" | "non-commit" | "commit";
      readonly relation: MemoryRelation;
      readonly expected: DependencyResultCommitResolution;
    }[] = [
      {
        name: "absent object",
        commit: COMMIT_1,
        kind: "missing",
        relation: "ancestor",
        expected: {
          status: "unresolvable",
          reason: "result-commit-object-missing",
          dependencyRef: "tasks:T1",
          resultCommit: COMMIT_1,
        },
      },
      {
        name: "non-commit object",
        commit: COMMIT_2,
        kind: "non-commit",
        relation: "ancestor",
        expected: {
          status: "unresolvable",
          reason: "result-commit-object-not-commit",
          dependencyRef: "tasks:T1",
          resultCommit: COMMIT_2,
        },
      },
      {
        name: "diverged commit",
        commit: COMMIT_2,
        kind: "commit",
        relation: "diverged",
        expected: {
          status: "unresolvable",
          reason: "result-commit-not-contained",
          dependencyRef: "tasks:T1",
          resultCommit: COMMIT_2,
          proposedDispatchBase: DISPATCH_BASE,
          relation: "diverged",
        },
      },
      {
        name: "unrelated commit",
        commit: COMMIT_3,
        kind: "commit",
        relation: "unrelated",
        expected: {
          status: "unresolvable",
          reason: "result-commit-not-contained",
          dependencyRef: "tasks:T1",
          resultCommit: COMMIT_3,
          proposedDispatchBase: DISPATCH_BASE,
          relation: "unrelated",
        },
      },
    ];

    const observed: { name: string; result: DependencyResultCommitResolution }[] = [];
    for (const testCase of gitCases) {
      reader.taskSnapshots = [
        task("T9", "planned", ["T1"], null, false),
        task("T1", "done", [], testCase.commit, true),
      ];
      if (testCase.kind === "missing") git.objects.delete(testCase.commit);
      else git.objects.set(testCase.commit, testCase.kind);
      git.relations.set(`${testCase.commit}:${DISPATCH_BASE}`, testCase.relation);
      observed.push({
        name: testCase.name,
        result: await resolveDependencyResultCommitsForDispatch(request, reader, git.run),
      });
    }
    reader.taskSnapshots = [
      task("T9", "planned", ["T1"], null, false),
      task("T1", "done", [], COMMIT_1, true),
    ];
    git.objects.set(COMMIT_1, "commit");
    git.relations.set(`${COMMIT_1}:${DISPATCH_BASE}`, "ancestor");
    const corrected = await resolveDependencyResultCommitsForDispatch(request, reader, git.run);

    expect({ missingMetadata, observed, corrected }).toEqual({
      missingMetadata: {
        status: "unresolvable",
        reason: "result-commit-missing",
        dependencyRef: "tasks:T1",
      },
      observed: gitCases.map(({ name, expected }) => ({ name, result: expected })),
      corrected: {
        status: "ready",
        dependencyResultCommits: [{ dependencyRef: "tasks:T1", resultCommit: COMMIT_1 }],
      },
    });
  });
});

const repositories: string[] = [];

async function seedRepository(): Promise<{ cwd: string; base: string; head: string }> {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "dependency-result-commits-"));
  repositories.push(cwd);
  await exec("git", ["init", "--quiet"], { cwd });
  await exec(
    "git",
    [
      "-c",
      "user.name=Dependency Result Test",
      "-c",
      "user.email=dependency-result@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "dependency",
    ],
    { cwd },
  );
  const { stdout: baseOut } = await exec("git", ["rev-parse", "HEAD"], { cwd });
  await exec(
    "git",
    [
      "-c",
      "user.name=Dependency Result Test",
      "-c",
      "user.email=dependency-result@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "dispatch base",
    ],
    { cwd },
  );
  const { stdout: headOut } = await exec("git", ["rev-parse", "HEAD"], { cwd });
  return { cwd, base: baseOut.trim(), head: headOut.trim() };
}

afterAll(async () => {
  for (const repository of repositories) {
    await fs.rm(repository, { recursive: true, force: true });
  }
});

it("validates contained, absent, non-commit, and unrelated commits in a real repository", async () => {
  const repository = await seedRepository();
  const blobPath = path.join(repository.cwd, "blob.txt");
  await fs.writeFile(blobPath, "not a commit\n", "utf8");
  const { stdout: blobOut } = await exec("git", ["hash-object", "-w", blobPath], {
    cwd: repository.cwd,
  });
  const { stdout: treeOut } = await exec("git", ["write-tree"], { cwd: repository.cwd });
  const { stdout: unrelatedOut } = await exec(
    "git",
    [
      "-c",
      "user.name=Dependency Result Test",
      "-c",
      "user.email=dependency-result@example.invalid",
      "commit-tree",
      treeOut.trim(),
      "-m",
      "unrelated",
    ],
    { cwd: repository.cwd },
  );
  const reader = new MutableTaskSnapshotReader([]);
  const request = {
    cwd: repository.cwd,
    rootTaskRef: "T9",
    proposedDispatchBase: repository.head,
  } as const;
  const cases = [
    [repository.base, "ready"],
    ["f".repeat(40), "result-commit-object-missing"],
    [blobOut.trim(), "result-commit-object-not-commit"],
    [unrelatedOut.trim(), "result-commit-not-contained"],
  ] as const;

  const observed: [string, string][] = [];
  for (const [resultCommit, expectedStatus] of cases) {
    reader.taskSnapshots = [
      task("T9", "planned", ["T1"], null, false),
      task("T1", "done", [], resultCommit, true),
    ];
    const result = await resolveDependencyResultCommitsForDispatch(
      request,
      reader,
      async (cwd, args) => {
        try {
          const { stdout, stderr } = await exec("git", [...args], { cwd });
          return { code: 0, stdout, stderr };
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          return {
            code: failure.code ?? 1,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
          };
        }
      },
    );
    observed.push([expectedStatus, result.status === "ready" ? result.status : result.reason]);
  }

  expect(observed).toEqual(cases.map(([, expectedStatus]) => [expectedStatus, expectedStatus]));
});
