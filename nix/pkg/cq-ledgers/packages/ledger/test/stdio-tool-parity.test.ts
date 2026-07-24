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
  type ConfigCapability,
  type LedgerStore,
  type LedgerToolName,
  type ListProjectsCapability,
  type PromptCatalogCapability,
  type ReadLogCapability,
} from "../src/index.js";

const FIXED_NOW = "2026-07-24T12:00:00.000Z";
const PREFIXES = ["", "mirror"] as const;
const PROJECTED_READS = [
  "fetch_ledger",
  "fetch_item",
  "search_items",
  "fts_search",
  "fetch_milestone",
  "list_milestone_items",
] as const;

const READ_LOG_RESULT = {
  path: "raw/session.jsonl",
  content: '{"type":"result","result":"full transcript"}\n',
  truncated: false,
};
const CONFIG_RESULT = {
  configured: true,
  aliases: {
    frontier: {
      harness: "codex",
      model: "gpt-5.6",
      provider: null,
      effort: "high",
    },
  },
  reviewers: ["frontier"],
  planners: ["frontier"],
  tiers: {
    frontier: {
      harness: "codex",
      model: "gpt-5.6",
      provider: null,
      effort: "high",
    },
  },
  agentTiers: { "plan-reviewer": "frontier" },
  agentEfforts: { "plan-reviewer": "high" },
} as const;
const PROMPT_RESULT = {
  roleId: "plan-reviewer",
  kind: "dispatched-subagent" as const,
  dispatched: true,
  promptTemplate: "Full prompt catalog content.",
  version: 1,
  inputSchema: { type: "object", required: ["goalId"] },
  outputSchema: { type: "object", required: ["verdict"] },
};
const PROJECTS_RESULT = {
  projects: [
    {
      key: "parity-project",
      displayName: "Parity project",
      createdAt: FIXED_NOW,
    },
  ],
};

const readLog: ReadLogCapability = async (path) => {
  expect(path).toBe(READ_LOG_RESULT.path);
  return READ_LOG_RESULT;
};

const configCapability: ConfigCapability = {
  computeReviewers: () => ({
    configured: true,
    reviewers: [
      {
        harness: "codex",
        model: "gpt-5.6",
        provider: null,
        alias: "frontier",
        effort: "high",
      },
    ],
  }),
  computePlanners: () => ({
    configured: true,
    planners: [
      {
        harness: "codex",
        model: "gpt-5.6",
        provider: null,
        alias: "frontier",
        effort: "high",
      },
    ],
  }),
  computeConfig: () => CONFIG_RESULT,
  computeAgentModels: () => ({
    configured: true,
    agents: [
      {
        id: "plan-reviewer",
        status: "resolved",
        modelClass: "frontier",
        modelMappings: { claude: [], pi: ["openai-codex/gpt-5.6"] },
      },
    ],
  }),
};

const promptCatalog: PromptCatalogCapability = {
  fetchPrompt: (roleId) => {
    expect(roleId).toBe(PROMPT_RESULT.roleId);
    return PROMPT_RESULT;
  },
  validateInput: (roleId, input) => {
    expect(roleId).toBe(PROMPT_RESULT.roleId);
    expect(input).toEqual({ goalId: "G1" });
    return { ok: true };
  },
  validateOutput: (roleId, output) => {
    expect(roleId).toBe(PROMPT_RESULT.roleId);
    expect(output).toEqual({});
    return {
      ok: false,
      errors: [
        {
          path: "/verdict",
          message: "must have required property 'verdict'",
          keyword: "required",
          schemaPath: "#/required",
          params: { missingProperty: "verdict" },
        },
      ],
    };
  },
};

const listProjects: ListProjectsCapability = () => PROJECTS_RESULT;

type DirectTools = ReturnType<typeof createLedgerMcpTools>;

interface TextToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface ToolOutcome {
  kind: "success" | "error";
  text: string;
}

interface ComparableToolDefinition {
  name: string;
  description: string;
  inputs: string[];
  required: string[];
}

interface Fixture {
  store: InMemoryLedgerStore;
  ids: {
    activeMilestone: string;
    archivedMilestone: string;
    archivableMilestone: string;
    dependencyItem: string;
    targetItem: string;
    terminalItem: string;
    archivedItem: string;
  };
}

interface StdioConnection {
  client: Client;
  definitions: ComparableToolDefinition[];
  close(): Promise<void>;
}

