/**
 * Ledger MCP tool factory (msunify cycle).
 *
 * Returns an array of `tool()` instances ready to be passed to
 * `createSdkMcpServer({ name: 'cq', tools: [...askTools, ...ledgerTools] })`.
 *
 * Tool surface (13 tools after msunify):
 *
 * Item / ledger surface (8):
 *  - enumerate_ledgers, fetch_ledger, fetch_ledger_archive,
 *    fetch_item (renamed from ledger_fetch),
 *    update_item (renamed from ledger_update),
 *    create_item, create_ledger, search_items.
 *
 * Milestone surface (5) — global, operate against the `milestones` ledger:
 *  - create_milestone(title, description?, blocked?, depends?)
 *  - update_milestone(milestone_id, { title?, description?, status?, blocked?, depends? })
 *  - fetch_milestone(milestone_id) → { milestone, resolved, references }
 *  - archive_milestone(milestone_id, summary) → { pointer }
 *  - list_milestone_items(milestone_id) → { items: Record<ledger, Item[]> }
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

// D-LED-02: status values must round-trip through the markdown heading
// `### <id> — <status>`; the em-dash separator forbids `—` inside the value.
const statusValueSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9 _-]+$/,
    "status value may only contain A-Za-z0-9, space, dash, underscore",
  );

// D-LED-02: field names become YAML keys; restrict to identifier-style
// names and forbid the intrinsic Item field names.
const RESERVED_FIELD_NAMES_ZOD = ["createdAt", "updatedAt"];
const fieldNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "field name must match /^[A-Za-z_][A-Za-z0-9_]*$/",
  )
  .refine((n) => !RESERVED_FIELD_NAMES_ZOD.includes(n), {
    message: "field name is reserved (createdAt/updatedAt)",
  });

const schemaSchema = z
  .object({
    statusValues: z.array(statusValueSchema).min(1),
    terminalStatuses: z.array(z.string()),
    fields: z.record(fieldNameSchema, fieldSpecSchema),
  })
  .refine(
    (s) => s.terminalStatuses.every((t) => s.statusValues.includes(t)),
    {
      message: "every terminalStatuses entry must be in statusValues",
      path: ["terminalStatuses"],
    },
  );

/**
 * Field values may be string or string[]. Timestamps are ISO 8601
 * strings after the msunify cycle (numeric epoch ms is gone).
 */
const fieldValueSchema = z.union([z.string(), z.array(z.string())]);

const fieldsSchema = z.record(z.string(), fieldValueSchema);

/**
 * D-LED-01: caller-supplied milestone/item ids cannot contain `/`, `.`, or
 * whitespace — anything that could escape the filesystem path
 * `FsLedgerStore` derives from them.
 */
const safeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "id may only contain A-Za-z0-9_-");

// ---------------------------------------------------------------------------
// Tool builders
// ---------------------------------------------------------------------------

