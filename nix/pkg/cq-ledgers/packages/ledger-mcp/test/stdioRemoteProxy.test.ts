/**
 * T728 — stdio remote proxy vs direct /p/<key>/mcp semantic parity.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InMemoryLedgerStore } from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";
import { connectRemoteMcpProxy } from "../src/stdioRemoteProxy.js";

const TOKEN = "t728-ordinary-token";

async function seedStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore({});
  await store.init();
  return store;
}

function startProjectServer(store: InMemoryLedgerStore, requireAuth: boolean): ReturnType<typeof Bun.serve> {
  const handlers = attachMcpHttp(
    store,
    "t728-project",
    "",
    undefined,
    "alpha",
    undefined,
    undefined,
    undefined,
    "full",
    undefined,
    requireAuth
      ? { ordinaryToken: TOKEN, managementToken: "t728-admin-token" }
      : undefined,
  );
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/p/alpha/mcp") return handlers.handle(request);
      return new Response("not found", { status: 404 });
    },
  });
}

async function connectDirect(origin: string, token: string): Promise<Client> {
  const client = new Client({ name: "t728-direct", version: "0.0.1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/p/alpha/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }) as unknown as Transport,
  );
  return client;
}

async function connectProxy(origin: string, token: string): Promise<{
  client: Client;
  close(): Promise<void>;
}> {
  const proxy = await connectRemoteMcpProxy(origin, "alpha", token);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(serverTransport);
  const client = new Client({ name: "t728-proxy", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await proxy.close();
    },
  };
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

describe("T728 remote stdio proxy", () => {
  test("architecture: proxy never constructs a store or opens postgres [BA]", () => {
    const source = readFileSync(new URL("../src/stdioRemoteProxy.ts", import.meta.url), "utf8");
    expect(source).not.toContain("createLedgerStore");
    expect(source).not.toContain("openPgPool");
    expect(source).not.toContain("PostgresLedgerStore");
  });

  test("initialize, tool schemas, success, and typed errors match direct HTTP [BA]", async () => {
    const store = await seedStore();
    const http = startProjectServer(store, true);
    servers.push(http);
    const origin = `http://127.0.0.1:${String(http.port)}`;
    const direct = await connectDirect(origin, TOKEN);
    const proxied = await connectProxy(origin, TOKEN);
    try {
      expect(proxied.client.getInstructions()).toBe(direct.getInstructions());
      expect(proxied.client.getServerVersion()?.title).toBe(direct.getServerVersion()?.title);
      const directTools = await direct.listTools();
      const proxyTools = await proxied.client.listTools();
      expect(proxyTools.tools.map((tool) => tool.name)).toEqual(
        directTools.tools.map((tool) => tool.name),
      );
      expect(proxyTools.tools.map((tool) => tool.inputSchema)).toEqual(
        directTools.tools.map((tool) => tool.inputSchema),
      );
      const args = { ledger_id: "tasks", query: "none", projection: "compact" };
      const directHit = await direct.callTool({ name: "search_items", arguments: args });
      const proxyHit = await proxied.client.callTool({ name: "search_items", arguments: args });
      expect(JSON.stringify(proxyHit.content)).toBe(JSON.stringify(directHit.content));
      const directErr = await direct.callTool({
        name: "fetch_item",
        arguments: { ledger_id: "tasks", item_id: "T999", projection: "compact" },
      });
      const proxyErr = await proxied.client.callTool({
        name: "fetch_item",
        arguments: { ledger_id: "tasks", item_id: "T999", projection: "compact" },
      });
      expect(proxyErr.isError).toBe(true);
      expect(directErr.isError).toBe(true);
      expect(JSON.stringify(proxyErr.content)).toBe(JSON.stringify(directErr.content));
    } finally {
      await proxied.close();
      await direct.close();
      await store.dispose();
    }
  });

  test("auth rejection and unavailable propagate [BA]", async () => {
    const store = await seedStore();
    const http = startProjectServer(store, true);
    servers.push(http);
    const origin = `http://127.0.0.1:${String(http.port)}`;
    await expect(connectRemoteMcpProxy(origin, "alpha", "wrong-token")).rejects.toThrow();
    await store.dispose();
    await expect(connectRemoteMcpProxy("http://127.0.0.1:9", "alpha", TOKEN)).rejects.toThrow();
  });
});
