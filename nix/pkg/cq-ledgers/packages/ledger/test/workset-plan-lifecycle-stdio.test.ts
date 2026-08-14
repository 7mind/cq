/** T1981: stdio MCP plan lifecycle enters through workset admission. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "bun:test";
import { GOALS_LEDGER, registerLedgerStdioTools } from "../src/index.js";
import {
  EXCLUDED_PLAN_CASES,
  excludedPlanResult,
  seedExcludedPlanStore,
  textPayload,
} from "./worksetPlanLifecycleMcpSupport.js";

describe("workset-guarded plan lifecycle — stdio MCP [Behavioral-Active Blackbox-Group]", () => {
  it("rejects all four excluded operations before changing the goal", async () => {
    const store = await seedExcludedPlanStore();
    const server = new McpServer({ name: "t1981-stdio", version: "0.0.1" });
    registerLedgerStdioTools(server, store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "t1981-client", version: "0.0.1" });
    await client.connect(clientTransport);
    try {
      for (const { tool, operation, input } of EXCLUDED_PLAN_CASES) {
        const result = await client.callTool({ name: tool, arguments: { ...input } });
        expect(JSON.parse(textPayload(result)), tool).toEqual(excludedPlanResult(operation));
        expect(store.fetchItem(GOALS_LEDGER, "G1").status).toBe("clarifying");
      }
    } finally {
      await client.close();
      await server.close();
      await store.dispose();
    }
  });
});
