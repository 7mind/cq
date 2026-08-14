import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RegisteredLaunchBootstrapSpecification } from "./registeredLaunch.js";
import {
  WorksetEffectBroker,
  type WorksetEffectBrokerOptions,
} from "./worksetEffectBroker.js";
import type { WorksetEffectAdmissionProvider } from "./worksetEffectProtocol.js";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const ZERO_COMMIT = "0".repeat(40);
const TASK_REF = /^tasks:T[0-9]+$/u;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

const STRIPPED_GIT_ENVIRONMENT = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;
const STRIPPED_WORKSET_CREDENTIALS = [
  "CQ_LEDGER_REMOTE_TOKEN",
  "CQ_SERVE_MANAGEMENT_TOKEN",
  "CQ_SERVE_TOKEN",
] as const;

interface WorksetGitEffectBase {
  readonly targetRef: string;
  readonly repositoryRoot: string;
}

export interface WorktreeCreateEffectBinding extends WorksetGitEffectBase {
  readonly kind: "worktree-create";
  readonly worktreePath: string;
  readonly branch: string;
  readonly branchCommit: string;
}

export interface WorktreeRemoveEffectBinding extends WorksetGitEffectBase {
  readonly kind: "worktree-remove";
  readonly worktreePath: string;
  readonly branch: string;
  readonly headCommit: string;
}

export interface BranchCreateEffectBinding extends WorksetGitEffectBase {
  readonly kind: "branch-create";
  readonly branch?: string;
  readonly reference?: string;
  readonly expectedReferenceCommit?: string;
  readonly commit: string;
}

export interface BranchRemoveEffectBinding extends WorksetGitEffectBase {
  readonly kind: "branch-remove";
  readonly branch: string;
  readonly expectedCommit: string;
}

export interface RebaseOntoEffectBinding extends WorksetGitEffectBase {
  readonly kind: "rebase";
  readonly worktreePath: string;
  readonly ontoCommit: string;
}

export interface RebaseContinueEffectBinding extends WorksetGitEffectBase {
  readonly kind: "rebase";
  readonly worktreePath: string;
  readonly continueAtHead: string;
}

export type RebaseEffectBinding = RebaseOntoEffectBinding | RebaseContinueEffectBinding;

export interface MergeEffectBinding extends WorksetGitEffectBase {
  readonly kind: "merge";
  readonly commit: string;
}

export type WorksetGitEffectBinding =
  | WorktreeCreateEffectBinding
  | WorktreeRemoveEffectBinding
  | BranchCreateEffectBinding
  | BranchRemoveEffectBinding
  | RebaseEffectBinding
  | MergeEffectBinding;

export interface RunWorksetGitEffectGateOptions {
  readonly expected: WorksetGitEffectBinding;
  readonly resolve: () => Promise<WorksetGitEffectBinding>;
  readonly provider: WorksetEffectAdmissionProvider;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly settlement?: WorksetEffectBrokerOptions["settlement"];
}

export interface WorksetGitEffectResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

interface GitOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

