/**
 * T1699 / D160 — real-repository fixture for Pi-native managed worktree path.
 *
 * Blackbox-Atomic against the public prepare/bind/release seams:
 *  - manager-returned path/handle used for marker+commit only in that tree
 *  - criticism resume preserves the prior tip on the same handle
 *  - release goes only through worktree_manage; main stays byte-identical
 *  - concurrent unrelated main checkout is never dirtied
 */
import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  bindPiNativeWorktree,
  releasePiNativeWorktree,
  type PiNativeManagedWorktreeHandle,
  type PiNativeWorktreeManagePort,
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
      GIT_AUTHOR_NAME: "T1699",
      GIT_AUTHOR_EMAIL: "t1699@example.invalid",
      GIT_COMMITTER_NAME: "T1699",
      GIT_COMMITTER_EMAIL: "t1699@example.invalid",
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
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "t1699-pi-managed-"));
  repositories.push(cwd);
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "t1699@example.invalid"]);
  await git(cwd, ["config", "user.name", "T1699"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);

  const workspace = path.join(cwd, "nix", "pkg", "cq-ledgers");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "t1699-workspace", private: true, workspaces: [] }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(workspace, "bun.lock"), "{}\n");
  await fs.writeFile(
    path.join(cwd, ".gitignore"),
    "node_modules/\n.test-cache/\n.test-managed-state/\n.claude/worktrees/\n",
  );
  const mainReadme = "t1699 main seed\n";
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
      await fs.writeFile(path.join(plan.cwd, "node_modules", ".t1699"), "ok\n");
      return { code: 0, stdout: "install-ok\n", stderr: "" };
    },
  };
}

