/**
 * Stdio MCP tool registration for the ledger surface.
 *
 * Registers the 18-tool ledger surface (`LEDGER_TOOL_NAMES`) on a raw
 * `@modelcontextprotocol/sdk` `McpServer` via `registerTool`, backed by a
 * `LedgerStore`. This is the stdio counterpart to `createLedgerMcpTools`
 * (the in-process Claude-SDK `tool()` factory in `./ledgerTools.ts`): both
 * carry identical operational semantics, but the stdio path takes raw Zod
 * shapes through `McpServer.registerTool` whereas the Claude path builds
 * `SdkMcpToolDefinition` objects.
 *
 * Consumers:
 *  - `@cq/ledger-mcp` — the standalone, cq-free ledger MCP binary.
 *  - `@cq/cq-mcp` — the cq-coupled binary (adds ask/submit/WS on top).
 *
 * Keeping this here (rather than in either binary) is what lets both
 * stdio servers share one copy of the tool surface; the schema-drift
 * guard between the stdio path and the Claude path is the test suite.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LedgerStore, CreateItemInit, UpdateItemPatch } from "../store/LedgerStore.js";
import { QUERY_LANGUAGE_HELP } from "../search/query.js";
import type { FieldValue, LedgerSchema } from "../types.js";
import { QUESTIONS_LEDGER } from "../constants.js";
import {
  ReadLogNotImplementedError,
  type ReadLogCapability,
} from "./readLog.js";

// ---------------------------------------------------------------------------
// Shared Zod fragments (mirror ./ledgerTools.ts)
// ---------------------------------------------------------------------------

const FIELD_TYPE_VALUES = ["string", "string[]", "id", "id[]", "timestamp"] as const;

const fieldSpecSchema = z.object({
  type: z.enum(FIELD_TYPE_VALUES),
  required: z.boolean(),
});

const statusValueSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9 _-]+$/,
    "status value may only contain A-Za-z0-9, space, dash, underscore",
  );

const RESERVED_FIELD_NAMES_ZOD = ["createdAt", "updatedAt", "author", "session"];
const fieldNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "field name must match /^[A-Za-z_][A-Za-z0-9_]*$/",
  )
  .refine((n) => !RESERVED_FIELD_NAMES_ZOD.includes(n), {
    message: "field name is reserved (createdAt/updatedAt/author/session)",
  });

// Optional provenance params shared by create_item / update_item — see
// ledgerTools.ts for the rationale. `author` is "user" or the writing model's
// class (e.g. "opus-4.8[1m]"); `session` is the writing session id.
const authorParam = z
  .string()
  .optional()
  .describe('who is writing: "user", or your model class e.g. "opus-4.8[1m]"');
const sessionParam = z
  .string()
  .optional()
  .describe("writing session id, e.g. the value of CLAUDE_CODE_SESSION_ID");

const idPrefixSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*$/, "idPrefix must match /^[A-Za-z][A-Za-z0-9]*$/");

const schemaSchema = z
  .object({
    statusValues: z.array(statusValueSchema).min(1),
    terminalStatuses: z.array(z.string()),
    fields: z.record(fieldNameSchema, fieldSpecSchema),
    idPrefix: idPrefixSchema.optional(),
    transitions: z.record(z.string(), z.array(z.string())).optional(),
  })
  .refine(
    (s) => s.terminalStatuses.every((t) => s.statusValues.includes(t)),
    {
      message: "every terminalStatuses entry must be in statusValues",
      path: ["terminalStatuses"],
    },
  );

const fieldValueSchema = z.union([z.string(), z.array(z.string())]);

const fieldsSchema = z.record(z.string(), fieldValueSchema);

const safeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "id may only contain A-Za-z0-9_-");

// ---------------------------------------------------------------------------
// Completion classification (server-side, schema-aware)
// ---------------------------------------------------------------------------

/**
 * The answered status for the questions ledger. Kept as a local constant so
 * the completion logic is expressed once (mirror of ANSWERED_STATUS in the
 * web client's status.ts, but server-side where we have the schema).
 */
const QUESTIONS_ANSWERED_STATUS = "answered";

/**
 * Compute the number of active items that count as COMPLETED for this
 * ledger's progress bar, classified against its OWN schema:
 *  - questions ledger: only items in the "answered" status (NOT all terminals;
 *    "withdrawn" is also terminal but does not count as a positive completion).
 *  - every other ledger: items whose status is in schema.terminalStatuses.
 */
