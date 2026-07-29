import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  InMemoryLedgerStore,
  NON_DISPATCH_LEDGER_TOOL_NAMES,
  type LedgerStore,
  type ListProjectsCapability,
} from "@cq/ledger";
import { attachMcpHttp, createLedgerMcpServer } from "../src/main.js";

const SHARED_PROJECTS = {
  projects: [
    {
      key: "alpha",
      displayName: "Alpha",
      createdAt: "2026-07-24T10:00:00.000Z",
    },
    {
      key: "beta",
      displayName: "Beta",
      createdAt: "2026-07-25T10:00:00.000Z",
    },
  ],
};

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

const stores: LedgerStore[] = [];
const httpServers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of httpServers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) await store.dispose();
});

async function makeStore(): Promise<LedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  stores.push(store);
  return store;
}

async function callDirect(server: McpServer): Promise<{
  result: ToolResult;
  toolNames: string[];
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "list-projects-override-direct", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  try {
    return {
      result: (await client.callTool({
        name: "list_projects",
        arguments: {},
      })) as ToolResult,
      toolNames: (await client.listTools()).tools.map((tool) => tool.name).sort(),
    };
  } finally {
    await client.close();
  }
}

async function startHttp(
  store: LedgerStore,
  listProjects?: ListProjectsCapability,
): Promise<URL> {
  const handlers = attachMcpHttp(
    store,
    "session-project",
    "",
    undefined,
    "session-project",
    undefined,
    listProjects,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: handlers.handle,
    websocket: {
      open: handlers.onWsOpen,
      message: handlers.onWsMessage,
    },
  });
  httpServers.push(server);
  return new URL(`http://127.0.0.1:${server.port}/`);
}

async function callHttp(url: URL): Promise<{
  result: ToolResult;
  toolNames: string[];
}> {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client(
    { name: "list-projects-override-http", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport as unknown as Transport);
  try {
    return {
      result: (await client.callTool({
        name: "list_projects",
        arguments: {},
      })) as ToolResult,
      toolNames: (await client.listTools()).tools.map((tool) => tool.name).sort(),
    };
  } finally {
    await client.close();
  }
}

function resultText(result: ToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text" || first.text === undefined) {
    throw new Error("expected one text result");
  }
  return first.text;
}

describe("shared list_projects capability override", () => {
  it("returns one byte-equivalent whole-XDG result from two direct project sessions", async () => {
    const listProjects: ListProjectsCapability = () => SHARED_PROJECTS;
    const alpha = await callDirect(
      createLedgerMcpServer({
        store: await makeStore(),
        displayName: "Alpha session",
        projectKey: "alpha",
        listProjects,
      }),
    );
    const beta = await callDirect(
      createLedgerMcpServer({
        store: await makeStore(),
        displayName: "Beta session",
        projectKey: "beta",
        listProjects,
      }),
    );

    expect(resultText(alpha.result)).toBe(JSON.stringify(SHARED_PROJECTS));
    expect(resultText(beta.result)).toBe(resultText(alpha.result));
    expect(alpha.toolNames).toEqual([...NON_DISPATCH_LEDGER_TOOL_NAMES].sort());
    expect(beta.toolNames).toEqual(alpha.toolNames);
    expect(resultText(alpha.result)).not.toContain(process.cwd());
  });

  it("returns one byte-equivalent whole-XDG result from two HTTP sessions", async () => {
    const url = await startHttp(await makeStore(), () => SHARED_PROJECTS);
    const alpha = await callHttp(url);
    const beta = await callHttp(url);

    expect(resultText(alpha.result)).toBe(JSON.stringify(SHARED_PROJECTS));
    expect(resultText(beta.result)).toBe(resultText(alpha.result));
    expect(alpha.toolNames).toEqual([...NON_DISPATCH_LEDGER_TOOL_NAMES].sort());
    expect(beta.toolNames).toEqual(alpha.toolNames);
    expect(resultText(alpha.result)).not.toContain(process.cwd());
  });

  it("preserves the synthesized fallback when the override is omitted", async () => {
    const direct = await callDirect(
      createLedgerMcpServer({
        store: await makeStore(),
        displayName: "Fallback",
        projectKey: "fallback-key",
      }),
    );
    const http = await callHttp(await startHttp(await makeStore()));

    expect(resultText(direct.result)).toBe(
      JSON.stringify({ projects: [{ key: "fallback-key", displayName: "Fallback" }] }),
    );
    expect(resultText(http.result)).toBe(
      JSON.stringify({
        projects: [{ key: "session-project", displayName: "session-project" }],
      }),
    );
  });

  it("surfaces override failures as direct and HTTP tool errors", async () => {
    const listProjects: ListProjectsCapability = () => {
      throw new Error("shared project registry unavailable");
    };
    const direct = await callDirect(
      createLedgerMcpServer({
        store: await makeStore(),
        displayName: "Direct failure",
        listProjects,
      }),
    );
    const http = await callHttp(await startHttp(await makeStore(), listProjects));

    expect(direct.result.isError).toBe(true);
    expect(resultText(direct.result)).toContain("shared project registry unavailable");
    expect(http.result.isError).toBe(true);
    expect(resultText(http.result)).toContain("shared project registry unavailable");
  });
});
