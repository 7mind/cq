/** T1982: stdio ordinary mutations enter through workset admission. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "bun:test";
import { registerLedgerStdioTools } from "../src/index.js";
import {
  EXCLUDED_GENERIC_MUTATION_CASES,
  genericStoreBytes,
  seedExcludedGenericMutationStore,
} from "./worksetGenericMutationMcpSupport.js";

describe("workset-guarded generic mutation — stdio MCP [Behavioral-Active Blackbox-Group]", () => {
  it("rejects every excluded ordinary mutation before changing the store", async () => {
    const store = await seedExcludedGenericMutationStore();
    const server = new McpServer({ name: "t1982-stdio", version: "0.0.1" });
    registerLedgerStdioTools(server, store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "t1982-client", version: "0.0.1" });
    await client.connect(clientTransport);
    const before = genericStoreBytes(store);
    try {
      for (const { tool, input } of EXCLUDED_GENERIC_MUTATION_CASES) {
        const result = (await client.callTool({
          name: tool,
          arguments: { ...input },
        })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
        expect(result.isError, tool).toBe(true);
        const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
        expect(text.length, tool).toBeGreaterThan(0);
        expect(genericStoreBytes(store), tool).toBe(before);
        expect(store.worksetStore().activeAdmissionCount(), tool).toBe(0);
      }
    } finally {
      await client.close();
      await server.close();
      await store.dispose();
    }
  });
});
