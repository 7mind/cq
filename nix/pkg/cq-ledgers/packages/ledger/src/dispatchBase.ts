import { execFile } from "node:child_process";

export interface DispatchBaseGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** A Git process seam whose repository remains explicit for every invocation. */
export type DispatchBaseGitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<DispatchBaseGitResult>;

const DISPATCH_BASE_REPOSITORY_ENVIRONMENT_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

function dispatchBaseGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const variable of DISPATCH_BASE_REPOSITORY_ENVIRONMENT_VARIABLES) {
    delete environment[variable];
  }
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
}

export const nodeDispatchBaseGitRunner: DispatchBaseGitRunner = (cwd, args) =>
  new Promise<DispatchBaseGitResult>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        env: dispatchBaseGitEnvironment(),
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code: error ? Number((error as { code?: number }).code ?? 1) : 0,
        });
      },
    );
  });

export type DispatchCommitObservation =
  | { readonly status: "commit"; readonly commit: string }
  | { readonly status: "missing" }
  | { readonly status: "non-commit" };

export type DispatchBaseAncestryObservation =
  "equal" | "ancestor" | "diverged" | "unrelated" | "unobserved";

export interface DispatchBaseObservations {
  readonly base: DispatchCommitObservation;
  readonly head: DispatchCommitObservation;
  readonly ancestry: DispatchBaseAncestryObservation;
}

export interface VerifiedDispatchBase {
  readonly status: "verified";
  readonly relation: "equal" | "descendant";
  readonly baseCommit: string;
  readonly headCommit: string;
}

export interface RebaseRequiredDispatchBase {
  readonly status: "rebase-required";
  readonly relation: "diverged";
  readonly baseCommit: string;
  readonly headCommit: string;
}

export type UnresolvableDispatchBase =
  | {
      readonly status: "unresolvable";
      readonly reason: "base-missing" | "base-not-commit";
      readonly baseCommit: null;
      readonly headCommit: string | null;
    }
  | {
      readonly status: "unresolvable";
      readonly reason: "head-missing" | "head-not-commit";
      readonly baseCommit: string;
      readonly headCommit: null;
    }
  | {
      readonly status: "unresolvable";
      readonly reason: "unrelated-histories" | "ancestry-unobserved";
      readonly baseCommit: string;
      readonly headCommit: string;
    };

export type DispatchBaseUnresolvableReason = UnresolvableDispatchBase["reason"];

export type DispatchBaseVerification =
  VerifiedDispatchBase | RebaseRequiredDispatchBase | UnresolvableDispatchBase;

function observedCommit(observation: DispatchCommitObservation): string | null {
  return observation.status === "commit" ? observation.commit : null;
}

export function verifyDispatchBase(
  observations: DispatchBaseObservations,
): DispatchBaseVerification {
  if (observations.base.status === "missing") {
    return {
      status: "unresolvable",
      reason: "base-missing",
      baseCommit: null,
      headCommit: observedCommit(observations.head),
    };
  }
  if (observations.base.status === "non-commit") {
    return {
      status: "unresolvable",
      reason: "base-not-commit",
      baseCommit: null,
      headCommit: observedCommit(observations.head),
    };
  }
  if (observations.head.status === "missing") {
    return {
      status: "unresolvable",
      reason: "head-missing",
      baseCommit: observations.base.commit,
      headCommit: null,
    };
  }
  if (observations.head.status === "non-commit") {
    return {
      status: "unresolvable",
      reason: "head-not-commit",
      baseCommit: observations.base.commit,
      headCommit: null,
    };
  }

  const baseCommit = observations.base.commit;
  const headCommit = observations.head.commit;
  switch (observations.ancestry) {
    case "equal":
      return { status: "verified", relation: "equal", baseCommit, headCommit };
    case "ancestor":
      return { status: "verified", relation: "descendant", baseCommit, headCommit };
    case "diverged":
      return { status: "rebase-required", relation: "diverged", baseCommit, headCommit };
    case "unrelated":
      return {
        status: "unresolvable",
        reason: "unrelated-histories",
        baseCommit,
        headCommit,
      };
    case "unobserved":
      return {
        status: "unresolvable",
        reason: "ancestry-unobserved",
        baseCommit,
        headCommit,
      };
  }
}

export interface ObserveDispatchBaseRequest {
  readonly cwd: string;
  readonly baseRevision: string;
  readonly headRevision: string;
}

export class DispatchBaseGitCommandError extends Error {
  constructor(
    readonly cwd: string,
    readonly args: readonly string[],
    readonly result: DispatchBaseGitResult,
  ) {
    super(`git ${args.join(" ")} failed in ${cwd} (exit ${result.code}): ${result.stderr.trim()}`);
    this.name = "DispatchBaseGitCommandError";
  }
}

async function observeCommit(
  cwd: string,
  revision: string,
  run: DispatchBaseGitRunner,
): Promise<DispatchCommitObservation> {
  const existenceArgs = ["rev-parse", "--verify", "--quiet", `${revision}^{object}`] as const;
  const existence = await run(cwd, existenceArgs);
  if (existence.code === 1) return { status: "missing" };
  if (existence.code !== 0) {
    throw new DispatchBaseGitCommandError(cwd, existenceArgs, existence);
  }

  const object = existence.stdout.trim();
  const typeArgs = ["cat-file", "-t", object] as const;
  const objectType = await run(cwd, typeArgs);
  if (objectType.code !== 0) {
    throw new DispatchBaseGitCommandError(cwd, typeArgs, objectType);
  }
  if (objectType.stdout.trim() !== "commit") return { status: "non-commit" };
  return { status: "commit", commit: object };
}

export async function observeDispatchBase(
  request: ObserveDispatchBaseRequest,
  run: DispatchBaseGitRunner,
): Promise<DispatchBaseObservations> {
  const [base, head] = await Promise.all([
    observeCommit(request.cwd, request.baseRevision, run),
    observeCommit(request.cwd, request.headRevision, run),
  ]);
  if (base.status !== "commit" || head.status !== "commit") {
    return { base, head, ancestry: "unobserved" };
  }
  if (base.commit === head.commit) return { base, head, ancestry: "equal" };

  const ancestorArgs = ["merge-base", "--is-ancestor", base.commit, head.commit] as const;
  const ancestor = await run(request.cwd, ancestorArgs);
  if (ancestor.code === 0) return { base, head, ancestry: "ancestor" };
  if (ancestor.code !== 1) {
    throw new DispatchBaseGitCommandError(request.cwd, ancestorArgs, ancestor);
  }

  const commonBaseArgs = ["merge-base", base.commit, head.commit] as const;
  const commonBase = await run(request.cwd, commonBaseArgs);
  if (commonBase.code === 0) return { base, head, ancestry: "diverged" };
  if (commonBase.code === 1) return { base, head, ancestry: "unrelated" };
  throw new DispatchBaseGitCommandError(request.cwd, commonBaseArgs, commonBase);
}
