/**
 * D336 — terminal release loses its task admission after the task becomes done.
 *
 * Progression-Effectual-GoodCommunication: a production-selected XDG SQLite
 * store, a real Git repository, and a linked MCP client exercise the complete
 * managed-worktree lifecycle without a network dependency.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createLedgerStore,
  createWorktreeManageCapability,
  GOALS_LEDGER,
  listManagedLiveWorktrees,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  type ManagedWorktreeHandle,
} from "@cq/ledger";
import { createManagementLedgerMcpServer } from "../src/main.js";

const exec = promisify(execFile);
const roots: string[] = [];
const TASK_ID = "T336";
const GOAL_ID = "G336";

interface ReleaseEvidence {
  readonly worktreePresent: boolean;
  readonly branchUnchanged: boolean;
  readonly registryUnchanged: boolean;
}

interface ToolResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

interface ReleaseState {
  readonly worktreePresent: boolean;
  readonly branchCommit: string | null;
  readonly registry: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "D336",
      GIT_AUTHOR_EMAIL: "d336@example.invalid",
      GIT_COMMITTER_NAME: "D336",
      GIT_COMMITTER_EMAIL: "d336@example.invalid",
    },
  });
  return stdout.trim();
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("");
}

function decode<T>(result: ToolResult): T {
  expect(result.isError ?? false, textOf(result)).toBe(false);
  return JSON.parse(textOf(result)) as T;
}

function releaseEvidenceRemains(evidence: ReleaseEvidence): boolean {
  return evidence.worktreePresent && evidence.branchUnchanged && evidence.registryUnchanged;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "d336-worktree-release-"));
  roots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "d336@example.invalid"]);
  await git(root, ["config", "user.name", "D336"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(
    path.join(root, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "d336-${crypto.randomUUID()}"\n`,
  );
  await writeFile(path.join(root, ".gitignore"), ".claude/worktrees/\nnode_modules/\n");
  await writeFile(path.join(root, "README.md"), "D336 seed\n");
  const workspace = path.join(root, "nix", "pkg", "cq-ledgers");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "d336-workspace", private: true, workspaces: [] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(workspace, "bun.lock"),
    '{\n  "lockfileVersion": 1,\n  "configVersion": 1,\n  "workspaces": {\n    "": { "name": "d336-workspace", "private": true }\n  }\n}\n',
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "seed"]);
  return root;
}

async function withClient(
  repositoryRoot: string,
  run: (
    client: Client,
    store: Awaited<ReturnType<typeof createLedgerStore>>["store"],
  ) => Promise<void>,
): Promise<void> {
  const resolved = await createLedgerStore(repositoryRoot);
  const server = createManagementLedgerMcpServer({
    store: resolved.store,
    displayName: "D336 XDG fixture",
    configRoot: resolved.configRoot,
    ...(resolved.projectKey === undefined ? {} : { projectKey: resolved.projectKey }),
    repositoryRoot,
    worktreeManage: createWorktreeManageCapability(repositoryRoot, { deps: { skipInstall: true } }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "d336-xdg-client", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    expect(resolved.backend).toBe("xdg");
    expect(resolved.dbPath).toContain(process.env["XDG_STATE_HOME"]!);
    await run(client, resolved.store);
  } finally {
    await client.close();
    await server.close();
    await resolved.store.dispose();
  }
}

async function releaseState(
  repositoryRoot: string,
  handle: ManagedWorktreeHandle,
): Promise<ReleaseState> {
  const registryPath = path.join(
    repositoryRoot,
    ".claude",
    "worktrees",
    ".cq-managed-registry",
    "tasks",
    handle.taskId,
    "current.json",
  );
  return {
    worktreePresent: await stat(handle.absolutePath)
      .then((entry) => entry.isDirectory())
      .catch(() => false),
    branchCommit: await git(repositoryRoot, ["rev-parse", `refs/heads/${handle.branch}`]).catch(
      () => null,
    ),
    registry: await readFile(registryPath, "utf8"),
  };
}

async function seedLedger(repositoryRoot: string): Promise<string> {
  const resolved = await createLedgerStore(repositoryRoot);
  try {
    const milestone = await resolved.store.createMilestone({ title: "D336 terminal release" });
    await resolved.store.createItem(TASKS_LEDGER, milestone.id, {
      id: TASK_ID,
      status: "planned",
      fields: { headline: "Release managed D336 task" },
    });
    await resolved.store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: GOAL_ID,
      status: "clarifying",
      fields: { title: "D336 restrictive root", description: "keeps the workset nonempty" },
    });
    return milestone.id;
  } finally {
    await resolved.store.dispose();
  }
}

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("D336 production XDG terminal worktree release", () => {
  test("rejects incomplete terminal release evidence", () => {
    expect(
      releaseEvidenceRemains({
        worktreePresent: false,
        branchUnchanged: true,
        registryUnchanged: true,
      }),
    ).toBe(false);
    expect(
      releaseEvidenceRemains({
        worktreePresent: true,
        branchUnchanged: false,
        registryUnchanged: true,
      }),
    ).toBe(false);
    expect(
      releaseEvidenceRemains({
        worktreePresent: true,
        branchUnchanged: true,
        registryUnchanged: false,
      }),
    ).toBe(false);
  });

  test("releases a merged terminal task while restrictive roots remain stable", async () => {
    const previousStateHome = process.env["XDG_STATE_HOME"];
    const stateHome = await mkdtemp(path.join(tmpdir(), "d336-xdg-state-"));
    roots.push(stateHome);
    process.env["XDG_STATE_HOME"] = stateHome;
    try {
      const repositoryRoot = await repository();
      const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      const milestoneId = await seedLedger(repositoryRoot);
      await withClient(repositoryRoot, async (client, store) => {
        decode<{ acknowledgement: { roots: string[] } }>(
          (await client.callTool({
            name: "workset",
            arguments: { op: "set", roots: [`milestones:${milestoneId}`, `goals:${GOAL_ID}`] },
          })) as ToolResult,
        );
        const prepared = decode<{ status: string; handle: ManagedWorktreeHandle }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: { operation: "prepare", taskId: TASK_ID, baseCommit },
          })) as ToolResult,
        );
        expect(prepared.status, JSON.stringify(prepared)).toBe("prepared");
        await writeFile(
          path.join(prepared.handle.absolutePath, "RESULT-T336.md"),
          "merged result\n",
        );
        await git(prepared.handle.absolutePath, ["add", "RESULT-T336.md"]);
        await git(prepared.handle.absolutePath, ["commit", "-q", "-m", "D336 result"]);
        const resultCommit = await git(prepared.handle.absolutePath, ["rev-parse", "HEAD"]);
        await git(repositoryRoot, [
          "merge",
          "--no-ff",
          "--no-gpg-sign",
          prepared.handle.branch,
          "-m",
          "merge D336",
        ]);

        const updated = decode<{ item: { status: string } }>(
          (await client.callTool({
            name: "update_item",
            arguments: { ledger_id: "tasks", item_id: TASK_ID, status: "done" },
          })) as ToolResult,
        );
        expect(updated.item.status).toBe("done");

        const rootsBefore = await store.worksetStore!().snapshot();
        await expect(
          store.worksetStore!().admitExternalEffect({
            kind: "worktree-remove",
            targetRef: `tasks:${TASK_ID}`,
          }),
        ).rejects.toMatchObject({ code: "target-excluded" });

        const released = decode<{
          status: string;
          handle: ManagedWorktreeHandle;
          idempotent: boolean;
          absolutePath: string;
        }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: {
              operation: "release",
              handle: prepared.handle,
              terminalDisposition: "done",
              resultCommit,
            },
          })) as ToolResult,
        );
        expect(released).toEqual({
          status: "released",
          handle: prepared.handle,
          idempotent: false,
          absolutePath: prepared.handle.absolutePath,
        });
        expect(
          await stat(prepared.handle.absolutePath)
            .then(() => true)
            .catch(() => false),
        ).toBe(false);
        expect(
          await git(repositoryRoot, ["rev-parse", `refs/heads/${prepared.handle.branch}`]).catch(
            () => null,
          ),
        ).toBeNull();
        expect(
          await git(repositoryRoot, [
            "rev-parse",
            `refs/cq-managed-recovery/${prepared.handle.branch}`,
          ]),
        ).toBe(resultCommit);
        expect(await listManagedLiveWorktrees(repositoryRoot, TASK_ID)).toEqual([]);
        expect(await store.worksetStore!().snapshot()).toEqual(rootsBefore);
      });
    } finally {
      if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previousStateHome;
    }
  });

  test("denies nonterminal, mismatched, and substituted release bindings without mutation", async () => {
    const previousStateHome = process.env["XDG_STATE_HOME"];
    const stateHome = await mkdtemp(path.join(tmpdir(), "d336-xdg-denial-state-"));
    roots.push(stateHome);
    process.env["XDG_STATE_HOME"] = stateHome;
    try {
      const repositoryRoot = await repository();
      const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      const milestoneId = await seedLedger(repositoryRoot);
      await withClient(repositoryRoot, async (client) => {
        decode(
          (await client.callTool({
            name: "workset",
            arguments: { op: "set", roots: [`milestones:${milestoneId}`, `goals:${GOAL_ID}`] },
          })) as ToolResult,
        );
        const prepared = decode<{ status: string; handle: ManagedWorktreeHandle }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: { operation: "prepare", taskId: TASK_ID, baseCommit },
          })) as ToolResult,
        );
        expect(prepared.status).toBe("prepared");
        const initial = await releaseState(repositoryRoot, prepared.handle);

        const nonterminal = (await client.callTool({
          name: "worktree_manage",
          arguments: {
            operation: "release",
            handle: prepared.handle,
            terminalDisposition: "done",
          },
        })) as ToolResult;
        expect(nonterminal.isError, textOf(nonterminal)).toBe(true);
        expect(await releaseState(repositoryRoot, prepared.handle)).toEqual(initial);

        decode(
          (await client.callTool({
            name: "update_item",
            arguments: { ledger_id: "tasks", item_id: TASK_ID, status: "done" },
          })) as ToolResult,
        );

        const substitutedAttempts: readonly {
          readonly handle: ManagedWorktreeHandle;
        }[] = [
          { handle: { ...prepared.handle, token: "substituted-token" } },
          {
            handle: { ...prepared.handle, nonce: "substituted-fingerprint-material" },
          },
          {
            handle: {
              ...prepared.handle,
              repositoryRoot: `${repositoryRoot}-foreign`,
              absolutePath: `${repositoryRoot}-foreign/.claude/worktrees/${prepared.handle.worktreeId}`,
            },
          },
          {
            handle: {
              ...prepared.handle,
              worktreeId: "019f2c7a-6b21-7c44-9e10-7a3f5d9b2e09",
              absolutePath: `${repositoryRoot}/.claude/worktrees/019f2c7a-6b21-7c44-9e10-7a3f5d9b2e09`,
            },
          },
          {
            handle: { ...prepared.handle, taskId: "T337", branch: "implement/T337" },
          },
        ];
        for (const attempt of substitutedAttempts) {
          const denied = (await client.callTool({
            name: "worktree_manage",
            arguments: {
              operation: "release",
              handle: attempt.handle,
              terminalDisposition: "done",
            },
          })) as ToolResult;
          expect(denied.isError, textOf(denied)).toBe(true);
          expect(await releaseState(repositoryRoot, prepared.handle)).toEqual(initial);
        }

        const mismatch = (await client.callTool({
          name: "worktree_manage",
          arguments: {
            operation: "release",
            handle: prepared.handle,
            terminalDisposition: "abandoned",
          },
        })) as ToolResult;
        expect(mismatch.isError, textOf(mismatch)).toBe(true);
        expect(await releaseState(repositoryRoot, prepared.handle)).toEqual(initial);
      });
    } finally {
      if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previousStateHome;
    }
  });
});
