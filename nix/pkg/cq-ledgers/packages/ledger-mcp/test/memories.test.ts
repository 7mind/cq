import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryLedgerStore, MILESTONES_AMBIENT_ID } from "@cq/ledger";
import { createLedgerMcpServer } from "../src/main.js";

function decode<T>(result: unknown): T {
  const response = result as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = response.content.find(({ type }) => type === "text")?.text;
  if (text === undefined) throw new Error("expected text MCP response");
  if (response.isError === true) throw new Error(text);
  return JSON.parse(text) as T;
}

describe("canonical memories through the public MCP surface", () => {
  it("enumerates, writes, searches, reads, and retires a provenance-stamped memory", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const server = createLedgerMcpServer({ store, displayName: "memories-test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "memories-test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      const enumerated = decode<{ ledgers: string[] }>(
        await client.callTool({ name: "enumerate_ledgers", arguments: {} }),
      );
      expect(enumerated.ledgers).toContain("memories");

      const created = decode<{
        item: {
          id: string;
          milestoneId: string;
          status: string;
          author?: string;
          session?: string;
        };
      }>(
        await client.callTool({
          name: "create_item",
          arguments: {
            ledger_id: "memories",
            milestone_id: MILESTONES_AMBIENT_ID,
            status: "active",
            fields: {
              title: "Storage authority",
              content: "SQLite remains the canonical XDG store.",
              tags: ["architecture"],
              sourceRefs: ["decisions:K189"],
            },
            author: "gpt-5.6",
            session: "memory-session",
          },
        }),
      );
      expect(created.item).toMatchObject({
        id: "MEM1",
        milestoneId: MILESTONES_AMBIENT_ID,
        status: "active",
        author: "gpt-5.6",
        session: "memory-session",
      });

      const hits = decode<{ results: Array<{ ledgerId: string; item: { id: string } }> }>(
        await client.callTool({
          name: "fts_search",
          arguments: {
            query: "ledger:memories status:active SQLite",
            projection: "compact",
          },
        }),
      );
      expect(hits.results.map(({ ledgerId, item }) => `${ledgerId}:${item.id}`)).toEqual([
        "memories:MEM1",
      ]);

      const fetched = decode<{
        item: { fields: Record<string, unknown>; author?: string; session?: string };
      }>(
        await client.callTool({
          name: "fetch_item",
          arguments: { ledger_id: "memories", item_id: "MEM1", projection: "full" },
        }),
      );
      expect(fetched.item).toMatchObject({
        fields: {
          title: "Storage authority",
          content: "SQLite remains the canonical XDG store.",
          tags: ["architecture"],
          sourceRefs: ["decisions:K189"],
        },
        author: "gpt-5.6",
        session: "memory-session",
      });

      const retired = decode<{ item: { status: string } }>(
        await client.callTool({
          name: "update_item",
          arguments: {
            ledger_id: "memories",
            item_id: "MEM1",
            status: "superseded",
            author: "gpt-5.6",
            session: "memory-session",
          },
        }),
      );
      expect(retired.item.status).toBe("superseded");
    } finally {
      await client.close();
      await store.dispose();
    }
  });
});