function computeCompletedCount(
  ledgerName: string,
  sc: Record<string, number>,
  schema: LedgerSchema,
): number {
  if (ledgerName === QUESTIONS_LEDGER) {
    return sc[QUESTIONS_ANSWERED_STATUS] ?? 0;
  }
  let total = 0;
  for (const status of schema.terminalStatuses) {
    total += sc[status] ?? 0;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function jsonResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

/**
 * Register the 18 ledger tools on the given MCP server. Identical
 * semantics to the Claude-side factory in `./ledgerTools.ts`.
 *
 * `readLog` is the explicit, FS-store-backed `read_log` capability (Q87 /
 * R137 #6). When omitted (the factory wired over an in-memory store), the
 * `read_log` tool throws `ReadLogNotImplementedError`.
 */
export function registerLedgerStdioTools(
  server: McpServer,
  store: LedgerStore,
  readLog?: ReadLogCapability,
): void {
  // ---- Item / ledger surface (9) -----------------------------------------

  server.registerTool(
    "enumerate_ledgers",
    {
      description:
        "List all known ledger names, plus a `counts` map of each ledger's active-item count.",
      inputSchema: {},
    },
    async () => {
      const ledgers = store.enumerate();
      const counts: Record<string, number> = {};
      const statusCounts: Record<string, Record<string, number>> = {};
      const completedCounts: Record<string, number> = {};
      for (const name of ledgers) {
        const fetched = store.fetch(name);
        const sc: Record<string, number> = {};
        let total = 0;
        for (const group of fetched.milestones) {
          for (const item of group.items) {
            sc[item.status] = (sc[item.status] ?? 0) + 1;
            total++;
          }
        }
        counts[name] = total;
        statusCounts[name] = sc;
        completedCounts[name] = computeCompletedCount(name, sc, fetched.schema);
      }
      const ledgerSummaries = ledgers.map((name) => ({
        name,
        itemCount: counts[name] ?? 0,
        statusCounts: statusCounts[name] ?? {},
        completedCount: completedCounts[name] ?? 0,
      }));
      return jsonResult({ ledgers, counts, ledgerSummaries });
    },
  );

  server.registerTool(
    "fetch_ledger",
    {
      description:
        "Fetch a ledger: schema, active milestone groups (each expanded with resolved milestone metadata { id, status, title, description }), and archive pointers.",
      inputSchema: { ledger_id: z.string() },
    },
    async (args) => jsonResult({ ledger: store.fetch(args.ledger_id) }),
  );

  server.registerTool(
    "fetch_ledger_archive",
    {
      description:
        "Fetch a specific archived item (when ledger_id=milestones) or a whole archived milestone-group (otherwise).",
      inputSchema: {
        ledger_id: z.string(),
        archive_id: z.string(),
      },
    },
    async (args) =>
      jsonResult({ archive: await store.fetchArchive(args.ledger_id, args.archive_id) }),
  );

  server.registerTool(
    "fetch_item",
    {
      description: "Fetch a single item by id from a specific ledger.",
      inputSchema: {
        ledger_id: z.string(),
        item_id: z.string(),
      },
    },
    async (args) => jsonResult({ item: store.fetchItem(args.ledger_id, args.item_id) }),
  );

  server.registerTool(
    "update_item",
    {
      description:
        "Update an item's status and/or fields. Provided fields replace existing values; omitted fields are preserved. Pass author/session to record who made this edit.",
      inputSchema: {
        ledger_id: z.string(),
        item_id: z.string(),
        status: z.string().optional(),
        fields: fieldsSchema.optional(),
        author: authorParam,
        session: sessionParam,
      },
    },
    async (args) => {
      const patch: UpdateItemPatch = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.fields !== undefined) patch.fields = args.fields as Record<string, FieldValue>;
      if (args.author !== undefined) patch.author = args.author;
      if (args.session !== undefined) patch.session = args.session;
      const item = await store.updateItem(args.ledger_id, args.item_id, patch);
      return jsonResult({ item });
    },
  );

  server.registerTool(
    "create_item",
    {
      description:
        "Create a new item under a milestone in a ledger. milestone_id must resolve to an active (non-archived, non-terminal) milestone in the milestones ledger. Status must be in the schema's statusValues. Fields must satisfy the schema (required fields present, types match). Auto-creates the depth-2 group on first reference. Pass author/session to record who created the item.",
      inputSchema: {
        ledger_id: z.string(),
        milestone_id: safeIdSchema,
        status: z.string(),
        fields: fieldsSchema,
        id: safeIdSchema.optional(),
        author: authorParam,
        session: sessionParam,
      },
    },
    async (args) => {
      const init: CreateItemInit = {
        status: args.status,
        fields: args.fields as Record<string, FieldValue>,
      };
      if (args.id !== undefined) init.id = args.id;
      if (args.author !== undefined) init.author = args.author;
      if (args.session !== undefined) init.session = args.session;
      const item = await store.createItem(args.ledger_id, args.milestone_id, init);
      return jsonResult({ item });
    },
  );

  server.registerTool(
    "create_ledger",
    {
      description:
        "Create a new ledger. Schema specifies allowed statuses, which subset is terminal, and the typed fields each item carries. The name `milestones` is reserved.",
      inputSchema: {
        name: z.string(),
        schema: schemaSchema,
      },
    },
    async (args) => {
      const ledger = await store.createLedger(args.name, args.schema as LedgerSchema);
      return jsonResult({ ledger });
    },
  );

  server.registerTool(
    "search_items",
    {
      description: "Substring search across status and field values within a single ledger.",
      inputSchema: {
        ledger_id: z.string(),
        query: z.string(),
      },
    },
    async (args) => jsonResult({ items: store.search(args.ledger_id, args.query) }),
  );

  server.registerTool(
    "fts_search",
    {
      description: `Ranked full-text search across ledger items, with a filter query language. Cross-ledger by default (pass \`ledger\` to restrict to one). Results are ranked by relevance (descending); field boosts favour headline/title/question over description/rationale over status. Each result carries the full item, its score, and the fields that matched. Use this for discovery; use search_items for precise single-ledger substring matching.

Params:
- status (string): dedicated pre-filter — applied before text ranking, accepts a single exact status value. Combine with inline status: qualifiers in query for multi-status OR: use query='(status:open OR status:wip)' (qualifier-only OR uses the structured evaluator, works correctly).
- include_archived (boolean): when false (default) covers only active (non-archived) items; set true to also search items in milestone-group archives.
- fuzzy / prefix (boolean): enable fuzzy matching or prefix matching on free-text terms.

Status semantics: terminalStatuses (e.g. done, resolved, abandoned per the ledger schema) are still active — searchable and editable — until archive_milestone is called. Use -status:done style negation to exclude them.

${QUERY_LANGUAGE_HELP}`,
      inputSchema: {
        query: z.string(),
        ledger: z.string().optional(),
        limit: z.number().int().positive().optional(),
        fuzzy: z.boolean().optional(),
        prefix: z.boolean().optional(),
        status: z
          .string()
          .optional()
          .describe(
            "exact status pre-filter (server-side, before ranking); for multi-status OR use inline query qualifier: '(status:open OR status:wip)'",
          ),
        include_archived: z
          .boolean()
          .optional()
          .describe(
            "when true, also searches items in milestone-group archives (default: false = active items only)",
          ),
      },
    },
    async (args) => {
      const opts: {
        ledger?: string;
        limit?: number;
        fuzzy?: boolean;
        prefix?: boolean;
        statusFilter?: string;
        includeArchived?: boolean;
      } = {};
      if (args.ledger !== undefined) opts.ledger = args.ledger;
      if (args.limit !== undefined) opts.limit = args.limit;
      if (args.fuzzy !== undefined) opts.fuzzy = args.fuzzy;
      if (args.prefix !== undefined) opts.prefix = args.prefix;
      if (args.status !== undefined) opts.statusFilter = args.status;
      if (args.include_archived !== undefined) opts.includeArchived = args.include_archived;
      const hits = await store.ftsSearch(args.query, opts);
      return jsonResult({
        results: hits.map((h) => ({
          ledgerId: h.ledgerId,
          item: h.item,
          score: h.score,
          matchedFields: h.matchedFields,
        })),
      });
    },
  );

  // ---- Milestone surface (5) ---------------------------------------------

  server.registerTool(
    "create_milestone",
    {
      description:
        "Create a new milestone in the milestones ledger. Allocates an M<n> id from the milestones ledger's own item counter. The blockedBy/dependsOn arrays are advisory cross-references (no FK enforcement).",
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        blockedBy: z.array(z.string()).optional(),
        dependsOn: z.array(z.string()).optional(),
        id: safeIdSchema.optional(),
      },
    },
    async (args) => {
      const init: {
        id?: string;
        title: string;
        description?: string;
        blockedBy?: string[];
        dependsOn?: string[];
      } = { title: args.title };
      if (args.description !== undefined) init.description = args.description;
      if (args.blockedBy !== undefined) init.blockedBy = args.blockedBy;
      if (args.dependsOn !== undefined) init.dependsOn = args.dependsOn;
      if (args.id !== undefined) init.id = args.id;
      const milestone = await store.createMilestone(init);
      return jsonResult({ milestone });
    },
  );

  server.registerTool(
    "update_milestone",
    {
      description:
        "Update a milestone in the milestones ledger. status must be one of open/done/postponed/blocked.",
      inputSchema: {
        milestone_id: safeIdSchema,
        status: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        blockedBy: z.array(z.string()).optional(),
        dependsOn: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const patch: {
        status?: string;
        title?: string;
        description?: string;
        blockedBy?: string[];
        dependsOn?: string[];
      } = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.title !== undefined) patch.title = args.title;
      if (args.description !== undefined) patch.description = args.description;
      if (args.blockedBy !== undefined) patch.blockedBy = args.blockedBy;
      if (args.dependsOn !== undefined) patch.dependsOn = args.dependsOn;
      const milestone = await store.updateMilestone(args.milestone_id, patch);
      return jsonResult({ milestone });
    },
  );

  server.registerTool(
    "fetch_milestone",
    {
      description:
        "Fetch a milestone from the milestones ledger; also returns a per-ledger count of active items referencing this milestone.",
      inputSchema: {
        milestone_id: safeIdSchema,
      },
    },
    async (args) => jsonResult(store.fetchMilestone(args.milestone_id)),
  );

  server.registerTool(
    "archive_milestone",
    {
      description:
        "Archive a milestone globally (2-level): sweeps every ledger's group with this id into ./archive/<ledger>/<id>.md, then moves the milestone-item itself to ./archive/milestones/<id>.md. Refused if any item in any ledger is non-terminal.",
      inputSchema: {
        milestone_id: safeIdSchema,
        summary: z.string(),
      },
    },
    async (args) => {
      const pointer = await store.archiveMilestone(args.milestone_id, args.summary);
      return jsonResult({ pointer });
    },
  );

  server.registerTool(
    "list_milestone_items",
    {
      description:
        "Return all active items grouped by ledger that reference this milestone. Convenience read for orchestration before archive.",
      inputSchema: {
        milestone_id: safeIdSchema,
      },
    },
    async (args) => jsonResult({ items: store.listMilestoneItems(args.milestone_id) }),
  );

  // ---- Recovery tools (2) ------------------------------------------------

  server.registerTool(
    "reopen_item",
    {
      description:
        "Recover an item accidentally set to a terminal status by moving it to a chosen non-terminal status.",
      inputSchema: {
        ledger_id: z.string(),
        item_id: z.string(),
        to_status: z.string(),
      },
    },
    async (args) => {
      const item = await store.reopenItem(args.ledger_id, args.item_id, args.to_status);
      return jsonResult({ item });
    },
  );

  server.registerTool(
    "unarchive_item",
    {
      description:
        "Restore a single item that was swept into its milestone-group archive (./docs/archive/<ledger>/<milestoneId>.md) back to the active ledger; pass the archived item's milestone id.",
      inputSchema: {
        ledger_id: z.string(),
        milestone_id: safeIdSchema,
        item_id: z.string(),
      },
    },
    async (args) => {
      const item = await store.unarchiveItem(args.ledger_id, args.milestone_id, args.item_id);
      return jsonResult({ item });
    },
  );

  // ---- Cross-ledger overview (1) -----------------------------------------

  server.registerTool(
    "snapshot",
    {
      description:
        "One-call cross-ledger actionable-state overview; compact {id,status,summary} stubs grouped by ledger x status; flow-agnostic (compose /advance predicates from this). Returns { ledger: { [ledgerId]: { [status]: { count, items: {id,status,summary}[] } } } } for every active ledger that has at least one active item. No long narrative fields — stays well under token-overflow thresholds. include_archived is accepted but currently a no-op (snapshot() covers active ledgers only; archived coverage is a future extension).",
      inputSchema: {
        include_archived: z
          .boolean()
          .optional()
          .describe("reserved for future use — currently ignored; active ledgers only"),
      },
    },
    async () => jsonResult({ ledger: store.snapshot() }),
  );

  // ---- Filesystem read (1) -----------------------------------------------

  server.registerTool(
    "read_log",
    {
      description:
        "Read a log file under the ledger's <root>/docs/logs/ directory and return its text content. `path` is repo-relative to docs/logs (e.g. \"20260101-1200-session.md\"); absolute paths and any path escaping docs/logs (e.g. `..` traversal) are rejected. Oversized files are truncated (truncated:true). Returns { path, content, truncated? }. Only available when the server is filesystem-backed; against an in-memory store it returns a not-implemented error.",
      inputSchema: {
        path: z.string().describe("repo-relative path under docs/logs/"),
      },
    },
    async (args) => {
      if (readLog === undefined) throw new ReadLogNotImplementedError();
      return jsonResult(await readLog(args.path));
    },
  );
}
