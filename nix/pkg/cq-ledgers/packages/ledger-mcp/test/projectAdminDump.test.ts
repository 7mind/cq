import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InMemoryLedgerStore } from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";
import { attachProjectAdminMcpHttp } from "../src/projectAdminMcp.js";

const ADMIN = "admin-secret";

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "t739", version: "0.0.1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }) as unknown as Transport,
  );
  return client;
}

function textPayload(result: unknown): unknown {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (content?.type !== "text" || typeof content.text !== "string") {
    throw new Error("expected text content");
  }
  return JSON.parse(content.text);
}

describe("T739 admin dump transfer [BA]", () => {
  test("round-trips a dump and rejects migrate-empty on a nonempty tenant", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    await store.createItem("tasks", "M-AMBIENT", {
      status: "planned",
      fields: { headline: "keep-me" },
    });
    const ordinary = attachMcpHttp(store, "t739", "");
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
      const client = await connect(`${origin}/admin/mcp`, ADMIN);
      const exported = textPayload(
        await client.callTool({ name: "export_dump", arguments: { operation_id: "exp-1" } }),
      ) as { dump: Array<{ path: string; content: string }> };
      expect(exported.dump.some((file) => file.path === "tasks.md")).toBe(true);

      const empty = new InMemoryLedgerStore({});
      await empty.init();
      const emptyAdmin = attachProjectAdminMcpHttp(empty, ADMIN);
      const emptyServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req) =>
          new URL(req.url).pathname === "/admin/mcp"
            ? emptyAdmin.handle(req)
            : new Response("not found", { status: 404 }),
      });
      try {
        const emptyClient = await connect(
          `http://127.0.0.1:${String(emptyServer.port)}/admin/mcp`,
          ADMIN,
        );
        const imported = textPayload(
          await emptyClient.callTool({
            name: "import_dump",
            arguments: {
              operation_id: "imp-1",
              intent: "migrate-empty",
              dump: exported.dump,
            },
          }),
        ) as { imported: boolean };
        expect(imported.imported).toBe(true);
        expect(empty.fetchItem("tasks", empty.search("tasks", "keep-me")[0]!.id).fields["headline"]).toBe(
          "keep-me",
        );
        const refused = await emptyClient.callTool({
          name: "import_dump",
          arguments: {
            operation_id: "imp-2",
            intent: "migrate-empty",
            dump: exported.dump,
          },
        });
        expect(refused.isError === true || JSON.stringify(refused).includes("not empty")).toBe(true);
        await emptyClient.close();
      } finally {
        await emptyServer.stop(true);
        await empty.dispose();
      }
      await client.close();
    } finally {
      await server.stop(true);
      await store.dispose();
    }
  });
});
