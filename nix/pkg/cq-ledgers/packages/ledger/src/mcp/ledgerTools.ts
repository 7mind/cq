/**
 * Ledger MCP tool factory (msunify cycle).
 *
 * Returns an array of `tool()` instances for
 * `createSdkMcpServer({ name: 'cq', tools: [...askTools, ...ledgerTools] })`.
 * The 26-tool surface is `LEDGER_TOOL_NAMES` (see the section dividers below);
 * the stdio counterpart is `registerLedgerStdioTools` (./stdioLedgerTools.ts).
 *
 * Capability-gated tools:
 *  - read_log requires an explicit FS-store `readLog` capability (Q87 / R137 #6);
 *    over an in-memory store it throws `ReadLogNotImplementedError`.
 *  - get_reviewers / get_planners / get_config require an injected
 *    `configCapability` (constructed in @cq/ledger-mcp over @cq/config, R193/G18);
 *    absent it they throw `ConfigNotImplementedError`.
 *
 * Each handler turns validated input into a single LedgerStore call, serialises
 * the result as JSON, and returns it as a text content block. Errors surface via
 * thrown Error (the SDK reports them as tool errors). Tool names are prefixed
 * `mcp__cq__*` by the SDK; the bridge's `canUseTool` auto-allow already covers them.
 */

import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { LedgerStore, CreateItemInit, UpdateItemPatch } from "../store/LedgerStore.js";
import { QUERY_LANGUAGE_HELP } from "../search/query.js";
import type { FieldValue, LedgerSchema } from "../types.js";
import { projectCompact, paginate } from "../projection.js";
import { derivePredicates } from "../store/predicates.js";
import { computeLedgerSummaries } from "../summaries.js";
import {
  ReadLogNotImplementedError,
  type ReadLogCapability,
} from "./readLog.js";
import {
  ConfigNotImplementedError,
  type ConfigCapability,
} from "./configCapability.js";
import {
  PromptCatalogNotImplementedError,
  type PromptCatalogCapability,
} from "./promptCatalogCapability.js";

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

// Optional provenance params shared by create_item / update_item. `author` is
// the literal "user" (a human) or the writing model's class (e.g.
// "opus-4.8[1m]"); `session` is the writing session id (e.g.
// CLAUDE_CODE_SESSION_ID). Intrinsic Item metadata, not schema fields.
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

