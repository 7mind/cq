import { describe, expect, it } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  ArchivePointer,
  ItemMutationAckDto,
  MilestoneMutationAckDto,
} from "@cq/ledger";
import { McpLedgerClient } from "../src/mcpClient.js";

interface RecordedCall {
  name: string;
  arguments: Record<string, unknown>;
}

function stubClient(
  responses: Record<string, unknown | unknown[]>,
): { client: McpLedgerClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const responseIndexes = new Map<string, number>();
  const sdk = {
    callTool: async (request: RecordedCall) => {
      calls.push(request);
      const configured = responses[request.name];
      const response = Array.isArray(configured)
        ? configured[responseIndexes.get(request.name) ?? 0]
        : configured;
      responseIndexes.set(request.name, (responseIndexes.get(request.name) ?? 0) + 1);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response),
          },
        ],
      };
    },
  };
  return {
    client: new McpLedgerClient(sdk as unknown as Client),
    calls,
  };
}

const item = {
  id: "T9",
  milestoneId: "M1",
  status: "wip",
  fields: {
    headline: "wire result",
    description: "full narrative",
    dependsOn: ["tasks:T1"],
  },
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T12:01:00.000Z",
};

const itemAck: ItemMutationAckDto = {
  id: "T9",
  milestoneId: "M1",
  status: "wip",
  fields: {
    dependsOn: ["tasks:T1"],
    blockedBy: ["questions:Q2"],
    ledgerRefs: ["researches:RS3"],
  },
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T12:01:00.000Z",
};

const milestoneAck: MilestoneMutationAckDto = {
  id: "M9",
  status: "open",
  fields: {
    dependsOn: ["milestones:M1"],
    blockedBy: ["milestones:M2"],
  },
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T12:01:00.000Z",
};

// BG, specified-origin: the public client emits the mandatory wire arguments.
describe("McpLedgerClient projected read wire contract", () => {
  it("passes an explicit projection through every projected read method", async () => {
    const { client, calls } = stubClient({
      fetch_ledger: {
        ledger: {
          id: "tasks",
          schema: { statusValues: ["wip"], terminalStatuses: [], fields: {} },
          counters: { milestone: 1, item: 10 },
          milestones: [],
          archivePointers: [],
        },
      },
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

    const ledger = await client.fetchLedger("tasks", "compact");
    const fetched = await client.fetchItem("tasks", "T9", "full");
    const hits = await client.ftsSearch("wire", "compact", {
      ledger: "tasks",
    });

    expect(ledger.id).toBe("tasks");
    expect(fetched.fields["description"]).toBe("full narrative");
    expect(hits).toEqual([
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
        arguments: { ledger_id: "tasks", projection: "compact" },
      },
      {
        name: "fetch_item",
        arguments: {
          ledger_id: "tasks",
          item_id: "T9",
          projection: "full",
        },
      },
      {
        name: "fts_search",
        arguments: {
          query: "wire",
          projection: "compact",
          ledger: "tasks",
        },
      },
    ]);
  });
});

describe("McpLedgerClient fixed mutation acknowledgement contract", () => {
  it("returns allocated ids and canonical references from every exposed mutation", async () => {
    const { client, calls } = stubClient({
      create_item: [{ item: itemAck }, { item: milestoneAck }],
      update_item: [{ item: itemAck }, { item: milestoneAck }],
    });

    expect(
      await client.createItem("tasks", "M1", {
        status: "planned",
        fields: { headline: "input", dependsOn: ["T1"] },
      }),
    ).toEqual(itemAck);
    expect(
      await client.updateItem("tasks", "T9", {
        status: "wip",
        fields: { blockedBy: ["Q2"] },
      }),
    ).toEqual(itemAck);
    expect(
      await client.createMilestone({
        title: "input title",
        description: "input narrative",
      }),
    ).toEqual(milestoneAck);
    expect(
      await client.updateMilestone("M9", {
        status: "open",
        title: "updated title",
      }),
    ).toEqual(milestoneAck);

    expect(calls).toEqual([
      {
        name: "create_item",
        arguments: {
          ledger_id: "tasks",
          milestone_id: "M1",
          status: "planned",
          fields: { headline: "input", dependsOn: ["T1"] },
        },
      },
      {
        name: "update_item",
        arguments: {
          ledger_id: "tasks",
          item_id: "T9",
          status: "wip",
          fields: { blockedBy: ["Q2"] },
        },
      },
      {
        name: "create_item",
        arguments: {
          ledger_id: "milestones",
          status: "open",
          fields: {
            title: "input title",
            description: "input narrative",
          },
          author: "user",
        },
      },
      {
        name: "update_item",
        arguments: {
          ledger_id: "milestones",
          item_id: "M9",
          status: "open",
          fields: { title: "updated title" },
          author: "user",
        },
      },
    ]);
  });
});

describe("McpLedgerClient archive acknowledgement contract", () => {
  it("sends the archive arguments and decodes the pointer envelope", async () => {
    const pointer: ArchivePointer = {
      id: "M9",
      path: "./archive/milestones/M9.md",
      summary: "shipped",
      title: "Milestone nine",
      status: "done",
    };
    const { client, calls } = stubClient({
      archive_milestone: { pointer },
    });

    expect(await client.archiveMilestone("M9", "shipped")).toEqual(pointer);
    expect(calls).toEqual([
      {
        name: "archive_milestone",
        arguments: {
          milestone_id: "M9",
          summary: "shipped",
        },
      },
    ]);
  });
});

describe("McpLedgerClient usage stats wire contract (T1513)", () => {
  it("calls get_usage_stats and decodes the snapshot payload", async () => {
    const snapshot = {
      endpoints: [
        { name: "fetch_item", callCount: 2, bytesIn: 30, bytesOut: 512 },
        { name: "get_usage_stats", callCount: 1, bytesIn: 2, bytesOut: 96 },
      ],
      totals: { name: "totals", callCount: 3, bytesIn: 32, bytesOut: 608 },
    };
    const { client, calls } = stubClient({ get_usage_stats: snapshot });

    expect(await client.getUsageStats()).toEqual(snapshot);
    expect(calls).toEqual([{ name: "get_usage_stats", arguments: {} }]);
  });
});