function containedPath(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function assertBranch(branch: string): void {
  if (
    branch.trim() === "" ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("\\") ||
    branch.includes(" ")
  ) {
    throw new Error("@cq/process-control: trusted Git effect branch is invalid");
  }
}

function validateBinding(binding: WorksetGitEffectBinding): WorksetGitEffectBinding {
  if (!TASK_REF.test(binding.targetRef)) {
    throw new Error("@cq/process-control: trusted Git effect target must be one canonical task ref");
  }
  const taskId = binding.targetRef.slice("tasks:".length);
  if (!isAbsolute(binding.repositoryRoot)) {
    throw new Error("@cq/process-control: trusted Git effect repository root must be absolute");
  }
  const repositoryRoot = resolve(binding.repositoryRoot);
  if (repositoryRoot !== binding.repositoryRoot) {
    throw new Error("@cq/process-control: trusted Git effect repository root must be canonical");
  }
  if ("branch" in binding && binding.branch !== undefined) {
    assertBranch(binding.branch);
    if (binding.branch.startsWith("implement/") && binding.branch !== `implement/${taskId}`) {
      throw new Error("@cq/process-control: trusted Git effect branch does not match its task target");
    }
  }
  if (binding.kind === "branch-create") {
    if ((binding.branch === undefined) === (binding.reference === undefined)) {
      throw new Error("@cq/process-control: trusted branch creation must name exactly one branch or recovery ref");
    }
    if (
      (binding.reference === undefined) !== (binding.expectedReferenceCommit === undefined)
    ) {
      throw new Error(
        "@cq/process-control: trusted recovery ref publication requires its expected prior commit",
      );
    }
    if (
      binding.reference !== undefined &&
      binding.reference !== `refs/cq-managed-recovery/implement/${taskId}`
    ) {
      throw new Error("@cq/process-control: trusted Git effect recovery ref is invalid");
    }
  }
  if ("commit" in binding && !FULL_COMMIT.test(binding.commit)) {
    throw new Error("@cq/process-control: trusted Git effect commit must be one full SHA");
  }
  for (const commit of [
    "branchCommit" in binding ? binding.branchCommit : undefined,
    "headCommit" in binding ? binding.headCommit : undefined,
    "expectedCommit" in binding ? binding.expectedCommit : undefined,
    binding.kind === "branch-create" ? binding.expectedReferenceCommit : undefined,
  ]) {
    if (commit !== undefined && !FULL_COMMIT.test(commit)) {
      throw new Error("@cq/process-control: trusted Git effect coordinate must be one full SHA");
    }
  }
  if (binding.kind === "rebase") {
    const commit = "ontoCommit" in binding ? binding.ontoCommit : binding.continueAtHead;
    if (!FULL_COMMIT.test(commit)) {
      throw new Error("@cq/process-control: trusted Git effect rebase coordinate must be one full SHA");
    }
  }
  if ("worktreePath" in binding) {
    if (!isAbsolute(binding.worktreePath) || resolve(binding.worktreePath) !== binding.worktreePath) {
      throw new Error("@cq/process-control: trusted Git effect worktree path must be canonical and absolute");
    }
    if (!containedPath(repositoryRoot, binding.worktreePath)) {
      throw new Error("@cq/process-control: trusted Git effect worktree path escapes the repository");
    }
  }
  return binding;
}

function bindingIdentity(binding: WorksetGitEffectBinding): readonly string[] {
  switch (binding.kind) {
    case "worktree-create":
      return [
        binding.kind,
        binding.targetRef,
        binding.repositoryRoot,
        binding.worktreePath,
        binding.branch,
        binding.branchCommit,
      ];
    case "worktree-remove":
      return [
        binding.kind,
        binding.targetRef,
        binding.repositoryRoot,
        binding.worktreePath,
        binding.branch,
        binding.headCommit,
      ];
    case "branch-create":
      return [
        binding.kind,
        binding.targetRef,
        binding.repositoryRoot,
        binding.branch ?? "",
        binding.reference ?? "",
        binding.expectedReferenceCommit ?? "",
        binding.commit,
      ];
    case "branch-remove":
      return [
        binding.kind,
        binding.targetRef,
        binding.repositoryRoot,
        binding.branch,
        binding.expectedCommit,
      ];
    case "rebase":
      return [
        binding.kind,
        binding.targetRef,
        binding.repositoryRoot,
        binding.worktreePath,
        "ontoCommit" in binding ? "onto" : "continue",
        "ontoCommit" in binding ? binding.ontoCommit : binding.continueAtHead,
      ];
    case "merge":
      return [binding.kind, binding.targetRef, binding.repositoryRoot, binding.commit];
  }
}

function sameBinding(left: WorksetGitEffectBinding, right: WorksetGitEffectBinding): boolean {
  const a = bindingIdentity(left);
  const b = bindingIdentity(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function command(binding: WorksetGitEffectBinding): { readonly cwd: string; readonly argv: readonly string[] } {
  switch (binding.kind) {
    case "worktree-create":
      return {
        cwd: binding.repositoryRoot,
        argv: ["git", "worktree", "add", "--quiet", binding.worktreePath, binding.branch],
      };
    case "worktree-remove":
      return {
        cwd: binding.repositoryRoot,
        argv: ["git", "worktree", "remove", "--force", binding.worktreePath],
      };
    case "branch-create":
      return binding.branch === undefined
        ? {
            cwd: binding.repositoryRoot,
            argv: [
              "git",
              "update-ref",
              binding.reference!,
              binding.commit,
              binding.expectedReferenceCommit ?? ZERO_COMMIT,
            ],
          }
        : {
            cwd: binding.repositoryRoot,
            argv: ["git", "branch", binding.branch, binding.commit],
          };
    case "branch-remove":
      return {
        cwd: binding.repositoryRoot,
        argv: [
          "git",
          "update-ref",
          "-d",
          `refs/heads/${binding.branch}`,
          binding.expectedCommit,
        ],
      };
    case "rebase":
      return {
        cwd: binding.worktreePath,
        argv:
          "ontoCommit" in binding
            ? ["git", "rebase", binding.ontoCommit]
            : ["git", "rebase", "--continue"],
      };
    case "merge":
      return { cwd: binding.repositoryRoot, argv: ["git", "merge", "--ff-only", binding.commit] };
  }
}

function environment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const variable of STRIPPED_GIT_ENVIRONMENT) delete result[variable];
  const merged: NodeJS.ProcessEnv = {
    ...result,
    ...(overrides ?? {}),
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const variable of STRIPPED_WORKSET_CREDENTIALS) delete merged[variable];
  return merged;
}

function output(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return Promise.resolve("");
  return new Promise((resolveOutput, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        reject(new Error("@cq/process-control: trusted Git effect output exceeded its bound"));
        return;
      }
      chunks.push(chunk);
    });
    stream.once("end", () => resolveOutput(Buffer.concat(chunks).toString("utf8")));
    stream.once("error", reject);
  });
}

