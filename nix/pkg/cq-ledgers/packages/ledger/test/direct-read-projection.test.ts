import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  InMemoryLedgerStore,
  createLedgerMcpTools,
  type FieldValue,
  type FetchedMilestoneItem,
  type Item,
  type ItemDto,
  type ItemProjection,
  type LedgerSchema,
  type PromptCatalogCapability,
} from "../src/index.js";

const MILESTONE_NOTE = "Valid milestone field outside the compact allowlist";

const schema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: {
    headline: { type: "string", required: true },
    description: { type: "string", required: false },
    note: { type: "string", required: false },
    tags: { type: "string[]", required: false },
  },
};

type Tools = ReturnType<typeof createLedgerMcpTools>;
type ToolResult = { content: Array<{ type: string; text: string }> };

class ProjectionFixtureStore extends InMemoryLedgerStore {
  override fetchMilestone(milestoneId: string): FetchedMilestoneItem {
    const fetched = super.fetchMilestone(milestoneId);
    return {
      ...fetched,
      milestone: {
        ...fetched.milestone,
        fields: {
          ...fetched.milestone.fields,
          note: MILESTONE_NOTE,
        },
      },
    };
  }
}

interface Fixture {
  store: ProjectionFixtureStore;
  tools: Tools;
  milestone: Item;
  first: Item;
  second: Item;
}

async function buildFixture(
  readLog?: (path: string) => Promise<{
    path: string;
    content: string;
    truncated?: boolean;
  }>,
  promptCatalog?: PromptCatalogCapability,
): Promise<Fixture> {
  const store = new ProjectionFixtureStore({
    seed: [{ name: "xenos", schema }],
  });
  await store.init();
  const createdMilestone = await store.createMilestone({
    title: "Projection milestone",
    description: "Milestone narrative",
  });
  await store.updateItem("milestones", createdMilestone.id, {
    author: "gpt-5.6",
    session: "session-milestone",
  });
  const milestone = store.fetchItem("milestones", createdMilestone.id);
  const first = await store.createItem("xenos", milestone.id, {
    status: "open",
    fields: {
      headline: "Needle alpha",
      description: "Private needle narrative",
      note: "Valid short field outside the compact allowlist",
      tags: ["one"],
    },
    author: "gpt-5.6",
    session: "session-first",
  });
  const second = await store.createItem("xenos", milestone.id, {
    status: "open",
    fields: {
      headline: "Second item",
      description: "Different private narrative",
      note: "Second valid short field outside the compact allowlist",
      tags: ["two"],
    },
  });
  return {
    store,
    tools: createLedgerMcpTools(
      store,
      readLog,
      undefined,
      promptCatalog,
    ),
    milestone,
    first,
    second,
  };
}

function findTool(tools: Tools, name: string) {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`tool not found: ${name}`);
  return found;
}

function callTool(
  tools: Tools,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return findTool(tools, name).handler(args as never, null) as Promise<ToolResult>;
}

function decode<T = unknown>(result: ToolResult): T {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected one text content block");
  }
  return JSON.parse(first.text) as T;
}

const EXPECTED_COMPACT_FIELD_NAMES = [
  "headline",
  "title",
  "question",
  "answer",
  "summary",
  "severity",
  "suggestedModel",
  "tags",
  "sourceRefs",
  "dependsOn",
  "blockedBy",
  "ledgerRefs",
] as const;

const EXPECTED_COMPACT_FIELD_NAME_SET = new Set<string>(EXPECTED_COMPACT_FIELD_NAMES);

function expectedItem(item: Item, projection: ItemProjection): ItemDto {
  if (projection === "full") return item;
  const fields: Record<string, FieldValue> = {};
  if (projection === "complement") {
    for (const [fieldName, value] of Object.entries(item.fields)) {
      if (!EXPECTED_COMPACT_FIELD_NAME_SET.has(fieldName) && value !== undefined) {
        fields[fieldName] = value;
      }
    }
    return { id: item.id, fields };
  }
  for (const fieldName of EXPECTED_COMPACT_FIELD_NAMES) {
    const value = item.fields[fieldName];
    if (value !== undefined) fields[fieldName] = value;
  }
  const compact: Item = {
    id: item.id,
    milestoneId: item.milestoneId,
    status: item.status,
    fields,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.author !== undefined) compact.author = item.author;
  if (item.session !== undefined) compact.session = item.session;
  return compact;
}

function expectNoteOmitted(toolName: string, items: ItemDto[]): void {
  expect(items.length, `${toolName}: fixture items`).toBeGreaterThan(0);
  for (const item of items) {
    expect(item.fields, `${toolName}: ${item.id}`).not.toHaveProperty("note");
  }
}

