/**
 * T1698 / D263 / K238 — real-repository fixture for Claude-native managed path.
 *
 * Blackbox-Atomic: worktree_manage prepare → bindClaudeNativeWorktree →
 * qualifyClaudeNativeAdapter (harness-owned) → marker only in managed tree →
 * resume → release; main + sibling untouched. No live Claude provider required.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  bindClaudeNativeWorktree,
  qualifyClaudeNativeAdapter,
  releaseClaudeNativeWorktree,
  type ClaudeNativeManagedWorktreeHandle,
  type ClaudeNativeWorktreeManagePort,
} from "@cq/config";
import {
  prepareManagedWorktree,
  releaseManagedWorktree,
  type ManagedWorktreeInstallPlan,
  type ManagedWorktreeInstallRunner,
} from "../src/index.js";

const exec = promisify(execFile);
const repositories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "T1698",
      GIT_AUTHOR_EMAIL: "t1698@example.invalid",
      GIT_COMMITTER_NAME: "T1698",
      GIT_COMMITTER_EMAIL: "t1698@example.invalid",
    },
  });
  return stdout.trim();
}

async function seedRepository(): Promise<{
  cwd: string;
  base: string;
  stateDir: string;
  cacheRoot: string;
  workspace: string;
  mainReadme: string;
}> {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "t1698-claude-managed-"));
  repositories.push(cwd);
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "t1698@example.invalid"]);
  await git(cwd, ["config", "user.name", "T1698"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);

  const workspace = path.join(cwd, "nix", "pkg", "cq-ledgers");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "t1698-workspace", private: true, workspaces: [] }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(workspace, "bun.lock"), "{}\n");
  await fs.writeFile(
    path.join(cwd, ".gitignore"),
    "node_modules/\n.test-cache/\n.test-managed-state/\n.claude/worktrees/\n",
  );
  const mainReadme = "t1698 main seed\n";
  await fs.writeFile(path.join(cwd, "README.md"), mainReadme);
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-q", "-m", "seed"]);
  const base = await git(cwd, ["rev-parse", "HEAD"]);
  const stateDir = path.join(cwd, ".test-managed-state");
  const cacheRoot = path.join(cwd, ".test-cache");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(cacheRoot, { recursive: true });
  return { cwd, base, stateDir, cacheRoot, workspace, mainReadme };
}

function recordingInstall(): {
  runner: ManagedWorktreeInstallRunner;
  plans: ManagedWorktreeInstallPlan[];
} {
  const plans: ManagedWorktreeInstallPlan[] = [];
  return {
    plans,
    runner: async (plan) => {
      plans.push({
        cwd: plan.cwd,
        args: [...plan.args],
        env: { ...plan.env },
        bunInstallCacheDir: plan.bunInstallCacheDir,
      });
      await fs.mkdir(path.join(plan.cwd, "node_modules"), { recursive: true });
      await fs.writeFile(path.join(plan.cwd, "node_modules", ".t1698"), "ok\n");
      return { code: 0, stdout: "install-ok\n", stderr: "" };
    },
  };
}

function asPort(
  repo: Awaited<ReturnType<typeof seedRepository>>,
  install: ManagedWorktreeInstallRunner,
): ClaudeNativeWorktreeManagePort {
  const deps = {
    stateDir: repo.stateDir,
    cacheRoot: repo.cacheRoot,
    install,
    bunWorkspaceRoot: repo.workspace,
  };
  return {
    async prepare(input) {
      const taskId =
        input.taskId ??
        (input.handle !== undefined ? input.handle.taskId : undefined);
      if (taskId === undefined) {
        return {
          status: "refused" as const,
          reason: "task-id-invalid",
          detail: "taskId required",
        };
      }
      const result = await prepareManagedWorktree(
        {
          repositoryRoot: repo.cwd,
          taskId,
          ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
          ...(input.handle === undefined ? {} : { handle: input.handle as never }),
          ...(input.allowResumeRequired === undefined
            ? {}
            : { allowResumeRequired: input.allowResumeRequired }),
          ...(input.priorResultCommit === undefined
            ? {}
            : { priorResultCommit: input.priorResultCommit }),
        },
        deps,
      );
      if (result.status === "prepared" || result.status === "resume-required") {
        return {
          status: result.status,
          handle: result.handle as unknown as ClaudeNativeManagedWorktreeHandle,
          evidence: {
            worktreeId: result.evidence.worktreeId,
            absolutePath: result.evidence.absolutePath,
            baseCommit: result.evidence.baseCommit,
            headCommit: result.evidence.headCommit,
            branch: result.evidence.branch,
            mode: result.evidence.mode,
          },
        };
      }
      return {
        status: "refused" as const,
        reason: result.reason,
        detail: result.detail ?? result.reason,
      };
    },
    async release(input) {
      const result = await releaseManagedWorktree(
        {
          handle: input.handle as never,
          terminalDisposition: input.terminalDisposition,
          ...(input.resultCommit === undefined ? {} : { resultCommit: input.resultCommit }),
          ...(input.deleteBranch === undefined ? {} : { deleteBranch: input.deleteBranch }),
        },
        deps,
      );
      if (result.status === "released") {
        return {
          status: "released" as const,
          handle: result.handle as unknown as ClaudeNativeManagedWorktreeHandle,
          idempotent: result.idempotent,
          absolutePath: result.absolutePath,
        };
      }
      return {
        status: "refused" as const,
        reason: result.reason,
        detail: result.detail ?? result.reason,
      };
    },
  };
}

afterAll(async () => {
  for (const repository of repositories) {
    await fs.rm(repository, { recursive: true, force: true });
  }
});

describe("T1698 Claude-native managed worktree e2e [BA]", () => {
  it("T2047 consumes and qualifies a manager-issued adopted T1207 v2 handle", async () => {
    const handle: ClaudeNativeManagedWorktreeHandle = {
      kind: "cq-managed-worktree-handle",
      version: 2,
      token: "opaque-t1207-token",
      worktreeId: "019f2c7a-6b21-7c44-9e10-7a3f5d9b2e08",
      taskId: "T1207",
      branch: "implement/T1207",
      repositoryRoot: "/tmp/project",
      absolutePath: "/tmp/project/.claude/worktrees/implement-T1207",
      baseCommit: "a".repeat(40),
      createdAt: "2026-08-10T00:00:00.000Z",
      nonce: "opaque-t1207-nonce",
    };
    const port: ClaudeNativeWorktreeManagePort = {
      async prepare() {
        return {
          status: "prepared",
          handle,
          evidence: {
            worktreeId: handle.worktreeId,
            absolutePath: handle.absolutePath,
            branch: handle.branch,
            baseCommit: handle.baseCommit,
            headCommit: "b".repeat(40),
            mode: "resume",
          },
        };
      },
      async release() {
        throw new Error("release not exercised by this acceptance probe");
      },
    };

    const bound = await bindClaudeNativeWorktree({
      port,
      handle,
      observeHead: () => "b".repeat(40),
    });
    expect(bound).toMatchObject({ status: "bound", binding: { handle: { version: 2 } } });
    if (bound.status !== "bound") throw new Error("expected adopted handle to bind");
    expect(
      qualifyClaudeNativeAdapter({
        cwd: bound.binding.absolutePath,
        handle: bound.binding.handle,
      }).status,
    ).toBe("qualified");
  });

  it("bind → K238 qualify → marker only in managed tree → resume → release; main untouched", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const port = asPort(repo, install.runner);
    const mainHeadBefore = await git(repo.cwd, ["rev-parse", "HEAD"]);
    const mainReadmeBefore = await fs.readFile(path.join(repo.cwd, "README.md"), "utf8");
    const mainStatusBefore = await git(repo.cwd, ["status", "--porcelain", "--untracked-files=all"]);

    const siblingPath = path.join(repo.cwd, ".claude", "worktrees", "unrelated-sibling");
    await fs.mkdir(path.dirname(siblingPath), { recursive: true });
    await git(repo.cwd, ["worktree", "add", "-q", siblingPath, "HEAD"]);
    const siblingHeadBefore = await git(siblingPath, ["rev-parse", "HEAD"]);

    // Unbound qualifier still refuses.
    expect(qualifyClaudeNativeAdapter().status).toBe("incompatible");

    const bound = await bindClaudeNativeWorktree({
      port,
      taskId: "T16981",
      baseCommit: repo.base,
      observeHead: async (absolutePath) => git(absolutePath, ["rev-parse", "HEAD"]),
    });
    if (bound.status !== "bound") {
      throw new Error(`bind refused: ${JSON.stringify(bound)}`);
    }

    // K238/D287: manager-returned handle+path qualifies harness-owned.
    const q = qualifyClaudeNativeAdapter({
      cwd: bound.binding.absolutePath,
      handle: bound.binding.handle,
    });
    expect(q.status).toBe("qualified");
    if (q.status !== "qualified") throw new Error("expected qualified");
    expect(q.confinement).toBe("harness-owned");
    expect(q.defectClosed).toBe("D263");
    expect(q.evidence).toMatch(/did NOT accept write-confinement residual/i);

    const markerPath = path.join(bound.binding.absolutePath, "MARKER-T16981.txt");
    await fs.writeFile(markerPath, "t1698-marker\n");
    await git(bound.binding.absolutePath, ["add", "MARKER-T16981.txt"]);
    await git(bound.binding.absolutePath, ["commit", "-q", "-m", "criticism round marker"]);
    const criticismHead = await git(bound.binding.absolutePath, ["rev-parse", "HEAD"]);
    expect(criticismHead).not.toBe(repo.base);

    expect(await git(repo.cwd, ["rev-parse", "HEAD"])).toBe(mainHeadBefore);
    expect(await fs.readFile(path.join(repo.cwd, "README.md"), "utf8")).toBe(mainReadmeBefore);
    expect(await git(repo.cwd, ["status", "--porcelain", "--untracked-files=all"])).toBe(
      mainStatusBefore,
    );
    await expect(fs.stat(path.join(repo.cwd, "MARKER-T16981.txt"))).rejects.toBeDefined();

    const resumed = await bindClaudeNativeWorktree({
      port,
      handle: bound.binding.handle,
      priorResultCommit: criticismHead,
      observeHead: async (absolutePath) => git(absolutePath, ["rev-parse", "HEAD"]),
    });
    if (resumed.status !== "bound") {
      throw new Error(`resume bind refused: ${JSON.stringify(resumed)}`);
    }
    expect(resumed.binding.handle.token).toBe(bound.binding.handle.token);
    expect(await git(resumed.binding.absolutePath, ["rev-parse", "HEAD"])).toBe(criticismHead);

    // Re-qualify after resume still harness-owned.
    const q2 = qualifyClaudeNativeAdapter({
      cwd: resumed.binding.absolutePath,
      handle: resumed.binding.handle,
    });
    expect(q2.status).toBe("qualified");

    const released = await releaseClaudeNativeWorktree({
      port,
      binding: { ...resumed.binding, headCommit: criticismHead },
      terminalDisposition: "done",
      resultCommit: criticismHead,
      deleteBranch: true,
    });
    if (released.status !== "released") {
      throw new Error(`release refused: ${JSON.stringify(released)}`);
    }

    expect(await git(repo.cwd, ["rev-parse", "HEAD"])).toBe(mainHeadBefore);
    expect(await fs.readFile(path.join(repo.cwd, "README.md"), "utf8")).toBe(repo.mainReadme);
    expect(await git(siblingPath, ["rev-parse", "HEAD"])).toBe(siblingHeadBefore);
  });
});
