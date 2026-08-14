/**
 * Public-builder tests for `createLedgerMcpServer` (T378 / G45 / Q209).
 *
 * `createLedgerMcpServer({ store, displayName, toolPrefix })` is the extracted
 * public factory that `buildServer` now wraps. These tests round-trip a real
 * `@modelcontextprotocol/sdk` `McpServer` over an in-memory transport with a
 * `Client.listTools()` call (mirroring T375's stdio-tool-prefix.test.ts) and
 * assert:
 *  - a non-empty `toolPrefix` registers exactly `prefixedToolNames(prefix)`;
 *  - an omitted `toolPrefix` registers exactly the unprefixed `LEDGER_TOOL_NAMES`
 *    (the full LEDGER_TOOL_NAMES surface), matching the legacy `buildServer` default.
 */

import { describe, it, expect } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  exposedLedgerToolsForRole,
  ROLE_TOOL_CAPABILITY_MATRIX,
} from "@cq/config";
import {
  InMemoryLedgerStore,
  LEDGER_TOOL_NAMES,
  MILESTONES_AMBIENT_ID,
  NON_DISPATCH_LEDGER_TOOL_NAMES,
  TASKS_LEDGER,
  prefixedToolNames,
  type DispatchCapability,
  type LedgerStore,
} from "@cq/ledger";
import {
  buildServerInstructions,
  createLedgerMcpServer,
  InMemoryPromptArtifactStore,
} from "../src/main.js";

const encoder = new TextEncoder();
const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T2051",
  GIT_AUTHOR_EMAIL: "t2051@example.invalid",
  GIT_COMMITTER_NAME: "T2051",
  GIT_COMMITTER_EMAIL: "t2051@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", [...args], { cwd, env: GIT_ENV, encoding: "utf8" });
  return result.stdout.trim();
}

async function seedDefaultAdoptionFixture(): Promise<{
  readonly root: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly expectedHead: string;
  readonly dependencyCommit: string;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), "t2051-default-server-"));
  const repositoryRoot = join(root, "repo");
  const worktreePath = join(repositoryRoot, ".claude", "worktrees", "implement-T1207");
  await fs.mkdir(repositoryRoot);
  await git(repositoryRoot, ["init", "-q", "-b", "main"]);
  await fs.writeFile(join(repositoryRoot, ".gitignore"), "node_modules/\n");
  await fs.mkdir(join(repositoryRoot, "fixture-package"));
  await fs.writeFile(
    join(repositoryRoot, "fixture-package", "package.json"),
    '{"name":"fixture-package","version":"1.0.0"}\n',
  );
  await fs.writeFile(
    join(repositoryRoot, "package.json"),
    '{"name":"t2051-default","dependencies":{"fixture-package":"file:./fixture-package"}}\n',
  );
  await fs.writeFile(join(repositoryRoot, "seed.txt"), "seed\n");
  await exec("bun", ["install", "--lockfile-only"], { cwd: repositoryRoot, encoding: "utf8" });
  await fs.rm(join(repositoryRoot, "node_modules"), { recursive: true, force: true });
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  const dependencyCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  await git(repositoryRoot, ["switch", "-q", "-c", "implement/T1207"]);
  const commits: string[] = [];
  for (let index = 1; index <= 5; index += 1) {
    await fs.writeFile(join(repositoryRoot, `legacy-${index}.txt`), `${index}\n`);
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "-q", "-m", `legacy ${index}`]);
    commits.push(await git(repositoryRoot, ["rev-parse", "HEAD"]));
  }
  const expectedHead = commits.at(-1)!;
  await git(repositoryRoot, ["switch", "-q", "main"]);
  for (const commit of commits) await git(repositoryRoot, ["cherry-pick", "-x", commit]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  await fs.mkdir(dirname(worktreePath), { recursive: true });
  await git(repositoryRoot, ["worktree", "add", "-q", worktreePath, "implement/T1207"]);
  await fs.writeFile(join(worktreePath, "retained.bin"), Buffer.from([0, 255, 10]));
  return { root, repositoryRoot, worktreePath, baseCommit, expectedHead, dependencyCommit };
}