export function createLedgerMcpTools(
  store: LedgerStore,
  readLog?: ReadLogCapability,
  configCapability?: ConfigCapability,
  promptCatalog?: PromptCatalogCapability,
  toolPrefix: string = "",
): AnyTool[] {
  // Fail fast on an invalid prefix at the system boundary (Q205 / T373).
  assertToolPrefix(toolPrefix);
  // ---- Item / ledger surface (9) -----------------------------------------

  const enumerateLedgers = tool(
    "enumerate_ledgers",
    "List all known ledger names, plus a `counts` map of each ledger's active-item count.",
    {} as Record<string, never>,
    async () => jsonResult(computeLedgerSummaries(store)),
  );

  const fetchLedger = tool(
    "fetch_ledger",
    `Fetch a ledger: schema, active milestone groups (each expanded with resolved milestone metadata { id, status, title, description }), and archive pointers.

Optional params:
- compact (boolean): when true, strips all long narrative fields from every item (description, rationale, rootCause, grounding, recommendation, suggestions, and others in COMPACT_PROJECTION_DENYLIST). Use compact to avoid token-overflow when reading large ledgers such as goals (51.8 KB) or questions (142.7 KB). compact:true is strongly recommended when you only need a summary view.
- offset (integer, ≥0): zero-based index of the first item to return across the flattened item list. Enables pagination.
- limit (integer, >0): maximum number of items to return. When combined with offset, use total in the response to calculate remaining pages.

When offset or limit are provided the response shape changes: { ledger: { id, schema, counters, archivePointers }, items: Item[], total: number }. The milestone grouping is omitted; items are flattened across all milestone groups in their natural order.

When compact is true without pagination the response is the usual { ledger: FetchedLedger } with projected items in all milestone groups.

When no params are provided the response is the unchanged full ledger (backward-compatible).`,
    {
      ledger_id: z.string(),
      compact: z.boolean().optional().describe("strip long narrative fields from items to avoid token-overflow"),
      offset: z.number().int().min(0).optional().describe("zero-based start index for pagination"),
      limit: z.number().int().positive().optional().describe("max items to return per page"),
    } as const,
    async (args) => {
      const fetched = store.fetch(args.ledger_id);
      const usePagination = args.offset !== undefined || args.limit !== undefined;

      if (usePagination) {
        // Flatten all items across milestone groups, apply compact, paginate.
        const allItems = fetched.milestones.flatMap((g) => g.items);
        const projected = args.compact === true ? allItems.map(projectCompact) : allItems;
        const { items, total } = paginate(projected, args.offset ?? 0, args.limit);
        // Return schema/counters/archivePointers in ledger but omit milestones.
        const { milestones: _omit, ...ledgerMeta } = fetched;
        void _omit;
        return jsonResult({ ledger: ledgerMeta, items, total });
      }

      if (args.compact === true) {
        const projectedLedger = {
          ...fetched,
          milestones: fetched.milestones.map((g) => ({
            ...g,
            items: g.items.map(projectCompact),
          })),
        };
        return jsonResult({ ledger: projectedLedger });
      }

      return jsonResult({ ledger: fetched });
    },
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
    "Update an item's status and/or fields. Provided fields replace existing values; omitted fields are preserved. Pass author/session to record who made this edit.",
    {
      ledger_id: z.string(),
      item_id: z.string(),
      status: z.string().optional(),
      fields: fieldsSchema.optional(),
      author: authorParam,
      session: sessionParam,
    } as const,
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

  const createItem = tool(
    "create_item",
    "Create a new item under a milestone in a ledger. milestone_id must resolve to an active (non-archived, non-terminal) milestone in the milestones ledger. Status must be in the schema's statusValues. Fields must satisfy the schema (required fields present, types match). Auto-creates the depth-2 group on first reference. Pass author/session to record who created the item.",
    {
      ledger_id: z.string(),
      milestone_id: safeIdSchema,
      status: z.string(),
      fields: fieldsSchema,
      id: safeIdSchema.optional(),
      author: authorParam,
      session: sessionParam,
    } as const,
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

  const ftsSearch = tool(
    "fts_search",
    `Ranked full-text search across ledger items, with a filter query language. Cross-ledger by default (pass \`ledger\` to restrict to one). Results are ranked by relevance (descending); field boosts favour headline/title/question over description/rationale over status. Each result carries the full item, its score, and the fields that matched. Use this for discovery; use search_items for precise single-ledger substring matching.

Params:
- status (string): dedicated pre-filter — applied before text ranking, accepts a single exact status value. Combine with inline status: qualifiers in query for multi-status OR: use query='(status:open OR status:wip)' (qualifier-only OR uses the structured evaluator, works correctly).
- include_archived (boolean): when false (default) covers only active (non-archived) items; set true to also search items in milestone-group archives.
- fuzzy / prefix (boolean): enable fuzzy matching or prefix matching on free-text terms.

Status semantics: terminalStatuses (e.g. done, resolved, abandoned per the ledger schema) are still active — searchable and editable — until archive_milestone is called. Use -status:done style negation to exclude them.

${QUERY_LANGUAGE_HELP}`,
    {
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
    } as const,
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

  const createMilestone = tool(
    "create_milestone",
    "Create a new milestone in the milestones ledger. Allocates an M<n> id from the milestones ledger's own item counter. The blockedBy/dependsOn arrays are advisory cross-references (no FK enforcement).",
    {
      title: z.string(),
      description: z.string().optional(),
      blockedBy: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional(),
      id: safeIdSchema.optional(),
    } as const,
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

  const updateMilestone = tool(
    "update_milestone",
    "Update a milestone in the milestones ledger. status must be one of open/done/postponed/blocked.",
    {
      milestone_id: safeIdSchema,
      status: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      blockedBy: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional(),
    } as const,
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

  // ---- Recovery tools (2) ------------------------------------------------

  const reopenItem = tool(
    "reopen_item",
    "Recover an item accidentally set to a terminal status by moving it to a chosen non-terminal status.",
    {
      ledger_id: z.string(),
      item_id: z.string(),
      to_status: z.string(),
    } as const,
    async (args) => {
      const item = await store.reopenItem(args.ledger_id, args.item_id, args.to_status);
      return jsonResult({ item });
    },
  );

  const unarchiveItem = tool(
    "unarchive_item",
    "Restore a single item that was swept into its milestone-group archive (./.cq/archive/<ledger>/<milestoneId>.md) back to the active ledger; pass the archived item's milestone id.",
    {
      ledger_id: z.string(),
      milestone_id: safeIdSchema,
      item_id: z.string(),
    } as const,
    async (args) => {
      const item = await store.unarchiveItem(args.ledger_id, args.milestone_id, args.item_id);
      return jsonResult({ item });
    },
  );

  // ---- Cross-ledger overview (1) -----------------------------------------

  const snapshotTool = tool(
    "snapshot",
    "One-call cross-ledger actionable-state overview; compact {id,status,summary} stubs grouped by ledger x status; flow-agnostic (compose /cq:advance predicates from this). Returns { ledger: { [ledgerId]: { [status]: { count, items: {id,status,summary}[] } } } } for every active ledger that has at least one active item. No long narrative fields — stays well under token-overflow thresholds. include_archived is accepted but currently a no-op (snapshot() covers active ledgers only; archived coverage is a future extension).",
    {
      include_archived: z
        .boolean()
        .optional()
        .describe("reserved for future use — currently ignored; active ledgers only"),
    } as const,
    async () => jsonResult({ ledger: store.snapshot() }),
  );

  const derivePredicatesTool = tool(
    "derive_predicates",
    "Derive the /cq:advance flow-detection predicates from the current ledger state in one call (the SINGLE SOURCE OF TRUTH shared with @cq/cli — read these instead of hand-deriving them). Returns { pInvestigate, pSeed, pPlan, pResearch, pImplement, openQuestionGate, belowFloor }, each a verdict { value: boolean, items: string[] } where items names the ids that make the predicate TRUE-and-unblocked (pSeed = a root-caused defect at/above the critical/high severity floor owned by no live goal and un-gated; pResearch = an actionable item in the researches ledger; openQuestionGate.items lists the open questions gating the others; belowFloor is the INFORMATIONAL sub-floor companion to pSeed and gates nothing). Pure over active-ledger reads; no params.",
    {} as Record<string, never>,
    async () => jsonResult(derivePredicates(store)),
  );

  // ---- Filesystem read (1) -----------------------------------------------

  const readLogTool = tool(
    "read_log",
    "Read a log file under the ledger's <root>/.cq/logs/ directory and return its text content. `path` is repo-relative to .cq/logs (e.g. \"20260101-1200-session.md\"); absolute paths and any path escaping .cq/logs (e.g. `..` traversal) are rejected. Oversized files are truncated (truncated:true). Returns { path, content, truncated? }. Only available when the server is filesystem-backed; against an in-memory store it returns a not-implemented error.",
    {
      path: z.string().describe("repo-relative path under .cq/logs/"),
    } as const,
    async (args) => {
      if (readLog === undefined) throw new ReadLogNotImplementedError();
      return jsonResult(await readLog(args.path));
    },
  );

  // ---- Config capability (3) ---------------------------------------------

  const getReviewers = tool(
    "get_reviewers",
    "Resolve the reviewer set from the repo's cq.toml. Returns " +
      "{ configured, reviewers: [{ harness, model, alias }] }. " +
      "configured=false (no cq.toml or empty list) => use the single native " +
      "Claude reviewer. Only available when the server has a cq.toml-capable " +
      "config root; otherwise returns a not-implemented error.",
    {} as Record<string, never>,
    async () => {
      if (configCapability === undefined) throw new ConfigNotImplementedError();
      return jsonResult(configCapability.computeReviewers());
    },
  );

  const getPlanners = tool(
    "get_planners",
    "Resolve the planner set from the repo's cq.toml. Returns " +
      "{ configured, planners: [{ harness, model, alias }] }. " +
      "configured=false (no cq.toml or empty list) => use the single native " +
      "Claude planner. Only available when the server has a cq.toml-capable " +
      "config root; otherwise returns a not-implemented error.",
    {} as Record<string, never>,
    async () => {
      if (configCapability === undefined) throw new ConfigNotImplementedError();
      return jsonResult(configCapability.computePlanners());
    },
  );

  const getConfig = tool(
    "get_config",
    "Return the full parsed cq.toml: { configured, aliases, reviewers, " +
      "planners, tiers, agentTiers, agentEfforts }. reviewers/planners are " +
      "the raw alias-name lists; tiers is the per-harness resolved fast/" +
      "standard/frontier slots (each { harness, model, provider, effort } " +
      "or null); agentTiers maps agent-name to tier (or null); agentEfforts " +
      "maps agent-name to its per-agent effort override ({} when absent). " +
      "configured=false when no cq.toml is present. Only available when the " +
      "server has a cq.toml-capable config root; otherwise returns a " +
      "not-implemented error.",
    {} as Record<string, never>,
    async () => {
      if (configCapability === undefined) throw new ConfigNotImplementedError();
      return jsonResult(configCapability.computeConfig());
    },
  );

  const getAgentModels = tool(
    "get_agent_models",
    "Return the per-role model overlay for every agent in the 19-role roster. " +
      "Returns { configured, agents: [{ id, status, modelClass, modelMappings }] }. " +
      "Four status variants: " +
      "'resolved' — a live token was found for the role's tier class; " +
      "'not-configured' — no cq.toml is present; " +
      "'no-live-token' — cq.toml is present but the role's tier has no live token; " +
      "'not-model-configurable' — the role has no agentTierKey (orchestrator commands). " +
      "Only available when the server has a cq.toml-capable config root; " +
      "otherwise returns a not-implemented error.",
    {} as Record<string, never>,
    async () => {
      if (configCapability === undefined) throw new ConfigNotImplementedError();
      return jsonResult(configCapability.computeAgentModels());
    },
  );

  // ---- Prompt-catalog capability (3) -------------------------------------

  const fetchPrompt = tool(
    "fetch_prompt",
    "Fetch a role's typed prompt-catalog entry: { roleId, kind, dispatched, " +
      "promptTemplate, version?, inputSchema?, outputSchema? }. A dispatched-subagent " +
      "role returns both JSON Schemas (draft 2020-12); an orchestrator-command role " +
      "returns prompt + metadata with inputSchema/outputSchema ABSENT. Fails fast on an " +
      "unknown roleId. Only available when the server has an asset-capable catalog root; " +
      "otherwise returns a not-implemented error.",
    { roleId: z.string() } as const,
    async (args) => {
      if (promptCatalog === undefined) throw new PromptCatalogNotImplementedError();
      return jsonResult(promptCatalog.fetchPrompt(args.roleId));
    },
  );

  const validateInput = tool(
    "validate_input",
    "Validate `input` against a dispatched role's inputSchema (Ajv, draft 2020-12). " +
      "Returns { ok:true } or { ok:false, errors:[{ path, message, keyword, schemaPath, params }] } " +
      "with every failing constraint (the failing JSON-Schema field path included). Fails fast on " +
      "an unknown roleId, and on an orchestrator-command roleId (which has no input schema). Only " +
      "available when the server has an asset-capable catalog root; otherwise returns a " +
      "not-implemented error.",
    { roleId: z.string(), input: z.unknown() } as const,
    async (args) => {
      if (promptCatalog === undefined) throw new PromptCatalogNotImplementedError();
      return jsonResult(promptCatalog.validateInput(args.roleId, args.input));
    },
  );

  const validateOutput = tool(
    "validate_output",
    "Validate `output` against a dispatched role's outputSchema (Ajv, draft 2020-12). " +
      "Returns { ok:true } or { ok:false, errors:[{ path, message, keyword, schemaPath, params }] } " +
      "with every failing constraint (the failing JSON-Schema field path included). Fails fast on " +
      "an unknown roleId, and on an orchestrator-command roleId (which has no output schema). Only " +
      "available when the server has an asset-capable catalog root; otherwise returns a " +
      "not-implemented error.",
    { roleId: z.string(), output: z.unknown() } as const,
    async (args) => {
      if (promptCatalog === undefined) throw new PromptCatalogNotImplementedError();
      return jsonResult(promptCatalog.validateOutput(args.roleId, args.output));
    },
  );

  const tools = [
    enumerateLedgers,
    fetchLedger,
    fetchLedgerArchive,
    fetchItem,
    updateItem,
    createItem,
    createLedger,
    searchItems,
    ftsSearch,
    createMilestone,
    updateMilestone,
    fetchMilestone,
    archiveMilestone,
    listMilestoneItems,
    snapshotTool,
    derivePredicatesTool,
    reopenItem,
    unarchiveItem,
    readLogTool,
    getReviewers,
    getPlanners,
    getConfig,
    getAgentModels,
    fetchPrompt,
    validateInput,
    validateOutput,
  ] as unknown as AnyTool[];

  // Pure name transform (Q208): register each tool under its prefixed name.
  // Default `''` leaves every name byte-identical; handler bodies and Zod input
  // schemas are untouched. Derived ONCE here rather than at each tool() literal.
  if (toolPrefix === "") return tools;
  return tools.map((t) => ({ ...t, name: prefixToolName(toolPrefix, t.name) }));
}

// ---------------------------------------------------------------------------
// Tool-name prefix helpers (Q205 / T373)
// ---------------------------------------------------------------------------

/**
 * Regex that a tool prefix must match (non-empty values only).
 * Letters and digits only so that `<prefix>_<name>` stays within the
 * safeId charset `^[a-zA-Z0-9_-]+$`.
 */
export const TOOL_PREFIX_RE = /^[a-zA-Z0-9]+$/;

/**
 * Validate a tool prefix at the system boundary.
 * Accepts `''` (the cq default = unprefixed).
 * Throws a descriptive Error for any non-empty value that does not match
 * TOOL_PREFIX_RE (letters/digits only).
 */
export function assertToolPrefix(prefix: string): void {
  if (prefix === "") return;
  if (!TOOL_PREFIX_RE.test(prefix)) {
    throw new Error(
      `Invalid tool prefix ${JSON.stringify(prefix)}: must be empty or match /^[a-zA-Z0-9]+$/ (letters and digits only)`,
    );
  }
}

/**
 * Apply a prefix to a single tool name.
 * Returns the name unchanged when prefix is `''`; otherwise `${prefix}_${name}`.
 * Calls assertToolPrefix first.
 */
export function prefixToolName(prefix: string, name: string): string {
  assertToolPrefix(prefix);
  return prefix === "" ? name : `${prefix}_${name}`;
}

/**
 * Return the full list of ledger tool names, optionally prefixed.
 * `prefixedToolNames('')` returns a copy of LEDGER_TOOL_NAMES.
 * `prefixedToolNames('myproj')` returns `['myproj_enumerate_ledgers', ...]`.
 * Calls assertToolPrefix first.
 */
export function prefixedToolNames(prefix: string): string[] {
  assertToolPrefix(prefix);
  if (prefix === "") return [...LEDGER_TOOL_NAMES];
  return LEDGER_TOOL_NAMES.map((name) => `${prefix}_${name}`);
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
  "fts_search",
  "create_milestone",
  "update_milestone",
  "fetch_milestone",
  "archive_milestone",
  "list_milestone_items",
  "snapshot",
  "derive_predicates",
  "reopen_item",
  "unarchive_item",
  "read_log",
  "get_reviewers",
  "get_planners",
  "get_config",
  "get_agent_models",
  "fetch_prompt",
  "validate_input",
  "validate_output",
] as const;
