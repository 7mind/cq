/**
 * T1305 — managed worktree prepare + guarded release core.
 *
 * Real-repo Blackbox-Atomic / Communication tests against the public
 * `@cq/ledger` prepare/release API. Install is seamed so the exact argv +
 * BUN_INSTALL_CACHE_DIR contract is observed without a network install.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { serializeWipArtifact } from "@cq/config";
import {
  buildManagedWorktreeInstallPlan,
  generateUuidV7,
  isUuidV7,
  listManagedLiveWorktrees,
  prepareManagedWorktree,
  rebaseBunWorkspaceIntoWorktree,
  releaseManagedWorktree,
  validateManagedWorktreeInstallPlan,
  type DependencyTaskSnapshot,
  type DependencyTaskSnapshotReader,
  type ManagedWorktreeFaultBoundary,
  type ManagedWorktreeHandle,
  type ManagedWorktreeInstallPlan,
  type ManagedWorktreeInstallRunner,
} from "../src/index.js";

const exec = promisify(execFile);
const repositories: string[] = [];

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "T1305",
      GIT_AUTHOR_EMAIL: "t1305@example.invalid",
      GIT_COMMITTER_NAME: "T1305",
      GIT_COMMITTER_EMAIL: "t1305@example.invalid",
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
}> {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "t1305-managed-"));
  repositories.push(cwd);
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "t1305@example.invalid"]);
  await git(cwd, ["config", "user.name", "T1305"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);

  // Minimal bun workspace so discovery succeeds. node_modules must be
  // gitignored — install runs inside the managed worktree and must not dirty it.
  const workspace = path.join(cwd, "nix", "pkg", "cq-ledgers");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "t1305-workspace", private: true, workspaces: [] }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(workspace, "bun.lock"), "{}\n");
  await fs.writeFile(path.join(cwd, ".gitignore"), "node_modules/\n.test-cache/\n.test-managed-state/\n");
  await fs.writeFile(path.join(cwd, "README.md"), "t1305 seed\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-q", "-m", "seed"]);
  const base = await git(cwd, ["rev-parse", "HEAD"]);
  const stateDir = path.join(cwd, ".test-managed-state");
  const cacheRoot = path.join(cwd, ".test-cache");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(cacheRoot, { recursive: true });
  return { cwd, base, stateDir, cacheRoot, workspace };
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
      // Create a real directory node_modules (not a symlink) to satisfy the guard.
      await fs.mkdir(path.join(plan.cwd, "node_modules"), { recursive: true });
      await fs.writeFile(path.join(plan.cwd, "node_modules", ".t1305"), "ok\n");
      return { code: 0, stdout: "install-ok\n", stderr: "" };
    },
  };
}

function readerOf(snapshots: readonly DependencyTaskSnapshot[]): DependencyTaskSnapshotReader {
  return {
    readTaskSnapshots: async () => snapshots,
  };
}

function task(
  taskId: string,
  status: string,
  dependsOn: readonly string[],
  resultCommit: string | null,
): DependencyTaskSnapshot {
  return { taskId, status, dependsOn, resultCommit, archived: status === "done" };
}

afterAll(async () => {
  for (const repository of repositories) {
    await fs.rm(repository, { recursive: true, force: true });
  }
});

describe("UUIDv7 helpers", () => {
  it("generateUuidV7 produces version-7 identifiers", () => {
    const id = generateUuidV7();
    expect(isUuidV7(id)).toBe(true);
    expect(id.charAt(14)).toBe("7");
  });
});

describe("install plan validation (negative controls)", () => {
  it("accepts the exact frozen-lockfile plan under the CQ cache root", () => {
    const plan = buildManagedWorktreeInstallPlan({
      bunWorkspaceRoot: "/tmp/workspace",
      cacheRoot: "/tmp/cq-cache",
    });
    const validated = validateManagedWorktreeInstallPlan(plan, { cacheRoot: "/tmp/cq-cache" });
    expect(validated).toEqual({ status: "valid", plan });
    expect(plan.args).toEqual(["install", "--frozen-lockfile"]);
    expect(plan.env["BUN_INSTALL_CACHE_DIR"]).toBe("/tmp/cq-cache/bun-install");
  });

  it("fails for a named reason when BUN_INSTALL_CACHE_DIR is omitted", () => {
    const plan = buildManagedWorktreeInstallPlan({
      bunWorkspaceRoot: "/tmp/workspace",
      cacheRoot: "/tmp/cq-cache",
    });
    const { BUN_INSTALL_CACHE_DIR: _removed, ...env } = plan.env;
    const invalid = { ...plan, env };
    const validated = validateManagedWorktreeInstallPlan(invalid, { cacheRoot: "/tmp/cq-cache" });
    expect(validated.status).toBe("invalid");
    if (validated.status === "invalid") {
      expect(validated.reason).toBe("missing-bun-install-cache-dir");
    }
  });

  it("fails for a named reason when args are not exactly frozen-lockfile", () => {
    const plan = buildManagedWorktreeInstallPlan({
      bunWorkspaceRoot: "/tmp/workspace",
      cacheRoot: "/tmp/cq-cache",
    });
    const invalid = { ...plan, args: ["install"] };
    const validated = validateManagedWorktreeInstallPlan(invalid, { cacheRoot: "/tmp/cq-cache" });
    expect(validated.status).toBe("invalid");
    if (validated.status === "invalid") {
      expect(validated.reason).toBe("args-not-frozen-lockfile");
    }
  });

  it("fails when cache dir escapes the CQ cache root", () => {
    const plan = buildManagedWorktreeInstallPlan({
      bunWorkspaceRoot: "/tmp/workspace",
      cacheRoot: "/tmp/cq-cache",
    });
    const invalid = {
      ...plan,
      env: { ...plan.env, BUN_INSTALL_CACHE_DIR: "/tmp/other/bun-install" },
      bunInstallCacheDir: "/tmp/other/bun-install",
    };
    const validated = validateManagedWorktreeInstallPlan(invalid, { cacheRoot: "/tmp/cq-cache" });
    expect(validated.status).toBe("invalid");
    if (validated.status === "invalid") {
      expect(validated.reason).toBe("bun-install-cache-dir-outside-root");
    }
  });
});

describe("prepareManagedWorktree", () => {
  it("concurrent fresh prepares yield distinct valid UUIDv7 paths", async () => {
    const repo = await seedRepository();
    const installA = recordingInstall();
    const installB = recordingInstall();
    const [a, b] = await Promise.all([
      prepareManagedWorktree(
        {
          repositoryRoot: repo.cwd,
          taskId: "T1305",
          baseCommit: repo.base,
        },
        {
          stateDir: path.join(repo.stateDir, "a"),
          cacheRoot: repo.cacheRoot,
          install: installA.runner,
          bunWorkspaceRoot: repo.workspace,
        },
      ),
      prepareManagedWorktree(
        {
          repositoryRoot: repo.cwd,
          taskId: "T1306",
          baseCommit: repo.base,
        },
        {
          stateDir: path.join(repo.stateDir, "b"),
          cacheRoot: repo.cacheRoot,
          install: installB.runner,
          bunWorkspaceRoot: repo.workspace,
        },
      ),
    ]);
    expect(a.status).toBe("prepared");
    expect(b.status).toBe("prepared");
    if (a.status !== "prepared" || b.status !== "prepared") return;
    expect(isUuidV7(a.evidence.worktreeId)).toBe(true);
    expect(isUuidV7(b.evidence.worktreeId)).toBe(true);
    expect(a.evidence.worktreeId).not.toBe(b.evidence.worktreeId);
    expect(a.evidence.absolutePath).not.toBe(b.evidence.absolutePath);
    expect(a.evidence.absolutePath).toContain(`${path.sep}.claude${path.sep}worktrees${path.sep}`);
    expect(await fs.stat(a.evidence.absolutePath).then((s) => s.isDirectory())).toBe(true);
    expect(await fs.stat(b.evidence.absolutePath).then((s) => s.isDirectory())).toBe(true);
  });

  it("duplicate prepare for the same task cannot create a second live tree", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const deps = {
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install: install.runner,
      bunWorkspaceRoot: repo.workspace,
    };
    const first = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1305", baseCommit: repo.base },
      deps,
    );
    expect(first.status).toBe("prepared");
    if (first.status !== "prepared") return;

    const second = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1305", baseCommit: repo.base },
      deps,
    );
    expect(second.status).toBe("resume-required");
    if (second.status !== "resume-required") return;
    expect(second.handle.token).toBe(first.handle.token);
    expect(second.evidence.absolutePath).toBe(first.evidence.absolutePath);

    const live = await listManagedLiveWorktrees(repo.cwd, "T1305", repo.stateDir);
    expect(live).toHaveLength(1);

    // Forced fresh (allowResumeRequired=false) also refuses rather than minting a second tree.
    const forced = await prepareManagedWorktree(
      {
        repositoryRoot: repo.cwd,
        taskId: "T1305",
        baseCommit: repo.base,
        allowResumeRequired: false,
      },
      deps,
    );
    expect(forced.status).toBe("refused");
    if (forced.status === "refused") {
      expect(forced.reason).toBe("registry-conflict");
    }
    expect(await listManagedLiveWorktrees(repo.cwd, "T1305", repo.stateDir)).toHaveLength(1);
  });

  it("refuses before git worktree add when base verification fails", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    let worktreeAddCount = 0;
    const gitRunner = async (cwd: string, args: readonly string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        worktreeAddCount += 1;
      }
      const result = await exec("git", [...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }).then(
        (ok) => ({ code: 0, stdout: ok.stdout, stderr: ok.stderr }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({
          code: typeof error.code === "number" ? error.code : 1,
          stdout: String(error.stdout ?? ""),
          stderr: String(error.stderr ?? ""),
        }),
      );
      return result;
    };

    const missingBase = await prepareManagedWorktree(
      {
        repositoryRoot: repo.cwd,
        taskId: "T1305",
        baseCommit: "0".repeat(40),
      },
      {
        stateDir: repo.stateDir,
        cacheRoot: repo.cacheRoot,
        install: install.runner,
        bunWorkspaceRoot: repo.workspace,
        git: gitRunner,
      },
    );
    expect(missingBase.status).toBe("refused");
    if (missingBase.status === "refused") {
      expect(missingBase.reason).toBe("base-unresolvable");
    }
    expect(worktreeAddCount).toBe(0);
    expect(install.plans).toHaveLength(0);

    // Dependency failure also blocks before worktree add.
    const depFail = await prepareManagedWorktree(
      {
        repositoryRoot: repo.cwd,
        taskId: "T1305",
        baseCommit: repo.base,
        dependencyReader: readerOf([
          task("T1305", "planned", ["T1"], null),
          task("T1", "wip", [], null),
        ]),
      },
      {
        stateDir: repo.stateDir,
        cacheRoot: repo.cacheRoot,
        install: install.runner,
        bunWorkspaceRoot: repo.workspace,
        git: gitRunner,
      },
    );
    expect(depFail.status).toBe("refused");
    if (depFail.status === "refused") {
      expect(depFail.reason).toBe("dependency-unresolvable");
      expect(depFail.dependency?.reason).toBe("dependency-not-satisfied");
    }
    expect(worktreeAddCount).toBe(0);
  });

  it("install receives BUN_INSTALL_CACHE_DIR and exact frozen-lockfile args; cwd is under managed worktree", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const prepared = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1305", baseCommit: repo.base },
      {
        stateDir: repo.stateDir,
        cacheRoot: repo.cacheRoot,
        install: install.runner,
        bunWorkspaceRoot: repo.workspace,
      },
    );
    expect(prepared.status).toBe("prepared");
    expect(install.plans).toHaveLength(1);
    const plan = install.plans[0]!;
    expect(plan.args).toEqual(["install", "--frozen-lockfile"]);
    expect(plan.env["BUN_INSTALL_CACHE_DIR"]).toBe(path.join(repo.cacheRoot, "bun-install"));
    if (prepared.status !== "prepared") return;
    // Install MUST target the workspace inside the managed worktree, never the seed.
    expect(plan.cwd.startsWith(prepared.evidence.absolutePath + path.sep)).toBe(true);
    expect(plan.cwd).not.toBe(repo.workspace);
    const rebased = rebaseBunWorkspaceIntoWorktree(
      repo.cwd,
      repo.workspace,
      prepared.evidence.absolutePath,
    );
    expect(rebased).not.toBeNull();
    if (rebased === null) return;
    expect(plan.cwd).toBe(rebased);
    expect(prepared.evidence.bunWorkspaceRoot).toBe(plan.cwd);
    expect(prepared.evidence.bunInstallArgs).toEqual(["install", "--frozen-lockfile"]);
    expect(prepared.evidence.bunInstallCacheDir).toBe(path.join(repo.cacheRoot, "bun-install"));
    const nm = path.join(plan.cwd, "node_modules");
    const stat = await fs.lstat(nm);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
    // Seed checkout must not have received the install.
    await expect(fs.stat(path.join(repo.workspace, "node_modules"))).rejects.toBeDefined();
  });

  it("post-add bun-install failure rolls back worktree and created branch (no live orphan)", async () => {
    const repo = await seedRepository();
    const failingInstall: ManagedWorktreeInstallRunner = async (plan) => {
      // Observe that cwd is already under a managed path before failing.
      expect(plan.cwd.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)).toBe(true);
      return { code: 17, stdout: "", stderr: "injected install failure\n" };
    };
    const result = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1701", baseCommit: repo.base },
      {
        stateDir: repo.stateDir,
        cacheRoot: repo.cacheRoot,
        install: failingInstall,
        bunWorkspaceRoot: repo.workspace,
      },
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("bun-install-failed");
    }
    const live = await listManagedLiveWorktrees(repo.cwd, "T1701", repo.stateDir);
    expect(live).toHaveLength(0);
    // Branch created by prepare must be gone after rollback.
    const branchCheck = await exec("git", ["show-ref", "--verify", "--quiet", "refs/heads/implement/T1701"], {
      cwd: repo.cwd,
      encoding: "utf8",
    }).then(
      () => 0,
      (error: { code?: number }) => (typeof error.code === "number" ? error.code : 1),
    );
    expect(branchCheck).not.toBe(0);
    // No residual worktrees under .claude/worktrees.
    const parent = path.join(repo.cwd, ".claude", "worktrees");
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(parent)).filter((name) => name !== ".cq-managed-registry");
    } catch {
      entries = [];
    }
    // stateDir is outside parent in tests; only UUIDv7 dirs would be orphans.
    for (const entry of entries) {
      if (entry === path.basename(repo.stateDir)) continue;
      // Registry dir name may live elsewhere; leftover UUIDv7 dirs are the defect.
      expect(isUuidV7(entry)).toBe(false);
    }
  });

  it("post-add registry-commit fault rolls back rather than orphaning a live=0 checkout", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const result = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1702", baseCommit: repo.base },
      {
        stateDir: repo.stateDir,
        cacheRoot: repo.cacheRoot,
        install: install.runner,
        bunWorkspaceRoot: repo.workspace,
        faultInjector: (boundary) => {
          if (boundary === "before-registry-commit") {
            throw new Error("injected fault at before-registry-commit");
          }
        },
      },
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("registry-conflict");
    }
    expect(await listManagedLiveWorktrees(repo.cwd, "T1702", repo.stateDir)).toHaveLength(0);
    const branchCheck = await exec("git", ["show-ref", "--verify", "--quiet", "refs/heads/implement/T1702"], {
      cwd: repo.cwd,
      encoding: "utf8",
    }).then(
      () => 0,
      (error: { code?: number }) => (typeof error.code === "number" ? error.code : 1),
    );
    expect(branchCheck).not.toBe(0);
  });

  it("concurrent same-task handle-free prepares serialize to a single live tree", async () => {
    const repo = await seedRepository();
    const installA = recordingInstall();
    const installB = recordingInstall();
    // Barrier: without the per-task lock both callers reach before-worktree-add
    // while live=0 and would mint two trees. With the lock only one enters.
    let arrived = 0;
    let releaseBarrier: (() => void) | undefined;
    const bothArrived = new Promise<void>((resolvePromise) => {
      releaseBarrier = () => resolvePromise();
    });
    const makeDeps = (install: ManagedWorktreeInstallRunner) => ({
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install,
      bunWorkspaceRoot: repo.workspace,
      // Bound lock wait so a stuck peer surfaces rather than hanging the suite.
      prepareLockTimeoutMs: 10_000,
      faultInjector: async (boundary: ManagedWorktreeFaultBoundary) => {
        if (boundary !== "before-worktree-add") return;
        arrived += 1;
        if (arrived >= 2) releaseBarrier?.();
        // Wait briefly for a peer; under the lock the peer cannot arrive until
        // we finish, so the timeout expires and we proceed alone.
        await Promise.race([
          bothArrived,
          new Promise<void>((r) => setTimeout(r, 150)),
        ]);
      },
    });
    const [a, b] = await Promise.all([
      prepareManagedWorktree(
        { repositoryRoot: repo.cwd, taskId: "T1800", baseCommit: repo.base },
        makeDeps(installA.runner),
      ),
      prepareManagedWorktree(
        { repositoryRoot: repo.cwd, taskId: "T1800", baseCommit: repo.base },
        makeDeps(installB.runner),
      ),
    ]);
    // Under exclusive lock the barrier never sees arrived>=2.
    expect(arrived).toBe(1);
    const statuses = [a.status, b.status].sort();
    // One prepared, the other resume-required (or refused registry-conflict).
    expect(statuses).toContain("prepared");
    expect(statuses.some((s) => s === "resume-required" || s === "refused")).toBe(true);
    const live = await listManagedLiveWorktrees(repo.cwd, "T1800", repo.stateDir);
    expect(live).toHaveLength(1);
    const prepared = a.status === "prepared" ? a : b.status === "prepared" ? b : null;
    expect(prepared).not.toBeNull();
    if (prepared === null) return;
    const worktreeParent = path.join(repo.cwd, ".claude", "worktrees");
    const dirs = (await fs.readdir(worktreeParent)).filter((name) => isUuidV7(name));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(prepared.evidence.worktreeId);
  });

  it("resume reuses the same path/branch and preserves a prior criticism commit", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const deps = {
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install: install.runner,
      bunWorkspaceRoot: repo.workspace,
    };
    const prepared = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1305", baseCommit: repo.base },
      deps,
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;

    // Simulate a criticism-round commit inside the managed worktree.
    await fs.writeFile(path.join(prepared.evidence.absolutePath, "fix.txt"), "round-1\n");
    await git(prepared.evidence.absolutePath, ["add", "fix.txt"]);
    await git(prepared.evidence.absolutePath, ["commit", "-q", "-m", "criticism round"]);
    const criticismHead = await git(prepared.evidence.absolutePath, ["rev-parse", "HEAD"]);
    expect(criticismHead).not.toBe(repo.base);

    const resumed = await prepareManagedWorktree(
      {
        repositoryRoot: repo.cwd,
        taskId: "T1305",
        handle: prepared.handle,
        priorResultCommit: criticismHead,
      },
      deps,
    );
    expect(resumed.status).toBe("prepared");
    if (resumed.status !== "prepared") return;
    expect(resumed.evidence.mode).toBe("resume");
    expect(resumed.evidence.absolutePath).toBe(prepared.evidence.absolutePath);
    expect(resumed.evidence.branch).toBe(prepared.evidence.branch);
    expect(resumed.evidence.headCommit).toBe(criticismHead);
    // No reset: criticism commit still tip.
    expect(await git(resumed.evidence.absolutePath, ["rev-parse", "HEAD"])).toBe(criticismHead);
    expect(await git(resumed.evidence.absolutePath, ["log", "--oneline"])).toContain(
      "criticism round",
    );
  });

  it("tampered, foreign, and path-traversal handles fail closed", async () => {
    const repo = await seedRepository();
    const other = await seedRepository();
    const install = recordingInstall();
    const deps = {
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install: install.runner,
      bunWorkspaceRoot: repo.workspace,
    };
    const prepared = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1305", baseCommit: repo.base },
      deps,
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;

    const baseHandle = prepared.handle;

    const tamperedToken: ManagedWorktreeHandle = {
      ...baseHandle,
      token: "0".repeat(32),
    };
    const tampered = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1305", handle: tamperedToken },
      deps,
    );
    expect(tampered.status).toBe("refused");
    if (tampered.status === "refused") {
      expect(["handle-invalid", "handle-mismatch"]).toContain(tampered.reason);
    }

    const foreign: ManagedWorktreeHandle = {
      ...baseHandle,
      repositoryRoot: other.cwd,
    };
    const foreignResult = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1305", handle: foreign },
      deps,
    );
    expect(foreignResult.status).toBe("refused");
    if (foreignResult.status === "refused") {
      expect(foreignResult.reason).toBe("handle-foreign");
    }

    const traversal: ManagedWorktreeHandle = {
      ...baseHandle,
      absolutePath: path.join(repo.cwd, "..", "escape", baseHandle.worktreeId),
    };
    const traversalResult = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1305", handle: traversal },
      deps,
    );
    expect(traversalResult.status).toBe("refused");
    if (traversalResult.status === "refused") {
      expect(["handle-path-traversal", "handle-mismatch"]).toContain(traversalResult.reason);
    }

    // Release path also fails closed on the same classes.
    const releaseTampered = await releaseManagedWorktree(
      { handle: tamperedToken, terminalDisposition: "done" },
      deps,
    );
    expect(releaseTampered.status).toBe("refused");

    const releaseTraversal = await releaseManagedWorktree(
      { handle: traversal, terminalDisposition: "done" },
      deps,
    );
    expect(releaseTraversal.status).toBe("refused");
    if (releaseTraversal.status === "refused") {
      expect(["handle-path-traversal", "handle-mismatch", "handle-invalid"]).toContain(
        releaseTraversal.reason,
      );
    }
  });
});

describe("releaseManagedWorktree", () => {
  it("leaves dirty, unmerged-result, and WIP-partial trees intact", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const deps = {
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install: install.runner,
      bunWorkspaceRoot: repo.workspace,
    };

    // Dirty tree.
    const dirtyPrep = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1401", baseCommit: repo.base },
      deps,
    );
    expect(dirtyPrep.status).toBe("prepared");
    if (dirtyPrep.status !== "prepared") return;
    await fs.writeFile(path.join(dirtyPrep.evidence.absolutePath, "dirt.txt"), "dirty\n");
    const dirtyRelease = await releaseManagedWorktree(
      { handle: dirtyPrep.handle, terminalDisposition: "done" },
      deps,
    );
    expect(dirtyRelease.status).toBe("refused");
    if (dirtyRelease.status === "refused") expect(dirtyRelease.reason).toBe("dirty");
    expect(await fs.stat(dirtyPrep.evidence.absolutePath).then((s) => s.isDirectory())).toBe(true);
    expect(await fs.readFile(path.join(dirtyPrep.evidence.absolutePath, "dirt.txt"), "utf8")).toBe(
      "dirty\n",
    );

    // WIP open checkpoints (G122).
    const wipPrep = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1402", baseCommit: repo.base },
      deps,
    );
    expect(wipPrep.status).toBe("prepared");
    if (wipPrep.status !== "prepared") return;
    const wipBody = serializeWipArtifact({
      id: "T1402",
      role: "implement-worker",
      baseCommit: repo.base,
      startedAt: "2026-08-07T00:00:00.000Z",
      checkpoints: [{ name: "implementation", status: "todo", body: "still open\n" }],
      complete: false,
      openCheckpoints: ["implementation"],
    });
    await fs.writeFile(path.join(wipPrep.evidence.absolutePath, "WIP-T1402.md"), wipBody);
    // Commit the WIP so dirty check does not fire first — open WIP alone must refuse.
    await git(wipPrep.evidence.absolutePath, ["add", "WIP-T1402.md"]);
    await git(wipPrep.evidence.absolutePath, ["commit", "-q", "-m", "wip partial"]);
    const wipRelease = await releaseManagedWorktree(
      { handle: wipPrep.handle, terminalDisposition: "done" },
      deps,
    );
    expect(wipRelease.status).toBe("refused");
    if (wipRelease.status === "refused") {
      expect(wipRelease.reason).toBe("wip-open");
      expect(wipRelease.openCheckpoints).toContain("implementation");
    }
    expect(await fs.stat(wipPrep.evidence.absolutePath).then((s) => s.isDirectory())).toBe(true);
    expect(
      await fs.readFile(path.join(wipPrep.evidence.absolutePath, "WIP-T1402.md"), "utf8"),
    ).toContain("implementation");

    // resultCommit mismatch (unmerged / wrong tip).
    const mismatchPrep = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1403", baseCommit: repo.base },
      deps,
    );
    expect(mismatchPrep.status).toBe("prepared");
    if (mismatchPrep.status !== "prepared") return;
    const mismatchRelease = await releaseManagedWorktree(
      {
        handle: mismatchPrep.handle,
        terminalDisposition: "done",
        resultCommit: "f".repeat(40),
      },
      deps,
    );
    expect(mismatchRelease.status).toBe("refused");
    if (mismatchRelease.status === "refused") expect(mismatchRelease.reason).toBe("commit-mismatch");
    expect(await fs.stat(mismatchPrep.evidence.absolutePath).then((s) => s.isDirectory())).toBe(
      true,
    );

    // Non-terminal disposition.
    const nonTerm = await releaseManagedWorktree(
      { handle: mismatchPrep.handle, terminalDisposition: "wip" },
      deps,
    );
    expect(nonTerm.status).toBe("refused");
    if (nonTerm.status === "refused") expect(nonTerm.reason).toBe("not-terminal");
    expect(await fs.stat(mismatchPrep.evidence.absolutePath).then((s) => s.isDirectory())).toBe(
      true,
    );
  });

  it("eligible clean terminal release is idempotent", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const deps = {
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install: install.runner,
      bunWorkspaceRoot: repo.workspace,
    };
    const prepared = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1500", baseCommit: repo.base },
      deps,
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    const head = prepared.evidence.headCommit;

    const first = await releaseManagedWorktree(
      {
        handle: prepared.handle,
        terminalDisposition: "done",
        resultCommit: head,
      },
      deps,
    );
    expect(first.status).toBe("released");
    if (first.status === "released") expect(first.idempotent).toBe(false);
    await expect(fs.stat(prepared.evidence.absolutePath)).rejects.toBeDefined();

    const second = await releaseManagedWorktree(
      {
        handle: prepared.handle,
        terminalDisposition: "done",
        resultCommit: head,
      },
      deps,
    );
    expect(second.status).toBe("released");
    if (second.status === "released") expect(second.idempotent).toBe(true);
  });

  it("fault injection before irreversible remove leaves recoverable work intact", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const depsBase = {
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install: install.runner,
      bunWorkspaceRoot: repo.workspace,
    };
    const prepared = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1600", baseCommit: repo.base },
      depsBase,
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    await fs.writeFile(path.join(prepared.evidence.absolutePath, "recover-me.txt"), "precious\n");
    await git(prepared.evidence.absolutePath, ["add", "recover-me.txt"]);
    await git(prepared.evidence.absolutePath, ["commit", "-q", "-m", "precious work"]);
    // Keep tree clean but inject fault before remove — actually dirty would refuse earlier.
    // Use clean tree with open WIP so release refuses before remove; ALSO inject fault.
    // Better: clean + terminal, fault at before-worktree-remove throws.
    const head = await git(prepared.evidence.absolutePath, ["rev-parse", "HEAD"]);

    const hit: { boundary: ManagedWorktreeFaultBoundary | undefined } = {
      boundary: undefined,
    };
    await expect(
      releaseManagedWorktree(
        {
          handle: prepared.handle,
          terminalDisposition: "done",
          resultCommit: head,
        },
        {
          ...depsBase,
          faultInjector: (boundary) => {
            if (boundary === "before-worktree-remove") {
              hit.boundary = boundary;
              throw new Error("injected fault at before-worktree-remove");
            }
          },
        },
      ),
    ).rejects.toThrow("injected fault at before-worktree-remove");
    expect(hit.boundary).toBe("before-worktree-remove");
    // Recoverable work still present.
    expect(
      await fs.readFile(path.join(prepared.evidence.absolutePath, "recover-me.txt"), "utf8"),
    ).toBe("precious\n");
    expect(await git(prepared.evidence.absolutePath, ["rev-parse", "HEAD"])).toBe(head);
    const live = await listManagedLiveWorktrees(repo.cwd, "T1600", repo.stateDir);
    expect(live).toHaveLength(1);
  });

  it("fault before-registry-release preserves precious commit on branch (registry still live)", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const depsBase = {
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install: install.runner,
      bunWorkspaceRoot: repo.workspace,
    };
    const prepared = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1601", baseCommit: repo.base },
      depsBase,
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    await fs.writeFile(path.join(prepared.evidence.absolutePath, "precious.txt"), "keep-me\n");
    await git(prepared.evidence.absolutePath, ["add", "precious.txt"]);
    await git(prepared.evidence.absolutePath, ["commit", "-q", "-m", "precious commit"]);
    const head = await git(prepared.evidence.absolutePath, ["rev-parse", "HEAD"]);
    const branch = prepared.evidence.branch;

    await expect(
      releaseManagedWorktree(
        {
          handle: prepared.handle,
          terminalDisposition: "done",
          resultCommit: head,
        },
        {
          ...depsBase,
          faultInjector: (boundary) => {
            if (boundary === "before-registry-release") {
              throw new Error("injected fault at before-registry-release");
            }
          },
        },
      ),
    ).rejects.toThrow("injected fault at before-registry-release");

    // Worktree directory may be gone, but branch tip must still hold the precious commit.
    // Registry must remain live so a later release can complete.
    expect(await listManagedLiveWorktrees(repo.cwd, "T1601", repo.stateDir)).toHaveLength(1);
    const branchTip = await git(repo.cwd, ["rev-parse", branch]);
    expect(branchTip).toBe(head);
    // Blob content reachable via the branch tip.
    const blob = await git(repo.cwd, ["show", `${head}:precious.txt`]);
    expect(blob).toBe("keep-me");

    // worktree-missing + live registry is completable after the fault.
    const recovered = await releaseManagedWorktree(
      {
        handle: prepared.handle,
        terminalDisposition: "done",
        resultCommit: head,
      },
      depsBase,
    );
    expect(recovered.status).toBe("released");
    if (recovered.status === "released") expect(recovered.idempotent).toBe(false);
    expect(await listManagedLiveWorktrees(repo.cwd, "T1601", repo.stateDir)).toHaveLength(0);
    // Branch deleted only after durable registry release.
    const branchGone = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repo.cwd,
      encoding: "utf8",
    }).then(
      () => false,
      () => true,
    );
    expect(branchGone).toBe(true);
    // Recovery ref still holds the tip for archaeology.
    const recoveryTip = await git(repo.cwd, [
      "rev-parse",
      `refs/cq-managed-recovery/${branch}`,
    ]);
    expect(recoveryTip).toBe(head);
  });

  it("worktree-missing + live registry release is completable", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const deps = {
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install: install.runner,
      bunWorkspaceRoot: repo.workspace,
    };
    const prepared = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1602", baseCommit: repo.base },
      deps,
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    const head = prepared.evidence.headCommit;
    // Simulate external removal of the worktree path while registry stays live.
    await exec("git", ["worktree", "remove", "--force", prepared.evidence.absolutePath], {
      cwd: repo.cwd,
      encoding: "utf8",
    });
    expect(await listManagedLiveWorktrees(repo.cwd, "T1602", repo.stateDir)).toHaveLength(1);

    const released = await releaseManagedWorktree(
      {
        handle: prepared.handle,
        terminalDisposition: "abandoned",
        resultCommit: head,
      },
      deps,
    );
    expect(released.status).toBe("released");
    expect(await listManagedLiveWorktrees(repo.cwd, "T1602", repo.stateDir)).toHaveLength(0);
  });
});

/**
 * T1310 — end-to-end local gates for the managed worktree prepare→dispatch→release
 * state machine. Orchestrator invariants:
 *   1. prepare precedes wip/dispatch (no live tree ⇒ no dispatch authority);
 *   2. release is guarded (dirty / open-WIP / non-terminal refuse; clean terminal ok).
 */
