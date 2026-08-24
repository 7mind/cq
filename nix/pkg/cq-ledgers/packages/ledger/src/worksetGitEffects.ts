import { resolve } from "node:path";
import {
  runWorksetGitEffectGate,
  type WorksetGitEffectBinding,
} from "@cq/process-control";
import { TASKS_LEDGER } from "./constants.js";
import {
  nodeManagedWorktreeGitRunner,
  type ManagedWorktreeGitResult,
  type ManagedWorktreeGitRunner,
} from "./managedWorktree.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import { requireWorksetStore } from "./worksetAccess.js";
import { worksetEffectAdmissionProviderFromStore } from "./worksetStore.js";
import {
  assertManagedTerminalReleaseRunnerBinding,
  type ManagedTerminalReleaseBinding,
  type ManagedTerminalReleaseEffect,
} from "./managedTerminalReleaseAdmission.js";
import { resolveUniqueTaskState } from "./taskStateResolver.js";

const ZERO_COMMIT = "0".repeat(40);

export interface ManagedWorktreeGitEffectRunnerOptions {
  readonly store: LedgerStore;
  readonly taskId: string;
  readonly repositoryRoot: string;
  readonly terminalReleaseBinding?: ManagedTerminalReleaseBinding;
  readonly readOnlyGit?: ManagedWorktreeGitRunner;
}

export interface RunLedgerWorksetGitEffectOptions {
  readonly store: LedgerStore;
  readonly expected: WorksetGitEffectBinding;
  readonly resolve: () => Promise<WorksetGitEffectBinding>;
  readonly terminalReleaseBinding?: ManagedTerminalReleaseBinding;
  readonly environment?: NodeJS.ProcessEnv;
}

function terminalReleaseEffect(binding: WorksetGitEffectBinding): ManagedTerminalReleaseEffect {
  if (binding.kind === "worktree-remove") {
    return {
      kind: binding.kind,
      targetRef: binding.targetRef,
      repositoryRoot: binding.repositoryRoot,
      worktreePath: binding.worktreePath,
      branch: binding.branch,
    };
  }
  if (
    binding.kind === "branch-create" &&
    binding.reference !== undefined &&
    binding.expectedReferenceCommit !== undefined
  ) {
    return {
      kind: binding.kind,
      targetRef: binding.targetRef,
      repositoryRoot: binding.repositoryRoot,
      reference: binding.reference,
      expectedReferenceCommit: binding.expectedReferenceCommit,
      commit: binding.commit,
    };
  }
  if (binding.kind === "branch-remove") {
    return {
      kind: binding.kind,
      targetRef: binding.targetRef,
      repositoryRoot: binding.repositoryRoot,
      branch: binding.branch,
      expectedCommit: binding.expectedCommit,
    };
  }
  throw new Error("managed terminal release binding cannot admit this Git effect");
}