function expectExactComplement(toolName: string, items: ItemDto[]): void {
  expect(items.length, `${toolName}: fixture items`).toBeGreaterThan(0);
  for (const item of items) {
    expect(Object.keys(item).sort(), `${toolName}: ${item.id} envelope`).toEqual([
      "fields",
      "id",
    ]);
    expect(item.fields, `${toolName}: ${item.id} narrative`).toHaveProperty("description");
    expect(item.fields, `${toolName}: ${item.id} note`).toHaveProperty("note");
    for (const fieldName of EXPECTED_COMPACT_FIELD_NAMES) {
      expect(item.fields, `${toolName}: ${item.id} compact field ${fieldName}`).not.toHaveProperty(
        fieldName,
      );
    }
  }
}

const READ_SCHEMA_CASES = [
  { label: "fetch_ledger", tool: "fetch_ledger", args: { ledger_id: "xenos" } },
  { label: "fetch_item", tool: "fetch_item", args: { ledger_id: "xenos", item_id: "X1" } },
  { label: "search_items", tool: "search_items", args: { ledger_id: "xenos", query: "Needle" } },
  { label: "fts_search", tool: "fts_search", args: { query: "needle", ledger: "xenos" } },
  {
    label: "milestones-via-fetch_item",
    tool: "fetch_item",
    args: { ledger_id: "milestones", item_id: "M1" },
  },
  {
    label: "list_milestone_items",
    tool: "list_milestone_items",
    args: { milestone_id: "M1" },
  },
] as const;

