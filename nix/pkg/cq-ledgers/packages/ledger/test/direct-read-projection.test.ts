import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  InMemoryLedgerStore,
  createLedgerMcpTools,
  type FieldValue,
  type Item,
  type ItemProjection,
  type LedgerSchema,
  type PromptCatalogCapability,
} from "../src/index.js";

const schema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: {
    headline: { type: "string", required: true },
    description: { type: "string", required: false },
    tags: { type: "string[]", required: false },
  },
};

type Tools = ReturnType<typeof createLedgerMcpTools>;
type ToolResult = { content: Array<{ type: string; text: string }> };

interface Fixture {
  store: InMemoryLedgerStore;
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
  const store = new InMemoryLedgerStore({
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

function decode(result: ToolResult): unknown {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected one text content block");
  }
  return JSON.parse(first.text) as unknown;
}

function expectedItem(item: Item, projection: ItemProjection): Item {
  if (projection === "full") return item;
  const fields: Record<string, FieldValue> = {};
  for (const fieldName of [
    "headline",
    "title",
    "question",
    "summary",
    "severity",
    "suggestedModel",
    "tags",
    "sourceRefs",
    "dependsOn",
    "blockedBy",
    "ledgerRefs",
  ]) {
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

const READ_INPUTS = {
  fetch_ledger: { ledger_id: "xenos" },
  fetch_item: { ledger_id: "xenos", item_id: "X1" },
  search_items: { ledger_id: "xenos", query: "Needle" },
  fts_search: { query: "needle", ledger: "xenos" },
  fetch_milestone: { milestone_id: "M1" },
  list_milestone_items: { milestone_id: "M1" },
} as const;

describe("createLedgerMcpTools mandatory read projections", () => {
  it("rejects omitted and invalid projections for all six item-bearing reads", async () => {
    const { tools } = await buildFixture();

    for (const [name, args] of Object.entries(READ_INPUTS)) {
      const tool = findTool(tools, name);
      const input = z.object(tool.inputSchema);
      expect(input.safeParse(args).success, `${name}: omitted`).toBe(false);
      expect(
        input.safeParse({ ...args, projection: "summary" }).success,
        `${name}: invalid`,
      ).toBe(false);
      expect(
        input.safeParse({ ...args, projection: "compact" }).success,
        `${name}: compact`,
      ).toBe(true);
      expect(
        input.safeParse({ ...args, projection: "full" }).success,
        `${name}: full`,
      ).toBe(true);
      expect("compact" in tool.inputSchema, `${name}: obsolete compact`).toBe(
        false,
      );
    }
  });

  for (const projection of ["compact", "full"] as const) {
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
      expect(
        decode(
          await callTool(tools, "fetch_ledger", {
            ledger_id: "xenos",
            projection,
          }),
        ),
        "fetch_ledger",
      ).toEqual({ ledger: expectedLedger });

      expect(
        decode(
          await callTool(tools, "fetch_item", {
            ledger_id: "xenos",
            item_id: first.id,
            projection,
          }),
        ),
        "fetch_item",
      ).toEqual({ item: expectedItem(first, projection) });

      expect(
        decode(
          await callTool(tools, "search_items", {
            ledger_id: "xenos",
            query: "Needle",
            projection,
          }),
        ),
        "search_items",
      ).toEqual({ items: [expectedItem(first, projection)] });

      const authoritativeHits = await store.ftsSearch("needle", {
        ledger: "xenos",
      });
      expect(
        decode(
          await callTool(tools, "fts_search", {
            query: "needle",
            ledger: "xenos",
            projection,
          }),
        ),
        "fts_search",
      ).toEqual({
        results: authoritativeHits.map((hit) => ({
          ...hit,
          item: expectedItem(hit.item, projection),
        })),
      });

      const fetchedMilestone = store.fetchMilestone(milestone.id);
      expect(
        decode(
          await callTool(tools, "fetch_milestone", {
            milestone_id: milestone.id,
            projection,
          }),
        ),
        "fetch_milestone",
      ).toEqual({
        ...fetchedMilestone,
        milestone: expectedItem(fetchedMilestone.milestone, projection),
      });

      const milestoneItems = store.listMilestoneItems(milestone.id);
      expect(
        decode(
          await callTool(tools, "list_milestone_items", {
            milestone_id: milestone.id,
            projection,
          }),
        ),
        "list_milestone_items",
      ).toEqual({
        items: Object.fromEntries(
          Object.entries(milestoneItems).map(([ledgerId, items]) => [
            ledgerId,
            items.map((item) => expectedItem(item, projection)),
          ]),
        ),
      });
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