export function createLedgerMcpTools(store: LedgerStore): AnyTool[] {
  // ---- Item / ledger surface (8) -----------------------------------------

  const enumerateLedgers = tool(
    "enumerate_ledgers",
    "List all known ledger names.",
    {} as Record<string, never>,
    async () => jsonResult({ ledgers: store.enumerate() }),
  );

  const fetchLedger = tool(
    "fetch_ledger",
    "Fetch a ledger: schema, active milestone groups (each expanded with resolved milestone metadata { id, status, title, description }), and archive pointers.",
    { ledger_id: z.string() } as const,
    async (args) => jsonResult({ ledger: store.fetch(args.ledger_id) }),
  );

  const fetchLedgerArchive = tool(
    "fetch_ledger_archive",
    "Fetch a specific archived item (when ledger_id=milestones) or a whole archived milestone-group (otherwise).",
    {
      ledger_id: z.string(),
      archive_id: z.string(),
    } as const,
    async (args) =>
      jsonResult({ archive: await store.fetchArchive(args.ledger_id, args.archive_id) }),
  );

  const fetchItem = tool(
    "fetch_item",
    "Fetch a single item by id from a specific ledger.",
    {
      ledger_id: z.string(),
      item_id: z.string(),
    } as const,
    async (args) => jsonResult({ item: store.fetchItem(args.ledger_id, args.item_id) }),
  );

  const updateItem = tool(
    "update_item",
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
    "Create a new item under a milestone in a ledger. milestone_id must resolve to an active (non-archived, non-terminal) milestone in the milestones ledger. Status must be in the schema's statusValues. Fields must satisfy the schema (required fields present, types match). Auto-creates the depth-2 group on first reference.",
    {
      ledger_id: z.string(),
      milestone_id: safeIdSchema,
      status: z.string(),
      fields: fieldsSchema,
      id: safeIdSchema.optional(),
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

  const createLedger = tool(
    "create_ledger",
    "Create a new ledger. Schema specifies allowed statuses, which subset is terminal, and the typed fields each item carries. The name `milestones` is reserved.",
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

  const searchItems = tool(
    "search_items",
    "Substring search across status and field values within a single ledger.",
    {
      ledger_id: z.string(),
      query: z.string(),
    } as const,
    async (args) => jsonResult({ items: store.search(args.ledger_id, args.query) }),
  );

  // ---- Milestone surface (5) ---------------------------------------------

  const createMilestone = tool(
    "create_milestone",
    "Create a new milestone in the milestones ledger. Allocates an M<n> id from the milestones ledger's own item counter. The blocked/depends arrays are advisory cross-references (no FK enforcement).",
    {
      title: z.string(),
      description: z.string().optional(),
      blocked: z.array(z.string()).optional(),
      depends: z.array(z.string()).optional(),
      id: safeIdSchema.optional(),
    } as const,
    async (args) => {
      const init: {
        id?: string;
        title: string;
        description?: string;
        blocked?: string[];
        depends?: string[];
      } = { title: args.title };
      if (args.description !== undefined) init.description = args.description;
      if (args.blocked !== undefined) init.blocked = args.blocked;
      if (args.depends !== undefined) init.depends = args.depends;
      if (args.id !== undefined) init.id = args.id;
      const milestone = await store.createMilestone(init);
      return jsonResult({ milestone });
    },
  );

  const updateMilestone = tool(
    "update_milestone",
    "Update a milestone in the milestones ledger. status must be one of open/done/postponed/blocked.",
    {
      milestone_id: safeIdSchema,
      status: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      blocked: z.array(z.string()).optional(),
      depends: z.array(z.string()).optional(),
    } as const,
    async (args) => {
      const patch: {
        status?: string;
        title?: string;
        description?: string;
        blocked?: string[];
        depends?: string[];
      } = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.title !== undefined) patch.title = args.title;
      if (args.description !== undefined) patch.description = args.description;
      if (args.blocked !== undefined) patch.blocked = args.blocked;
      if (args.depends !== undefined) patch.depends = args.depends;
      const milestone = await store.updateMilestone(args.milestone_id, patch);
      return jsonResult({ milestone });
    },
  );

  const fetchMilestone = tool(
    "fetch_milestone",
    "Fetch a milestone from the milestones ledger; also returns a per-ledger count of active items referencing this milestone.",
    {
      milestone_id: safeIdSchema,
    } as const,
    async (args) => jsonResult(store.fetchMilestone(args.milestone_id)),
  );

  const archiveMilestone = tool(
    "archive_milestone",
    "Archive a milestone globally (2-level): sweeps every ledger's group with this id into ./archive/<ledger>/<id>.md, then moves the milestone-item itself to ./archive/milestones/<id>.md. Refused if any item in any ledger is non-terminal.",
    {
      milestone_id: safeIdSchema,
      summary: z.string(),
    } as const,
    async (args) => {
      const pointer = await store.archiveMilestone(args.milestone_id, args.summary);
      return jsonResult({ pointer });
    },
  );

  const listMilestoneItems = tool(
    "list_milestone_items",
    "Return all active items grouped by ledger that reference this milestone. Convenience read for orchestration before archive.",
    {
      milestone_id: safeIdSchema,
    } as const,
    async (args) => jsonResult({ items: store.listMilestoneItems(args.milestone_id) }),
  );

  return [
    enumerateLedgers,
    fetchLedger,
    fetchLedgerArchive,
    fetchItem,
    updateItem,
    createItem,
    createLedger,
    searchItems,
    createMilestone,
    updateMilestone,
    fetchMilestone,
    archiveMilestone,
    listMilestoneItems,
  ] as unknown as AnyTool[];
}

// Helpful for tests that want to enumerate the tool names without running them.
export const LEDGER_TOOL_NAMES = [
  "enumerate_ledgers",
  "fetch_ledger",
  "fetch_ledger_archive",
  "fetch_item",
  "update_item",
  "create_item",
  "create_ledger",
  "search_items",
  "create_milestone",
  "update_milestone",
  "fetch_milestone",
  "archive_milestone",
  "list_milestone_items",
] as const;
