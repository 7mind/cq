/**
 * Ledger MCP tool factory (msunify cycle).
 *
 * Returns a compatibility array of `tool()` instances for direct invocation
 * and composition. Anthropic in-process MCP hosts should use
 * `createLedgerSdkMcpServer`, which preserves these Zod handlers while
 * publishing the compact public tools/list schemas.
 * The canonical typed specifications feed both this direct factory and
 * `registerLedgerStdioTools` (./stdioLedgerTools.ts). The full compatibility
 * surface is `LEDGER_TOOL_NAMES`; the six dispatch handlers are omitted when
 * no durable `DispatchCapability` is supplied, and named role profiles are
 * intersected before either transport serializes `tools/list`.
 *
 * Capability-gated tools:
 *  - read_log requires an explicit FS-store `readLog` capability (Q87 / R137 #6);
 *    over an in-memory store it throws `ReadLogNotImplementedError`.
 *  - sectioned get_config requires an injected
 *    `configCapability` (constructed in @cq/ledger-mcp over @cq/config, R193/G18);
 *    absent it they throw `ConfigNotImplementedError`.
 *  - the four guarded plan-lifecycle tools (T852, ./planLifecycleTools.ts)
 *    require a store that implements `PlanLifecycleStore`; every production
 *    backend does, and a store that does not throws
 *    `PlanLifecycleNotImplementedError`.
 *  - list_projects requires an injected `listProjects` capability (T585 /
 *    Q284); UNLIKE the above, every real server always supplies one (the
 *    public `createLedgerMcpServer` builder never leaves it undefined) — the
 *    `ListProjectsNotImplementedError` it throws when absent is reachable
 *    only by calling this factory directly without threading one.
 *
 * Each handler turns validated input into a single LedgerStore call, serialises
 * the result as JSON, and returns it as a text content block. Errors surface via
 * thrown Error (the SDK reports them as tool errors). Tool names are prefixed
 * `mcp__cq__*` by the SDK; the bridge's `canUseTool` auto-allow already covers them.
 */

import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import {
  exposedLedgerToolsForRole,
  LEDGER_CAPABILITY_TOOL_NAMES,
  type LedgerCapabilityToolName,
} from "@cq/config";
import type {
  LedgerStore,
  CreateItemInit,
  CreateMilestoneItemInit,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "../store/LedgerStore.js";
import { MILESTONES_LEDGER } from "../constants.js";
import type { FieldValue, LedgerSchema } from "../types.js";
import { LedgerError } from "../types.js";
import { paginate } from "../projection.js";
import { derivePredicates } from "../store/predicates.js";
import { computeLedgerSummaries } from "../summaries.js";
import {
  appendLedgerResponseDescription,
  ITEM_MUTATION_ACK_DESCRIPTION,
  ITEM_PROJECTION_DESCRIPTION,
  LEDGER_MUTATION_ACK_DESCRIPTION,
  produceWireDto,
  projectFetchedLedgerDto,
  projectFetchedMilestoneDto,
  projectFtsSearchResultsDto,
  projectItemDto,
  projectItemMutationAckDto,
  projectLedgerMutationAckDto,
  projectMilestoneItemGroupsDto,
  projectPaginatedLedgerDto,
  serializeWireDto,
  type ProducedWireDto,
} from "./wireResponseContract.js";
import { ReadLogNotImplementedError, type ReadLogCapability } from "./readLog.js";
import {
  CONFIG_SECTIONS,
  ConfigNotImplementedError,
  computeConfigSection,
  type ConfigCapability,
} from "./configCapability.js";
import type { DispatchCapability } from "./dispatchCapability.js";
import {
  ABORT_DISPATCH_INPUT,
  CONFIRM_DISPATCH_COMPLETION_INPUT,
  FETCH_DISPATCH_INPUT_INPUT,
  FETCH_DISPATCH_RESULT_INPUT,
  PREPARE_DISPATCH_INPUT,
  STORE_RESULT_INPUT,
} from "./dispatchToolSchemas.js";
import {
  PromptCatalogNotImplementedError,
  type PromptCatalogCapability,
} from "./promptCatalogCapability.js";
import { ListProjectsNotImplementedError, type ListProjectsCapability } from "./listProjects.js";
import { PLAN_LIFECYCLE_TOOL_SPECS } from "./planLifecycleTools.js";

/** The compatibility profile: every capability-gated tool specification. */
export const FULL_LEDGER_TOOL_PROFILE = "full";

/** A named tool profile. Role ids resolve through T1325's authoritative matrix. */
export type LedgerToolProfileName = string;

/** Canonical tool-name order, owned by the T1325 capability inventory. */
export const LEDGER_TOOL_NAMES = LEDGER_CAPABILITY_TOOL_NAMES;

export type LedgerToolName = LedgerCapabilityToolName;

export const DISPATCH_LIFECYCLE_TOOL_NAMES = [
  "prepare_dispatch",
  "fetch_dispatch_input",
  "store_result",
  "confirm_dispatch_completion",
  "abort_dispatch",
  "fetch_dispatch_result",
] as const satisfies readonly LedgerToolName[];

const DISPATCH_LIFECYCLE_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  DISPATCH_LIFECYCLE_TOOL_NAMES,
);