function exited(child: ChildProcess): Promise<GitOutcome> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolveExit({ exitCode, signal }));
  });
}

function gitBootstrap(specification: RegisteredLaunchBootstrapSpecification<"pipe">) {
  const child = spawn(specification.argv[0], specification.argv.slice(1), {
    cwd: specification.cwd,
    env: specification.env,
    detached: specification.detached,
    stdio: specification.stdio,
  });
  let stdout = "";
  let stderr = "";
  const stdoutDrained = output(child.stdout).then((value) => {
    stdout = value;
  });
  const stderrDrained = output(child.stderr).then((value) => {
    stderr = value;
  });
  return {
    process: child,
    pid: child.pid,
    exited: exited(child),
    outputDrained: Promise.all([stdoutDrained, stderrDrained]).then(() => undefined),
    resultFromTargetOutcome: (outcome: GitOutcome) => ({ ...outcome, stdout, stderr }),
    terminate: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

export async function runWorksetGitEffectGate(
  options: RunWorksetGitEffectGateOptions,
): Promise<WorksetGitEffectResult> {
  const expected = validateBinding(options.expected);
  const initial = validateBinding(await options.resolve());
  if (!sameBinding(expected, initial)) {
    throw new Error("@cq/process-control: trusted Git effect binding does not match the requested coordinates");
  }
  const resolvedCommand = command(initial);
  const broker = new WorksetEffectBroker({
    provider: options.provider,
    ...(options.settlement === undefined ? {} : { settlement: options.settlement }),
  });
  const launched = await broker.launch<ChildProcess, GitOutcome, "pipe">({
    kind: initial.kind,
    targetRef: initial.targetRef,
    argv: resolvedCommand.argv,
    cwd: resolvedCommand.cwd,
    env: environment(options.environment),
    stdio: "pipe" as const,
    launchBootstrap: gitBootstrap,
    beforeLaunch: async () => {
      const current = validateBinding(await options.resolve());
      if (!sameBinding(initial, current) || !sameBinding(expected, current)) {
        throw new Error("@cq/process-control: trusted Git effect binding changed before launch");
      }
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const outcome = await launched.exited;
  const code = outcome.exitCode ?? (outcome.signal === null ? 1 : 128);
  return { stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "", code };
}