export async function runLedgerWorksetGitEffect(
  options: RunLedgerWorksetGitEffectOptions,
): Promise<ManagedWorktreeGitResult> {
  const worksetStore = requireWorksetStore(options.store);
  const provider =
    options.terminalReleaseBinding === undefined
      ? worksetEffectAdmissionProviderFromStore(worksetStore)
      : {
          acquire: async (input: {
            readonly kind: WorksetGitEffectBinding["kind"];
            readonly targetRef: string;
          }) => {
            if (
              input.kind !== options.expected.kind ||
              input.targetRef !== options.expected.targetRef
            ) {
              throw new Error(
                "managed terminal release effect coordinates changed before admission",
              );
            }
            return await worksetStore.admitManagedTerminalReleaseEffect({
              binding: options.terminalReleaseBinding!,
              effect: terminalReleaseEffect(options.expected),
            });
          },
        };
  return await runWorksetGitEffectGate({
    expected: options.expected,
    resolve: options.resolve,
    provider,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
}

function combine(
  left: ManagedWorktreeGitResult,
  right: ManagedWorktreeGitResult,
): ManagedWorktreeGitResult {
  return {
    stdout: `${left.stdout}${right.stdout}`,
    stderr: `${left.stderr}${right.stderr}`,
    code: right.code,
  };
}

function exactArgs(args: readonly string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((value, index) => value === expected[index]);
}

function assertLiveTask(store: LedgerStore, taskId: string): void {
  const task = store.fetchItem(TASKS_LEDGER, taskId);
  if (task.id !== taskId) throw new Error("workset Git effect task identity changed");
}

export function createManagedWorktreeGitEffectRunner(
  options: ManagedWorktreeGitEffectRunnerOptions,
): ManagedWorktreeGitRunner {
  if (!/^T[0-9]+$/u.test(options.taskId)) {
    throw new Error("managed worktree Git effect requires one canonical task id");
  }
  const repositoryRoot = resolve(options.repositoryRoot);
  if (repositoryRoot !== options.repositoryRoot) {
    throw new Error("managed worktree Git effect repository root must be canonical");
  }
  const readOnlyGit = options.readOnlyGit ?? nodeManagedWorktreeGitRunner;
  const targetRef = `tasks:${options.taskId}`;
  const taskBranch = `implement/${options.taskId}`;
  if (options.terminalReleaseBinding !== undefined) {
    assertManagedTerminalReleaseRunnerBinding(options.terminalReleaseBinding, {
      taskId: options.taskId,
      repositoryRoot,
    });
  }

  function assertTaskBranch(branch: string): string {
    if (branch !== taskBranch) {
      throw new Error("managed worktree Git effect branch does not match its task target");
    }
    return branch;
  }

  async function requiredGit(cwd: string, args: readonly string[], label: string): Promise<string> {
    const result = await readOnlyGit(cwd, args);
    if (result.code !== 0) throw new Error(`managed worktree Git effect cannot resolve ${label}`);
    return result.stdout.trim();
  }

  async function currentReferenceCommit(reference: string): Promise<string> {
    const result = await readOnlyGit(repositoryRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      reference,
    ]);
    if (result.code === 0) return result.stdout.trim();
    if (result.code === 1) return ZERO_COMMIT;
    throw new Error("managed worktree Git effect cannot resolve recovery ref");
  }

  async function effect(
    binding: WorksetGitEffectBinding,
    resolveCoordinates: () => Promise<WorksetGitEffectBinding> = async () => binding,
  ): Promise<ManagedWorktreeGitResult> {
    const resolveBinding = async (): Promise<WorksetGitEffectBinding> => {
      if (options.terminalReleaseBinding === undefined) {
        assertLiveTask(options.store, options.taskId);
      } else {
        const task = await resolveUniqueTaskState(options.store, options.taskId);
        if (task.status !== options.terminalReleaseBinding.terminalDisposition) {
          throw new Error(
            `managed terminal release task status ${task.status} does not equal bound disposition ${options.terminalReleaseBinding.terminalDisposition}`,
          );
        }
      }
      return await resolveCoordinates();
    };
    return await runLedgerWorksetGitEffect({
      store: options.store,
      expected: binding,
      resolve: resolveBinding,
      ...(options.terminalReleaseBinding === undefined
        ? {}
        : { terminalReleaseBinding: options.terminalReleaseBinding }),
    });
  }

  return async (cwd, args) => {
    if (resolve(cwd) !== cwd) {
      throw new Error("managed worktree Git effect command cwd must be canonical");
    }
    if (
      args.length === 7 &&
      exactArgs(args.slice(0, 3), ["worktree", "add", "--quiet"]) &&
      args[3] === "-b"
    ) {
      const branch = assertTaskBranch(args[4]!);
      const worktreePath = resolve(args[5]!);
      const commit = args[6]!;
      const branchBinding: WorksetGitEffectBinding = {
        kind: "branch-create",
        targetRef,
        repositoryRoot,
        branch,
        commit,
      };
      const branchResult = await effect(branchBinding, async () => {
        const existing = await readOnlyGit(repositoryRoot, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]);
        if (existing.code === 0) {
          throw new Error("managed worktree Git effect branch appeared before creation");
        }
        await requiredGit(repositoryRoot, ["cat-file", "-e", `${commit}^{commit}`], "base commit");
        return branchBinding;
      });
      if (branchResult.code !== 0) return branchResult;
      const worktreeBinding: WorksetGitEffectBinding = {
        kind: "worktree-create",
        targetRef,
        repositoryRoot,
        worktreePath,
        branch,
        branchCommit: commit,
      };
      return combine(
        branchResult,
        await effect(worktreeBinding, async () => {
          if (
            (await requiredGit(repositoryRoot, ["rev-parse", `refs/heads/${branch}`], "task branch")) !==
            commit
          ) {
            throw new Error("managed worktree Git effect branch tip changed before creation");
          }
          return worktreeBinding;
        }),
      );
    }
    if (
      args.length === 5 &&
      exactArgs(args.slice(0, 3), ["worktree", "add", "--quiet"])
    ) {
      const branch = assertTaskBranch(args[4]!);
      const branchCommit = await requiredGit(
        repositoryRoot,
        ["rev-parse", `refs/heads/${branch}`],
        "task branch",
      );
      const binding: WorksetGitEffectBinding = {
        kind: "worktree-create",
        targetRef,
        repositoryRoot,
        worktreePath: resolve(args[3]!),
        branch,
        branchCommit,
      };
      return await effect(binding, async () => {
        if (
          (await requiredGit(repositoryRoot, ["rev-parse", `refs/heads/${branch}`], "task branch")) !==
          branchCommit
        ) {
          throw new Error("managed worktree Git effect branch tip changed before creation");
        }
        return binding;
      });
    }
    if (
      args.length === 4 &&
      exactArgs(args.slice(0, 3), ["worktree", "remove", "--force"])
    ) {
      const worktreePath = resolve(args[3]!);
      const headCommit = await requiredGit(worktreePath, ["rev-parse", "HEAD"], "worktree HEAD");
      const binding: WorksetGitEffectBinding = {
        kind: "worktree-remove",
        targetRef,
        repositoryRoot,
        worktreePath,
        branch: taskBranch,
        headCommit,
      };
      return await effect(binding, async () => {
        if (
          (await requiredGit(worktreePath, ["symbolic-ref", "--quiet", "HEAD"], "worktree branch")) !==
          `refs/heads/${taskBranch}` ||
          (await requiredGit(worktreePath, ["rev-parse", "HEAD"], "worktree HEAD")) !== headCommit
        ) {
          throw new Error("managed worktree Git effect worktree binding changed before removal");
        }
        return binding;
      });
    }
    if (args.length === 3 && exactArgs(args.slice(0, 2), ["branch", "-D"])) {
      const branch = assertTaskBranch(args[2]!);
      const expectedCommit = await requiredGit(
        repositoryRoot,
        ["rev-parse", `refs/heads/${branch}`],
        "task branch",
      );
      const binding: WorksetGitEffectBinding = {
        kind: "branch-remove",
        targetRef,
        repositoryRoot,
        branch,
        expectedCommit,
      };
      return await effect(binding, async () => {
        if (
          (await requiredGit(repositoryRoot, ["rev-parse", `refs/heads/${branch}`], "task branch")) !==
          expectedCommit
        ) {
          throw new Error("managed worktree Git effect branch tip changed before removal");
        }
        return binding;
      });
    }
    if (args.length === 3 && args[0] === "update-ref") {
      if (args[1] !== `refs/cq-managed-recovery/${taskBranch}`) {
        throw new Error("managed worktree Git effect recovery ref does not match its task target");
      }
      const expectedReferenceCommit = await currentReferenceCommit(args[1]);
      const binding: WorksetGitEffectBinding = {
        kind: "branch-create",
        targetRef,
        repositoryRoot,
        reference: args[1]!,
        expectedReferenceCommit,
        commit: args[2]!,
      };
      return await effect(binding, async () => {
        if (
          (await requiredGit(repositoryRoot, ["rev-parse", taskBranch], "task branch")) !==
            args[2]! ||
          (await currentReferenceCommit(args[1]!)) !== expectedReferenceCommit
        ) {
          throw new Error(
            "managed worktree Git effect recovery coordinates changed before publication",
          );
        }
        return binding;
      });
    }
    return await readOnlyGit(cwd, args);
  };
}
