/**
 * Stdio tool-name prefix tests (T375 / G45).
 *
 * Threads the trailing optional `toolPrefix` through `registerLedgerStdioTools`
 * and asserts — via a real `@modelcontextprotocol/sdk` `McpServer` round-tripped
 * over an in-memory transport with a `Client.listTools()` call — that:
 *  - a non-empty prefix registers exactly `prefixedToolNames(prefix)`;
 *  - the default `''` (and an omitted arg) registers exactly `LEDGER_TOOL_NAMES`.
 *
 * The prefix is a PURE NAME TRANSFORM: only the registered names change; config
 * (description/inputSchema) and handler behaviour are untouched.
 */

import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InMemoryLedgerStore,
  registerLedgerStdioTools,
  LEDGER_TOOL_NAMES,
  prefixedToolNames,
  type LedgerStore,
} from "../src/index.js";

async function buildStore(): Promise<LedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

/**
 * Register the stdio tools (with the given trailing args) on a fresh McpServer,
 * round-trip a Client over an in-memory transport, and return the sorted list of
 * registered tool names via tools/list.
 */
async function registeredNames(
  store: LedgerStore,
  ...trailing: [readLog?: undefined, configCapability?: undefined, promptCatalog?: undefined, toolPrefix?: string]
): Promise<string[]> {
  const server = new McpServer(
    { name: "stdio-prefix-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerLedgerStdioTools(server, store, ...trailing);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "stdio-prefix-test-client", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

function decode<T>(result: unknown): T {
  const response = result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(response.isError ?? false).toBe(false);
  const first = response.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

async function withRegisteredClient(
  toolPrefix: string,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const store = await buildStore();
  const server = new McpServer(
    { name: "stdio-prefix-contract-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerLedgerStdioTools(
    server,
    store,
    undefined,
    undefined,
    undefined,
    toolPrefix,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "stdio-prefix-contract-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

describe("registerLedgerStdioTools — trailing toolPrefix", () => {
  it("registers prefixedToolNames(prefix) for a non-empty prefix", async () => {
    const store = await buildStore();
    const names = await registeredNames(store, undefined, undefined, undefined, "myproj");
    expect(names).toEqual([...prefixedToolNames("myproj")].sort());
    // Every registered name carries the prefix; the count is preserved.
    expect(names.length).toBe(LEDGER_TOOL_NAMES.length);
    expect(names.every((n) => n.startsWith("myproj_"))).toBe(true);
  });

  it("registers exactly LEDGER_TOOL_NAMES for prefix ''", async () => {
    const store = await buildStore();
    const names = await registeredNames(store, undefined, undefined, undefined, "");
    expect(names).toEqual([...LEDGER_TOOL_NAMES].sort());
  });

  it("registers exactly LEDGER_TOOL_NAMES when toolPrefix is omitted (default '')", async () => {
    const store = await buildStore();
    const names = await registeredNames(store);
    expect(names).toEqual([...LEDGER_TOOL_NAMES].sort());
  });

  it("preserves ack, compact, and full contracts with and without a prefix", async () => {
    for (const prefix of ["", "myproj"]) {
      await withRegisteredClient(prefix, async (client) => {
        decode<{ milestone: { id: string } }>(
          await client.callTool({
            name: prefix === "" ? "create_milestone" : `${prefix}_create_milestone`,
            arguments: { id: "M1", title: "projection contract" },
          }),
        );
        const created = decode<{
          item: { id: string; fields: Record<string, never> };
        }>(
          await client.callTool({
            name: prefix === "" ? "create_item" : `${prefix}_create_item`,
            arguments: {
              ledger_id: "tasks",
              milestone_id: "M1",
              status: "planned",
              fields: {
                headline: "prefix contract",
                description: "full-only narrative",
              },
            },
          }),
        );
        expect(created.item.fields).toEqual({});

        const compact = decode<{
          item: { fields: Record<string, unknown> };
        }>(
          await client.callTool({
            name: prefix === "" ? "fetch_item" : `${prefix}_fetch_item`,
            arguments: {
              ledger_id: "tasks",
              item_id: created.item.id,
              projection: "compact",
            },
          }),
        );
        expect(compact.item.fields["headline"]).toBe("prefix contract");
        expect(compact.item.fields["description"]).toBeUndefined();

        const full = decode<{
          item: { fields: Record<string, unknown> };
        }>(
          await client.callTool({
            name: prefix === "" ? "fetch_item" : `${prefix}_fetch_item`,
            arguments: {
              ledger_id: "tasks",
              item_id: created.item.id,
              projection: "full",
            },
          }),
        );
        expect(full.item.fields["description"]).toBe("full-only narrative");
      });
    }
  });

  it("rejects an invalid (non-alphanumeric) prefix at the boundary", async () => {
    const store = await buildStore();
    const server = new McpServer(
      { name: "stdio-prefix-bad", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    expect(() =>
      registerLedgerStdioTools(server, store, undefined, undefined, undefined, "bad prefix"),
    ).toThrow(/Invalid tool prefix/);
  });
});