describe("createLedgerMcpTools mandatory read projections", () => {
  it("parses complement and rejects omitted/invalid projections for all six read paths", async () => {
    const { tools } = await buildFixture();

    for (const { label, tool: toolName, args } of READ_SCHEMA_CASES) {
      const tool = findTool(tools, toolName);
      const input = z.object(tool.inputSchema);
      expect(input.safeParse(args).success, `${label}: omitted`).toBe(false);
      expect(input.safeParse({ ...args, projection: "summary" }).success, `${label}: invalid`).toBe(
        false,
      );
      expect(input.safeParse({ ...args, projection: "compact" }).success, `${label}: compact`).toBe(
        true,
      );
      expect(input.safeParse({ ...args, projection: "full" }).success, `${label}: full`).toBe(true);
      expect(
        input.safeParse({ ...args, projection: "complement" }).success,
        `${label}: complement`,
      ).toBe(true);
      expect("compact" in tool.inputSchema, `${label}: obsolete compact`).toBe(false);
    }
  });

  for (const projection of ["compact", "full", "complement"] as const) {
    it(`emits exact ${projection} envelopes for every eligible read`, async () => {
      const fixture = await buildFixture();
      const { store, tools, milestone, first } = fixture;

      const fetchedLedger = store.fetch("xenos");
      const expectedLedger = {
        ...fetchedLedger,
        milestones: fetchedLedger.milestones.map((group) => ({
          ...group,
          items: group.items.map((item) => expectedItem(item, projection)),
        })),
      };
      const ledgerResponse = decode<{ ledger: typeof expectedLedger }>(
        await callTool(tools, "fetch_ledger", {
          ledger_id: "xenos",
          projection,
        }),
      );
      expect(ledgerResponse, "fetch_ledger").toEqual({
        ledger: expectedLedger,
      });

      const itemResponse = decode<{ item: ItemDto }>(
        await callTool(tools, "fetch_item", {
          ledger_id: "xenos",
          item_id: first.id,
          projection,
        }),
      );
      expect(itemResponse, "fetch_item").toEqual({
        item: expectedItem(first, projection),
      });

      const searchResponse = decode<{ items: ItemDto[] }>(
        await callTool(tools, "search_items", {
          ledger_id: "xenos",
          query: "Needle",
          projection,
        }),
      );
      expect(searchResponse, "search_items").toEqual({
        items: [expectedItem(first, projection)],
      });

      const authoritativeHits = await store.ftsSearch("needle", {
        ledger: "xenos",
      });
      const ftsResponse = decode<{ results: Array<{ item: ItemDto }> }>(
        await callTool(tools, "fts_search", {
          query: "needle",
          ledger: "xenos",
          projection,
        }),
      );
      expect(ftsResponse, "fts_search").toEqual({
        results: authoritativeHits.map((hit) => ({
          ...hit,
          item: expectedItem(hit.item, projection),
        })),
      });

      const fetchedMilestone = store.fetchMilestone(milestone.id);
      expect(fetchedMilestone.milestone.fields["note"], "root fetch source precondition").toBe(
        MILESTONE_NOTE,
      );
      const milestoneResponse = decode<{
        item: ItemDto;
        resolved: typeof fetchedMilestone.resolved;
        references: typeof fetchedMilestone.references;
      }>(
        await callTool(tools, "fetch_item", {
          ledger_id: "milestones",
          item_id: milestone.id,
          projection,
        }),
      );
      expect(milestoneResponse, "root fetch").toEqual({
        item: expectedItem(fetchedMilestone.milestone, projection),
        resolved: fetchedMilestone.resolved,
        references: fetchedMilestone.references,
      });

      const milestoneItems = store.listMilestoneItems(milestone.id);
      const milestoneItemsResponse = decode<{
        items: Record<string, ItemDto[]>;
      }>(
        await callTool(tools, "list_milestone_items", {
          milestone_id: milestone.id,
          projection,
        }),
      );
      expect(milestoneItemsResponse, "list_milestone_items").toEqual({
        items: Object.fromEntries(
          Object.entries(milestoneItems).map(([ledgerId, items]) => [
            ledgerId,
            items.map((item) => expectedItem(item, projection)),
          ]),
        ),
      });

      if (projection === "compact") {
        expectNoteOmitted(
          "fetch_ledger",
          ledgerResponse.ledger.milestones.flatMap((group) => group.items),
        );
        expectNoteOmitted("fetch_item", [itemResponse.item]);
        expectNoteOmitted("search_items", searchResponse.items);
        expectNoteOmitted(
          "fts_search",
          ftsResponse.results.map((result) => result.item),
        );
        expectNoteOmitted("root fetch", [milestoneResponse.item]);
        expectNoteOmitted(
          "list_milestone_items",
          Object.values(milestoneItemsResponse.items).flat(),
        );
      }
      if (projection === "complement") {
        expectExactComplement(
          "fetch_ledger",
          ledgerResponse.ledger.milestones.flatMap((group) => group.items),
        );
        expectExactComplement("fetch_item", [itemResponse.item]);
        expectExactComplement("search_items", searchResponse.items);
        expectExactComplement(
          "fts_search",
          ftsResponse.results.map((result) => result.item),
        );
        expectExactComplement("milestones-via-fetch_item", [milestoneResponse.item]);
        expectExactComplement(
          "list_milestone_items",
          Object.values(milestoneItemsResponse.items).flat(),
        );
      }
    });
  }

  it("preserves pagination metadata and exposes the next offset", async () => {
    const { store, tools, first, second } = await buildFixture();
    const { milestones, ...ledger } = store.fetch("xenos");
    void milestones;

    const firstPage = decode(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "xenos",
        projection: "compact",
        offset: 0,
        limit: 1,
      }),
    );
    expect(firstPage).toEqual({
      ledger,
      items: [expectedItem(first, "compact")],
      total: 2,
      offset: 0,
      limit: 1,
      nextOffset: 1,
    });

    const lastPage = decode(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "xenos",
        projection: "full",
        offset: 1,
        limit: 1,
      }),
    );
    expect(lastPage).toEqual({
      ledger,
      items: [second],
      total: 2,
      offset: 1,
      limit: 1,
      nextOffset: null,
    });

    const complementPage = decode(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "xenos",
        projection: "complement",
        offset: 0,
        limit: 1,
      }),
    );
    expect(complementPage).toEqual({
      ledger,
      items: [expectedItem(first, "complement")],
      total: 2,
      offset: 0,
      limit: 1,
      nextOffset: 1,
    });
  });

  it("keeps unchanged tools byte-compatible and all JSON minified", async () => {
    const logPayload = {
      path: "raw/session.jsonl",
      content: '{"type":"result"}\n',
      truncated: false,
    };
    const promptPayload = {
      roleId: "plan-reviewer",
      kind: "dispatched-subagent" as const,
      dispatched: true,
      promptTemplate: "Complete prompt body.",
      version: 1,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    };
    const promptCatalog: PromptCatalogCapability = {
      fetchPrompt: () => promptPayload,
      validateInput: () => ({ ok: true }),
      validateOutput: () => ({ ok: true }),
    };
    const { store, tools } = await buildFixture(
      async () => logPayload,
      promptCatalog,
    );

    const cases = [
      {
        name: "snapshot",
        args: {},
        expected: { ledger: store.snapshot() },
      },
      {
        name: "read_log",
        args: { path: logPayload.path },
        expected: logPayload,
      },
      {
        name: "fetch_prompt",
        args: { roleId: promptPayload.roleId },
        expected: promptPayload,
      },
    ] as const;

    for (const testCase of cases) {
      const result = await callTool(tools, testCase.name, testCase.args);
      expect(result.content[0]?.text, testCase.name).toBe(
        JSON.stringify(testCase.expected),
      );
      expect(result.content[0]?.text.includes("\n"), testCase.name).toBe(
        false,
      );
    }
  });
});
