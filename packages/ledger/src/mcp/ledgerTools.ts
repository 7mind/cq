/**
 * Ledger MCP tool factory.
 *
 * Returns an array of `tool()` instances ready to be passed to
 * `createSdkMcpServer({ name: 'cq', tools: [...askTools, ...ledgerTools] })`.
 *
 * Each handler turns the validated input into a single LedgerStore call,
 * serialises the result as JSON, and returns it as a text content block.
 * Errors are surfaced via thrown Error (the SDK reports them as tool errors).
 *
 * Auto-allow: tool names are prefixed `mcp__cq__*` automatically by the SDK;
 * the bridge's existing `canUseTool` auto-allow rule already covers them.
 */

import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { LedgerStore } from "../store/LedgerStore.js";
import type { FieldValue, LedgerSchema } from "../types.js";

/**
 * The SDK's `tools?:` field on createSdkMcpServer is typed as
 * `Array<SdkMcpToolDefinition<any>>`. We alias that here so our factory
 * can return a heterogeneous list of tools without TS rejecting the union.
 *
 * The `any` in the schema generic is the SDK's own choice (see
 * `sdk.d.ts`); we re-use it intentionally as a typed-boundary escape hatch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = SdkMcpToolDefinition<any>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

const FIELD_TYPE_VALUES = ["string", "string[]", "id", "id[]", "timestamp"] as const;

const fieldSpecSchema = z.object({
  type: z.enum(FIELD_TYPE_VALUES),
  required: z.boolean(),
});

const schemaSchema = z.object({
  statusValues: z.array(z.string()).min(1),
  terminalStatuses: z.array(z.string()),
  fields: z.record(z.string(), fieldSpecSchema),
});

/**
 * Field values may be string, string[], or number (timestamp). The MCP
 * subprocess passes them as raw JSON, so we accept the union here.
 */
const fieldValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.number(),
]);

const fieldsSchema = z.record(z.string(), fieldValueSchema);

/**
 * The MCP SDK is strict about input schemas being plain Zod object shapes
 * (key → Zod type), not a full ZodObject. Each tool below declares its
 * input schema as such a record literal.
 */

// ---------------------------------------------------------------------------
// Tool builders
// ---------------------------------------------------------------------------

