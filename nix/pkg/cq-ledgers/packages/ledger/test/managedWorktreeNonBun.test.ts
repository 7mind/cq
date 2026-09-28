/**
 * D567 — managed worktree preparation must not require a Bun workspace.
 *
 * A project with no `bun.lock` used to be refused `bun-workspace-missing`, so
 * no Python, Rust, Go or JVM project could get a managed worktree at all. It
 * now gets a plain worktree with no dependency bootstrap; a Bun workspace keeps
 * its frozen install (the control).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { prepareManagedWorktree, type ManagedWorktreeInstallRunner } from "../src/managedWorktree.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function repository(files: Readonly<Record<string, string>>) {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "cq-managed-nonbun-"));
  roots.push(cwd);
  const git = async (...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.email", "d567@example.invalid");
  await git("config", "user.name", "D567");
  await git("config", "commit.gpgsign", "false");
  for (const [relative, bytes] of Object.entries({ ".gitignore": "node_modules/\n.state/\n.cache/\n", ...files })) {
    await fs.mkdir(path.dirname(path.join(cwd, relative)), { recursive: true });
    await fs.writeFile(path.join(cwd, relative), bytes);
  }
  await git("add", ".");
  await git("commit", "-q", "-m", "seed");
  return { cwd, base: await git("rev-parse", "HEAD") };
}

function recordingInstall(): { readonly runner: ManagedWorktreeInstallRunner; readonly cwds: string[] } {
  const cwds: string[] = [];
  return {
    cwds,
    runner: async (plan) => {
      cwds.push(plan.cwd);
      await fs.mkdir(path.join(plan.cwd, "node_modules"), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("D567 managed worktrees for non-Bun projects [Behavioral-Active Effectual-GoodCommunication]", () => {
  test("a Python project is prepared as a plain worktree with no dependency bootstrap", async () => {
    const repo = await repository({
      "pyproject.toml": "[project]\nname = \"pricing\"\n",
      "app.py": "def price():\n    return 1\n",
      "test_app.py": "from app import price\n\ndef test_price():\n    assert price() == 1\n",
    });
    const install = recordingInstall();
    const prepared = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T567", baseCommit: repo.base },
      { stateDir: path.join(repo.cwd, ".state"), cacheRoot: path.join(repo.cwd, ".cache"), install: install.runner },
    );
    expect(prepared.status === "refused" ? `${prepared.reason}: ${prepared.detail}` : prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(install.cwds).toEqual([]);
    expect(prepared.evidence.bunWorkspaceRoots).toEqual([]);
    expect(prepared.evidence.bunInstallArgs).toEqual([]);
    expect(await fs.readFile(path.join(prepared.handle.absolutePath, "app.py"), "utf8")).toContain("def price");
    const resumed = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T567", baseCommit: repo.base },
      { stateDir: path.join(repo.cwd, ".state"), cacheRoot: path.join(repo.cwd, ".cache"), install: install.runner },
    );
    expect(resumed.status).toBe("resume-required");
    if (resumed.status !== "resume-required") return;
    expect(resumed.evidence.bunWorkspaceRoots).toEqual([]);
    expect(resumed.evidence.bunInstallArgs).toEqual([]);
  });

  test("control: a Bun workspace still receives its frozen install", async () => {
    const repo = await repository({
      "package.json": `${JSON.stringify({ name: "d567-control", private: true })}\n`,
      "bun.lock": "{}\n",
    });
    const install = recordingInstall();
    const prepared = await prepareManagedWorktree(
      { repositoryRoot: repo.cwd, taskId: "T568", baseCommit: repo.base },
      { stateDir: path.join(repo.cwd, ".state"), cacheRoot: path.join(repo.cwd, ".cache"), install: install.runner },
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(install.cwds).toEqual([prepared.handle.absolutePath]);
    expect(prepared.evidence.bunInstallArgs).toEqual(["install", "--frozen-lockfile"]);
  });
});
