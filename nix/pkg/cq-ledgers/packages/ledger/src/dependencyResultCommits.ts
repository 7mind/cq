import { TASKS_LEDGER, TASKS_SCHEMA } from "./constants.js";
import { observeDispatchBase, verifyDispatchBase } from "./dispatchBase.js";
import type { DispatchBaseGitRunner, DispatchBaseVerification } from "./dispatchBase.js";
import { canonicalizeRef, parseRef } from "./refs.js";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const TASK_ID = /^T\d+$/;
const TASK_REF_REGISTRY: ReadonlyMap<string, string> = new Map([["T", TASKS_LEDGER]]);
const TASK_SATISFYING_STATUSES = new Set(
  TASKS_SCHEMA.satisfiesDependencyStatuses ?? TASKS_SCHEMA.terminalStatuses,
);

export interface DependencyTaskSnapshot {
  readonly taskId: string;
  readonly status: string;
  readonly dependsOn: readonly string[];
  readonly resultCommit: string | null;
  readonly archived: boolean;
}

export interface DependencyResultCommit {
  readonly dependencyRef: string;
  readonly resultCommit: string;
}

export interface ReadyDependencyResultCommits {
  readonly status: "ready";
  readonly dependencyResultCommits: readonly DependencyResultCommit[];
}

export type UnresolvableDependencyResultCommits =
  | {
      readonly status: "unresolvable";
      readonly reason: "dependency-ref-invalid" | "dependency-not-found";
      readonly dependencyRef: string;
    }
  | {
      readonly status: "unresolvable";
      readonly reason: "dependency-cycle";
      readonly dependencyRef: string;
      readonly cycle: readonly string[];
    }
  | {
      readonly status: "unresolvable";
      readonly reason: "dependency-not-satisfied";
      readonly dependencyRef: string;
      readonly dependencyStatus: string;
      readonly archived: boolean;
    }
  | {
      readonly status: "unresolvable";
      readonly reason: "result-commit-missing";
      readonly dependencyRef: string;
    }
  | {
      readonly status: "unresolvable";
      readonly reason:
        | "result-commit-malformed"
        | "result-commit-object-missing"
        | "result-commit-object-not-commit";
      readonly dependencyRef: string;
      readonly resultCommit: string;
    }
  | {
      readonly status: "unresolvable";
      readonly reason: "result-commit-not-contained";
      readonly dependencyRef: string;
      readonly resultCommit: string;
      readonly proposedDispatchBase: string;
      readonly relation: "diverged" | "unrelated";
    }
  | {
      readonly status: "unresolvable";
      readonly reason: "dispatch-base-object-missing" | "dispatch-base-object-not-commit";
      readonly dependencyRef: string;
      readonly resultCommit: string;
      readonly proposedDispatchBase: string;
    }
  | {
      readonly status: "unresolvable";
      readonly reason: "result-commit-ancestry-unobserved";
      readonly dependencyRef: string;
      readonly resultCommit: string;
      readonly proposedDispatchBase: string;
    };

export type DependencyResultCommitResolution =
  ReadyDependencyResultCommits | UnresolvableDependencyResultCommits;

export interface ResolveDependencyResultCommitsRequest {
  readonly rootTaskRef: string;
  readonly taskSnapshots: readonly DependencyTaskSnapshot[];
}

