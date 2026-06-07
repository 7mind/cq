/**
 * Regression: D34 fix was incomplete — the server emits `progressTotal` on each
 * LedgerSummary (T207) and LedgerProgressBar uses it as the denominator (T208),
 * but McpLedgerClient.enumerateLedgers() dropped the field while parsing the
 * wire response, so `summary.progressTotal` was always undefined on the client
 * and the bar fell back to itemCount (the 46/47 symptom persists post-fix).
 *
 * This test stubs the SDK client's callTool to return an enumerate_ledgers
 * response carrying progressTotal, and asserts enumerateLedgers() passes it
 * through. Fails before the mcpClient.ts fix (progressTotal undefined), passes
 * after.
 */
import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpLedgerClient } from "../src/mcpClient.js";

function stubClient(response: unknown): Client {
  const stub = {
    callTool: async ({ name }: { name: string }) => {
      if (name !== "enumerate_ledgers") throw new Error(`unexpected tool ${name}`);
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    },
  };
  return stub as unknown as Client;
}

describe("McpLedgerClient.enumerateLedgers progressTotal passthrough (D34)", () => {
  it("copies the server-computed progressTotal onto the LedgerSummary", async () => {
    // 46 answered + 1 withdrawn + 0 open = itemCount 47; progressTotal excludes
    // the terminal withdrawn → 46. The bar must read 46/46, not 46/47.
    const client = new McpLedgerClient(
      stubClient({
        ledgers: ["questions"],
        counts: { questions: 47 },
        ledgerSummaries: [
          {
            name: "questions",
            itemCount: 47,
            statusCounts: { answered: 46, withdrawn: 1 },
            completedCount: 46,
            progressTotal: 46,
          },
        ],
      }),
    );
    const summaries = await client.enumerateLedgers();
    const q = summaries.find((s) => s.name === "questions");
    expect(q).toBeDefined();
    expect(q!.itemCount).toBe(47);
    expect(q!.completedCount).toBe(46);
    expect(q!.progressTotal).toBe(46);
  });

  it("leaves progressTotal undefined when the server omits it (older peer)", async () => {
    const client = new McpLedgerClient(
      stubClient({
        ledgers: ["questions"],
        counts: { questions: 3 },
        ledgerSummaries: [{ name: "questions", itemCount: 3, completedCount: 2 }],
      }),
    );
    const summaries = await client.enumerateLedgers();
    const q = summaries.find((s) => s.name === "questions");
    expect(q!.progressTotal).toBeUndefined();
    expect(q!.itemCount).toBe(3);
  });
});