/** The surface registered when no durable dispatch capability exists. */
export const NON_DISPATCH_LEDGER_TOOL_NAMES = LEDGER_TOOL_NAMES.filter(
  (name) => !DISPATCH_LIFECYCLE_TOOL_NAME_SET.has(name),
);

/**
 * The SDK's `tools?:` field on createSdkMcpServer is typed as
 * `Array<SdkMcpToolDefinition<any>>`. We alias that here so our factory
 * can return a heterogeneous list of tools without TS rejecting the union.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = SdkMcpToolDefinition<any>;

/**
 * One transport-independent ledger tool specification. Direct Claude tools
 * and raw MCP SDK registrations both derive from this shape.
 */
export type LedgerToolSpecification = AnyTool & {
  readonly name: LedgerToolName;
  readonly description: string;
};

function simplifyInputSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(simplifyInputSchemaNode);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "$schema" && key !== "description")
    .map(([key, child]) => [key, simplifyInputSchemaNode(child)] as const);
  const simplified = Object.fromEntries(entries) as Record<string, unknown>;
  const allOf = simplified["allOf"];
  if (Object.keys(simplified).length === 1 && Array.isArray(allOf) && allOf.length === 1) {
    const only = allOf[0];
    if (
      only !== null &&
      typeof only === "object" &&
      Object.keys(only as Record<string, unknown>).length === 1 &&
      typeof (only as Record<string, unknown>)["$ref"] === "string"
    ) {
      return only;
    }
  }
  return simplified;
}

/** Serialize the validating Zod shape to the deliberately minimal public JSON Schema. */
export function ledgerToolInputJsonSchema(
  specification: LedgerToolSpecification,
): Record<string, unknown> {
  const converted = z.toJSONSchema(
    z.object(specification.inputSchema as Record<string, z.ZodType>),
    { target: "draft-7", unrepresentable: "any" },
  );
  const schema = simplifyInputSchemaNode(converted) as Record<string, unknown>;
  if (specification.name === "create_item" || specification.name.endsWith("_create_item")) {
    schema["allOf"] = [
      {
        if: {
          properties: { ledger_id: { const: MILESTONES_LEDGER } },
          required: ["ledger_id"],
        },
        then: {
          not: { required: ["milestone_id"] },
          properties: {
            status: { const: "open" },
            fields: { required: ["title"] },
          },
        },
        else: { required: ["milestone_id"] },
      },
    ];
  } else if (specification.name === "update_item" || specification.name.endsWith("_update_item")) {
    schema["allOf"] = [
      {
        if: {
          properties: { ledger_id: { const: MILESTONES_LEDGER } },
          required: ["ledger_id"],
        },
        then: {
          properties: {
            status: { enum: ["open", "done", "postponed", "blocked"] },
          },
        },
      },
    ];
  }
  return schema;
}

export interface LedgerToolListDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: LedgerToolSpecification["annotations"];
  readonly _meta?: Record<string, unknown>;
}

