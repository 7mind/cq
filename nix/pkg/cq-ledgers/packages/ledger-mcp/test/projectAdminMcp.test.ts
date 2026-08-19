import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InMemoryLedgerStore } from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";
import {
  attachProjectAdminMcpHttp,
  PROJECT_ADMIN_TOOLS,
} from "../src/projectAdminMcp.js";

const ADMIN = "admin-secret";
const ORDINARY = "ordinary-secret";

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "t729", version: "0.0.1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }) as unknown as Transport,
  );
  return client;
}

describe("T729 project-admin MCP surface", () => {
  test("privileged tools are absent from the ordinary endpoint [BA]", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const ordinary = attachMcpHttp(store, "t729", "");
    const admin = attachProjectAdminMcpHttp(store, ADMIN);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/mcp") return ordinary.handle(req);
        if (path === "/admin/mcp") return admin.handle(req);
        return new Response("not found", { status: 404 });
      },
    });
    const origin = `http://127.0.0.1:${String(server.port)}`;
    try {
      const ordinaryClient = await connect(`${origin}/mcp`, ORDINARY);
      const names = (await ordinaryClient.listTools()).tools.map((tool) => tool.name);
      for (const tool of PROJECT_ADMIN_TOOLS) {
        expect(names).not.toContain(tool);
      }
      await ordinaryClient.close();

      await expect(connect(`${origin}/admin/mcp`, ORDINARY)).rejects.toThrow();
      const adminClient = await connect(`${origin}/admin/mcp`, ADMIN);
      const adminNames = (await adminClient.listTools()).tools.map((tool) => tool.name).sort();
      expect(adminNames).toEqual([...PROJECT_ADMIN_TOOLS].sort());
      const first = await adminClient.callTool({
        name: "export_dump",
        arguments: { operation_id: "op-1" },
      });
      const replay = await adminClient.callTool({
        name: "export_dump",
        arguments: { operation_id: "op-1" },
      });
      expect(JSON.stringify(replay.content)).toBe(JSON.stringify(first.content));
      await adminClient.close();
    } finally {
      await server.stop(true);
      await store.dispose();
    }
  });
});
