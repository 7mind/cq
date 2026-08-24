import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createStrictInMemoryWorksetEffectAdmissionProvider,
  readProcessIdentity,
  runWorksetGitEffectGate,
  type WorksetGitEffectBinding,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cq-workset-git-effect-"));
  roots.push(root);
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "cq@example.invalid"]);
  await git(root, ["config", "user.name", "CQ Test"]);
  await Bun.write(join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "--quiet", "-m", "base"]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workset Git effect gate [T1984]", () => {
  test("runs one trusted branch effect under one admission [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const root = await repository();
    const head = await git(root, ["rev-parse", "HEAD"]);
    const provider = createStrictInMemoryWorksetEffectAdmissionProvider();
    const binding: WorksetGitEffectBinding = {
      kind: "branch-create",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      branch: "implement/T1984",
      commit: head,
    };

    const result = await runWorksetGitEffectGate({
      expected: binding,
      resolve: async () => binding,
      provider,
    });

    expect(result).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(await git(root, ["rev-parse", "refs/heads/implement/T1984"])).toBe(head);
    expect(provider.activeAdmissionCount()).toBe(0);
    expect(provider.events()).toEqual([
      "admission-acquired",
      "process-group-registered",
      "guardian-shared",
      "process-group-settled",
      "guardian-released",
      "admission-released",
    ]);
  });

  test("revalidates exact trusted coordinates after admission and mutates nothing on mismatch [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const root = await repository();
    const head = await git(root, ["rev-parse", "HEAD"]);
    const provider = createStrictInMemoryWorksetEffectAdmissionProvider();
    const expected: WorksetGitEffectBinding = {
      kind: "branch-create",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      branch: "implement/T1984",
      commit: head,
    };
    let resolution = 0;

    await expect(
      runWorksetGitEffectGate({
        expected,
        resolve: async () => {
          resolution += 1;
          return resolution === 1
            ? expected
            : { ...expected, commit: "b".repeat(40) };
        },
        provider,
      }),
    ).rejects.toThrow("trusted Git effect binding changed before launch");

    expect(await git(root, ["branch", "--list", "implement/T1984"])).toBe("");
    expect(provider.activeAdmissionCount()).toBe(0);
    expect(provider.events()).toEqual(["admission-acquired", "admission-abandoned"]);
  });

  test("binds completion and operation identity across trusted merge re-resolution [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const root = await repository();
    const head = await git(root, ["rev-parse", "HEAD"]);
    const provider = createStrictInMemoryWorksetEffectAdmissionProvider();
    const expected: WorksetGitEffectBinding = {
      kind: "merge",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      commit: head,
      completionRef: "cq-implementation-completion:v1:" + "b".repeat(64),
      mergeOperationId: "implement-t1984-merge-r0",
    };
    let resolution = 0;

    await expect(
      runWorksetGitEffectGate({
        expected,
        resolve: async () => {
          resolution += 1;
          return resolution === 1
            ? expected
            : {
                ...expected,
                completionRef: "cq-implementation-completion:v1:" + "c".repeat(64),
              };
        },
        provider,
      }),
    ).rejects.toThrow("trusted Git effect binding changed before launch");

    expect(provider.events()).toEqual(["admission-acquired", "admission-abandoned"]);
  });

  test("serializes every named Git/worktree mutation through registered process groups [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const root = await repository();
    const base = await git(root, ["rev-parse", "HEAD"]);
    const worktreePath = join(root, ".claude", "worktrees", "effect-matrix");
    const branch = "implement/T1984";
    const provider = createStrictInMemoryWorksetEffectAdmissionProvider();
    const run = async (binding: WorksetGitEffectBinding) => {
      const result = await runWorksetGitEffectGate({
        expected: binding,
        resolve: async () => binding,
        provider,
      });
      expect(result.code, `${binding.kind}: ${result.stderr}`).toBe(0);
    };

    await run({
      kind: "branch-create",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      branch,
      commit: base,
    });
    await run({
      kind: "worktree-create",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      worktreePath,
      branch,
      branchCommit: base,
    });
    await Bun.write(join(worktreePath, "feature.txt"), "feature\n");
    await git(worktreePath, ["add", "feature.txt"]);
    await git(worktreePath, ["commit", "--quiet", "-m", "feature"]);
    await Bun.write(join(root, "main.txt"), "main\n");
    await git(root, ["add", "main.txt"]);
    await git(root, ["commit", "--quiet", "-m", "main"]);
    const ontoCommit = await git(root, ["rev-parse", "HEAD"]);
    await run({
      kind: "rebase",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      worktreePath,
      ontoCommit,
    });
    const resultCommit = await git(worktreePath, ["rev-parse", "HEAD"]);
    await run({
      kind: "merge",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      commit: resultCommit,
      completionRef: "cq-implementation-completion:v1:" + "b".repeat(64),
      mergeOperationId: "implement-t1984-merge-r0",
    });
    await run({
      kind: "branch-create",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      reference: "refs/cq-managed-recovery/implement/T1984",
      expectedReferenceCommit: "0".repeat(40),
      commit: resultCommit,
    });
    await run({
      kind: "worktree-remove",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      worktreePath,
      branch,
      headCommit: resultCommit,
    });
    await run({
      kind: "branch-remove",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      branch,
      expectedCommit: resultCommit,
    });

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(resultCommit);
    expect(await git(root, ["rev-parse", "refs/cq-managed-recovery/implement/T1984"])).toBe(
      resultCommit,
    );
    expect(await git(root, ["branch", "--list", branch])).toBe("");
    expect(provider.activeAdmissionCount()).toBe(0);
    expect(provider.events()).toHaveLength(7 * 6);
  });

  test("a failed Git command releases its admission without changing the repository [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const root = await repository();
    const head = await git(root, ["rev-parse", "HEAD"]);
    const branch = "implement/T1984";
    await git(root, ["branch", branch, head]);
    const provider = createStrictInMemoryWorksetEffectAdmissionProvider();
    const binding: WorksetGitEffectBinding = {
      kind: "branch-create",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      branch,
      commit: head,
    };

    const result = await runWorksetGitEffectGate({
      expected: binding,
      resolve: async () => binding,
      provider,
    });

    expect(result.code).not.toBe(0);
    expect(await git(root, ["rev-parse", `refs/heads/${branch}`])).toBe(head);
    expect(provider.activeAdmissionCount()).toBe(0);
    expect(provider.events()).toEqual([
      "admission-acquired",
      "process-group-registered",
      "guardian-shared",
      "process-group-settled",
      "guardian-released",
      "admission-released",
    ]);
  });

  test("cancellation settles the Git hook process group and preserves the pre-rebase tip [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const root = await repository();
    const worktreePath = join(root, ".claude", "worktrees", "cancel-rebase");
    const branch = "implement/T1984";
    await git(root, ["branch", branch, "HEAD"]);
    await git(root, ["worktree", "add", "--quiet", worktreePath, branch]);
    await Bun.write(join(worktreePath, "feature.txt"), "feature\n");
    await git(worktreePath, ["add", "feature.txt"]);
    await git(worktreePath, ["commit", "--quiet", "-m", "feature"]);
    const featureTip = await git(worktreePath, ["rev-parse", "HEAD"]);
    await Bun.write(join(root, "main.txt"), "main\n");
    await git(root, ["add", "main.txt"]);
    await git(root, ["commit", "--quiet", "-m", "main"]);
    const ontoCommit = await git(root, ["rev-parse", "HEAD"]);
    const marker = join(root, "hook-pids");
    const hook = join(root, ".git", "hooks", "pre-rebase");
    await Bun.write(
      hook,
      `#!/bin/sh\ntrap '' TERM\nsleep 30 &\necho "$$ $!" > ${JSON.stringify(marker)}\nwait\n`,
    );
    await chmod(hook, 0o755);
    const provider = createStrictInMemoryWorksetEffectAdmissionProvider();
    const controller = new AbortController();
    const binding: WorksetGitEffectBinding = {
      kind: "rebase",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      worktreePath,
      ontoCommit,
    };
    const effect = runWorksetGitEffectGate({
      expected: binding,
      resolve: async () => binding,
      provider,
      signal: controller.signal,
      settlement: { termGraceMs: 10, killGraceMs: 1_000, pollIntervalMs: 2 },
    });
    for (let attempt = 0; attempt < 1_000 && !(await Bun.file(marker).exists()); attempt += 1) {
      await Bun.sleep(2);
    }
    expect(await Bun.file(marker).exists()).toBe(true);
    const pids = (await readFile(marker, "utf8")).trim().split(" ").map(Number);
    controller.abort(new Error("test cancellation"));
    expect((await effect).code).not.toBe(0);
    for (const pid of pids) {
      for (let attempt = 0; attempt < 1_000 && (await readProcessIdentity(pid)) !== null; attempt += 1) {
        await Bun.sleep(2);
      }
      expect(await readProcessIdentity(pid)).toBeNull();
    }
    expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(featureTip);
    expect(provider.activeAdmissionCount()).toBe(0);
  });

  test("rejects target/path substitution and confines workset credentials from Git hooks [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const root = await repository();
    const base = await git(root, ["rev-parse", "HEAD"]);
    const provider = createStrictInMemoryWorksetEffectAdmissionProvider();
    await expect(
      runWorksetGitEffectGate({
        expected: {
          kind: "worktree-create",
          targetRef: "tasks:T1984",
          repositoryRoot: root,
          worktreePath: join(root, "..", "substituted"),
          branch: "implement/T1984",
          branchCommit: base,
        },
        resolve: async () => ({
          kind: "worktree-create",
          targetRef: "tasks:T1984",
          repositoryRoot: root,
          worktreePath: join(root, "..", "substituted"),
          branch: "implement/T1984",
          branchCommit: base,
        }),
        provider,
      }),
    ).rejects.toThrow("worktree path escapes the repository");
    await expect(
      runWorksetGitEffectGate({
        expected: {
          kind: "branch-create",
          targetRef: "tasks:T1984",
          repositoryRoot: root,
          branch: "implement/T9999",
          commit: base,
        },
        resolve: async () => ({
          kind: "branch-create",
          targetRef: "tasks:T1984",
          repositoryRoot: root,
          branch: "implement/T9999",
          commit: base,
        }),
        provider,
      }),
    ).rejects.toThrow("branch does not match its task target");

    const worktreePath = join(root, ".claude", "worktrees", "credential-rebase");
    await git(root, ["branch", "implement/T1984", base]);
    await git(root, ["worktree", "add", "--quiet", worktreePath, "implement/T1984"]);
    await Bun.write(join(worktreePath, "feature.txt"), "feature\n");
    await git(worktreePath, ["add", "feature.txt"]);
    await git(worktreePath, ["commit", "--quiet", "-m", "feature"]);
    await Bun.write(join(root, "main.txt"), "main\n");
    await git(root, ["add", "main.txt"]);
    await git(root, ["commit", "--quiet", "-m", "main"]);
    const ontoCommit = await git(root, ["rev-parse", "HEAD"]);
    const marker = join(root, "credential-probe");
    const hook = join(root, ".git", "hooks", "pre-rebase");
    await Bun.write(
      hook,
      "#!/bin/sh\nprintf '%s|%s|%s' \"${CQ_SERVE_TOKEN-unset}\" \"${CQ_SERVE_MANAGEMENT_TOKEN-unset}\" \"${CQ_LEDGER_REMOTE_TOKEN-unset}\" > " +
        JSON.stringify(marker) +
        "\n",
    );
    await chmod(hook, 0o755);
    const binding: WorksetGitEffectBinding = {
      kind: "rebase",
      targetRef: "tasks:T1984",
      repositoryRoot: root,
      worktreePath,
      ontoCommit,
    };
    expect(
      (
        await runWorksetGitEffectGate({
          expected: binding,
          resolve: async () => binding,
          provider,
          environment: {
            CQ_SERVE_TOKEN: "serve-secret",
            CQ_SERVE_MANAGEMENT_TOKEN: "management-secret",
            CQ_LEDGER_REMOTE_TOKEN: "remote-secret",
          },
        })
      ).code,
    ).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("unset|unset|unset");
  });
});