/** Build the compact public tools/list definitions shared by both transports. */
export function ledgerToolListDefinitions(
  specifications: readonly LedgerToolSpecification[],
  toolPrefix: string,
  alwaysLoad: boolean = false,
): LedgerToolListDefinition[] {
  assertToolPrefix(toolPrefix);
  return specifications.map((specification) => {
    const meta = {
      ...specification._meta,
      ...(alwaysLoad ? { "anthropic/alwaysLoad": true } : {}),
    };
    return {
      name: prefixToolName(toolPrefix, specification.name),
      description: specification.description,
      inputSchema: ledgerToolInputJsonSchema(specification),
      ...(specification.annotations === undefined
        ? {}
        : { annotations: specification.annotations }),
      ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }),
    };
  });
}

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

function wireResult(value: ProducedWireDto<object>): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: serializeWireDto(value) }],
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
  .regex(/^[A-Za-z0-9 _-]+$/, "status value may only contain A-Za-z0-9, space, dash, underscore");

// D-LED-02: field names become YAML keys; restrict to identifier-style
// names and forbid the intrinsic Item field names.
const RESERVED_FIELD_NAMES_ZOD = ["createdAt", "updatedAt", "author", "session"];
const fieldNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "field name must match /^[A-Za-z_][A-Za-z0-9_]*$/")
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
  .refine((s) => s.terminalStatuses.every((t) => s.statusValues.includes(t)), {
    message: "every terminalStatuses entry must be in statusValues",
    path: ["terminalStatuses"],
  });

/**
 * Field values may be string or string[]. Timestamps are ISO 8601
 * strings after the msunify cycle (numeric epoch ms is gone).
 */
const fieldValueSchema = z.union([z.string(), z.array(z.string())]);

const fieldsSchema = z.record(z.string(), fieldValueSchema);

const projectionSchema = z.enum(["compact", "full"]).describe(ITEM_PROJECTION_DESCRIPTION);

/**
 * D-LED-01: caller-supplied milestone/item ids cannot contain `/`, `.`, or
 * whitespace — anything that could escape the filesystem path
 * `FsLedgerStore` derives from them.
 */
const safeIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "id may only contain A-Za-z0-9_-");

const COMPLETE_DESCRIPTION_TOOL_NAMES: ReadonlySet<LedgerToolName> = new Set([
  "fetch_ledger",
  "fetch_item",
  "update_item",
  "create_item",
  "search_items",
  "fts_search",
  "list_milestone_items",
  "snapshot",
  "derive_predicates",
]);

function optionalMilestoneString(
  fields: Record<string, FieldValue>,
  name: "title" | "description",
): string | undefined {
  const value = fields[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new LedgerError(`milestones field "${name}" must be a string`);
  }
  return value;
}

function optionalMilestoneReferences(
  fields: Record<string, FieldValue>,
  name: "blockedBy" | "dependsOn",
): string[] | undefined {
  const value = fields[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new LedgerError(`milestones field "${name}" must be a string[]`);
  }
  return value;
}

function assertOnlyMilestoneFields(fields: Record<string, FieldValue>): void {
  const allowed = new Set(["title", "description", "blockedBy", "dependsOn"]);
  const unsupported = Object.keys(fields).find((name) => !allowed.has(name));
  if (unsupported !== undefined) {
    throw new LedgerError(`unknown milestones field "${unsupported}"`);
  }
}

// ---------------------------------------------------------------------------
// Tool builders
// ---------------------------------------------------------------------------