interface Invocation {
  name: LedgerToolName;
  args: Record<string, unknown>;
}

async function buildFixture(): Promise<Fixture> {
  const store = new InMemoryLedgerStore({ now: () => FIXED_NOW });
  await store.init();

  const activeMilestone = await store.createMilestone({
    title: "Transport parity milestone",
    description: "active milestone full narrative",
  });
  const dependencyItem = await store.createItem("tasks", activeMilestone.id, {
    status: "planned",
    fields: { headline: "Dependency target" },
  });
  const targetItem = await store.createItem("tasks", activeMilestone.id, {
    status: "planned",
    fields: {
      headline: "Transport parity target",
      description: "transport-parity-needle full narrative",
      tags: ["wire"],
      dependsOn: [dependencyItem.id],
    },
    author: "gpt-5.6",
    session: "parity-session",
  });
  const terminalItem = await store.createItem("tasks", activeMilestone.id, {
    status: "done",
    fields: { headline: "Recovery target" },
  });

  const archivedMilestone = await store.createMilestone({
    title: "Pre-archived milestone",
  });
  const archivedItem = await store.createItem("tasks", archivedMilestone.id, {
    status: "done",
    fields: {
      headline: "Archived target",
      description: "archived full narrative",
    },
  });
  await store.updateMilestone(archivedMilestone.id, { status: "done" });
  await store.archiveMilestone(archivedMilestone.id, "pre-seeded archive");

  const archivableMilestone = await store.createMilestone({
    title: "Archive through tool",
  });
  await store.createItem("tasks", archivableMilestone.id, {
    status: "done",
    fields: { headline: "Archive-ready target" },
  });
  await store.updateMilestone(archivableMilestone.id, { status: "done" });

  return {
    store,
    ids: {
      activeMilestone: activeMilestone.id,
      archivedMilestone: archivedMilestone.id,
      archivableMilestone: archivableMilestone.id,
      dependencyItem: dependencyItem.id,
      targetItem: targetItem.id,
      terminalItem: terminalItem.id,
      archivedItem: archivedItem.id,
    },
  };
}

function directTools(store: LedgerStore, prefix: string): DirectTools {
  return createLedgerMcpTools(
    store,
    readLog,
    configCapability,
    promptCatalog,
    prefix,
    listProjects,
  );
}