function canonicalTaskRef(raw: string): string | null {
  try {
    const canonical = canonicalizeRef(raw, TASK_REF_REGISTRY);
    const parsed = parseRef(canonical);
    if (parsed.kind !== "prefixed" || parsed.ledger !== TASKS_LEDGER || !TASK_ID.test(parsed.id)) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

function invalidDependencyRef(dependencyRef: string): UnresolvableDependencyResultCommits {
  return { status: "unresolvable", reason: "dependency-ref-invalid", dependencyRef };
}

export function resolveDependencyResultCommits(
  request: ResolveDependencyResultCommitsRequest,
): DependencyResultCommitResolution {
  const tasksByRef = new Map<string, DependencyTaskSnapshot>();
  for (const task of request.taskSnapshots) {
    const taskRef = canonicalTaskRef(task.taskId);
    if (taskRef === null) return invalidDependencyRef(task.taskId);
    tasksByRef.set(taskRef, task);
  }

  const rootTaskRef = canonicalTaskRef(request.rootTaskRef);
  if (rootTaskRef === null) return invalidDependencyRef(request.rootTaskRef);
  if (!tasksByRef.has(rootTaskRef)) {
    return { status: "unresolvable", reason: "dependency-not-found", dependencyRef: rootTaskRef };
  }

  const stateByRef = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const dependencyResultCommits: DependencyResultCommit[] = [];

  function visit(taskRef: string): UnresolvableDependencyResultCommits | null {
    const state = stateByRef.get(taskRef);
    if (state === "done") return null;
    if (state === "visiting") {
      const cycleStart = stack.indexOf(taskRef);
      return {
        status: "unresolvable",
        reason: "dependency-cycle",
        dependencyRef: taskRef,
        cycle: [...stack.slice(cycleStart), taskRef],
      };
    }

    const task = tasksByRef.get(taskRef);
    if (task === undefined) {
      return { status: "unresolvable", reason: "dependency-not-found", dependencyRef: taskRef };
    }
    if (taskRef !== rootTaskRef) {
      if (!TASK_SATISFYING_STATUSES.has(task.status)) {
        return {
          status: "unresolvable",
          reason: "dependency-not-satisfied",
          dependencyRef: taskRef,
          dependencyStatus: task.status,
          archived: task.archived,
        };
      }
      if (task.resultCommit === null) {
        return { status: "unresolvable", reason: "result-commit-missing", dependencyRef: taskRef };
      }
      if (!FULL_COMMIT_SHA.test(task.resultCommit)) {
        return {
          status: "unresolvable",
          reason: "result-commit-malformed",
          dependencyRef: taskRef,
          resultCommit: task.resultCommit,
        };
      }
    }

    stateByRef.set(taskRef, "visiting");
    stack.push(taskRef);
    const dependencyRefs = new Set<string>();
    for (const rawDependencyRef of [...task.dependsOn].sort()) {
      const dependencyRef = canonicalTaskRef(rawDependencyRef);
      if (dependencyRef === null) return invalidDependencyRef(rawDependencyRef);
      dependencyRefs.add(dependencyRef);
    }
    for (const dependencyRef of [...dependencyRefs].sort()) {
      const blocker = visit(dependencyRef);
      if (blocker !== null) return blocker;
    }
    stack.pop();
    stateByRef.set(taskRef, "done");

    if (taskRef !== rootTaskRef) {
      const resultCommit = task.resultCommit;
      if (resultCommit === null) {
        throw new Error(`validated dependency ${taskRef} lost its result commit`);
      }
      dependencyResultCommits.push({ dependencyRef: taskRef, resultCommit });
    }
    return null;
  }

  const blocker = visit(rootTaskRef);
  if (blocker !== null) return blocker;
  return { status: "ready", dependencyResultCommits };
}

export interface DependencyTaskSnapshotReader {
  readTaskSnapshots(): Promise<readonly DependencyTaskSnapshot[]>;
}

export interface ResolveDependencyResultCommitsForDispatchRequest {
  readonly cwd: string;
  readonly rootTaskRef: string;
  readonly proposedDispatchBase: string;
}

function mapDispatchBaseBlocker(
  dependency: DependencyResultCommit,
  proposedDispatchBase: string,
  verification: Exclude<DispatchBaseVerification, { status: "verified" }>,
): UnresolvableDependencyResultCommits {
  if (verification.status === "rebase-required") {
    return {
      status: "unresolvable",
      reason: "result-commit-not-contained",
      dependencyRef: dependency.dependencyRef,
      resultCommit: dependency.resultCommit,
      proposedDispatchBase,
      relation: "diverged",
    };
  }
  switch (verification.reason) {
    case "base-missing":
      return {
        status: "unresolvable",
        reason: "result-commit-object-missing",
        dependencyRef: dependency.dependencyRef,
        resultCommit: dependency.resultCommit,
      };
    case "base-not-commit":
      return {
        status: "unresolvable",
        reason: "result-commit-object-not-commit",
        dependencyRef: dependency.dependencyRef,
        resultCommit: dependency.resultCommit,
      };
    case "head-missing":
      return {
        status: "unresolvable",
        reason: "dispatch-base-object-missing",
        dependencyRef: dependency.dependencyRef,
        resultCommit: dependency.resultCommit,
        proposedDispatchBase,
      };
    case "head-not-commit":
      return {
        status: "unresolvable",
        reason: "dispatch-base-object-not-commit",
        dependencyRef: dependency.dependencyRef,
        resultCommit: dependency.resultCommit,
        proposedDispatchBase,
      };
    case "unrelated-histories":
      return {
        status: "unresolvable",
        reason: "result-commit-not-contained",
        dependencyRef: dependency.dependencyRef,
        resultCommit: dependency.resultCommit,
        proposedDispatchBase,
        relation: "unrelated",
      };
    case "ancestry-unobserved":
      return {
        status: "unresolvable",
        reason: "result-commit-ancestry-unobserved",
        dependencyRef: dependency.dependencyRef,
        resultCommit: dependency.resultCommit,
        proposedDispatchBase,
      };
  }
}

export async function resolveDependencyResultCommitsForDispatch(
  request: ResolveDependencyResultCommitsForDispatchRequest,
  reader: DependencyTaskSnapshotReader,
  run: DispatchBaseGitRunner,
): Promise<DependencyResultCommitResolution> {
  const metadataResolution = resolveDependencyResultCommits({
    rootTaskRef: request.rootTaskRef,
    taskSnapshots: await reader.readTaskSnapshots(),
  });
  if (metadataResolution.status === "unresolvable") return metadataResolution;

  for (const dependency of metadataResolution.dependencyResultCommits) {
    const observations = await observeDispatchBase(
      {
        cwd: request.cwd,
        baseRevision: dependency.resultCommit,
        headRevision: request.proposedDispatchBase,
      },
      run,
    );
    const verification = verifyDispatchBase(observations);
    if (verification.status !== "verified") {
      return mapDispatchBaseBlocker(dependency, request.proposedDispatchBase, verification);
    }
  }
  return metadataResolution;
}
