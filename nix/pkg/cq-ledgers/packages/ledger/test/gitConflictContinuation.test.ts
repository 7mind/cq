/**
 * T2043 / D307 — durable manager-bound conflict continuation.
 *
 * Behavioral-Active Effectual-GoodCommunication tests against disposable real
 * Git repositories. Regression origin: a workspace-write resolver cannot
 * update a linked-worktree index without receiving repository-wide authority.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  continueManagedWorktreeRebase,
  gitRebaseConflictStateDigest,
  observeManagedRebaseConflict,
  prepareManagedWorktree,
  resolveManagedWorktreeDispatchBinding,
  validateGitConflictContinuationResultEvidence,
  type DispatchBoundGitAuthorization,
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
      GIT_AUTHOR_NAME: "T2043",
      GIT_AUTHOR_EMAIL: "t2043@example.invalid",
      GIT_COMMITTER_NAME: "T2043",
      GIT_COMMITTER_EMAIL: "t2043@example.invalid",
    },
  });
  return stdout.trim();
}

async function waitForPath(file: string, child: ReturnType<typeof spawn>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await fs.lstat(file);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("continuation child exited before reaching its process barrier");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("continuation child did not reach its process barrier");
}

function digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function seed(): Promise<{
  stateDir: string;
  worktreePath: string;
  authorization: DispatchBoundGitAuthorization;
}> {
  const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), "t2043-continuation-"));
  roots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "-q", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.name", "T2043"]);
  await git(repositoryRoot, ["config", "user.email", "t2043@example.invalid"]);
  await git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(repositoryRoot, "bun.lock"), "{}\n");
  await fs.writeFile(path.join(repositoryRoot, "a.txt"), "base a\n");
  await fs.writeFile(path.join(repositoryRoot, "b.txt"), "base b\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  const base = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const stateDir = path.join(repositoryRoot, ".broker-state");
  const prepared = await prepareManagedWorktree(
    { repositoryRoot, taskId: "T2043", baseCommit: base },
    { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
  );
  if (prepared.status !== "prepared") throw new Error(`prepare returned ${prepared.status}`);
  const binding = await resolveManagedWorktreeDispatchBinding(
    {
      repositoryRoot,
      taskId: "T2043",
      worktreePath: prepared.handle.absolutePath,
      branch: prepared.handle.branch,
    },
    { stateDir },
  );
  if (binding === null) throw new Error("managed dispatch binding did not resolve");

  await fs.writeFile(path.join(prepared.handle.absolutePath, "a.txt"), "task a\n");
  await git(prepared.handle.absolutePath, ["add", "a.txt"]);
  await git(prepared.handle.absolutePath, ["commit", "-q", "-m", "task a"]);
  await fs.writeFile(path.join(prepared.handle.absolutePath, "b.txt"), "task b\n");
  await git(prepared.handle.absolutePath, ["add", "b.txt"]);
  await git(prepared.handle.absolutePath, ["commit", "-q", "-m", "task b"]);

  await fs.writeFile(path.join(repositoryRoot, "a.txt"), "base changed a\n");
  await fs.writeFile(path.join(repositoryRoot, "b.txt"), "base changed b\n");
  await git(repositoryRoot, ["add", "a.txt", "b.txt"]);
  await git(repositoryRoot, ["commit", "-q", "-m", "base changes"]);
  const onto = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const rebase = Bun.spawnSync(["git", "rebase", onto], {
    cwd: prepared.handle.absolutePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (rebase.exitCode === 0) throw new Error("seeded rebase did not conflict");

  return {
    stateDir,
    worktreePath: prepared.handle.absolutePath,
    authorization: {
      ...binding,
      attestationId: "cq_attest_BBBBBBBBBBBBBBBBBBBBBB",
      generation: 1,
      roleId: "implement-conflict-resolver",
      surface: "codex",
      childCancelAt: "2099-01-01T00:00:00.000Z",
    },
  };
}

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("continueManagedWorktreeRebase", () => {
  test("continues one marker-free resolution at a time and durably replays each receipt", async () => {
    const fixture = await seed();
    const authorize = async () => {};
    const firstState = await observeManagedRebaseConflict(fixture.authorization, {
      stateDir: fixture.stateDir,
    });
    const authorization = {
      ...fixture.authorization,
      conflictStateDigest: gitRebaseConflictStateDigest(firstState),
    };
    await fs.writeFile(path.join(fixture.worktreePath, "a.txt"), "base changed a + task a\n");
    const firstRequest = {
      authorization,
      operationId: "T2043-resolution-1",
      expectedState: firstState,
      resolutions: [
        {
          kind: "regular" as const,
          path: "a.txt",
          newState: { mode: "100644" as const, digest: digest("base changed a + task a\n") },
        },
      ],
    };
    const first = await continueManagedWorktreeRebase(firstRequest, {
      stateDir: fixture.stateDir,
      authorize,
    });
    expect(first.outcome.kind).toBe("conflict");
    if (first.outcome.kind !== "conflict") throw new Error("expected second conflict");
    expect(first.paths).toEqual(["a.txt"]);
    expect(await continueManagedWorktreeRebase(firstRequest, {
      stateDir: fixture.stateDir,
      authorize,
    })).toEqual(first);

    await fs.writeFile(path.join(fixture.worktreePath, "b.txt"), "base changed b + task b\n");
    const second = await continueManagedWorktreeRebase(
      {
        authorization,
        operationId: "T2043-resolution-2",
        expectedState: first.outcome.state,
        resolutions: [
          {
            kind: "regular",
            path: "b.txt",
            newState: {
              mode: "100644",
              digest: digest("base changed b + task b\n"),
            },
          },
        ],
      },
      { stateDir: fixture.stateDir, authorize },
    );
    expect(second.outcome).toEqual({ kind: "terminal", tip: second.newHead });
    expect(await git(fixture.worktreePath, ["status", "--porcelain"])).toBe("");
    expect(await git(fixture.worktreePath, ["show", "HEAD:a.txt"])).toBe(
      "base changed a + task a",
    );
    expect(await git(fixture.worktreePath, ["show", "HEAD:b.txt"])).toBe(
      "base changed b + task b",
    );
    for (const oid of [...first.objectOids, ...second.objectOids]) {
      expect(await git(fixture.worktreePath, ["cat-file", "-e", oid]).then(() => true)).toBe(true);
    }
    await expect(
      validateGitConflictContinuationResultEvidence(
        authorization,
        {
          taskId: "T2043",
          resultCommit: second.newHead,
          branch: authorization.branch,
          actualWorktreePath: fixture.worktreePath,
          filesResolved: ["a.txt", "b.txt"],
          conflictReceipts: [first, second],
        },
        { stateDir: fixture.stateDir },
      ),
    ).resolves.toBeUndefined();
  });

  test("recovers after the broker process dies after Git advances but before journaling completion", async () => {
    const fixture = await seed();
    const firstState = await observeManagedRebaseConflict(fixture.authorization, {
      stateDir: fixture.stateDir,
    });
    const authorization = {
      ...fixture.authorization,
      conflictStateDigest: gitRebaseConflictStateDigest(firstState),
    };
    await fs.writeFile(path.join(fixture.worktreePath, "a.txt"), "base changed a + task a\n");
    const request = {
      authorization,
      operationId: "T2043-process-crash",
      expectedState: firstState,
      resolutions: [
        {
          kind: "regular" as const,
          path: "a.txt",
          newState: { mode: "100644" as const, digest: digest("base changed a + task a\n") },
        },
      ],
    };

    const barrier = path.join(fixture.stateDir, "git-finished-process-barrier");
    const bin = path.join(fixture.stateDir, "bin");
    await fs.mkdir(bin, { recursive: true });
    const actualGit = (await exec("which", ["git"], { encoding: "utf8" })).stdout.trim();
    const wrapper = path.join(bin, "git");
    await fs.writeFile(
      wrapper,
      `#!/bin/sh\ncase " $* " in\n  *" rebase --continue "*)\n    "${actualGit}" "$@"\n    code=$?\n    : > "$CQ_TEST_BARRIER"\n    parent=$PPID\n    while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done\n    exit "$code"\n    ;;\nesac\nexec "${actualGit}" "$@"\n`,
    );
    await fs.chmod(wrapper, 0o755);
    const requestFile = path.join(fixture.stateDir, "request.json");
    await fs.writeFile(requestFile, JSON.stringify({ request, stateDir: fixture.stateDir }));
    const childScript = path.join(fixture.stateDir, "continue-child.ts");
    const ledgerEntry = pathToFileURL(path.resolve(import.meta.dir, "../src/index.ts")).href;
    await fs.writeFile(
      childScript,
      `import { readFile } from "node:fs/promises";\nimport { continueManagedWorktreeRebase } from ${JSON.stringify(ledgerEntry)};\nconst payload = JSON.parse(await readFile(process.argv[2], "utf8"));\nawait continueManagedWorktreeRebase(payload.request, { stateDir: payload.stateDir, authorize: async () => {} });\n`,
    );
    const systemPath = process.env.PATH;
    if (systemPath === undefined) throw new Error("PATH is required for the process-boundary test");
    const child = spawn(process.execPath, [childScript, requestFile], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        PATH: `${bin}:${systemPath}`,
        CQ_TEST_BARRIER: barrier,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForPath(barrier, child);
    child.kill("SIGKILL");
    await once(child, "exit");

    const operationEntries = await fs.readdir(
      path.join(fixture.stateDir, "git-conflict-broker"),
      { withFileTypes: true },
    );
    expect(operationEntries.filter((entry) => entry.isDirectory())).toHaveLength(1);
    const journal = JSON.parse(
      await fs.readFile(
        path.join(
          fixture.stateDir,
          "git-conflict-broker",
          operationEntries[0]!.name,
          "journal.json",
        ),
        "utf8",
      ),
    ) as { readonly state: string };
    expect(journal.state).toBe("prepared");

    const recovered = await continueManagedWorktreeRebase(request, {
      stateDir: fixture.stateDir,
      authorize: async () => {},
    });
    expect(recovered.outcome.kind).toBe("conflict");
    expect(
      await continueManagedWorktreeRebase(request, {
        stateDir: fixture.stateDir,
        authorize: async () => {},
      }),
    ).toEqual(recovered);
  });

  test("isolates hooks, signing, and editors, then rejects configured filters before advancing", async () => {
    const fixture = await seed();
    const state = await observeManagedRebaseConflict(fixture.authorization, {
      stateDir: fixture.stateDir,
    });
    const authorization = {
      ...fixture.authorization,
      conflictStateDigest: gitRebaseConflictStateDigest(state),
    };
    const sentinel = path.join(fixture.stateDir, "external-program-ran");
    const external = path.join(fixture.stateDir, "external-program");
    await fs.writeFile(external, `#!/bin/sh\n: > "${sentinel}"\nexit 73\n`);
    await fs.chmod(external, 0o755);
    const hooks = path.join(authorization.commonDir, "hooks");
    await fs.mkdir(hooks, { recursive: true });
    await fs.writeFile(path.join(hooks, "pre-commit"), `#!/bin/sh\nexec "${external}"\n`);
    await fs.chmod(path.join(hooks, "pre-commit"), 0o755);
    await git(fixture.worktreePath, ["config", "commit.gpgsign", "true"]);
    await git(fixture.worktreePath, ["config", "gpg.program", external]);
    await git(fixture.worktreePath, ["config", "core.editor", external]);
    await git(fixture.worktreePath, ["config", "sequence.editor", external]);
    await fs.writeFile(path.join(fixture.worktreePath, "a.txt"), "base changed a + task a\n");
    const first = await continueManagedWorktreeRebase(
      {
        authorization,
        operationId: "T2043-hermetic-programs",
        expectedState: state,
        resolutions: [
          {
            kind: "regular",
            path: "a.txt",
            newState: { mode: "100644", digest: digest("base changed a + task a\n") },
          },
        ],
      },
      { stateDir: fixture.stateDir, authorize: async () => {} },
    );
    expect(first.outcome.kind).toBe("conflict");
    await expect(fs.lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    if (first.outcome.kind !== "conflict") throw new Error("expected second conflict");

    await git(fixture.worktreePath, ["config", "filter.external.clean", external]);
    await fs.writeFile(path.join(fixture.worktreePath, "b.txt"), "base changed b + task b\n");
    await expect(
      continueManagedWorktreeRebase(
        {
          authorization,
          operationId: "T2043-reject-filter",
          expectedState: first.outcome.state,
          resolutions: [
            {
              kind: "regular",
              path: "b.txt",
              newState: { mode: "100644", digest: digest("base changed b + task b\n") },
            },
          ],
        },
        { stateDir: fixture.stateDir, authorize: async () => {} },
      ),
    ).rejects.toThrow(/filter/i);
    await expect(fs.lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects replace refs and exec sequencer lines before advancing", async () => {
    for (const mechanism of ["replace-ref", "exec-line"] as const) {
      const fixture = await seed();
      if (mechanism === "replace-ref") {
        const head = await git(fixture.worktreePath, ["rev-parse", "HEAD"]);
        const original = await git(fixture.worktreePath, ["rev-parse", "ORIG_HEAD"]);
        await git(fixture.worktreePath, ["update-ref", `refs/replace/${head}`, original]);
      } else {
        const gitDir = await git(fixture.worktreePath, [
          "rev-parse",
          "--path-format=absolute",
          "--absolute-git-dir",
        ]);
        await fs.appendFile(path.join(gitDir, "rebase-merge", "git-rebase-todo"), "exec false\n");
      }
      const state = await observeManagedRebaseConflict(fixture.authorization, {
        stateDir: fixture.stateDir,
      });
      const authorization = {
        ...fixture.authorization,
        conflictStateDigest: gitRebaseConflictStateDigest(state),
      };
      const oldHead = state.currentHead;
      await fs.writeFile(path.join(fixture.worktreePath, "a.txt"), "resolved\n");
      await expect(
        continueManagedWorktreeRebase(
          {
            authorization,
            operationId: `T2043-reject-${mechanism}`,
            expectedState: state,
            resolutions: [
              {
                kind: "regular",
                path: "a.txt",
                newState: { mode: "100644", digest: digest("resolved\n") },
              },
            ],
          },
          { stateDir: fixture.stateDir, authorize: async () => {} },
        ),
      ).rejects.toThrow(mechanism === "replace-ref" ? /replace ref/i : /todo command/i);
      expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(oldHead);
    }
  });

  test("rejects a substituted parent observation before advancing the rebase", async () => {
    const fixture = await seed();
    const state = await observeManagedRebaseConflict(fixture.authorization, {
      stateDir: fixture.stateDir,
    });
    const authorization = {
      ...fixture.authorization,
      conflictStateDigest: gitRebaseConflictStateDigest(state),
    };
    const headBefore = await git(fixture.worktreePath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(fixture.worktreePath, "a.txt"), "resolved\n");
    await expect(
      continueManagedWorktreeRebase(
        {
          authorization,
          operationId: "T2043-substituted-state",
          expectedState: { ...state, currentHead: "a".repeat(40) },
          resolutions: [
            {
              kind: "regular",
              path: "a.txt",
              newState: { mode: "100644", digest: digest("resolved\n") },
            },
          ],
        },
        { stateDir: fixture.stateDir, authorize: async () => {} },
      ),
    ).rejects.toThrow(/state|HEAD|transaction/i);
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(fixture.worktreePath, ["diff", "--name-only", "--diff-filter=U"])).toBe(
      "a.txt",
    );
  });

  test("binds every parent-observed rebase and conflict-stage coordinate", async () => {
    const fixture = await seed();
    const state = await observeManagedRebaseConflict(fixture.authorization, {
      stateDir: fixture.stateDir,
    });
    const authorization = {
      ...fixture.authorization,
      conflictStateDigest: gitRebaseConflictStateDigest(state),
    };
    await fs.writeFile(path.join(fixture.worktreePath, "a.txt"), "resolved\n");
    const substitutions: readonly [string, (candidate: typeof state) => void][] = [
      ["base", (candidate) => Object.assign(candidate, { baseCommit: "a".repeat(40) })],
      ["head", (candidate) => Object.assign(candidate, { currentHead: "a".repeat(40) })],
      ["ancestry", (candidate) => Object.assign(candidate.expectedAncestry[0]!, { descendant: "a".repeat(40) })],
      ["sequencer-identity", (candidate) => Object.assign(candidate.sequencer, { identity: "a".repeat(64) })],
      ["head-name", (candidate) => Object.assign(candidate.sequencer, { headName: "refs/heads/main" })],
      ["original-tip", (candidate) => Object.assign(candidate.sequencer, { originalTip: "a".repeat(40) })],
      ["onto", (candidate) => Object.assign(candidate.sequencer, { onto: "a".repeat(40) })],
      ["stopped", (candidate) => Object.assign(candidate.sequencer, { stoppedCommit: "a".repeat(40) })],
      ["command", (candidate) => Object.assign(candidate.sequencer, { currentCommand: "exec false" })],
      ["todo", (candidate) => Object.assign(candidate.sequencer, { todoDigest: "a".repeat(64) })],
      ["done", (candidate) => Object.assign(candidate.sequencer, { doneDigest: "a".repeat(64) })],
      ["stage-oid", (candidate) => Object.assign(candidate.conflicts[0]!, { oid: "a".repeat(40) })],
      ["stage-mode", (candidate) => Object.assign(candidate.conflicts[0]!, { mode: "120000" })],
    ];
    const headBefore = await git(fixture.worktreePath, ["rev-parse", "HEAD"]);
    for (const [label, mutate] of substitutions) {
      const candidate = structuredClone(state);
      mutate(candidate);
      await expect(
        continueManagedWorktreeRebase(
          {
            authorization,
            operationId: `T2043-substitute-${label}`,
            expectedState: candidate,
            resolutions: [
              {
                kind: "regular",
                path: "a.txt",
                newState: { mode: "100644", digest: digest("resolved\n") },
              },
            ],
          },
          { stateDir: fixture.stateDir, authorize: async () => {} },
        ),
        label,
      ).rejects.toThrow();
      expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"]), label).toBe(headBefore);
    }
  });
});
