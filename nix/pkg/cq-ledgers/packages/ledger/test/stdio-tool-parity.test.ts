import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createLedgerMcpTools,
  InMemoryLedgerStore,
  LEDGER_TOOL_NAMES,
  registerLedgerStdioTools,
  type FetchedLedger,
  type Item,
  type LedgerStore,
} from "../src/index.js";

interface ComparableToolDefinition {
  name: string;
  description: string;
  required: string[];
}

interface TextToolResult {
  content: Array<{ type: string; text?: string }>;
}

async function initializedStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

function directDefinitions(
  store: LedgerStore,
  prefix: string,
): ComparableToolDefinition[] {
  return createLedgerMcpTools(
    store,
    undefined,
    undefined,
    undefined,
    prefix,
  )
    .map((tool) => {
      const schema = z.toJSONSchema(
        z.object(tool.inputSchema as Record<string, z.ZodType>),
      );
      return {
        name: tool.name,
        description: tool.description,
        required: Array.isArray(schema.required)
          ? [...schema.required].sort()
          : [],
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function stdioDefinitions(
  store: LedgerStore,
  prefix: string,
): Promise<ComparableToolDefinition[]> {
  const server = new McpServer(
    { name: "stdio-parity-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerLedgerStdioTools(
    server,
    store,
    undefined,
    undefined,
    undefined,
    prefix,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "stdio-parity-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  try {
    const response = await client.listTools();
    return response.tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        required: Array.isArray(tool.inputSchema.required)
          ? [...tool.inputSchema.required].sort()
          : [],
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    await client.close();
  }
}

function resultText(result: TextToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text" || first.text === undefined) {
    throw new Error("expected a text tool result");
  }
  return first.text;
}

async function invokeDirect(
  tools: ReturnType<typeof createLedgerMcpTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<TextToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`direct tool not found: ${name}`);
  return await (tool.handler(args as never, null) as Promise<TextToolResult>);
}

async function connectStdio(
  store: LedgerStore,
  prefix: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpServer(
    { name: "stdio-response-parity-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerLedgerStdioTools(
    server,
    store,
    undefined,
    undefined,
    undefined,
    prefix,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "stdio-response-parity-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

async function invokeStdio(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<TextToolResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as TextToolResult;
}

function prefixed(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}_${name}`;
}

// BG, specified-origin: both public registrations expose one wire contract.
describe("stdio/direct ledger tool definition parity", () => {
  for (const prefix of ["", "mirror"]) {
    it(`matches all 27 names, descriptions, and required arguments for prefix ${JSON.stringify(prefix)}`, async () => {
      const store = await initializedStore();
      const direct = directDefinitions(store, prefix);
      const stdio = await stdioDefinitions(store, prefix);

      expect(direct).toHaveLength(LEDGER_TOOL_NAMES.length);
      expect(stdio).toEqual(direct);
    });
  }
});

describe("stdio/direct projected read response parity", () => {
  for (const prefix of ["", "mirror"]) {
    it(`matches compact, full, and paginated envelopes byte-for-byte for prefix ${JSON.stringify(prefix)}`, async () => {
      const store = await initializedStore();
      const milestone = await store.createMilestone({
        title: "Read fixture milestone",
        description: "milestone narrative",
      });
      const item = await store.createItem("tasks", milestone.id, {
        status: "planned",
        fields: {
          headline: "Transport parity target",
          description: "transport-parity-needle narrative",
          tags: ["wire"],
        },
        author: "gpt-5.6",
        session: "read-session",
      });
      const direct = createLedgerMcpTools(
        store,
        undefined,
        undefined,
        undefined,
        prefix,
      );
      const stdio = await connectStdio(store, prefix);
      const responses = new Map<string, string>();
      try {
        for (const projection of ["compact", "full"] as const) {
          const cases: Array<{
            name: string;
            args: Record<string, unknown>;
          }> = [
            {
              name: "fetch_ledger",
              args: { ledger_id: "tasks", projection },
            },
            {
              name: "fetch_item",
              args: { ledger_id: "tasks", item_id: item.id, projection },
            },
            {
              name: "search_items",
              args: {
                ledger_id: "tasks",
                query: "transport-parity-needle",
                projection,
              },
            },
            {
              name: "fts_search",
              args: {
                query: "transport-parity-needle",
                ledger: "tasks",
                projection,
              },
            },
            {
              name: "fetch_milestone",
              args: { milestone_id: milestone.id, projection },
            },
            {
              name: "list_milestone_items",
              args: { milestone_id: milestone.id, projection },
            },
          ];

          for (const testCase of cases) {
            const name = prefixed(prefix, testCase.name);
            const directText = resultText(
              await invokeDirect(direct, name, testCase.args),
            );
            const stdioText = resultText(
              await invokeStdio(stdio.client, name, testCase.args),
            );
            expect(stdioText).toBe(directText);
            expect(JSON.parse(stdioText)).toEqual(JSON.parse(directText));
            responses.set(`${testCase.name}:${projection}`, stdioText);
          }
        }

        const paginationArgs = {
          ledger_id: "tasks",
          projection: "compact",
          offset: 0,
          limit: 1,
        };
        const paginationName = prefixed(prefix, "fetch_ledger");
        const directPagination = resultText(
          await invokeDirect(direct, paginationName, paginationArgs),
        );
        const stdioPagination = resultText(
          await invokeStdio(
            stdio.client,
            paginationName,
            paginationArgs,
          ),
        );
        expect(stdioPagination).toBe(directPagination);
        expect(JSON.parse(stdioPagination)).toEqual(
          JSON.parse(directPagination),
        );

        const compactItem = JSON.parse(
          responses.get("fetch_item:compact") ?? "{}",
        ) as { item: { fields: Record<string, unknown> } };
        const fullItem = JSON.parse(
          responses.get("fetch_item:full") ?? "{}",
        ) as { item: { fields: Record<string, unknown> } };
        expect(compactItem.item.fields).toEqual({
          headline: "Transport parity target",
          tags: ["wire"],
        });
        expect(fullItem.item.fields["description"]).toBe(
          "transport-parity-needle narrative",
        );

        const page = JSON.parse(stdioPagination) as {
          items: unknown[];
          total: number;
          offset: number;
          limit: number | null;
          nextOffset: number | null;
        };
        expect({
          itemCount: page.items.length,
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          nextOffset: page.nextOffset,
        }).toEqual({
          itemCount: 1,
          total: 1,
          offset: 0,
          limit: 1,
          nextOffset: null,
        });
      } finally {
        await stdio.close();
      }
    });
  }
});

describe("stdio/direct mutation acknowledgement parity", () => {
  for (const prefix of ["", "mirror"]) {
    it(`matches all seven fixed acknowledgements byte-for-byte for prefix ${JSON.stringify(prefix)}`, async () => {
      const item: Item = {
        id: "T42",
        milestoneId: "M7",
        status: "wip",
        fields: {
          headline: "omitted narrative",
          description: "omitted narrative body",
          dependsOn: ["tasks:T1"],
          blockedBy: ["questions:Q2"],
          ledgerRefs: ["goals:G3"],
        },
        createdAt: "2026-07-24T12:00:00.000Z",
        updatedAt: "2026-07-24T12:01:00.000Z",
        author: "gpt-5.6",
        session: "mutation-session",
      };
      const milestone: Item = {
        ...item,
        id: "M7",
        milestoneId: "active",
        status: "blocked",
        fields: {
          title: "omitted milestone title",
          description: "omitted milestone body",
          dependsOn: ["milestones:M1"],
          blockedBy: ["milestones:M2"],
        },
      };
      const ledger: FetchedLedger = {
        id: "widgets",
        schema: {
          statusValues: ["open", "done"],
          terminalStatuses: ["done"],
          fields: {},
        },
        counters: { milestone: 0, item: 0 },
        milestones: [],
        archivePointers: [],
      };
      const store = {
        updateItem: async () => item,
        createItem: async () => item,
        createLedger: async () => ledger,
        createMilestone: async () => milestone,
        updateMilestone: async () => milestone,
        reopenItem: async () => item,
        unarchiveItem: async () => item,
      } as unknown as LedgerStore;
      const direct = createLedgerMcpTools(
        store,
        undefined,
        undefined,
        undefined,
        prefix,
      );
      const stdio = await connectStdio(store, prefix);
      const itemAcknowledgement = {
        item: {
          id: item.id,
          milestoneId: item.milestoneId,
          status: item.status,
          fields: {
            dependsOn: item.fields["dependsOn"],
            blockedBy: item.fields["blockedBy"],
            ledgerRefs: item.fields["ledgerRefs"],
          },
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          author: item.author,
          session: item.session,
        },
      };
      const milestoneAcknowledgement = {
        milestone: {
          id: milestone.id,
          status: milestone.status,
          fields: {
            dependsOn: milestone.fields["dependsOn"],
            blockedBy: milestone.fields["blockedBy"],
          },
          createdAt: milestone.createdAt,
          updatedAt: milestone.updatedAt,
          author: milestone.author,
          session: milestone.session,
        },
      };
      const cases: Array<{
        name: string;
        args: Record<string, unknown>;
        expected: unknown;
      }> = [
        {
          name: "update_item",
          args: { ledger_id: "tasks", item_id: "T42", status: "wip" },
          expected: itemAcknowledgement,
        },
        {
          name: "create_item",
          args: {
            ledger_id: "tasks",
            milestone_id: "M7",
            status: "planned",
            fields: { headline: "input" },
          },
          expected: itemAcknowledgement,
        },
        {
          name: "create_ledger",
          args: {
            name: "widgets",
            schema: {
              statusValues: ["open", "done"],
              terminalStatuses: ["done"],
              fields: {},
            },
          },
          expected: { ledger: { id: "widgets" } },
        },
        {
          name: "create_milestone",
          args: { title: "input" },
          expected: milestoneAcknowledgement,
        },
        {
          name: "update_milestone",
          args: { milestone_id: "M7", status: "blocked" },
          expected: milestoneAcknowledgement,
        },
        {
          name: "reopen_item",
          args: {
            ledger_id: "tasks",
            item_id: "T42",
            to_status: "wip",
          },
          expected: itemAcknowledgement,
        },
        {
          name: "unarchive_item",
          args: {
            ledger_id: "tasks",
            milestone_id: "M7",
            item_id: "T42",
          },
          expected: itemAcknowledgement,
        },
      ];

      try {
        for (const testCase of cases) {
          const name = prefixed(prefix, testCase.name);
          const directText = resultText(
            await invokeDirect(direct, name, testCase.args),
          );
          const stdioText = resultText(
            await invokeStdio(stdio.client, name, testCase.args),
          );
          expect(stdioText).toBe(directText);
          expect(stdioText).toBe(JSON.stringify(testCase.expected));
          expect(JSON.parse(stdioText)).toEqual(testCase.expected);
        }
      } finally {
        await stdio.close();
      }
    });
  }
});
