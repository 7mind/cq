/**
 * T1513 (I20/G155): McpLedgerClient.getUsageStats() maps to the
 * get_usage_stats tool and JSON-decodes the single text content block into
 * the UsageStatsSnapshot (`{ endpoints, totals }`) unchanged — the same
 * discipline as the other read methods (cf. mcpClientProgressTotal.test.ts).
 */
import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpLedgerClient } from "../src/mcpClient.js";

function stubClient(response: unknown): Client {
  const stub = {
    callTool: async ({ name }: { name: string }) => {
      if (name !== "get_usage_stats") throw new Error(`unexpected tool ${name}`);
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    },
  };
  return stub as unknown as Client;
}

describe("McpLedgerClient.getUsageStats (T1513)", () => {
  it("parses the get_usage_stats MCP JSON payload into the snapshot", async () => {
    const payload = {
      endpoints: [
        { name: "fetch_ledger", callCount: 2, bytesIn: 64, bytesOut: 1024 },
        { name: "get_usage_stats", callCount: 1, bytesIn: 2, bytesOut: 128 },
      ],
      totals: { name: "totals", callCount: 3, bytesIn: 66, bytesOut: 1152 },
    };
    const client = new McpLedgerClient(stubClient(payload));
    const stats = await client.getUsageStats();
    expect(stats).toEqual(payload);
    expect(stats.totals.name).toBe("totals");
  });
});