describe("T1310 managed worktree prepare→dispatch→release state machine [BA]", () => {
  type OrchestratorPhase = "idle" | "prepared" | "wip" | "terminal" | "released";

  function advance(phase: OrchestratorPhase, event: "prepare" | "wip" | "terminal" | "release"): OrchestratorPhase | "refused" {
    // Local gate table — mirrors implement/advance ordering.
    if (event === "prepare") {
      return phase === "idle" || phase === "prepared" ? "prepared" : "refused";
    }
    if (event === "wip") {
      return phase === "prepared" || phase === "wip" ? "wip" : "refused";
    }
    if (event === "terminal") {
      return phase === "wip" || phase === "terminal" ? "terminal" : "refused";
    }
    // release
    return phase === "terminal" ? "released" : "refused";
  }

  it("prepare precedes wip; release only after terminal", () => {
    expect(advance("idle", "wip")).toBe("refused");
    expect(advance("idle", "release")).toBe("refused");
    expect(advance("idle", "prepare")).toBe("prepared");
    expect(advance("prepared", "wip")).toBe("wip");
    expect(advance("wip", "release")).toBe("refused"); // guarded: not terminal
    expect(advance("wip", "terminal")).toBe("terminal");
    expect(advance("terminal", "release")).toBe("released");
    expect(advance("released", "prepare")).toBe("refused");
  });

  it("e2e: prepare → wip marker → guarded release refuse → clean terminal release", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const deps = {
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install: install.runner,
      bunWorkspaceRoot: repo.workspace,
    };

    // No live tree before prepare — dispatch authority absent.
    expect(await listManagedLiveWorktrees(repo.cwd, "T1310", repo.stateDir)).toHaveLength(0);

    const prepared = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T1310", baseCommit: repo.base },
      deps,
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(await listManagedLiveWorktrees(repo.cwd, "T1310", repo.stateDir)).toHaveLength(1);

    // Simulate orchestrator wip/dispatch: write a WIP partial with open checkpoint.
    const wipBody = serializeWipArtifact({
      id: "T1310",
      role: "implement-worker",
      baseCommit: repo.base,
      startedAt: "2026-08-07T00:00:00.000Z",
      checkpoints: [{ name: "implementation", status: "todo", body: "in flight\n" }],
      complete: false,
      openCheckpoints: ["implementation"],
    });
    await fs.writeFile(path.join(prepared.evidence.absolutePath, "WIP-T1310.md"), wipBody);
    await git(prepared.evidence.absolutePath, ["add", "WIP-T1310.md"]);
    await git(prepared.evidence.absolutePath, ["commit", "-q", "-m", "wip partial"]);

    // Release while wip is open MUST refuse (guarded).
    const earlyRelease = await releaseManagedWorktree(
      {
        handle: prepared.handle,
        terminalDisposition: "done",
        resultCommit: await git(prepared.evidence.absolutePath, ["rev-parse", "HEAD"]),
      },
      deps,
    );
    expect(earlyRelease.status).toBe("refused");
    if (earlyRelease.status === "refused") {
      expect(earlyRelease.reason).toBe("wip-open");
    }
    expect(await listManagedLiveWorktrees(repo.cwd, "T1310", repo.stateDir)).toHaveLength(1);

    // Complete the WIP (close checkpoints) and add a final commit — terminal.
    const doneBody = serializeWipArtifact({
      id: "T1310",
      role: "implement-worker",
      baseCommit: repo.base,
      startedAt: "2026-08-07T00:00:00.000Z",
      checkpoints: [{ name: "implementation", status: "done", body: "done\n" }],
      complete: true,
      openCheckpoints: [],
    });
    await fs.writeFile(path.join(prepared.evidence.absolutePath, "WIP-T1310.md"), doneBody);
    await fs.writeFile(path.join(prepared.evidence.absolutePath, "done.txt"), "ok\n");
    await git(prepared.evidence.absolutePath, ["add", "."]);
    await git(prepared.evidence.absolutePath, ["commit", "-q", "-m", "complete"]);
    const tip = await git(prepared.evidence.absolutePath, ["rev-parse", "HEAD"]);

    const released = await releaseManagedWorktree(
      {
        handle: prepared.handle,
        terminalDisposition: "done",
        resultCommit: tip,
        deleteBranch: true,
      },
      deps,
    );
    expect(released.status).toBe("released");
    expect(await listManagedLiveWorktrees(repo.cwd, "T1310", repo.stateDir)).toHaveLength(0);
  });
});

