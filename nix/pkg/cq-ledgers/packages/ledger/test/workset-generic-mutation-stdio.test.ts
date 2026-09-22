/** T1982: stdio ordinary mutations enter through workset admission. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "bun:test";
import { ledgerItemRevisionV1 } from "../src/itemRevision.js";
import {
  IDEAS_LEDGER,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  QUESTIONS_LEDGER,
  TASKS_LEDGER,
  registerLedgerStdioTools,
} from "../src/index.js";
import {
  EXCLUDED_GENERIC_MUTATION_CASES,
  genericStoreBytes,
  seedExcludedGenericMutationStore,
} from "./worksetGenericMutationMcpSupport.js";

describe("workset-guarded generic mutation — stdio MCP [Behavioral-Active Blackbox-Group]", () => {
  it("executes the closed exact-item archive arm without archiving a sibling", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const milestone = await store.createMilestone({ title: "exact archive transport" });
    const selected = await store.createItem(TASKS_LEDGER, milestone.id, {
      status: "done", fields: { headline: "selected" },
    });
    const sibling = await store.createItem(TASKS_LEDGER, milestone.id, {
      status: "done", fields: { headline: "unrelated" },
    });
    await store.worksetStore().setRoots([`tasks:${selected.id}`]);
    const server = new McpServer({ name: "exact-archive-stdio", version: "0.0.1" });
    registerLedgerStdioTools(server, store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "exact-archive-client", version: "0.0.1" });
    await client.connect(clientTransport);
    const operation = {
      id: "archive:selected", action: "archive-terminal-item", version: 1,
      target_id: `tasks:${selected.id}`, expected_milestone_id: milestone.id,
      expected_updated_at: selected.updatedAt, summary: "exact completion",
      expected_item_digest: ledgerItemRevisionV1(`tasks:${selected.id}`, selected),
    };
    try {
      const { expected_updated_at: _revision, ...missingRevision } = operation;
      expect((await client.callTool({
        name: "execute_finalize", arguments: { operations: [missingRevision] },
      })).isError).toBe(true);
      expect(store.fetchItem(TASKS_LEDGER, selected.id).status).toBe("done");
      const result = await client.callTool({
        name: "execute_finalize", arguments: { operations: [operation] },
      });
      expect(result.isError).not.toBe(true);
      expect(() => store.fetchItem(TASKS_LEDGER, selected.id)).toThrow();
      expect(store.fetchItem(TASKS_LEDGER, sibling.id).status).toBe("done");
    } finally {
      await client.close();
      await server.close();
      await store.dispose();
    }
  });

  it("D442 admits ambient idea creation and the TUI answer field shape", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    await store.createMilestone({ id: "M1", title: "D442 stdio" });
    await store.createItem(TASKS_LEDGER, "M1", {
      id: "T1",
      status: "planned",
      fields: { headline: "restrictive root" },
    });
    await store.createItem(QUESTIONS_LEDGER, "M1", {
      id: "Q1",
      status: "open",
      fields: { question: "Proceed?" },
    });
    await store.worksetStore().setRoots(["tasks:T1"]);
    const server = new McpServer({ name: "d442-stdio", version: "0.0.1" });
    registerLedgerStdioTools(server, store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "d442-client", version: "0.0.1" });
    await client.connect(clientTransport);
    try {
      const created = await client.callTool({
        name: "create_item",
        arguments: {
          ledger_id: IDEAS_LEDGER,
          id: "I1",
          status: "open",
          fields: { title: "stdio idea" },
        },
      });
      expect(created.isError).not.toBe(true);
      expect(store.fetchItem(IDEAS_LEDGER, "I1").milestoneId).toBe(MILESTONES_AMBIENT_ID);
      const answered = await client.callTool({
        name: "update_item",
        arguments: {
          ledger_id: QUESTIONS_LEDGER,
          item_id: "Q1",
          status: "answered",
          fields: { answer: "proceed" },
          author: "user",
        },
      });
      expect(answered.isError).not.toBe(true);
      expect(store.fetchItem(QUESTIONS_LEDGER, "Q1").fields.answer).toBe("proceed");
    } finally {
      await client.close();
      await server.close();
      await store.dispose();
    }
  });

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