export function createLedgerMcpToolSpecifications(
  store: LedgerStore,
  readLog?: ReadLogCapability,
  configCapability?: ConfigCapability,
  promptCatalog?: PromptCatalogCapability,
  listProjects?: ListProjectsCapability,
  dispatchCapability?: DispatchCapability,
): LedgerToolSpecification[] {
  // ---- Item / ledger surface (9) -----------------------------------------

  const enumerateLedgers = tool(
    "enumerate_ledgers",
    "List all known ledger names, plus a `counts` map of each ledger's active-item count.",
    {} as Record<string, never>,
    async () => jsonResult(computeLedgerSummaries(store)),
  );

  const fetchLedger = tool(
    "fetch_ledger",
    "Fetch a ledger's schema, active milestone groups with resolved milestone metadata, and archive pointers. projection is required: compact returns identity, status, timestamps, provenance, summary fields, and references; full returns every item field. Without pagination returns grouped {ledger}; offset/limit returns flattened {ledger,items,total,offset,limit,nextOffset}. Follow nextOffset until null.",
    {
      ledger_id: z.string(),
      projection: projectionSchema,
      offset: z.number().int().min(0).optional().describe("zero-based start index for pagination"),
      limit: z.number().int().positive().optional().describe("max items to return per page"),
    } as const,
    async (args) => {
      const fetched = store.fetch(args.ledger_id);
      const usePagination = args.offset !== undefined || args.limit !== undefined;

      if (usePagination) {
        const allItems = fetched.milestones.flatMap((g) => g.items);
        const offset = args.offset ?? 0;
        const { items, total } = paginate(allItems, offset, args.limit);
        const nextOffset =
          args.limit !== undefined && offset + items.length < total ? offset + items.length : null;
        const { milestones: _omit, ...ledgerMeta } = fetched;
        void _omit;
        return wireResult(
          projectPaginatedLedgerDto(
            {
              ledger: ledgerMeta,
              items,
              total,
              offset,
              limit: args.limit ?? null,
              nextOffset,
            },
            args.projection,
          ),
        );
      }

      return wireResult(
        produceWireDto({
          ledger: projectFetchedLedgerDto(fetched, args.projection),
        }),
      );
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
    "Fetch one active item. For ledger_id=milestones, item_id is the milestone id and the response is {item,resolved,references}, preserving resolved metadata and per-ledger active reference counts; other ledgers return {item}. projection is required: compact returns identity, status, timestamps, provenance, summary fields, and references; full returns every item field.",
    {
      ledger_id: z.string(),
      item_id: z.string(),
      projection: projectionSchema,
    } as const,
    async (args) => {
      if (args.ledger_id === MILESTONES_LEDGER) {
        const fetched = projectFetchedMilestoneDto(
          store.fetchMilestone(args.item_id),
          args.projection,
        );
        return wireResult(
          produceWireDto({
            item: fetched.milestone,
            resolved: fetched.resolved,
            references: fetched.references,
          }),
        );
      }
      return wireResult(
        produceWireDto({
          item: projectItemDto(store.fetchItem(args.ledger_id, args.item_id), args.projection),
        }),
      );
    },
  );

  const updateItem = tool(
    "update_item",
    "Update one item while preserving omitted values. For ledger_id=milestones, item_id is the milestone id and milestone status plus dependency-DAG invariants remain explicit. All writes validate the ledger schema, canonicalize recognized references, reject newly added dangling known-ledger refs, and record optional author/session provenance. Returns the generic item acknowledgement.",
    {
      ledger_id: z.string(),
      item_id: z.string(),
      status: z.string().optional(),
      fields: fieldsSchema.optional(),
      author: authorParam,
      session: sessionParam,
    } as const,
    async (args) => {
      if (args.ledger_id === MILESTONES_LEDGER) {
        const fields = (args.fields ?? {}) as Record<string, FieldValue>;
        assertOnlyMilestoneFields(fields);
        const patch: UpdateMilestoneItemPatch = {};
        if (args.status !== undefined) patch.status = args.status;
        const title = optionalMilestoneString(fields, "title");
        if (title !== undefined) patch.title = title;
        const description = optionalMilestoneString(fields, "description");
        if (description !== undefined) patch.description = description;
        const blockedBy = optionalMilestoneReferences(fields, "blockedBy");
        if (blockedBy !== undefined) patch.blockedBy = blockedBy;
        const dependsOn = optionalMilestoneReferences(fields, "dependsOn");
        if (dependsOn !== undefined) patch.dependsOn = dependsOn;
        if (args.author !== undefined) patch.author = args.author;
        if (args.session !== undefined) patch.session = args.session;
        const milestone = await store.updateMilestone(args.item_id, patch);
        return wireResult(produceWireDto({ item: projectItemMutationAckDto(milestone) }));
      }
      const patch: UpdateItemPatch = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.fields !== undefined) patch.fields = args.fields as Record<string, FieldValue>;
      if (args.author !== undefined) patch.author = args.author;
      if (args.session !== undefined) patch.session = args.session;
      const item = await store.updateItem(args.ledger_id, args.item_id, patch);
      return wireResult(produceWireDto({ item: projectItemMutationAckDto(item) }));
    },
  );

  const createItem = tool(
    "create_item",
    "Create an item. For ledger_id=milestones, omit milestone_id, require status=open and fields.title, allocate the root M<n> counter, validate dependency-DAG fields, and return the generic item acknowledgement. Every other ledger requires an active nonterminal milestone_id. All writes validate the ledger schema, canonicalize recognized references, reject newly added dangling known-ledger refs, and record optional author/session provenance.",
    {
      ledger_id: z.string(),
      milestone_id: safeIdSchema.optional(),
      status: z.string(),
      fields: fieldsSchema,
      id: safeIdSchema.optional(),
      author: authorParam,
      session: sessionParam,
    } as const,
    async (args) => {
      if (args.ledger_id === MILESTONES_LEDGER) {
        if (args.milestone_id !== undefined) {
          throw new LedgerError("milestone_id must be omitted for the milestones ledger");
        }
        if (args.status !== "open") {
          throw new LedgerError('milestones items must be created with status "open"');
        }
        const fields = args.fields as Record<string, FieldValue>;
        assertOnlyMilestoneFields(fields);
        const title = optionalMilestoneString(fields, "title");
        if (title === undefined) throw new LedgerError('milestones field "title" is required');
        const init: CreateMilestoneItemInit = { title };
        const description = optionalMilestoneString(fields, "description");
        if (description !== undefined) init.description = description;
        const blockedBy = optionalMilestoneReferences(fields, "blockedBy");
        if (blockedBy !== undefined) init.blockedBy = blockedBy;
        const dependsOn = optionalMilestoneReferences(fields, "dependsOn");
        if (dependsOn !== undefined) init.dependsOn = dependsOn;
        if (args.id !== undefined) init.id = args.id;
        if (args.author !== undefined) init.author = args.author;
        if (args.session !== undefined) init.session = args.session;
        const milestone = await store.createMilestone(init);
        return wireResult(produceWireDto({ item: projectItemMutationAckDto(milestone) }));
      }
      if (args.milestone_id === undefined) {
        throw new LedgerError("milestone_id is required outside the milestones ledger");
      }
      const init: CreateItemInit = {
        status: args.status,
        fields: args.fields as Record<string, FieldValue>,
      };
      if (args.id !== undefined) init.id = args.id;
      if (args.author !== undefined) init.author = args.author;
      if (args.session !== undefined) init.session = args.session;
      const item = await store.createItem(args.ledger_id, args.milestone_id, init);
      return wireResult(produceWireDto({ item: projectItemMutationAckDto(item) }));
    },
  );

  const createLedger = tool(
    "create_ledger",
    `Create a new ledger. Schema specifies allowed statuses, which subset is terminal, and the typed fields each item carries. The name \`milestones\` is reserved. ${LEDGER_MUTATION_ACK_DESCRIPTION}`,
    {
      name: z.string(),
      schema: schemaSchema,
    } as const,
    async (args) => {
      const schema = args.schema as LedgerSchema;
      const ledger = await store.createLedger(args.name, schema);
      return wireResult(produceWireDto({ ledger: projectLedgerMutationAckDto(ledger) }));
    },
  );

  const searchItems = tool(
    "search_items",
    "Substring-search status and fields within one ledger. projection is required: compact returns identity, status, timestamps, provenance, summary fields, and references; full returns every item field. Returns {items}.",
    {
      ledger_id: z.string(),
      query: z.string(),
      projection: projectionSchema,
    } as const,
    async (args) =>
      wireResult(
        produceWireDto({
          items: store
            .search(args.ledger_id, args.query)
            .map((item) => projectItemDto(item, args.projection)),
        }),
      ),
  );

  const ftsSearch = tool(
    "fts_search",
    "Ranked cross-ledger search with optional ledger/status prefilters, archived coverage, fuzzy matching, and prefixes. query accepts free text; field:value qualifiers for status, ledger, milestone, author, session, and item fields; quoted values; implicit AND; uppercase OR; NOT or leading -; and parentheses. The status prefilter composes with query. Terminal items remain active until archive_milestone. Returns ranked {ledgerId,item,score,matchedFields} results; compact returns identity, status, timestamps, provenance, summary fields, and references; full returns every item field.",
    {
      query: z.string(),
      projection: projectionSchema,
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
      return wireResult(
        produceWireDto({
          results: projectFtsSearchResultsDto(hits, args.projection),
        }),
      );
    },
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
    "Return active items grouped by ledger that reference one milestone. projection is required: compact returns identity, status, timestamps, provenance, summary fields, and references; full returns every item field.",
    {
      milestone_id: safeIdSchema,
      projection: projectionSchema,
    } as const,
    async (args) =>
      wireResult(
        produceWireDto({
          items: projectMilestoneItemGroupsDto(
            store.listMilestoneItems(args.milestone_id),
            args.projection,
          ),
        }),
      ),
  );

  // ---- Recovery tools (2) ------------------------------------------------

  const reopenItem = tool(
    "reopen_item",
    `Recover an item accidentally set to a terminal status by moving it to a chosen non-terminal status. ${ITEM_MUTATION_ACK_DESCRIPTION}`,
    {
      ledger_id: z.string(),
      item_id: z.string(),
      to_status: z.string(),
    } as const,
    async (args) => {
      const item = await store.reopenItem(args.ledger_id, args.item_id, args.to_status);
      return wireResult(produceWireDto({ item: projectItemMutationAckDto(item) }));
    },
  );

  const unarchiveItem = tool(
    "unarchive_item",
    `Restore a single item that was swept into its milestone-group archive (./.cq/archive/<ledger>/<milestoneId>.md) back to the active ledger; pass the archived item's milestone id. ${ITEM_MUTATION_ACK_DESCRIPTION}`,
    {
      ledger_id: z.string(),
      milestone_id: safeIdSchema,
      item_id: z.string(),
    } as const,
    async (args) => {
      const item = await store.unarchiveItem(args.ledger_id, args.milestone_id, args.item_id);
      return wireResult(produceWireDto({ item: projectItemMutationAckDto(item) }));
    },
  );

  // ---- Cross-ledger overview (1) -----------------------------------------

  const snapshotTool = tool(
    "snapshot",
    "Return active items as compact {id,status,summary} stubs grouped by ledger and status. The include_archived parameter remains reserved and has no effect.",
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
    "Return the authoritative /cq:advance verdicts pInvestigate, pSeed, pPlan, pResearch, pImplement, openQuestionGate, belowFloor, planBusy, and goalDrift as {value,items}. The first five are actionable flows; openQuestionGate suppresses gated work; belowFloor, planBusy, and goalDrift are informational.",
    {} as Record<string, never>,
    async () => jsonResult(derivePredicates(store)),
  );

  // ---- Filesystem read (1) -----------------------------------------------

  const readLogTool = tool(
    "read_log",
    'Read a log file under the ledger\'s <root>/.cq/logs/ directory and return its text content. `path` is repo-relative to .cq/logs (e.g. "20260101-1200-session.md"); absolute paths and any path escaping .cq/logs (e.g. `..` traversal) are rejected. Oversized files are truncated (truncated:true). Returns { path, content, truncated? }. Only available when the server is filesystem-backed; against an in-memory store it returns a not-implemented error.',
    {
      path: z.string().describe("repo-relative path under .cq/logs/"),
    } as const,
    async (args) => {
      if (readLog === undefined) throw new ReadLogNotImplementedError();
      return jsonResult(await readLog(args.path));
    },
  );

  // ---- Config capability (1) ---------------------------------------------

  const getConfig = tool(
    "get_config",
    "Return one independently-fallbacked cq.toml section. reviewers and planners " +
      "preserve their former resolved payloads; agent_models preserves its former " +
      "per-role overlay; all preserves the former full get_config payload.",
    { section: z.enum(CONFIG_SECTIONS) } as const,
    async (args) => {
      if (configCapability === undefined) throw new ConfigNotImplementedError();
      return jsonResult(computeConfigSection(configCapability, args.section));
    },
  );

  const prepareDispatchTool = tool(
    "prepare_dispatch",
    "Validate and durably prepare one typed dispatch, returning its handle, deadlines, provenance, and distinct input/result capabilities.",
    PREPARE_DISPATCH_INPUT,
    async (args) => {
      if (dispatchCapability === undefined) throw new Error("unreachable dispatch tool");
      return jsonResult(
        await dispatchCapability.prepare({
          ...(args.roleId === undefined ? {} : { roleId: args.roleId }),
          ...(args.input === undefined ? {} : { input: args.input }),
          ...(args.refs === undefined ? {} : { refs: args.refs }),
          idempotencyKey: args.idempotencyKey,
          timeoutMs: args.timeoutMs,
          ...(args.overlays === undefined ? {} : { overlays: args.overlays }),
          expectedChild: args.expectedChild,
          ...(args.reprepareOf === undefined ? {} : { reprepareOf: args.reprepareOf }),
        }),
      );
    },
  );
  const fetchDispatchInputTool = tool(
    "fetch_dispatch_input",
    "Materialize the prepare-bound typed child input exactly once using its distinct input capability.",
    FETCH_DISPATCH_INPUT_INPUT,
    async (args) => {
      if (dispatchCapability === undefined) throw new Error("unreachable dispatch tool");
      return jsonResult(await dispatchCapability.fetchInput(args));
    },
  );
  const storeResultTool = tool(
    "store_result",
    "Store a typed child result using the capability that authorizes only this operation.",
    STORE_RESULT_INPUT,
    async (args) => {
      if (dispatchCapability === undefined) throw new Error("unreachable dispatch tool");
      return jsonResult(await dispatchCapability.storeResult(args));
    },
  );
  const confirmDispatchCompletionTool = tool(
    "confirm_dispatch_completion",
    "Confirm observed native completion and promote a stored result to consumed without returning its body.",
    CONFIRM_DISPATCH_COMPLETION_INPUT,
    async (args) => {
      if (dispatchCapability === undefined) throw new Error("unreachable dispatch tool");
      return jsonResult(await dispatchCapability.confirmCompletion(args));
    },
  );
  const abortDispatchTool = tool(
    "abort_dispatch",
    "Abort a prepared dispatch with a typed terminal reason.",
    ABORT_DISPATCH_INPUT,
    async (args) => {
      if (dispatchCapability === undefined) throw new Error("unreachable dispatch tool");
      return jsonResult(
        await dispatchCapability.abort({
          attestationId: args.attestationId,
          generation: args.generation,
          reason: args.reason,
          ...(args.details === undefined ? {} : { details: args.details }),
        }),
      );
    },
  );
  const fetchDispatchResultTool = tool(
    "fetch_dispatch_result",
    "Materialize a consumed dispatch result exactly once. Input is the dispatch handle only.",
    FETCH_DISPATCH_RESULT_INPUT,
    async (args) => {
      if (dispatchCapability === undefined) throw new Error("unreachable dispatch tool");
      return jsonResult(await dispatchCapability.fetch(args));
    },
  );

  // ---- Ordinary prompt-catalog MCP surface (1) ---------------------------
  // Both validators remain available on PromptCatalogCapability only for
  // explicit inspection/debug callers; ordinary tools/list advertises neither.

  const fetchPrompt = tool(
    "fetch_prompt",
    "Fetch a role's typed prompt-catalog entry: { roleId, kind, dispatched, " +
      "promptTemplate, promptSurface?, renderer?, sourcePath?, workflowDependencies?, " +
      "requiredCapabilities?, intentionalDifferences?, version?, inputSchema?, " +
      "outputSchema? }. Built prompt roots return the additive surface-build metadata; " +
      "requiredCapabilities is the ordered catalog renderer-fragment capability list. " +
      "A dispatched-subagent " +
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

  // ---- Multi-project overview (1) ----------------------------------------

  const listProjectsTool = tool(
    "list_projects",
    "List every project this server's store knows about. Returns " +
      "{ projects: [{ key, displayName, createdAt? }] }. A multi-tenant " +
      "backend (postgres) returns every registered tenant; every other " +
      "backend (xdg, in-memory) returns EXACTLY ONE entry synthesized from " +
      "this server's own resolved project — so callers never need to sniff " +
      "the backend to know how many projects to expect.",
    {} as Record<string, never>,
    async () => {
      if (listProjects === undefined) throw new ListProjectsNotImplementedError();
      return jsonResult(await listProjects());
    },
  );

  // ---- Guarded plan lifecycle (4) ----------------------------------------

  // Built from the SHARED specs so the stdio registration cannot drift: one
  // description, one Zod shape, one handler per guarded mutation (T852).
  const planLifecycleTools = PLAN_LIFECYCLE_TOOL_SPECS.map((spec) =>
    tool(spec.name, spec.description, spec.inputSchema, async (args: unknown) =>
      wireResult(await spec.run(store, args)),
    ),
  );

  const dispatchTools =
    dispatchCapability === undefined
      ? []
      : [
          prepareDispatchTool,
          fetchDispatchInputTool,
          storeResultTool,
          confirmDispatchCompletionTool,
          abortDispatchTool,
          fetchDispatchResultTool,
        ];
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
    archiveMilestone,
    listMilestoneItems,
    snapshotTool,
    derivePredicatesTool,
    reopenItem,
    unarchiveItem,
    readLogTool,
    getConfig,
    ...dispatchTools,
    fetchPrompt,
    listProjectsTool,
    ...planLifecycleTools,
  ] as unknown as AnyTool[];

  const registeredToolNames =
    dispatchCapability === undefined ? NON_DISPATCH_LEDGER_TOOL_NAMES : LEDGER_TOOL_NAMES;
  return tools.map((ledgerTool, index) => {
    const toolName = registeredToolNames[index];
    if (toolName === undefined || ledgerTool.name !== toolName) {
      throw new Error(`Ledger tool response-description order drift at ${ledgerTool.name}`);
    }
    return {
      ...ledgerTool,
      description: COMPLETE_DESCRIPTION_TOOL_NAMES.has(toolName)
        ? ledgerTool.description
        : appendLedgerResponseDescription(toolName, ledgerTool.description),
    } as LedgerToolSpecification;
  });
}

