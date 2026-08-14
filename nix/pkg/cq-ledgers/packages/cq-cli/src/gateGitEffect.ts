import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  TASKS_LEDGER,
  createManagementLedgerStore,
  listManagedLiveWorktrees,
  nodeManagedWorktreeGitRunner,
  requireWorksetStore,
  resolveManagedWorktreeDispatchBinding,
  worksetEffectAdmissionProviderFromStore,
  type LedgerStore,
  type ManagedWorktreeHandle,
} from "@cq/ledger";
import {
  runWorksetGitEffectGate,
  type WorksetGitEffectBinding,
} from "@cq/process-control";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const TASK_ID = /^T[0-9]+$/u;

export interface GateGitEffectRequest {
  readonly operation: "rebase" | "merge";
  readonly cwd: string;
  readonly taskId: string;
  readonly commit: string;
}

export interface GateGitEffectOutcome {
  readonly exitCode: number;
}

async function repositoryRoot(cwd: string): Promise<string> {
  const result = await nodeManagedWorktreeGitRunner(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0 || result.stdout.trim() === "") {
    throw new Error("cq gate git-effect: --cwd does not resolve to a Git repository");
  }
  return await realpath(resolve(result.stdout.trim()));
}

async function uniqueHandle(
  repository: string,
  taskId: string,
): Promise<ManagedWorktreeHandle> {
  const handles = await listManagedLiveWorktrees(repository, taskId);
  if (handles.length !== 1) {
    throw new Error(
      `cq gate git-effect: task ${taskId} must own exactly one live managed worktree`,
    );
  }
  return handles[0]!;
}

async function gitOutput(cwd: string, args: readonly string[], label: string): Promise<string> {
  const result = await nodeManagedWorktreeGitRunner(cwd, args);
  if (result.code !== 0) throw new Error(`cq gate git-effect: cannot resolve ${label}`);
  return result.stdout.trim();
}

async function resolveBinding(
  store: LedgerStore,
  request: GateGitEffectRequest,
  repository: string,
): Promise<WorksetGitEffectBinding> {
  const task = store.fetchItem(TASKS_LEDGER, request.taskId);
  if (task.id !== request.taskId) {
    throw new Error("cq gate git-effect: task identity changed during resolution");
  }
  if (task.status !== "wip") {
    throw new Error("cq gate git-effect: rebase and merge require an active wip task");
  }
  const handle = await uniqueHandle(repository, request.taskId);
  const binding = await resolveManagedWorktreeDispatchBinding({
    repositoryRoot: repository,
    taskId: request.taskId,
    worktreePath: handle.absolutePath,
    branch: handle.branch,
    allowDetachedRebase: request.operation === "rebase",
  });
  if (binding === null || binding.handleToken !== handle.token) {
    throw new Error("cq gate git-effect: managed worktree binding is no longer authoritative");
  }
  if ((await gitOutput(repository, ["symbolic-ref", "--quiet", "HEAD"], "integration branch")) !== "refs/heads/main") {
    throw new Error("cq gate git-effect: integration checkout must be on refs/heads/main");
  }
  if ((await gitOutput(repository, ["status", "--porcelain", "--untracked-files=all"], "integration status")) !== "") {
    throw new Error("cq gate git-effect: integration checkout must be clean");
  }
  if ((await gitOutput(binding.worktreePath, ["status", "--porcelain", "--untracked-files=all"], "managed worktree status")) !== "") {
    throw new Error("cq gate git-effect: managed worktree must be clean");
  }
  if (request.operation === "rebase") {
    if ((await gitOutput(repository, ["rev-parse", "HEAD"], "integration HEAD")) !== request.commit) {
      throw new Error("cq gate git-effect: rebase target does not equal the integration HEAD");
    }
    return {
      kind: "rebase",
      targetRef: `tasks:${request.taskId}`,
      repositoryRoot: repository,
      worktreePath: binding.worktreePath,
      ontoCommit: request.commit,
    };
  }
  const branchTip = await nodeManagedWorktreeGitRunner(repository, [
    "rev-parse",
    `refs/heads/${binding.branch}`,
  ]);
  if (branchTip.code !== 0 || branchTip.stdout.trim() !== request.commit) {
    throw new Error("cq gate git-effect: merge commit does not equal the managed branch tip");
  }
  const ancestor = await nodeManagedWorktreeGitRunner(repository, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    request.commit,
  ]);
  if (ancestor.code !== 0) {
    throw new Error("cq gate git-effect: merge commit is not a fast-forward of integration HEAD");
  }
  return {
    kind: "merge",
    targetRef: `tasks:${request.taskId}`,
    repositoryRoot: repository,
    commit: request.commit,
  };
}

export async function runGateGitEffect(
  request: GateGitEffectRequest,
): Promise<GateGitEffectOutcome> {
  if (!TASK_ID.test(request.taskId)) {
    throw new Error("cq gate git-effect: --task-id must be one canonical task id");
  }
  if (!FULL_COMMIT.test(request.commit)) {
    throw new Error("cq gate git-effect: --commit must be one full commit SHA");
  }
  if (!isAbsolute(request.cwd)) {
    throw new Error("cq gate git-effect: --cwd must be absolute");
  }
  const resolved = await createManagementLedgerStore(request.cwd);
  try {
    const repository = await repositoryRoot(request.cwd);
    const trustedResolve = async () =>
      await resolveBinding(resolved.store, request, repository);
    const expected = await trustedResolve();
    const result = await runWorksetGitEffectGate({
      expected,
      resolve: trustedResolve,
      provider: worksetEffectAdmissionProviderFromStore(requireWorksetStore(resolved.store)),
    });
    if (result.stdout !== "") process.stdout.write(result.stdout);
    if (result.stderr !== "") process.stderr.write(result.stderr);
    return { exitCode: result.code };
  } finally {
    await resolved.store.dispose();
  }
}
