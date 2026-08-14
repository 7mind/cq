/** T1982: HTTP ordinary mutations enter through workset admission. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "bun:test";
import { InMemoryLedgerStore, TASKS_LEDGER } from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";

describe("workset-guarded generic mutation — HTTP MCP [Behavioral-Active Blackbox-GoodCommunication]", () => {
  it("rejects excluded update, creation, and ledger creation without mutation", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    await store.createMilestone({ id: "M1", title: "T1982 HTTP" });
    for (const itemId of ["T1", "T2"] as const) {
      await store.createItem(TASKS_LEDGER, "M1", {
        id: itemId,
        status: "planned",
        fields: { headline: itemId },
      });
    }
    await store.worksetStore().setRoots(["tasks:T2"]);

    const handlers = attachMcpHttp(store, "t1982-http", "");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handlers.handle(request),
    });
    const client = new Client(
      { name: "t1982-http-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(server.port)}/mcp`),
      ) as unknown as Transport,
    );

    try {
      for (const { name, arguments: args } of [
        {
          name: "update_item",
          arguments: {
            ledger_id: TASKS_LEDGER,
            item_id: "T1",
            fields: { headline: "Excluded HTTP update" },
          },
        },
        {
          name: "create_item",
          arguments: {
            ledger_id: TASKS_LEDGER,
            milestone_id: "M1",
            id: "T99",
            status: "planned",
            fields: { headline: "Excluded HTTP create" },
          },
        },
        {
          name: "create_ledger",
          arguments: {
            name: "excludedHttpLedger",
            schema: {
              idPrefix: "XH",
              statusValues: ["open", "done"],
              terminalStatuses: ["done"],
              fields: { headline: { type: "string", required: true } },
            },
          },
        },
      ] as const) {
        const result = await client.callTool({ name, arguments: { ...args } });
        expect(result.isError, name).toBe(true);
        expect(store.fetchItem(TASKS_LEDGER, "T1").fields.headline, name).toBe("T1");
        expect(store.enumerate(), name).not.toContain("excludedHttpLedger");
        expect(store.worksetStore().activeAdmissionCount(), name).toBe(0);
      }
    } finally {
      await client.close();
      await server.stop(true);
      await store.dispose();
    }
  });
});