/** Resolve a fail-closed named profile through the T1325 role matrix. */
export function ledgerToolNamesForProfile(
  profileName: LedgerToolProfileName = FULL_LEDGER_TOOL_PROFILE,
): readonly LedgerToolName[] {
  if (profileName === FULL_LEDGER_TOOL_PROFILE) return LEDGER_TOOL_NAMES;
  return exposedLedgerToolsForRole(profileName);
}

/**
 * Filter canonical specifications before either transport can serialize
 * `tools/list`. Capability gating has already removed unavailable dispatch
 * specifications before this profile intersection runs.
 */
export function selectLedgerMcpToolSpecifications(
  specifications: readonly LedgerToolSpecification[],
  profileName: LedgerToolProfileName = FULL_LEDGER_TOOL_PROFILE,
): LedgerToolSpecification[] {
  const selectedNames = new Set<LedgerToolName>(ledgerToolNamesForProfile(profileName));
  return specifications.filter((specification) => selectedNames.has(specification.name));
}

export function createLedgerMcpTools(
  store: LedgerStore,
  readLog?: ReadLogCapability,
  configCapability?: ConfigCapability,
  promptCatalog?: PromptCatalogCapability,
  toolPrefix: string = "",
  listProjects?: ListProjectsCapability,
  dispatchCapability?: DispatchCapability,
  profileName: LedgerToolProfileName = FULL_LEDGER_TOOL_PROFILE,
): AnyTool[] {
  assertToolPrefix(toolPrefix);
  const specifications = selectLedgerMcpToolSpecifications(
    createLedgerMcpToolSpecifications(
      store,
      readLog,
      configCapability,
      promptCatalog,
      listProjects,
      dispatchCapability,
    ),
    profileName,
  );
  if (toolPrefix === "") return specifications;
  return specifications.map((specification) => ({
    ...specification,
    name: prefixToolName(toolPrefix, specification.name),
  }));
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
