/**
 * T1306 — `worktree_manage` MCP capability.
 *
 * Classification: Behavioral-Active Blackbox-GoodCommunication. Every
 * assertion goes through a real tool invocation (direct `tool()` handler or a
 * linked-pair stdio `McpServer`), never a direct `prepareManagedWorktree` call.
 *
 * Covered:
 *  - schema rejects mixed prepare/observe/release fields, unknown fields, invalid
 *    UUID/commit/handle values, and caller-supplied dependency evidence;
 *  - both transports exercise fresh prepare, exact conflict observation,
 *    resume-required, resume-by-handle,
 *    typed base/dependency refusal, guarded release refusal, and idempotent
 *    release with identical normalised acknowledgements;
 *  - neither transport exposes filesystem mutation primitives individually.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serializeWipArtifact } from "@cq/config";
import {
  acknowledgeOperatorAction,
  completeOperatorActionTask,
  createLedgerMcpTools,
  createWorktreeManageCapability,
  GOALS_LEDGER,
  InMemoryLedgerStore,
  isUuidV7,
  LEDGER_TOOL_NAMES,
  listManagedLiveWorktrees,
  materializeOperatorAction,
  parseWorktreeManageInput,
  recordOperatorActionEvidence,
  registerLedgerStdioTools,
  TASKS_LEDGER,
  WORKTREE_MANAGE_TOOL_SPEC,
  type LedgerStore,
  type LedgerToolName,
  type ManagedWorktreeHandle,
  type ManagedWorktreeInstallPlan,
  type ManagedWorktreeInstallRunner,
  type WorktreeManageCapability,
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
      GIT_AUTHOR_NAME: "T1306",
      GIT_AUTHOR_EMAIL: "t1306@example.invalid",
      GIT_COMMITTER_NAME: "T1306",
      GIT_COMMITTER_EMAIL: "t1306@example.invalid",
    },
  });
  return stdout.trim();
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
      await fs.writeFile(path.join(plan.cwd, "node_modules", ".t1306"), "ok\n");
      return { code: 0, stdout: "install-ok\n", stderr: "" };
    },
  };
}

async function seedRepository(): Promise<{
  cwd: string;
  base: string;
  stateDir: string;
  cacheRoot: string;
}> {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "t1306-wt-mcp-"));
  repositories.push(cwd);
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "t1306@example.invalid"]);
  await git(cwd, ["config", "user.name", "T1306"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);

  const workspace = path.join(cwd, "nix", "pkg", "cq-ledgers");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "t1306-workspace", private: true, workspaces: [] }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(workspace, "bun.lock"), "{}\n");
  await fs.writeFile(
    path.join(cwd, ".gitignore"),
    "node_modules/\n.test-cache/\n.test-managed-state/\n",
  );
  await fs.writeFile(path.join(cwd, "README.md"), "t1306 seed\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-q", "-m", "seed"]);
  const base = await git(cwd, ["rev-parse", "HEAD"]);
  const stateDir = path.join(cwd, ".test-managed-state");
  const cacheRoot = path.join(cwd, ".test-cache");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(cacheRoot, { recursive: true });
  return { cwd, base, stateDir, cacheRoot };
}

async function buildStore(options?: {
  readonly rootTaskId?: string;
  readonly dependency?: {
    readonly taskId: string;
    readonly status: string;
    readonly resultCommit: string | null;
  };
}): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  const milestone = await store.createMilestone({ title: "T1306 managed worktree" });
  if (options?.dependency !== undefined) {
    await store.createItem(TASKS_LEDGER, milestone.id, {
      id: options.dependency.taskId,
      status: options.dependency.status,
      fields: {
        headline: "dependency",
        ...(options.dependency.resultCommit === null
          ? {}
          : { resultCommit: options.dependency.resultCommit }),
      },
    });
  }
  await store.createItem(TASKS_LEDGER, milestone.id, {
    id: options?.rootTaskId ?? "T1306",
    status: "planned",
    fields: {
      headline: "root",
      ...(options?.dependency === undefined
        ? {}
        : { dependsOn: [`tasks:${options.dependency.taskId}`] }),
    },
  });
  return store;
}

async function buildCompletedOperatorActionStore(baseCommit: string): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  const milestone = await store.createMilestone({ title: "T2192 operator action dependency" });
  const goal = await store.createItem(GOALS_LEDGER, milestone.id, {
    status: "planned",
    fields: { title: "deploy", description: "deploy" },
  });
  await store.createItem(TASKS_LEDGER, milestone.id, {
    id: "T2191",
    status: "done",
    fields: { headline: "Git-producing ancestor", resultCommit: baseCommit },
  });
  await store.createItem(TASKS_LEDGER, milestone.id, {
    id: "T2192",
    status: "planned",
    fields: {
      headline: "Verified operator action",
      description: "CQ-OPERATOR-ACTION v1 deploy-t2192. Deploy the verified external effect.",
      dependsOn: ["tasks:T2191"],
      ledgerRefs: [`goals:${goal.id}`],
    },
  });
  await store.createItem(TASKS_LEDGER, milestone.id, {
    id: "T2217",
    status: "planned",
    fields: { headline: "root", dependsOn: ["tasks:T2192"] },
  });

  const outputIdentity = "/nix/store/t2192-deployed-output";
  const command = "probe-t2192-deployment";
  const materialized = await materializeOperatorAction(store, {
    taskId: "T2192",
    expectedOutputIdentity: outputIdentity,
    expectedEvidence: [command],
    author: "parent",
  });
  await acknowledgeOperatorAction(store, {
    actionId: materialized.action.id,
    expectedRevision: 1,
    outputIdentity,
    acknowledgedAt: "2026-08-18T00:00:00.000Z",
  });
  await recordOperatorActionEvidence(
    store,
    materialized.action.id,
    1,
    {
      command,
      stdout: "deployed\n",
      stderr: "",
      exitCode: 0,
      outputIdentity,
      observedAt: "2026-08-18T00:01:00.000Z",
    },
    { author: "parent" },
  );
  await completeOperatorActionTask(store, materialized.action.id, 1, "verified", {
    author: "parent",
  });
  return store;
}

type ToolArgs = Record<string, unknown>;
type Outcome =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly message: string };

interface TextToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

type DirectTools = ReturnType<typeof createLedgerMcpTools>;

async function invokeDirect(
  tools: DirectTools,
  name: LedgerToolName,
  args: ToolArgs,
): Promise<Outcome> {
  const target = tools.find((candidate) => candidate.name === name);
  if (target === undefined) throw new Error(`direct tool not found: ${name}`);
  const parsed = z.object(target.inputSchema as Record<string, z.ZodType>).safeParse(args);
  if (!parsed.success) return { ok: false, message: parsed.error.message };
  try {
    const result = (await target.handler(parsed.data as never, null)) as TextToolResult;
    const text = result.content[0]?.text;
    if (text === undefined) throw new Error("expected one text content block");
    return { ok: true, payload: JSON.parse(text) };
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof (error as { message: unknown }).message === "string"
          ? (error as { message: string }).message
          : String(error);
    return { ok: false, message };
  }
}

async function invokeStdio(client: Client, name: LedgerToolName, args: ToolArgs): Promise<Outcome> {
  try {
    const result = (await client.callTool({ name, arguments: args })) as TextToolResult;
    const text = result.content[0]?.text ?? "";
    if (result.isError === true) return { ok: false, message: text };
    return { ok: true, payload: JSON.parse(text) };
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof (error as { message: unknown }).message === "string"
          ? (error as { message: string }).message
          : String(error);
    return { ok: false, message };
  }
}

interface StdioSurface {
  client: Client;
  close(): Promise<void>;
}

async function connectStdio(
  store: LedgerStore,
  worktreeManage: WorktreeManageCapability,
): Promise<StdioSurface> {
  const server = new McpServer(
    { name: "worktree-manage-mcp-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerLedgerStdioTools(
    server,
    store,
    undefined,
    undefined,
    undefined,
    "",
    undefined,
    undefined,
    "full",
    worktreeManage,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "worktree-manage-mcp-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeJson(nested)]),
  );
}

function capabilityFor(
  repo: Awaited<ReturnType<typeof seedRepository>>,
  install: ReturnType<typeof recordingInstall>,
): WorktreeManageCapability {
  return createWorktreeManageCapability(repo.cwd, {
    deps: {
      stateDir: repo.stateDir,
      cacheRoot: repo.cacheRoot,
      install: install.runner,
    },
  });
}

interface TransportPair {
  readonly label: "direct" | "stdio";
  readonly repo: Awaited<ReturnType<typeof seedRepository>>;
  readonly store: InMemoryLedgerStore;
  call(args: ToolArgs): Promise<Outcome>;
  close(): Promise<void>;
}

async function openTransportPair(
  label: "direct" | "stdio",
  storeOptions?: Parameters<typeof buildStore>[0],
): Promise<TransportPair> {
  const repo = await seedRepository();
  const install = recordingInstall();
  const store = await buildStore(storeOptions);
  const capability = capabilityFor(repo, install);
  if (label === "direct") {
    const tools = createLedgerMcpTools(
      store,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      "full",
      capability,
    );
    return {
      label,
      repo,
      store,
      call: (args) => invokeDirect(tools, "worktree_manage", args),
      close: async () => {
        await store.dispose();
      },
    };
  }
  const stdio = await connectStdio(store, capability);
  return {
    label,
    repo,
    store,
    call: (args) => invokeStdio(stdio.client, "worktree_manage", args),
    close: async () => {
      await stdio.close();
      await store.dispose();
    },
  };
}

function expectOk(outcome: Outcome, context: string): unknown {
  expect(outcome.ok, `${context}: ${JSON.stringify(outcome)}`).toBe(true);
  if (!outcome.ok) throw new Error(context);
  return outcome.payload;
}

afterAll(async () => {
  for (const repository of repositories) {
    await fs.rm(repository, { recursive: true, force: true });
  }
});

const HANDLE_ID = "019f2c7a-6b21-7c44-9e10-7a3f5d9b2e08";

function wireHandle(version: 1 | 2) {
  return {
    kind: "cq-managed-worktree-handle" as const,
    version,
    token: `opaque-v${version}-token`,
    worktreeId: HANDLE_ID,
    taskId: "T1207",
    branch: "implement/T1207",
    repositoryRoot: "/tmp/project",
    absolutePath:
      version === 1
        ? `/tmp/project/.claude/worktrees/${HANDLE_ID}`
        : "/tmp/project/.claude/worktrees/implement-T1207",
    baseCommit: "a".repeat(40),
    createdAt: "2026-08-10T00:00:00.000Z",
    nonce: `opaque-v${version}-nonce`,
  };
}

describe("worktree_manage schema", () => {
  it("publishes paired prepare-only adoption coordinates on the public tool schema", () => {
    expect(WORKTREE_MANAGE_TOOL_SPEC.description).toContain("legacy");
    expect(WORKTREE_MANAGE_TOOL_SPEC.description).toContain("adoptWorktreePath");
    expect(WORKTREE_MANAGE_TOOL_SPEC.description).toContain("expectedHead");
    expect(Object.keys(WORKTREE_MANAGE_TOOL_SPEC.inputSchema)).toEqual(
      expect.arrayContaining(["adoptWorktreePath", "expectedHead"]),
    );
  });

  it("rejects mixed prepare/release fields", () => {
    expect(() =>
      parseWorktreeManageInput({
        operation: "prepare",
        taskId: "T1",
        baseCommit: "a".repeat(40),
        terminalDisposition: "done",
      }),
    ).toThrow(/release-only/);
    expect(() =>
      parseWorktreeManageInput({
        operation: "release",
        terminalDisposition: "done",
        handle: wireHandle(1),
        taskId: "T1",
      }),
    ).toThrow(/prepare-only/);
  });

  it("rejects unknown fields and caller-supplied dependency evidence", () => {
    expect(() =>
      parseWorktreeManageInput({
        operation: "prepare",
        taskId: "T1",
        baseCommit: "a".repeat(40),
        unexpected: true,
      }),
    ).toThrow(/unrecognized_keys|unexpected/i);
    expect(() =>
      parseWorktreeManageInput({
        operation: "prepare",
        taskId: "T1",
        baseCommit: "a".repeat(40),
        dependencyResultCommits: [{ dependencyRef: "tasks:T0", resultCommit: "b".repeat(40) }],
      }),
    ).toThrow(/dependency evidence/);
    expect(() =>
      parseWorktreeManageInput({
        operation: "prepare",
        taskId: "T1",
        baseCommit: "a".repeat(40),
        taskSnapshots: [],
      }),
    ).toThrow(/dependency evidence/);
  });

  it("accepts a manager-issued v2 handle for the canonical adopted T1207 path", () => {
    const handle = wireHandle(2);

    expect(
      parseWorktreeManageInput({
        operation: "prepare",
        taskId: "T1207",
        handle,
      }),
    ).toEqual({
      operation: "prepare",
      prepare: { taskId: "T1207", handle },
    });
  });

  it("accepts only a manager handle for observe-conflict", () => {
    const handle = wireHandle(2);
    expect(
      parseWorktreeManageInput({ operation: "observe-conflict", handle }),
    ).toEqual({ operation: "observe-conflict", observeHandle: handle });
    expect(() =>
      parseWorktreeManageInput({ operation: "observe-conflict", handle, taskId: "T1207" }),
    ).toThrow(/must not accompany/);
  });

  it("accepts only a manager handle for dispatch recovery resolution", () => {
    const handle = wireHandle(2);
    expect(
      parseWorktreeManageInput({ operation: "resolve-dispatch-recovery", handle }),
    ).toEqual({ operation: "resolve-dispatch-recovery", recoveryHandle: handle });
    expect(() =>
      parseWorktreeManageInput({
        operation: "resolve-dispatch-recovery",
        handle,
        taskId: "T1207",
      }),
    ).toThrow(/must not accompany/);
  });

  it("accepts only a complete prepare-only legacy adoption target", () => {
    const expectedHead = "b".repeat(40);
    const adoptWorktreePath = "/tmp/project/.claude/worktrees/implement-T1207";
    expect(
      parseWorktreeManageInput({
        operation: "prepare",
        taskId: "T1207",
        baseCommit: "a".repeat(40),
        adoptWorktreePath,
        expectedHead,
      }),
    ).toEqual({
      operation: "prepare",
      prepare: {
        taskId: "T1207",
        baseCommit: "a".repeat(40),
        adoptWorktreePath,
        expectedHead,
      },
    });

    for (const args of [
      {
        operation: "prepare",
        taskId: "T1207",
        baseCommit: "a".repeat(40),
        adoptWorktreePath,
      },
      {
        operation: "prepare",
        taskId: "T1207",
        baseCommit: "a".repeat(40),
        expectedHead,
      },
      {
        operation: "release",
        handle: wireHandle(2),
        terminalDisposition: "done",
        adoptWorktreePath,
        expectedHead,
      },
    ]) {
      expect(() => parseWorktreeManageInput(args)).toThrow();
    }
  });

  it("keeps v1 accepted and rejects unknown, mixed, traversal, foreign, and tampered v2 handles", () => {
    expect(
      parseWorktreeManageInput({
        operation: "release",
        terminalDisposition: "done",
        handle: wireHandle(1),
      }),
    ).toMatchObject({ operation: "release", release: { handle: wireHandle(1) } });

    const invalidHandles = [
      { ...wireHandle(2), version: 3 },
      { ...wireHandle(2), version: 1 },
      { ...wireHandle(1), version: 2 },
      {
        ...wireHandle(2),
        absolutePath: "/tmp/project/.claude/worktrees/../worktrees/implement-T1207",
      },
      { ...wireHandle(2), absolutePath: "/tmp/foreign/.claude/worktrees/implement-T1207" },
      { ...wireHandle(2), branch: "implement/T1208" },
      { ...wireHandle(2), taskId: "T1208" },
      { ...wireHandle(2), placement: "adopted" },
    ];
    for (const handle of invalidHandles) {
      expect(() =>
        parseWorktreeManageInput({
          operation: "release",
          terminalDisposition: "done",
          handle,
        }),
      ).toThrow();
    }
  });

  it("rejects invalid UUID/commit/handle values", () => {
    expect(() =>
      parseWorktreeManageInput({
        operation: "prepare",
        taskId: "not-a-task",
        baseCommit: "a".repeat(40),
      }),
    ).toThrow(/task id/i);
    expect(() =>
      parseWorktreeManageInput({
        operation: "prepare",
        taskId: "T1",
        baseCommit: "deadbeef",
      }),
    ).toThrow(/40-char/);
    expect(() =>
      parseWorktreeManageInput({
        operation: "release",
        terminalDisposition: "done",
        handle: {
          kind: "cq-managed-worktree-handle",
          version: 1,
          token: "tok",
          worktreeId: "00000000-0000-4000-8000-000000000000",
          taskId: "T1",
          branch: "implement/T1",
          repositoryRoot: "/tmp/r",
          absolutePath: "/tmp/r/.claude/worktrees/x",
          baseCommit: "a".repeat(40),
          createdAt: "2026-01-01T00:00:00.000Z",
          nonce: "n",
        },
      }),
    ).toThrow(/UUIDv7/);
  });
});

describe("worktree_manage direct/stdio contract", () => {
  it("never exposes filesystem mutation primitives as separate tools", () => {
    expect(LEDGER_TOOL_NAMES).toContain("worktree_manage");
    expect(LEDGER_TOOL_NAMES).not.toContain("worktree_prepare" as never);
    expect(LEDGER_TOOL_NAMES).not.toContain("worktree_release" as never);
    expect(LEDGER_TOOL_NAMES).not.toContain("git_worktree_add" as never);
  });

  it("resolves dispatch recovery only from the exact live manager handle", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const store = await buildStore({ rootTaskId: "T2306" });
    const observed: Array<{ taskId: string; liveTip: string }> = [];
    const capability = createWorktreeManageCapability(repo.cwd, {
      deps: {
        stateDir: repo.stateDir,
        cacheRoot: repo.cacheRoot,
        install: install.runner,
      },
      resolveDispatchRecovery: async (binding, liveTip) => {
        observed.push({ taskId: binding.taskId, liveTip });
        return {
          status: "dispatch-recovery-resolved",
          recoveryReference: `cq-dispatch-recovery:v1:${"a".repeat(64)}`,
          taskId: binding.taskId,
          liveTip,
          terminalAt: "2026-08-21T20:00:00.000Z",
        };
      },
    });
    const tools = createLedgerMcpTools(
      store,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      "full",
      capability,
    );
    try {
      const prepared = expectOk(
        await invokeDirect(tools, "worktree_manage", {
          operation: "prepare",
          taskId: "T2306",
          baseCommit: repo.base,
        }),
        "prepare recovery worktree",
      ) as { readonly handle: ManagedWorktreeHandle };
      const resolved = expectOk(
        await invokeDirect(tools, "worktree_manage", {
          operation: "resolve-dispatch-recovery",
          handle: prepared.handle,
        }),
        "resolve recovery",
      ) as Record<string, unknown>;
      expect(resolved).toMatchObject({
        status: "dispatch-recovery-resolved",
        taskId: "T2306",
        liveTip: repo.base,
      });
      expect(observed).toEqual([{ taskId: "T2306", liveTip: repo.base }]);

      const forged = await invokeDirect(tools, "worktree_manage", {
        operation: "resolve-dispatch-recovery",
        handle: { ...prepared.handle, nonce: "forged" },
      });
      expect(forged.ok).toBe(false);
      expect(observed).toHaveLength(1);
    } finally {
      await store.dispose();
    }
  });

  it("D346 preserves a verified T2192 external effect and its transitive Git contribution", async () => {
    const repo = await seedRepository();
    const install = recordingInstall();
    const store = await buildCompletedOperatorActionStore(repo.base);
    const tools = createLedgerMcpTools(
      store,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      "full",
      capabilityFor(repo, install),
    );
    try {
      const prepared = expectOk(
        await invokeDirect(tools, "worktree_manage", {
          operation: "prepare",
          taskId: "T2217",
          baseCommit: repo.base,
        }),
        "D346 operator-action dependency prepare",
      ) as {
        readonly status: string;
        readonly evidence?: {
          readonly dependencyResultCommits: readonly unknown[];
        };
      };

      expect(prepared.status).toBe("prepared");
      expect(prepared.evidence?.dependencyResultCommits).toEqual([
        { dependencyRef: "tasks:T2191", resultCommit: repo.base },
      ]);
      expect(install.plans).toHaveLength(1);
      expect(await listManagedLiveWorktrees(repo.cwd, "T2217", repo.stateDir)).toHaveLength(1);
      expect(await git(repo.cwd, ["rev-parse", "HEAD"])).toBe(repo.base);
      expect(store.fetchItem(TASKS_LEDGER, "T2192").status).toBe("done");
      expect(store.fetchItem(TASKS_LEDGER, "T2217").status).toBe("planned");
    } finally {
      await store.dispose();
    }
  });

  it("returns the complete manager-observed conflict state over both transports", async () => {
    for (const label of ["direct", "stdio"] as const) {
      const transport = await openTransportPair(label, { rootTaskId: "T2043" });
      try {
        const prepared = expectOk(
          await transport.call({
            operation: "prepare",
            taskId: "T2043",
            baseCommit: transport.repo.base,
          }),
          `${label} prepare conflict observer`,
        ) as { readonly status: string; readonly handle: ManagedWorktreeHandle };
        expect(prepared.status).toBe("prepared");
        await fs.writeFile(path.join(prepared.handle.absolutePath, "README.md"), "task side\n");
        await git(prepared.handle.absolutePath, ["add", "README.md"]);
        await git(prepared.handle.absolutePath, ["commit", "-q", "-m", "task side"]);
        await fs.writeFile(path.join(transport.repo.cwd, "README.md"), "base side\n");
        await git(transport.repo.cwd, ["add", "README.md"]);
        await git(transport.repo.cwd, ["commit", "-q", "-m", "base side"]);
        const onto = await git(transport.repo.cwd, ["rev-parse", "HEAD"]);
        const rebase = Bun.spawnSync(["git", "rebase", onto], {
          cwd: prepared.handle.absolutePath,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(rebase.exitCode).not.toBe(0);

        const observed = expectOk(
          await transport.call({ operation: "observe-conflict", handle: prepared.handle }),
          `${label} observe conflict`,
        ) as {
          readonly status: string;
          readonly conflictState: {
            readonly baseCommit: string;
            readonly currentHead: string;
            readonly expectedAncestry: readonly unknown[];
            readonly sequencer: { readonly headName: string; readonly identity: string };
            readonly conflicts: readonly { readonly path: string; readonly stage: number }[];
          };
        };
        expect(observed.status).toBe("conflict-observed");
        expect(observed.conflictState.baseCommit).toBe(transport.repo.base);
        expect(observed.conflictState.currentHead).toBe(onto);
        expect(observed.conflictState.expectedAncestry).toHaveLength(3);
        expect(observed.conflictState.sequencer.headName).toBe(
          `refs/heads/${prepared.handle.branch}`,
        );
        expect(observed.conflictState.sequencer.identity).toMatch(/^[0-9a-f]{64}$/);
        expect(observed.conflictState.conflicts.map((stage) => stage.path)).toEqual([
          "README.md",
          "README.md",
          "README.md",
        ]);
        expect(observed.conflictState.conflicts.map((stage) => stage.stage)).toEqual([1, 2, 3]);
      } finally {
        await transport.close();
      }
    }
  });

  it("returns identical acknowledgements on both transports for the full lifecycle matrix", async () => {
    const direct = await openTransportPair("direct", { rootTaskId: "T1306" });
    const stdio = await openTransportPair("stdio", { rootTaskId: "T1306" });

    try {
      // 1. Fresh prepare
      const freshDirect = expectOk(
        await direct.call({
          operation: "prepare",
          taskId: "T1306",
          baseCommit: direct.repo.base,
        }),
        "direct fresh",
      ) as { status: string; handle: ManagedWorktreeHandle; evidence: Record<string, unknown> };
      const freshStdio = expectOk(
        await stdio.call({
          operation: "prepare",
          taskId: "T1306",
          baseCommit: stdio.repo.base,
        }),
        "stdio fresh",
      ) as { status: string; handle: ManagedWorktreeHandle; evidence: Record<string, unknown> };

      expect(freshDirect.status).toBe("prepared");
      expect(freshStdio.status).toBe("prepared");
      expect(freshDirect.handle.version).toBe(1);
      expect(freshStdio.handle.version).toBe(1);
      expect(isUuidV7(freshDirect.handle.worktreeId)).toBe(true);
      expect(isUuidV7(freshStdio.handle.worktreeId)).toBe(true);
      expect(path.basename(freshDirect.handle.absolutePath)).toBe(freshDirect.handle.worktreeId);
      expect(path.basename(freshStdio.handle.absolutePath)).toBe(freshStdio.handle.worktreeId);
      expect(freshDirect.handle.taskId).toBe("T1306");
      expect(freshStdio.handle.taskId).toBe("T1306");
      expect(
        normalizeJson({
          status: freshDirect.status,
          branch: freshDirect.evidence["branch"],
          bunInstallArgs: freshDirect.evidence["bunInstallArgs"],
        }),
      ).toEqual(
        normalizeJson({
          status: freshStdio.status,
          branch: freshStdio.evidence["branch"],
          bunInstallArgs: freshStdio.evidence["bunInstallArgs"],
        }),
      );
      expect(freshDirect.evidence["baseCommit"]).toBe(direct.repo.base);
      expect(freshStdio.evidence["baseCommit"]).toBe(stdio.repo.base);

      // 2. resume-required
      const resumeRequiredDirect = expectOk(
        await direct.call({
          operation: "prepare",
          taskId: "T1306",
          baseCommit: direct.repo.base,
        }),
        "direct resume-required",
      ) as { status: string; reason: string };
      const resumeRequiredStdio = expectOk(
        await stdio.call({
          operation: "prepare",
          taskId: "T1306",
          baseCommit: stdio.repo.base,
        }),
        "stdio resume-required",
      ) as { status: string; reason: string };
      expect(resumeRequiredDirect).toMatchObject({
        status: "resume-required",
        reason: "live-tree-exists",
      });
      expect(resumeRequiredStdio).toMatchObject({
        status: "resume-required",
        reason: "live-tree-exists",
      });

      // 3. resume-by-handle
      const resumeDirect = expectOk(
        await direct.call({ operation: "prepare", handle: freshDirect.handle }),
        "direct resume-by-handle",
      ) as { status: string; handle: ManagedWorktreeHandle };
      const resumeStdio = expectOk(
        await stdio.call({ operation: "prepare", handle: freshStdio.handle }),
        "stdio resume-by-handle",
      ) as { status: string; handle: ManagedWorktreeHandle };
      expect(resumeDirect.status).toBe("prepared");
      expect(resumeStdio.status).toBe("prepared");
      expect(resumeDirect.handle.token).toBe(freshDirect.handle.token);
      expect(resumeStdio.handle.token).toBe(freshStdio.handle.token);

      // 4. typed base refusal (fresh task, missing commit object)
      const baseDirectPair = await openTransportPair("direct", { rootTaskId: "T1400" });
      const baseStdioPair = await openTransportPair("stdio", { rootTaskId: "T1400" });
      try {
        const baseArgs = {
          operation: "prepare",
          taskId: "T1400",
          baseCommit: "f".repeat(40),
        };
        const baseDirect = expectOk(
          await baseDirectPair.call(baseArgs),
          "direct base refuse",
        ) as { status: string; reason: string };
        const baseStdio = expectOk(
          await baseStdioPair.call(baseArgs),
          "stdio base refuse",
        ) as { status: string; reason: string };
        expect(baseDirect).toMatchObject({ status: "refused", reason: "base-unresolvable" });
        expect(baseStdio).toMatchObject({ status: "refused", reason: "base-unresolvable" });
        expect(normalizeJson(baseDirect)).toEqual(normalizeJson(baseStdio));
      } finally {
        await baseDirectPair.close();
        await baseStdioPair.close();
      }

      // 5. typed dependency refusal
      const depOpts = {
        rootTaskId: "T1500",
        dependency: { taskId: "T1499", status: "wip", resultCommit: null },
      } as const;
      const depDirectPair = await openTransportPair("direct", depOpts);
      const depStdioPair = await openTransportPair("stdio", depOpts);
      try {
        const depDirect = expectOk(
          await depDirectPair.call({
            operation: "prepare",
            taskId: "T1500",
            baseCommit: depDirectPair.repo.base,
          }),
          "direct dep refuse",
        ) as { status: string; reason: string };
        const depStdio = expectOk(
          await depStdioPair.call({
            operation: "prepare",
            taskId: "T1500",
            baseCommit: depStdioPair.repo.base,
          }),
          "stdio dep refuse",
        ) as { status: string; reason: string };
        expect(depDirect).toMatchObject({
          status: "refused",
          reason: "dependency-unresolvable",
        });
        expect(depStdio).toMatchObject({
          status: "refused",
          reason: "dependency-unresolvable",
        });
        expect(normalizeJson(depDirect)).toEqual(normalizeJson(depStdio));
      } finally {
        await depDirectPair.close();
        await depStdioPair.close();
      }

      await direct.store.updateItem(TASKS_LEDGER, "T1306", { status: "done" });
      await stdio.store.updateItem(TASKS_LEDGER, "T1306", { status: "done" });

      // 6. guarded release refusal — dirty
      await fs.writeFile(path.join(freshDirect.handle.absolutePath, "dirty.txt"), "dirty\n");
      await fs.writeFile(path.join(freshStdio.handle.absolutePath, "dirty.txt"), "dirty\n");
      const dirtyDirect = expectOk(
        await direct.call({
          operation: "release",
          handle: freshDirect.handle,
          terminalDisposition: "done",
        }),
        "direct dirty",
      ) as { status: string; reason: string };
      const dirtyStdio = expectOk(
        await stdio.call({
          operation: "release",
          handle: freshStdio.handle,
          terminalDisposition: "done",
        }),
        "stdio dirty",
      ) as { status: string; reason: string };
      expect(dirtyDirect).toMatchObject({ status: "refused", reason: "dirty" });
      expect(dirtyStdio).toMatchObject({ status: "refused", reason: "dirty" });
      await fs.rm(path.join(freshDirect.handle.absolutePath, "dirty.txt"));
      await fs.rm(path.join(freshStdio.handle.absolutePath, "dirty.txt"));

      // guarded release refusal — open WIP (committed so dirty does not fire)
      const wipBody = serializeWipArtifact({
        id: "T1306",
        role: "implement-worker",
        baseCommit: direct.repo.base,
        startedAt: "2026-01-01T00:00:00.000Z",
        checkpoints: [{ name: "implementation", status: "todo", body: "still open\n" }],
        complete: false,
        openCheckpoints: ["implementation"],
      });
      for (const handle of [freshDirect.handle, freshStdio.handle]) {
        await fs.writeFile(path.join(handle.absolutePath, "WIP-T1306.md"), wipBody);
        await git(handle.absolutePath, ["add", "WIP-T1306.md"]);
        await git(handle.absolutePath, ["commit", "-q", "-m", "wip partial"]);
      }
      const wipDirect = expectOk(
        await direct.call({
          operation: "release",
          handle: freshDirect.handle,
          terminalDisposition: "done",
        }),
        "direct wip",
      ) as { status: string; reason: string };
      const wipStdio = expectOk(
        await stdio.call({
          operation: "release",
          handle: freshStdio.handle,
          terminalDisposition: "done",
        }),
        "stdio wip",
      ) as { status: string; reason: string };
      expect(wipDirect).toMatchObject({ status: "refused", reason: "wip-open" });
      expect(wipStdio).toMatchObject({ status: "refused", reason: "wip-open" });
      for (const handle of [freshDirect.handle, freshStdio.handle]) {
        await fs.rm(path.join(handle.absolutePath, "WIP-T1306.md"));
        await git(handle.absolutePath, ["add", "-A"]);
        await git(handle.absolutePath, ["commit", "-q", "-m", "clear wip"]);
      }

      // regression: a present WIP candidate that cannot be read must fail closed.
      for (const handle of [freshDirect.handle, freshStdio.handle]) {
        await fs.mkdir(path.join(handle.absolutePath, "WIP-T9999.md"));
        await fs.writeFile(path.join(handle.absolutePath, "WIP-T9999.md", "present"), "present\n");
        await git(handle.absolutePath, ["add", "WIP-T9999.md"]);
        await git(handle.absolutePath, ["commit", "-q", "-m", "unreadable wip candidate"]);
      }
      const unreadableWipDirect = expectOk(
        await direct.call({
          operation: "release",
          handle: freshDirect.handle,
          terminalDisposition: "done",
        }),
        "direct unreadable wip",
      ) as { status: string; reason: string };
      const unreadableWipStdio = expectOk(
        await stdio.call({
          operation: "release",
          handle: freshStdio.handle,
          terminalDisposition: "done",
        }),
        "stdio unreadable wip",
      ) as { status: string; reason: string };
      expect([unreadableWipDirect, unreadableWipStdio]).toMatchObject([
        { status: "refused", reason: "wip-malformed" },
        { status: "refused", reason: "wip-malformed" },
      ]);
      for (const handle of [freshDirect.handle, freshStdio.handle]) {
        await fs.rm(path.join(handle.absolutePath, "WIP-T9999.md"), {
          recursive: true,
          force: true,
        });
        await git(handle.absolutePath, ["add", "-A"]);
        await git(handle.absolutePath, ["commit", "-q", "-m", "clear unreadable wip"]);
      }

      // 7. successful release + idempotent release
      const releasedDirect = expectOk(
        await direct.call({
          operation: "release",
          handle: freshDirect.handle,
          terminalDisposition: "done",
        }),
        "direct release",
      ) as { status: string; idempotent: boolean };
      const releasedStdio = expectOk(
        await stdio.call({
          operation: "release",
          handle: freshStdio.handle,
          terminalDisposition: "done",
        }),
        "stdio release",
      ) as { status: string; idempotent: boolean };
      expect(releasedDirect).toMatchObject({ status: "released", idempotent: false });
      expect(releasedStdio).toMatchObject({ status: "released", idempotent: false });

      const againDirect = expectOk(
        await direct.call({
          operation: "release",
          handle: freshDirect.handle,
          terminalDisposition: "done",
        }),
        "direct release idempotent",
      ) as { status: string; idempotent: boolean };
      const againStdio = expectOk(
        await stdio.call({
          operation: "release",
          handle: freshStdio.handle,
          terminalDisposition: "done",
        }),
        "stdio release idempotent",
      ) as { status: string; idempotent: boolean };
      expect(againDirect).toMatchObject({ status: "released", idempotent: true });
      expect(againStdio).toMatchObject({ status: "released", idempotent: true });
      expect(
        normalizeJson({ status: releasedDirect.status, idempotent: releasedDirect.idempotent }),
      ).toEqual(
        normalizeJson({ status: releasedStdio.status, idempotent: releasedStdio.idempotent }),
      );
      expect(
        normalizeJson({ status: againDirect.status, idempotent: againDirect.idempotent }),
      ).toEqual(normalizeJson({ status: againStdio.status, idempotent: againStdio.idempotent }));

      // Schema rejection channel parity
      const mixed = {
        operation: "prepare",
        taskId: "T1306",
        baseCommit: direct.repo.base,
        terminalDisposition: "done",
      };
      const mixedDirect = await direct.call(mixed);
      const mixedStdio = await stdio.call(mixed);
      expect(mixedDirect.ok).toBe(false);
      expect(mixedStdio.ok).toBe(false);
    } finally {
      await direct.close();
      await stdio.close();
    }
  });
});