function asPort(
  repo: Awaited<ReturnType<typeof seedRepository>>,
  install: ManagedWorktreeInstallRunner,
  prepareCalls: Array<{ taskId?: string; hasHandle: boolean }>,
): PiNativeWorktreeManagePort {
  const deps = {
    stateDir: repo.stateDir,
    cacheRoot: repo.cacheRoot,
    install,
    bunWorkspaceRoot: repo.workspace,
  };
  return {
    async prepare(input) {
      prepareCalls.push({
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        hasHandle: input.handle !== undefined,
      });
      // Do NOT inherit handle.taskId here — that is the binder's job under test.
      const taskId = input.taskId;
      if (taskId === undefined) {
        return {
          status: "refused" as const,
          reason: "task-id-invalid",
          detail: "taskId required from binder (handle.taskId inherit must happen in bind)",
        };
      }
      const result = await prepareManagedWorktree(
        {
          repositoryRoot: repo.cwd,
          taskId,
          ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
          ...(input.handle === undefined
            ? {}
            : { handle: input.handle as never }),
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
          handle: result.handle as unknown as PiNativeManagedWorktreeHandle,
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
          handle: result.handle as unknown as PiNativeManagedWorktreeHandle,
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

describe("T1699 Pi-native managed worktree e2e [BA]", () => {
  it("prepare → marker/commit only in managed tree → resume preserves tip → release; main untouched", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const prepareCalls: Array<{ taskId?: string; hasHandle: boolean }> = [];
    const port = asPort(repo, install.runner, prepareCalls);
    const mainHeadBefore = await git(repo.cwd, ["rev-parse", "HEAD"]);
    const mainReadmeBefore = await fs.readFile(path.join(repo.cwd, "README.md"), "utf8");
    const mainStatusBefore = await git(repo.cwd, ["status", "--porcelain", "--untracked-files=all"]);

    // Unrelated sibling worktree (not managed) must also stay byte/Git-identical.
    const siblingPath = path.join(repo.cwd, ".claude", "worktrees", "unrelated-sibling");
    await fs.mkdir(path.dirname(siblingPath), { recursive: true });
    await git(repo.cwd, ["worktree", "add", "-q", siblingPath, "HEAD"]);
    const siblingHeadBefore = await git(siblingPath, ["rev-parse", "HEAD"]);
    const siblingReadmeBefore = await fs.readFile(path.join(siblingPath, "README.md"), "utf8");
    const siblingStatusBefore = await git(siblingPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);

    const bound = await bindPiNativeWorktree({
      port,
      taskId: "T16991",
      baseCommit: repo.base,
      observeHead: async (absolutePath) => git(absolutePath, ["rev-parse", "HEAD"]),
    });
    if (bound.status !== "bound") {
      throw new Error(`bind refused: ${JSON.stringify(bound)}`);
    }

    // Marker/commit only inside the manager-returned path (not WIP-* so release
    // guards do not treat it as an open partial).
    const markerPath = path.join(bound.binding.absolutePath, "MARKER-T16991.txt");
    await fs.writeFile(markerPath, "t1699-marker\n");
    await git(bound.binding.absolutePath, ["add", "MARKER-T16991.txt"]);
    await git(bound.binding.absolutePath, ["commit", "-q", "-m", "criticism round marker"]);
    const criticismHead = await git(bound.binding.absolutePath, ["rev-parse", "HEAD"]);
    expect(criticismHead).not.toBe(repo.base);

    // Main checkout remains byte- and Git-state-identical.
    expect(await git(repo.cwd, ["rev-parse", "HEAD"])).toBe(mainHeadBefore);
    expect(await fs.readFile(path.join(repo.cwd, "README.md"), "utf8")).toBe(mainReadmeBefore);
    expect(await git(repo.cwd, ["status", "--porcelain", "--untracked-files=all"])).toBe(
      mainStatusBefore,
    );
    // Marker must not exist on main.
    await expect(fs.stat(path.join(repo.cwd, "MARKER-T16991.txt"))).rejects.toBeDefined();

    // Resume same handle; criticism tip preserved.
    // Omit taskId so bind must inherit handle.taskId (change #2 under test).
    const resumed = await bindPiNativeWorktree({
      port,
      handle: bound.binding.handle,
      priorResultCommit: criticismHead,
      observeHead: async (absolutePath) => git(absolutePath, ["rev-parse", "HEAD"]),
    });
    if (resumed.status !== "bound") {
      throw new Error(`resume bind refused: ${JSON.stringify(resumed)}`);
    }
    const resumeCall = prepareCalls.find((c) => c.hasHandle);
    expect(resumeCall?.taskId).toBe("T16991");
    expect(resumed.binding.handle.token).toBe(bound.binding.handle.token);
    expect(resumed.binding.absolutePath).toBe(bound.binding.absolutePath);
    expect(await git(resumed.binding.absolutePath, ["rev-parse", "HEAD"])).toBe(criticismHead);
    expect(await fs.readFile(markerPath, "utf8")).toContain("t1699-marker");

    // Terminal release via worktree_manage only.
    const released = await releasePiNativeWorktree({
      port,
      binding: {
        ...resumed.binding,
        headCommit: criticismHead,
      },
      terminalDisposition: "done",
      resultCommit: criticismHead,
      deleteBranch: true,
    });
    if (released.status !== "released") {
      throw new Error(`release refused: ${JSON.stringify(released)}`);
    }

    // Main still untouched after release.
    expect(await git(repo.cwd, ["rev-parse", "HEAD"])).toBe(mainHeadBefore);
    expect(await fs.readFile(path.join(repo.cwd, "README.md"), "utf8")).toBe(repo.mainReadme);
    expect(await git(repo.cwd, ["status", "--porcelain", "--untracked-files=all"])).toBe(
      mainStatusBefore,
    );
    // Unrelated sibling worktree unchanged.
    expect(await git(siblingPath, ["rev-parse", "HEAD"])).toBe(siblingHeadBefore);
    expect(await fs.readFile(path.join(siblingPath, "README.md"), "utf8")).toBe(
      siblingReadmeBefore,
    );
    expect(await git(siblingPath, ["status", "--porcelain", "--untracked-files=all"])).toBe(
      siblingStatusBefore,
    );
  });
});