export function createLedgerMcpTools(store: LedgerStore): AnyTool[] {
  const enumerateLedgers = tool(
    "enumerate_ledgers",
    "List all known ledger names.",
    {} as Record<string, never>,
    async () => jsonResult({ ledgers: store.enumerate() }),
  );

  const fetchLedger = tool(
    "fetch_ledger",
    "Fetch a ledger: schema, active milestones (with their items), and archive pointers.",
    { ledger_id: z.string() } as const,
    async (args) => jsonResult({ ledger: store.fetch(args.ledger_id) }),
  );

  const fetchLedgerArchive = tool(
    "fetch_ledger_archive",
    "Fetch a specific archived milestone (full items).",
    {
      ledger_id: z.string(),
      archive_id: z.string(),
    } as const,
    async (args) =>
      jsonResult({ milestone: await store.fetchArchive(args.ledger_id, args.archive_id) }),
  );

  const fetchMilestone = tool(
    "fetch_milestone",
    "Fetch a single active milestone by id.",
    {
      ledger_id: z.string(),
      milestone_id: z.string(),
    } as const,
    async (args) =>
      jsonResult({ milestone: store.fetchMilestone(args.ledger_id, args.milestone_id) }),
  );

  const updateMilestone = tool(
    "update_milestone",
    "Update a milestone's title and/or description. Items are not affected.",
    {
      ledger_id: z.string(),
      milestone_id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
    } as const,
    async (args) => {
      const patch: { title?: string; description?: string } = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.description !== undefined) patch.description = args.description;
      const milestone = await store.updateMilestone(args.ledger_id, args.milestone_id, patch);
      return jsonResult({ milestone });
    },
  );

  const ledgerFetch = tool(
    "ledger_fetch",
    "Fetch a single item by id.",
    {
      ledger_id: z.string(),
      item_id: z.string(),
    } as const,
    async (args) => jsonResult({ item: store.fetchItem(args.ledger_id, args.item_id) }),
  );

  const ledgerUpdate = tool(
    "ledger_update",
    "Update an item's status and/or fields. Provided fields replace existing values; omitted fields are preserved.",
    {
      ledger_id: z.string(),
      item_id: z.string(),
      status: z.string().optional(),
      fields: fieldsSchema.optional(),
    } as const,
    async (args) => {
      const patch: { status?: string; fields?: Record<string, FieldValue> } = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.fields !== undefined) patch.fields = args.fields as Record<string, FieldValue>;
      const item = await store.updateItem(args.ledger_id, args.item_id, patch);
      return jsonResult({ item });
    },
  );

  const createItem = tool(
    "create_item",
    "Create a new item under a milestone. Status must be in the schema's statusValues. Fields must satisfy the schema (required fields present, types match).",
    {
      ledger_id: z.string(),
      milestone_id: z.string(),
      status: z.string(),
      fields: fieldsSchema,
      id: z.string().optional(),
    } as const,
    async (args) => {
      const init: { id?: string; status: string; fields: Record<string, FieldValue> } = {
        status: args.status,
        fields: args.fields as Record<string, FieldValue>,
      };
      if (args.id !== undefined) init.id = args.id;
      const item = await store.createItem(args.ledger_id, args.milestone_id, init);
      return jsonResult({ item });
    },
  );

  const createMilestone = tool(
    "create_milestone",
    "Create a new milestone in a ledger. Returns the new milestone with its allocated id.",
    {
      ledger_id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      id: z.string().optional(),
    } as const,
    async (args) => {
      const init: { id?: string; title: string; description?: string } = { title: args.title };
      if (args.description !== undefined) init.description = args.description;
      if (args.id !== undefined) init.id = args.id;
      const milestone = await store.createMilestone(args.ledger_id, init);
      return jsonResult({ milestone });
    },
  );

  const createLedger = tool(
    "create_ledger",
    "Create a new ledger. Schema specifies allowed statuses, which subset is terminal, and the typed fields each item carries.",
    {
      name: z.string(),
      schema: schemaSchema,
    } as const,
    async (args) => {
      const schema = args.schema as LedgerSchema;
      const ledger = await store.createLedger(args.name, schema);
      return jsonResult({ ledger });
    },
  );

  const archiveMilestone = tool(
    "archive_milestone",
    "Archive a milestone (move it to docs/archive/<ledger>/<id>.md). Refused if any item is not in a terminal status.",
    {
      ledger_id: z.string(),
      milestone_id: z.string(),
      summary: z.string(),
    } as const,
    async (args) => {
      const pointer = await store.archiveMilestone(
        args.ledger_id,
        args.milestone_id,
        args.summary,
      );
      return jsonResult({ pointer });
    },
  );

  const searchItems = tool(
    "search_items",
    "Substring search across status and field values within a single ledger.",
    {
      ledger_id: z.string(),
      query: z.string(),
    } as const,
    async (args) => jsonResult({ items: store.search(args.ledger_id, args.query) }),
  );

  // The handler input type is covariant in the schema parameter, so TS does
  // not consider each concrete schema assignable to AnyTool's schema=any.
  // Widen each one explicitly at the boundary; the SDK then validates the
  // input at runtime against the per-tool inputSchema.
  return [
    enumerateLedgers,
    fetchLedger,
    fetchLedgerArchive,
    fetchMilestone,
    updateMilestone,
    ledgerFetch,
    ledgerUpdate,
    createItem,
    createMilestone,
    createLedger,
    archiveMilestone,
    searchItems,
  ] as unknown as AnyTool[];
}

// Helpful for tests that want to enumerate the tool names without running them.
export const LEDGER_TOOL_NAMES = [
  "enumerate_ledgers",
  "fetch_ledger",
  "fetch_ledger_archive",
  "fetch_milestone",
  "update_milestone",
  "ledger_fetch",
  "ledger_update",
  "create_item",
  "create_milestone",
  "create_ledger",
  "archive_milestone",
  "search_items",
] as const;