function prefixed(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}_${name}`;
}

function requiredNames(schema: { required?: unknown }): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string").sort()
    : [];
}

function inputNames(schema: { properties?: unknown }): string[] {
  if (
    schema.properties === undefined ||
    schema.properties === null ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    return [];
  }
  return Object.keys(schema.properties).sort();
}

function comparableDefinition(
  name: string,
  description: string,
  schema: { properties?: unknown; required?: unknown },
): ComparableToolDefinition {
  return {
    name,
    description,
    inputs: inputNames(schema),
    required: requiredNames(schema),
  };
}

function directDefinitions(tools: DirectTools): ComparableToolDefinition[] {
  return tools
    .map((tool) => {
      const schema = z.toJSONSchema(
        z.object(tool.inputSchema as Record<string, z.ZodType>),
      );
      return comparableDefinition(tool.name, tool.description, schema);
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function connectStdio(
  store: LedgerStore,
  prefix: string,
): Promise<StdioConnection> {
  const server = new McpServer(
    { name: "stdio-parity-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerLedgerStdioTools(
    server,
    store,
    readLog,
    configCapability,
    promptCatalog,
    prefix,
    listProjects,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "stdio-parity-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const definitions = listed.tools
    .map((tool) =>
      comparableDefinition(
        tool.name,
        tool.description ?? "",
        tool.inputSchema,
      ),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    client,
    definitions,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function resultText(result: TextToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text" || first.text === undefined) {
    throw new Error("expected one text tool result");
  }
  return first.text;
}

async function invokeDirect(
  tools: DirectTools,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`direct tool not found: ${name}`);
  try {
    const result = await (tool.handler(args as never, null) as Promise<TextToolResult>);
    return { kind: "success", text: resultText(result) };
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return { kind: "error", text: error.message };
  }
}

async function invokeStdio(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as TextToolResult;
  return {
    kind: result.isError === true ? "error" : "success",
    text: resultText(result),
  };
}

function decode(outcome: ToolOutcome): unknown {
  expect(outcome.kind).toBe("success");
  return JSON.parse(outcome.text) as unknown;
}

function invocationMatrix(fixture: Fixture): Invocation[] {
  const { ids } = fixture;
  return [
    { name: "enumerate_ledgers", args: {} },
    {
      name: "fetch_ledger",
      args: {
        ledger_id: "tasks",
        projection: "compact",
        offset: 0,
        limit: 1,
      },
    },
    {
      name: "fetch_ledger_archive",
      args: {
        ledger_id: "tasks",
        archive_id: ids.archivedMilestone,
      },
    },
    {
      name: "fetch_item",
      args: {
        ledger_id: "tasks",
        item_id: ids.targetItem,
        projection: "compact",
      },
    },
    {
      name: "update_item",
      args: {
        ledger_id: "tasks",
        item_id: ids.targetItem,
        status: "wip",
        fields: {
          dependsOn: [ids.dependencyItem],
          blockedBy: ["external:E1"],
          ledgerRefs: [`tasks:${ids.dependencyItem}`],
        },
        author: "gpt-5.6",
        session: "updated-session",
      },
    },
    {
      name: "create_item",
      args: {
        ledger_id: "tasks",
        milestone_id: ids.activeMilestone,
        status: "planned",
        fields: {
          headline: "Created through tool",
          description: "created full narrative",
        },
      },
    },
    {
      name: "create_ledger",
      args: {
        name: "widgets",
        schema: {
          statusValues: ["open", "done"],
          terminalStatuses: ["done"],
          idPrefix: "W",
          fields: {
            headline: { type: "string", required: true },
          },
        },
      },
    },
    {
      name: "search_items",
      args: {
        ledger_id: "tasks",
        query: "transport-parity-needle",
        projection: "full",
      },
    },
    {
      name: "fts_search",
      args: {
        query: "transport-parity-needle",
        ledger: "tasks",
        projection: "compact",
        limit: 5,
      },
    },
    {
      name: "create_milestone",
      args: {
        title: "Created through tool",
        description: "milestone full narrative",
      },
    },
    {
      name: "update_milestone",
      args: {
        milestone_id: ids.activeMilestone,
        description: "updated full milestone narrative",
        dependsOn: [ids.archivableMilestone],
      },
    },
    {
      name: "fetch_milestone",
      args: {
        milestone_id: ids.activeMilestone,
        projection: "full",
      },
    },
    {
      name: "archive_milestone",
      args: {
        milestone_id: ids.archivableMilestone,
        summary: "archive through differential suite",
      },
    },
    {
      name: "list_milestone_items",
      args: {
        milestone_id: ids.activeMilestone,
        projection: "compact",
      },
    },
    { name: "snapshot", args: { include_archived: false } },
    { name: "derive_predicates", args: {} },
    {
      name: "reopen_item",
      args: {
        ledger_id: "tasks",
        item_id: ids.terminalItem,
        to_status: "planned",
      },
    },
    {
      name: "unarchive_item",
      args: {
        ledger_id: "tasks",
        milestone_id: ids.archivedMilestone,
        item_id: ids.archivedItem,
      },
    },
    { name: "read_log", args: { path: READ_LOG_RESULT.path } },
    { name: "get_reviewers", args: {} },
    { name: "get_planners", args: {} },
    { name: "get_config", args: {} },
    { name: "get_agent_models", args: {} },
    { name: "fetch_prompt", args: { roleId: PROMPT_RESULT.roleId } },
    {
      name: "validate_input",
      args: { roleId: PROMPT_RESULT.roleId, input: { goalId: "G1" } },
    },
    {
      name: "validate_output",
      args: { roleId: PROMPT_RESULT.roleId, output: {} },
    },
    { name: "list_projects", args: {} },
  ];
}

function assertRepresentativeContracts(
  responses: Map<LedgerToolName, unknown>,
  fixture: Fixture,
): void {
  const page = responses.get("fetch_ledger") as {
    items: Array<{ fields: Record<string, unknown> }>;
    total: number;
    offset: number;
    limit: number;
    nextOffset: number;
  };
  expect(page.items).toHaveLength(1);
  expect(page.total).toBeGreaterThan(1);
  expect({
    offset: page.offset,
    limit: page.limit,
    nextOffset: page.nextOffset,
  }).toEqual({ offset: 0, limit: 1, nextOffset: 1 });

  const archive = responses.get("fetch_ledger_archive") as {
    archive: { kind: string; milestone: { id: string } };
  };
  expect(archive.archive.kind).toBe("group");
  expect(archive.archive.milestone.id).toBe(fixture.ids.archivedMilestone);
  expect(responses.get("archive_milestone")).toMatchObject({
    pointer: { id: fixture.ids.archivableMilestone },
  });

  const updated = responses.get("update_item") as {
    item: { fields: Record<string, unknown> };
  };
  expect(updated.item.fields).toEqual({
    dependsOn: [`tasks:${fixture.ids.dependencyItem}`],
    blockedBy: ["external:E1"],
    ledgerRefs: [`tasks:${fixture.ids.dependencyItem}`],
  });
  expect(updated.item.fields).not.toHaveProperty("headline");
  expect(updated.item.fields).not.toHaveProperty("description");

  const fixedAcknowledgements = [
    ["create_item", "item"],
    ["create_milestone", "milestone"],
    ["update_milestone", "milestone"],
    ["reopen_item", "item"],
    ["unarchive_item", "item"],
  ] as const;
  for (const [toolName, envelope] of fixedAcknowledgements) {
    const response = responses.get(toolName) as Record<
      string,
      { fields: Record<string, unknown> }
    >;
    expect(response[envelope]?.fields, toolName).toBeDefined();
    expect(response[envelope]?.fields, toolName).not.toHaveProperty("headline");
    expect(response[envelope]?.fields, toolName).not.toHaveProperty("description");
  }
  expect(responses.get("create_ledger")).toEqual({
    ledger: { id: "widgets" },
  });
  expect(responses.get("update_milestone")).toMatchObject({
    milestone: {
      fields: {
        dependsOn: [`milestones:${fixture.ids.archivableMilestone}`],
      },
    },
  });

  expect(responses.get("snapshot")).toMatchObject({
    ledger: {
      tasks: {
        planned: { count: 2 },
        wip: { count: 1 },
        done: { count: 1 },
      },
    },
  });
  const predicates = responses.get("derive_predicates") as Record<
    string,
    unknown
  >;
  expect(Object.keys(predicates).sort()).toEqual(
    [
      "belowFloor",
      "goalDrift",
      "openQuestionGate",
      "pImplement",
      "pInvestigate",
      "pPlan",
      "pResearch",
      "pSeed",
    ].sort(),
  );
  expect(predicates).toMatchObject({
    pInvestigate: { value: false },
    pResearch: { value: false },
    openQuestionGate: { value: false },
  });
  expect(responses.get("reopen_item")).toMatchObject({
    item: { id: fixture.ids.terminalItem, status: "planned" },
  });
  expect(responses.get("unarchive_item")).toMatchObject({
    item: { id: fixture.ids.archivedItem, status: "done" },
  });

  expect(responses.get("read_log")).toEqual(READ_LOG_RESULT);
  expect(responses.get("get_config")).toEqual(CONFIG_RESULT);
  expect(responses.get("fetch_prompt")).toEqual(PROMPT_RESULT);
  expect(responses.get("validate_input")).toEqual({ ok: true });
  expect(responses.get("validate_output")).toMatchObject({ ok: false });
  expect(responses.get("list_projects")).toEqual(PROJECTS_RESULT);
}

// BG, specified-origin: both public registrations expose one 27-tool contract.
describe("stdio/direct ledger tool differential contract", () => {
  for (const prefix of PREFIXES) {
    it(`matches complete definitions for prefix ${JSON.stringify(prefix)}`, async () => {
      const directFixture = await buildFixture();
      const stdioFixture = await buildFixture();
      const direct = directTools(directFixture.store, prefix);
      const stdio = await connectStdio(stdioFixture.store, prefix);
      try {
        const directDefinitionList = directDefinitions(direct);
        const expectedNames = LEDGER_TOOL_NAMES
          .map((name) => prefixed(prefix, name))
          .sort();
        expect(directDefinitionList.map((tool) => tool.name)).toEqual(expectedNames);
        expect(stdio.definitions).toEqual(directDefinitionList);

        for (const name of PROJECTED_READS) {
          const definition = directDefinitionList.find(
            (tool) => tool.name === prefixed(prefix, name),
          );
          expect(definition?.inputs, `${name}: inputs`).toContain("projection");
          expect(definition?.required, `${name}: required`).toContain("projection");
        }
      } finally {
        await stdio.close();
        await directFixture.store.dispose();
        await stdioFixture.store.dispose();
      }
    });

    it(`invokes all 27 tools against independent stores for prefix ${JSON.stringify(prefix)}`, async () => {
      const directFixture = await buildFixture();
      const stdioFixture = await buildFixture();
      expect(directFixture.store).not.toBe(stdioFixture.store);
      expect(directFixture.ids).toEqual(stdioFixture.ids);
      expect(directFixture.store.snapshot()).toEqual(stdioFixture.store.snapshot());

      const direct = directTools(directFixture.store, prefix);
      const stdio = await connectStdio(stdioFixture.store, prefix);
      const invocations = invocationMatrix(directFixture);
      expect(
        invocations.map((invocation) => invocation.name).sort(),
      ).toEqual([...LEDGER_TOOL_NAMES].sort());

      const responses = new Map<LedgerToolName, unknown>();
      try {
        for (const invocation of invocations) {
          const name = prefixed(prefix, invocation.name);
          const directOutcome = await invokeDirect(
            direct,
            name,
            invocation.args,
          );
          const stdioOutcome = await invokeStdio(
            stdio.client,
            name,
            invocation.args,
          );
          expect(stdioOutcome, invocation.name).toEqual(directOutcome);
          expect(directOutcome.kind, invocation.name).toBe("success");
          responses.set(invocation.name, decode(directOutcome));
        }

        const compactArgs = {
          ledger_id: "tasks",
          item_id: directFixture.ids.targetItem,
          projection: "compact",
        };
        const fullArgs = { ...compactArgs, projection: "full" };
        const compactDirect = await invokeDirect(
          direct,
          prefixed(prefix, "fetch_item"),
          compactArgs,
        );
        const compactStdio = await invokeStdio(
          stdio.client,
          prefixed(prefix, "fetch_item"),
          compactArgs,
        );
        const fullDirect = await invokeDirect(
          direct,
          prefixed(prefix, "fetch_item"),
          fullArgs,
        );
        const fullStdio = await invokeStdio(
          stdio.client,
          prefixed(prefix, "fetch_item"),
          fullArgs,
        );
        expect(compactStdio).toEqual(compactDirect);
        expect(fullStdio).toEqual(fullDirect);
        const compact = decode(compactDirect) as {
          item: { fields: Record<string, unknown> };
        };
        const full = decode(fullDirect) as {
          item: { fields: Record<string, unknown> };
        };
        expect(compact.item.fields).not.toHaveProperty("description");
        expect(full.item.fields["description"]).toBe(
          "transport-parity-needle full narrative",
        );

        assertRepresentativeContracts(responses, directFixture);
        expect(directFixture.store.snapshot()).toEqual(stdioFixture.store.snapshot());
      } finally {
        await stdio.close();
        await directFixture.store.dispose();
        await stdioFixture.store.dispose();
      }
    });
  }

  it("rejects a missing mandatory projection and preserves handler errors", async () => {
    const directFixture = await buildFixture();
    const stdioFixture = await buildFixture();
    const direct = directTools(directFixture.store, "");
    const stdio = await connectStdio(stdioFixture.store, "");
    try {
      const fetchItem = direct.find((tool) => tool.name === "fetch_item");
      if (fetchItem === undefined) throw new Error("direct fetch_item not found");
      const input = z.object(
        fetchItem.inputSchema as Record<string, z.ZodType>,
      );
      expect(
        input.safeParse({
          ledger_id: "tasks",
          item_id: directFixture.ids.targetItem,
        }).success,
      ).toBe(false);
      const stdioValidation = await invokeStdio(stdio.client, "fetch_item", {
        ledger_id: "tasks",
        item_id: stdioFixture.ids.targetItem,
      });
      expect(stdioValidation.kind).toBe("error");
      expect(stdioValidation.text).toContain("projection");

      const missingArgs = {
        ledger_id: "tasks",
        item_id: "T999",
        projection: "full",
      };
      const directError = await invokeDirect(
        direct,
        "fetch_item",
        missingArgs,
      );
      const stdioError = await invokeStdio(
        stdio.client,
        "fetch_item",
        missingArgs,
      );
      expect(stdioError).toEqual(directError);
      expect(directError).toEqual({
        kind: "error",
        text: "Item not found in ledger tasks: T999",
      });
    } finally {
      await stdio.close();
      await directFixture.store.dispose();
      await stdioFixture.store.dispose();
    }
  });
});
