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
 *    (the 27-tool surface), matching the legacy `buildServer` default.
 */

import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InMemoryLedgerStore,
  LEDGER_TOOL_NAMES,
  prefixedToolNames,
  type LedgerStore,
} from "@cq/ledger";
import { createLedgerMcpServer } from "../src/main.js";

async function buildStore(): Promise<LedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

/**
 * Build the server via the public factory, round-trip a Client over an
 * in-memory transport, and return the sorted list of registered tool names.
 */
async function registeredNames(toolPrefix?: string): Promise<string[]> {
  const store = await buildStore();
  const server = createLedgerMcpServer(
    toolPrefix === undefined
      ? { store, displayName: "demo" }
      : { store, displayName: "demo", toolPrefix },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "create-server-test-client", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

describe("createLedgerMcpServer — public builder", () => {
  it("registers prefixedToolNames(prefix) for a non-empty toolPrefix", async () => {
    const names = await registeredNames("myproj");
    expect(names).toEqual([...prefixedToolNames("myproj")].sort());
    expect(names.length).toBe(LEDGER_TOOL_NAMES.length);
    expect(names.every((n) => n.startsWith("myproj_"))).toBe(true);
  });

  it("registers the unprefixed LEDGER_TOOL_NAMES (27) when toolPrefix is omitted", async () => {
    const names = await registeredNames();
    expect(names).toEqual([...LEDGER_TOOL_NAMES].sort());
    expect(names.length).toBe(LEDGER_TOOL_NAMES.length);
  });
});
