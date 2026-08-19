import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InMemoryLedgerStore } from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "t741", version: "0.0.1" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)) as unknown as Transport);
  return client;
}

describe("T741 ordinary put_log [BA]", () => {
  test("is absent unless enableLogWrite is set, then stores bytes", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const off = attachMcpHttp(store, "t741-off", "");
    const on = attachMcpHttp(
      store,
      "t741-on",
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "full",
      undefined,
      undefined,
      "observe",
      true,
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/off") return off.handle(req);
        if (path === "/on") return on.handle(req);
        return new Response("not found", { status: 404 });
      },
    });
    const origin = `http://127.0.0.1:${String(server.port)}`;
    try {
      const offClient = await connect(`${origin}/off`);
      expect((await offClient.listTools()).tools.map((tool) => tool.name)).not.toContain("put_log");
      await offClient.close();
      const onClient = await connect(`${origin}/on`);
      expect((await onClient.listTools()).tools.map((tool) => tool.name)).toContain("put_log");
      const result = await onClient.callTool({
        name: "put_log",
        arguments: { path: "logs/note.md", content: "hello-log" },
      });
      expect(JSON.stringify(result)).toContain("stored");
      const read = await store.readLog("note.md");
      expect(read.content).toBe("hello-log");
      await onClient.close();
    } finally {
      await server.stop(true);
      await store.dispose();
    }
  });
});
