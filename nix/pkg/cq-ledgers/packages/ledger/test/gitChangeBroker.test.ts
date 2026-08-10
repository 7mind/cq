/**
 * T2042 / D307 — trusted, dispatch-bound Git change broker.
 *
 * Behavioral-Active Effectual-GoodCommunication tests against disposable real
 * repositories. Regression origin: H236's linked-worktree index denial and
 * sibling-ref authority escape.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  commitManagedWorktreeChanges,
  prepareManagedWorktree,
  resolveManagedWorktreeDispatchBinding,
  type DispatchBoundGitAuthorization,
  type GitChangeBrokerRequest,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "T2042",
      GIT_AUTHOR_EMAIL: "t2042@example.invalid",
      GIT_COMMITTER_NAME: "T2042",
      GIT_COMMITTER_EMAIL: "t2042@example.invalid",
    },
  });
  return stdout.trim();
}

function digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function seed(): Promise<{
  repositoryRoot: string;
  stateDir: string;
  worktreePath: string;
  authorization: DispatchBoundGitAuthorization;
  head: string;
}> {
  const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), "t2042-broker-"));
  roots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "-q"]);
  await git(repositoryRoot, ["config", "user.name", "T2042"]);
  await git(repositoryRoot, ["config", "user.email", "t2042@example.invalid"]);
  await git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(repositoryRoot, "bun.lock"), "{}\n");
  await fs.writeFile(path.join(repositoryRoot, "modify.txt"), "before modify\n");
  await fs.writeFile(path.join(repositoryRoot, "delete.txt"), "before delete\n");
  await fs.writeFile(path.join(repositoryRoot, "rename-old.txt"), "before rename\n");
  await fs.writeFile(path.join(repositoryRoot, "mode.txt"), "mode\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  const head = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const stateDir = path.join(repositoryRoot, ".broker-state");
  const prepared = await prepareManagedWorktree(
    { repositoryRoot, taskId: "T2042", baseCommit: head },
    { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
  );
  if (prepared.status !== "prepared") {
    throw new Error(
      prepared.status === "refused"
        ? `prepare refused: ${prepared.reason}: ${prepared.detail}`
        : `prepare requires resume: ${prepared.reason}`,
    );
  }
  const binding = await resolveManagedWorktreeDispatchBinding(
    {
      repositoryRoot,
      taskId: "T2042",
      worktreePath: prepared.handle.absolutePath,
      branch: prepared.handle.branch,
    },
    { stateDir },
  );
  if (binding === null) throw new Error("managed dispatch binding did not resolve");
  return {
    repositoryRoot,
    stateDir,
    worktreePath: prepared.handle.absolutePath,
    head,
    authorization: {
      ...binding,
      attestationId: "cq_attest_AAAAAAAAAAAAAAAAAAAAAA",
      generation: 1,
      roleId: "implement-worker",
      surface: "codex",
      childCancelAt: "2099-01-01T00:00:00.000Z",
    },
  };
}

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("H236 retained reproductions", () => {
  test("Codex :workspace denies the linked-worktree index with EROFS", async () => {
    const fixture = await seed();
    await fs.writeFile(path.join(fixture.worktreePath, "modify.txt"), "sandbox edit\n");
    const result = Bun.spawnSync(
      ["codex", "sandbox", "-C", fixture.worktreePath, "-P", ":workspace", "--", "git", "add", "modify.txt"],
      { cwd: fixture.worktreePath, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(128);
    expect(`${result.stdout}${result.stderr}`).toMatch(/index\.lock.*Read-only file system/);
  });

  test("the broker authorization contains no task-gitdir authority", async () => {
    const fixture = await seed();
    expect(Object.keys(fixture.authorization)).not.toContain("gitDir");
    expect(Object.keys(fixture.authorization)).not.toContain("taskGitDir");
    expect(fixture.authorization.commonDir).toBe(path.join(fixture.repositoryRoot, ".git"));
  });
});

describe("commitManagedWorktreeChanges", () => {
  test("commits the closed add/modify/delete/rename/mode algebra and durably replays one receipt", async () => {
    const fixture = await seed();
    const beforeModify = await fs.readFile(path.join(fixture.worktreePath, "modify.txt"));
    const beforeDelete = await fs.readFile(path.join(fixture.worktreePath, "delete.txt"));
    const beforeRename = await fs.readFile(path.join(fixture.worktreePath, "rename-old.txt"));
    const beforeMode = await fs.readFile(path.join(fixture.worktreePath, "mode.txt"));
    await fs.writeFile(path.join(fixture.worktreePath, "add.txt"), "added\n");
    await fs.writeFile(path.join(fixture.worktreePath, "modify.txt"), "after modify\n");
    await fs.rm(path.join(fixture.worktreePath, "delete.txt"));
    await fs.rename(
      path.join(fixture.worktreePath, "rename-old.txt"),
      path.join(fixture.worktreePath, "rename-new.txt"),
    );
    await fs.chmod(path.join(fixture.worktreePath, "mode.txt"), 0o755);
    const request: GitChangeBrokerRequest = {
      authorization: fixture.authorization,
      operationId: "T2042-round-0-commit-1",
      expectedHead: fixture.head,
      message: "brokered change",
      changes: [
        { kind: "add", path: "add.txt", newState: { mode: "100644", digest: digest("added\n") } },
        {
          kind: "modify",
          path: "modify.txt",
          oldState: { mode: "100644", digest: digest(beforeModify) },
          newState: { mode: "100644", digest: digest("after modify\n") },
        },
        { kind: "delete", path: "delete.txt", oldState: { mode: "100644", digest: digest(beforeDelete) } },
        {
          kind: "rename",
          oldPath: "rename-old.txt",
          newPath: "rename-new.txt",
          oldState: { mode: "100644", digest: digest(beforeRename) },
          newState: { mode: "100644", digest: digest(beforeRename) },
        },
        {
          kind: "modify",
          path: "mode.txt",
          oldState: { mode: "100644", digest: digest(beforeMode) },
          newState: { mode: "100755", digest: digest(beforeMode) },
        },
      ],
    };
    let authorizationChecks = 0;
    const deps = {
      stateDir: fixture.stateDir,
      authorize: async () => {
        authorizationChecks += 1;
      },
    };
    const receipt = await commitManagedWorktreeChanges(request, deps);
    expect(authorizationChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.oldHead).toBe(fixture.head);
    expect(receipt.newHead).toBe(await git(fixture.worktreePath, ["rev-parse", "HEAD"]));
    expect(receipt.paths).toEqual([
      "add.txt",
      "delete.txt",
      "mode.txt",
      "modify.txt",
      "rename-new.txt",
      "rename-old.txt",
    ]);
    expect(await git(fixture.worktreePath, ["status", "--porcelain"])).toBe("");
    expect(await git(fixture.worktreePath, ["show", `${receipt.newHead}:add.txt`])).toBe("added");
    expect(await git(fixture.worktreePath, ["cat-file", "-t", receipt.tree])).toBe("tree");
    for (const oid of receipt.objectOids) {
      expect(await git(fixture.worktreePath, ["cat-file", "-e", oid]).then(() => true)).toBe(true);
    }
    const replay = await commitManagedWorktreeChanges(request, deps);
    expect(replay).toEqual(receipt);
    expect(await git(fixture.worktreePath, ["rev-parse", `${receipt.newHead}^`])).toBe(receipt.oldHead);
    expect(await git(fixture.worktreePath, ["rev-parse", `${receipt.newHead}^{tree}`])).toBe(
      receipt.tree,
    );
    await expect(
      commitManagedWorktreeChanges({ ...request, message: "substituted request" }, deps),
    ).rejects.toThrow(/operationId .* reused with a different request/);
  });

  test("recovers one identical receipt at every irreversible boundary", async () => {
    for (const boundary of [
      "before-snapshot",
      "after-private-construction",
      "after-object-install",
      "before-ref-cas",
      "after-ref-cas",
      "after-index-install",
      "before-receipt-commit",
    ] as const) {
      const fixture = await seed();
      await fs.writeFile(path.join(fixture.worktreePath, "boundary.txt"), `${boundary}\n`);
      const request: GitChangeBrokerRequest = {
        authorization: fixture.authorization,
        operationId: `T2042-${boundary}`,
        expectedHead: fixture.head,
        message: `recover ${boundary}`,
        changes: [
          {
            kind: "add",
            path: "boundary.txt",
            newState: { mode: "100644", digest: digest(`${boundary}\n`) },
          },
        ],
      };
      let injected = false;
      await expect(
        commitManagedWorktreeChanges(request, {
          stateDir: fixture.stateDir,
          authorize: async () => {},
          faultInjector: async (observed) => {
            if (!injected && observed === boundary) {
              injected = true;
              throw new Error(`injected ${boundary}`);
            }
          },
        }),
      ).rejects.toThrow(`injected ${boundary}`);
      const receipt = await commitManagedWorktreeChanges(request, {
        stateDir: fixture.stateDir,
        authorize: async () => {},
      });
      expect(injected, boundary).toBe(true);
      expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"]), boundary).toBe(
        receipt.newHead,
      );
      expect(await git(fixture.worktreePath, ["status", "--porcelain"]), boundary).toBe("");
      expect(
        await commitManagedWorktreeChanges(request, {
          stateDir: fixture.stateDir,
          authorize: async () => {},
        }),
        boundary,
      ).toEqual(receipt);
    }
  });

  test("refuses lifecycle revocation, traversal, symlinks, and request-id substitution without ref advance", async () => {
    const fixture = await seed();
    await fs.writeFile(path.join(fixture.worktreePath, "add.txt"), "added\n");
    const request: GitChangeBrokerRequest = {
      authorization: fixture.authorization,
      operationId: "T2042-refusal",
      expectedHead: fixture.head,
      message: "must not commit",
      changes: [
        { kind: "add", path: "add.txt", newState: { mode: "100644", digest: digest("added\n") } },
      ],
    };
    await expect(
      commitManagedWorktreeChanges(request, {
        stateDir: fixture.stateDir,
        authorize: async () => {
          throw new Error("dispatch no longer prepared");
        },
      }),
    ).rejects.toThrow(/dispatch no longer prepared/);
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.head);

    await expect(
      commitManagedWorktreeChanges(
        {
          ...request,
          operationId: "T2042-traversal",
          changes: [{ kind: "add", path: "../escape", newState: { mode: "100644", digest: digest("added\n") } }],
        },
        { stateDir: fixture.stateDir, authorize: async () => {} },
      ),
    ).rejects.toThrow(/path/);

    await fs.rm(path.join(fixture.worktreePath, "add.txt"));
    await fs.symlink("modify.txt", path.join(fixture.worktreePath, "add.txt"));
    await expect(
      commitManagedWorktreeChanges(
        { ...request, operationId: "T2042-symlink" },
        { stateDir: fixture.stateDir, authorize: async () => {} },
      ),
    ).rejects.toThrow(/regular file|symlink/);
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.head);
  });
});