async function buildStore(): Promise<LedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

/**
 * Build the server via the public factory, round-trip a Client over an
 * in-memory transport, and return the sorted list of registered tool names.
 */
async function registeredNames(toolPrefix?: string, toolProfile?: string): Promise<string[]> {
  const store = await buildStore();
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected dispatch operation");
  };
  const dispatchCapability: DispatchCapability = {
    prepare: unavailable,
    fetchInput: unavailable,
    storeResult: unavailable,
    confirmCompletion: unavailable,
    abort: unavailable,
    fetch: unavailable,
  };
  const server = createLedgerMcpServer(
    {
      store,
      displayName: "demo",
      dispatchCapability,
      ...(toolPrefix === undefined ? {} : { toolPrefix }),
      ...(toolProfile === undefined ? {} : { toolProfile }),
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "create-server-test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

describe("createLedgerMcpServer — public builder", () => {
  it("carries the canonical memory policy through initialize instructions", async () => {
    const store = await buildStore();
    const server = createLedgerMcpServer({ store, displayName: "demo" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "create-server-instructions-test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      expect(client.getInstructions()).toContain(buildServerInstructions(""));
      expect(client.getInstructions()).toContain(
        "create_item only confirmed durable project facts in memories/M-AMBIENT with useful sourceRefs",
      );
    } finally {
      await client.close();
      await store.dispose();
    }
  });

  it("adopts a legacy worktree through the default repository capability", async () => {
    const fixture = await seedDefaultAdoptionFixture();
    const store = new InMemoryLedgerStore();
    await store.init();
    await store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "T1206",
      status: "done",
      fields: { headline: "dependency", resultCommit: fixture.dependencyCommit },
    });
    await store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "T1207",
      status: "wip",
      fields: { headline: "legacy adoption", dependsOn: ["tasks:T1206"] },
    });
    const server = createLedgerMcpServer({
      store,
      displayName: "default-adoption",
      repositoryRoot: fixture.repositoryRoot,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "default-adoption-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    const owner = Bun.spawn(
      [process.execPath, "-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1_000)'],
      { cwd: fixture.worktreePath, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const prepare = async (): Promise<{
        readonly status: string;
        readonly reason?: string;
        readonly detail?: string;
      }> => {
        const response = (await client.callTool({
          name: "worktree_manage",
          arguments: {
            operation: "prepare",
            taskId: "T1207",
            baseCommit: fixture.baseCommit,
            adoptWorktreePath: fixture.worktreePath,
            expectedHead: fixture.expectedHead,
          },
        })) as { content: Array<{ type: string; text?: string }> };
        return JSON.parse(response.content[0]?.text ?? "") as {
          readonly status: string;
          readonly reason?: string;
          readonly detail?: string;
        };
      };
      const reader = owner.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
      const refused = await prepare();
      expect(refused).toMatchObject({
        status: "refused",
        reason: "adoption-reconciliation-failed",
      });
      expect(refused.detail).toContain(`process:${owner.pid}`);
      owner.kill();
      await owner.exited;

      expect(await prepare()).toMatchObject({ status: "prepared" });
      expect(await fs.readFile(join(fixture.worktreePath, "retained.bin"))).toEqual(
        Buffer.from([0, 255, 10]),
      );
    } finally {
      owner.kill();
      await owner.exited;
      await client.close();
      await store.dispose();
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("registers prefixedToolNames(prefix) for a non-empty toolPrefix", async () => {
    const names = await registeredNames("myproj");
    expect(names).toEqual([...prefixedToolNames("myproj")].sort());
    expect(names.length).toBe(LEDGER_TOOL_NAMES.length);
    expect(names.every((n) => n.startsWith("myproj_"))).toBe(true);
  });

  it("registers the unprefixed LEDGER_TOOL_NAMES (31) when toolPrefix is omitted", async () => {
    const names = await registeredNames();
    expect(names).toEqual([...LEDGER_TOOL_NAMES].sort());
    expect(names.length).toBe(LEDGER_TOOL_NAMES.length);
    expect(names).not.toContain("validate_input");
  });

  it("filters every narrower named role profile before tools/list serialization", async () => {
    for (const roleId of Object.keys(ROLE_TOOL_CAPABILITY_MATRIX)) {
      const expected = [...exposedLedgerToolsForRole(roleId)].sort();
      if (expected.length === LEDGER_TOOL_NAMES.length) continue;
      expect(await registeredNames(undefined, roleId), roleId).toEqual(expected);
    }
  });

  it("fails closed on an unknown tool profile before constructing a server", async () => {
    const store = await buildStore();
    expect(() =>
      createLedgerMcpServer({
        store,
        displayName: "demo",
        dispatchCapability: {
          prepare: async () => {
            throw new Error("unexpected dispatch operation");
          },
          fetchInput: async () => {
            throw new Error("unexpected dispatch operation");
          },
          storeResult: async () => {
            throw new Error("unexpected dispatch operation");
          },
          confirmCompletion: async () => {
            throw new Error("unexpected dispatch operation");
          },
          abort: async () => {
            throw new Error("unexpected dispatch operation");
          },
          fetch: async () => {
            throw new Error("unexpected dispatch operation");
          },
        },
        toolProfile: "unknown-profile",
      }),
    ).toThrow('unknown role tool profile "unknown-profile"');
    await store.dispose();
  });

  it("omits lifecycle tools before registration when no durable capability exists", async () => {
    const store = await buildStore();
    const server = createLedgerMcpServer({ store, displayName: "unsupported" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "create-server-unsupported-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual([...NON_DISPATCH_LEDGER_TOOL_NAMES].sort());
      expect(names).not.toContain("prepare_dispatch");
      expect(names).not.toContain("fetch_dispatch_result");
    } finally {
      await client.close();
      await store.dispose();
    }
  });

  it("threads the server-scoped dispatch capability into the registered handlers", async () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("unexpected dispatch operation");
    };
    const dispatchCapability: DispatchCapability = {
      prepare: unavailable,
      fetchInput: unavailable,
      storeResult: unavailable,
      confirmCompletion: unavailable,
      abort: unavailable,
      fetch: async (handle) => ({ state: "attestation-not-found", ...handle }),
    };
    const store = await buildStore();
    const server = createLedgerMcpServer({
      store,
      displayName: "demo",
      dispatchCapability,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "create-server-dispatch-test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "fetch_dispatch_result",
        arguments: { attestationId: "attestation-1", generation: 1 },
      })) as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
        state: "attestation-not-found",
        attestationId: "attestation-1",
        generation: 1,
      });
    } finally {
      await client.close();
      await store.dispose();
    }
  });

  it("serves exact prompt bytes from the injected artifact store without a config root", async () => {
    const promptTemplate = "Keep {{cq:literal}} and $ARGUMENTS unchanged.\n";
    const promptArtifactStore = new InMemoryPromptArtifactStore(
      encoder.encode(
        JSON.stringify([
          {
            roleId: "plan-advance",
            roleKind: "dispatched-subagent",
            sidecar: { schemaRoleId: "plan-advance" },
          },
        ]),
      ),
      [{ roleId: "plan-advance", bytes: encoder.encode(promptTemplate) }],
    );
    const store = await buildStore();
    const server = createLedgerMcpServer({
      store,
      displayName: "demo",
      promptArtifactStore,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "create-server-prompt-test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "fetch_prompt",
        arguments: { roleId: "plan-advance" },
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      expect(result.isError ?? false).toBe(false);
      const text = result.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text ?? "")
        .join("");
      expect(JSON.parse(text)).toMatchObject({
        roleId: "plan-advance",
        kind: "dispatched-subagent",
        promptTemplate,
      });
    } finally {
      await client.close();
      await store.dispose();
    }
  });
});
