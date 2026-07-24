import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpLedgerClient } from "../src/mcpClient.js";

interface ToolCall {
  name: string;
  args: unknown;
}

function stubClient(
  responses: Record<string, unknown>,
): { client: Client; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const stub = {
    callTool: async ({
      name,
      arguments: args,
    }: {
      name: string;
      arguments: unknown;
    }) => {
      calls.push({ name, args });
      const response = responses[name];
      if (response === undefined) throw new Error(`unexpected tool ${name}`);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    },
  };
  return { client: stub as unknown as Client, calls };
}

describe("McpLedgerClient projection and acknowledgement contract", () => {
  it("sends an explicit projection for every item-bearing read", async () => {
    const ledger = {
      id: "tasks",
      schema: {
        idPrefix: "T",
        fields: {},
        statusValues: ["planned"],
        terminalStatuses: [],
      },
      counters: { milestone: 1, item: 2 },
      milestones: [],
      archivePointers: [],
    };
    const item = {
      id: "T1",
      milestoneId: "M1",
      status: "planned",
      fields: { headline: "Task" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const { client: stub, calls } = stubClient({
      fetch_ledger: { ledger },
      fetch_item: { item },
      fts_search: {
        results: [
          {
            ledgerId: "tasks",
            item,
            score: 1,
            matchedFields: ["headline"],
          },
        ],
      },
    });
    const client = new McpLedgerClient(stub);

    expect(await client.fetchLedger("tasks", "compact")).toEqual(ledger);
    expect(await client.fetchItem("tasks", "T1", "full")).toEqual(item);
    expect(await client.ftsSearch("Task", "compact", { ledger: "tasks" }))
      .toEqual([
        {
          ledgerId: "tasks",
          item,
          score: 1,
          matchedFields: ["headline"],
        },
      ]);
    expect(calls).toEqual([
      {
        name: "fetch_ledger",
        args: { ledger_id: "tasks", projection: "compact" },
      },
      {
        name: "fetch_item",
        args: {
          ledger_id: "tasks",
          item_id: "T1",
          projection: "full",
        },
      },
      {
        name: "fts_search",
        args: {
          query: "Task",
          projection: "compact",
          ledger: "tasks",
        },
      },
    ]);
  });

  it("decodes fixed mutation acknowledgements without requiring full entities", async () => {
    const created = {
      id: "T42",
      milestoneId: "M1",
      status: "planned",
      fields: { dependsOn: ["tasks:T1"] },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const updated = {
      ...created,
      status: "wip",
      fields: { dependsOn: ["tasks:T1"], blockedBy: ["researches:RS1"] },
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const milestone = {
      id: "M42",
      status: "open",
      fields: { dependsOn: ["milestones:M1"] },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const pointer = {
      id: "M42",
      path: "./archive/milestones/M42.md",
      summary: "finished",
      title: "Milestone",
      status: "done",
    };
    const { client: stub, calls } = stubClient({
      create_item: { item: created },
      update_item: { item: updated },
      create_milestone: { milestone },
      update_milestone: { milestone: { ...milestone, status: "done" } },
      archive_milestone: { pointer },
    });
    const client = new McpLedgerClient(stub);

    expect(
      await client.createItem("tasks", "M1", {
        status: "planned",
        fields: { headline: "not returned in the acknowledgement" },
      }),
    ).toEqual(created);
    expect(
      await client.updateItem("tasks", "T42", {
        status: "wip",
        fields: { description: "also not returned" },
      }),
    ).toEqual(updated);
    expect(await client.createMilestone({ title: "Milestone" }))
      .toEqual(milestone);
    expect(await client.updateMilestone("M42", { status: "done" }))
      .toEqual({ ...milestone, status: "done" });
    expect(await client.archiveMilestone("M42", "finished")).toEqual(pointer);
    expect(calls).toEqual([
      {
        name: "create_item",
        args: {
          ledger_id: "tasks",
          milestone_id: "M1",
          status: "planned",
          fields: { headline: "not returned in the acknowledgement" },
        },
      },
      {
        name: "update_item",
        args: {
          ledger_id: "tasks",
          item_id: "T42",
          status: "wip",
          fields: { description: "also not returned" },
        },
      },
      {
        name: "create_milestone",
        args: { title: "Milestone" },
      },
      {
        name: "update_milestone",
        args: { milestone_id: "M42", status: "done" },
      },
      {
        name: "archive_milestone",
        args: { milestone_id: "M42", summary: "finished" },
      },
    ]);
  });
});
