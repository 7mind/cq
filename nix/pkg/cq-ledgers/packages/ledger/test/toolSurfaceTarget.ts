import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  ROLE_TOOL_CAPABILITY_MATRIX,
  exposedLedgerToolsForRole,
} from "../../cq-config/src/index.js";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

interface ToolDefinition extends Record<string, unknown> {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface SerializedMeasurement {
  utf8Bytes: number;
  tokens: number;
  sha256: string;
}

interface CounterfactualMeasurement {
  method: "independent whole-value JSON.stringify with o200k_base";
  current: SerializedMeasurement;
  counterfactual: SerializedMeasurement;
  deltaUtf8Bytes: number;
  deltaTokens: number;
}

interface G129Baseline {
  tokenizer: {
    package: "gpt-tokenizer";
    version: "3.4.0";
    encoding: "o200k_base";
  };
  profiles: {
    full: {
      initialize: { instructions: { serialization: string; tokens: number } };
      toolsList: { serialization: string; tokens: number };
    };
    "non-dispatch": {
      toolsList: { tokens: number };
    };
  };
}

const REPO_ROOT = resolve(import.meta.dir, "../../../../../..");
const G129_BASELINE_PATH = resolve(
  import.meta.dir,
  "../../../scripts/baselines/g129-tool-surface.json",
);
const DEFAULT_TARGET_PATH = resolve(
  import.meta.dir,
  "../../../scripts/baselines/t1326-tool-surface-target.json",
);

const TARGET_INSTRUCTIONS = `Project: tool-surface-profiler

Markdown-backed typed ledgers. Milestones form dependency DAGs; other items attach to milestones. Discover schemas with enumerate_ledgers. Write schema-valid items with author/session provenance; recognized ledger references are canonicalized on write.

Reads require compact or full projection. Paginate fetch_ledger until nextOffset is null. fts_search spans active ledgers by default and accepts field qualifiers; terminal items remain active until archive_milestone sweeps a fully terminal milestone.

Use snapshot and derive_predicates for CQ flow state. Dispatch and plan-lifecycle tools retain their capability, generation, fence, recovery, and idempotency contracts; preserve exact identifiers returned by those tools.`;

const COMPACT_PROJECTION =
  "compact returns identity, status, timestamps, provenance, summary fields, and references; full returns every item field";

const DESCRIPTION_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  create_item:
    "Create a schema-valid item under an active, nonterminal milestone. Writes canonicalize recognized dependsOn, blockedBy, and ledgerRefs values and reject newly added dangling references to known ledgers. Pass author/session provenance. Returns a fixed non-narrative item acknowledgement.",
  create_milestone:
    "Create an open root item in the milestones ledger, allocating its M<n> id and preserving explicit dependency-DAG fields. Returns a fixed non-narrative milestone acknowledgement.",
  derive_predicates:
    "Return the authoritative /cq:advance verdicts pInvestigate, pSeed, pPlan, pResearch, pImplement, openQuestionGate, belowFloor, planBusy, and goalDrift as {value,items}. The first five are actionable flows; openQuestionGate suppresses gated work; belowFloor, planBusy, and goalDrift are informational.",
  fetch_item: `Fetch one active item from a ledger. projection is required: ${COMPACT_PROJECTION}. Returns {item}.`,
  fetch_ledger: `Fetch a ledger's schema, active milestone groups with resolved milestone metadata, and archive pointers. projection is required: ${COMPACT_PROJECTION}. Without pagination returns grouped {ledger}; offset/limit returns flattened {ledger,items,total,offset,limit,nextOffset}. Follow nextOffset until null.`,
  fetch_milestone: `Fetch a milestones-ledger item plus resolved dependency metadata and per-ledger active reference counts. projection is required: ${COMPACT_PROJECTION}. Returns {milestone,resolved,references}.`,
  fts_search: `Ranked cross-ledger search with optional ledger/status prefilters, archived coverage, fuzzy matching, and prefixes. query accepts free text; field:value qualifiers for status, ledger, milestone, author, session, and item fields; quoted values; implicit AND; uppercase OR; NOT or leading -; and parentheses. The status prefilter composes with query. Terminal items remain active until archive_milestone. Returns ranked {ledgerId,item,score,matchedFields} results; ${COMPACT_PROJECTION}.`,
  list_milestone_items: `Return active items grouped by ledger that reference one milestone. projection is required: ${COMPACT_PROJECTION}.`,
  search_items: `Substring-search status and fields within one ledger. projection is required: ${COMPACT_PROJECTION}. Returns {items}.`,
  snapshot:
    "Return active items as compact {id,status,summary} stubs grouped by ledger and status. The include_archived parameter remains reserved and has no effect.",
  update_item:
    "Replace the supplied status and/or fields of one active item while preserving omitted values. Writes canonicalize recognized dependsOn, blockedBy, and ledgerRefs values and reject newly added dangling references to known ledgers. Pass author/session provenance. Returns a fixed non-narrative item acknowledgement.",
  update_milestone:
    "Update status or fields on a root milestones-ledger item while preserving the milestone dependency DAG. Returns a fixed non-narrative milestone acknowledgement.",
});

const REMOVED_MILESTONE_TOOLS = [
  "create_milestone",
  "update_milestone",
  "fetch_milestone",
] as const;

const REPLACEMENT_TOOL = Object.freeze({
  create_milestone: "create_item",
  update_milestone: "update_item",
  fetch_milestone: "fetch_item",
} as const);

const MIGRATION_SCAN_ROOTS = [
  "README.md",
  "nix/pkg/cq-assets",
  "nix/pkg/cq-ledgers/packages",
] as const;

const MIGRATION_SCAN_EXCLUSIONS = [
  "nix/pkg/cq-ledgers/packages/cq-config/evidence/role-tool-corpus.json",
  "nix/pkg/cq-ledgers/packages/ledger/test/tool-surface-target.test.ts",
  "nix/pkg/cq-ledgers/packages/ledger/test/toolSurfaceTarget.ts",
] as const;

const MIGRATION_RULES = Object.freeze({
  create_milestone: {
    replacement: "create_item",
    callShape:
      'create_item({ledger_id:"milestones",status:"open",fields:{title,description?,blockedBy?,dependsOn?},id?,author?,session?})',
    response:
      "The generic item acknowledgement carries the allocated M<n> id. ledger_id=milestones omits milestone_id, requires status=open and fields.title, and validates the milestone DAG.",
  },
  update_milestone: {
    replacement: "update_item",
    callShape:
      'update_item({ledger_id:"milestones",item_id:milestone_id,status?,fields:{title?,description?,blockedBy?,dependsOn?},author?,session?})',
    response:
      "The generic item acknowledgement replaces the milestone acknowledgement; milestone status and dependency-DAG invariants remain ledger-specific.",
  },
  fetch_milestone: {
    replacement: "fetch_item",
    callShape:
      'fetch_item({ledger_id:"milestones",item_id:milestone_id,projection:"compact"|"full"})',
    response:
      "For ledger_id=milestones the generic response remains {item,resolved,references}, preserving resolved metadata and active reference counts.",
  },
});

const REQUIRED_CAPABILITY_COVERAGE = Object.freeze({
  cq: ["snapshot", "derive_predicates", "fetch_item", "create_item", "update_item"],
  frontends: [
    "enumerate_ledgers",
    "fetch_ledger",
    "fetch_item",
    "search_items",
    "fts_search",
    "list_milestone_items",
    "get_config",
    "list_projects",
  ],
  cli: [
    "enumerate_ledgers",
    "fetch_ledger",
    "fetch_item",
    "create_item",
    "update_item",
    "archive_milestone",
  ],
  lifecycle: ["create_item", "update_item", "reopen_item", "unarchive_item"],
  recovery: [
    "fetch_ledger_archive",
    "reopen_item",
    "unarchive_item",
    "abort_dispatch",
    "fetch_dispatch_result",
    "release_plan_claim",
  ],
  referenceCanonicalization: ["create_item", "update_item"],
  archive: ["archive_milestone", "fetch_ledger_archive", "list_milestone_items", "unarchive_item"],
  dispatch: [
    "prepare_dispatch",
    "fetch_dispatch_input",
    "store_result",
    "confirm_dispatch_completion",
    "abort_dispatch",
    "fetch_dispatch_result",
  ],
  planFencing: ["claim_plan", "publish_plan_draft", "release_plan_claim", "finalize_plan"],
});

function serializedMeasurement(value: unknown): SerializedMeasurement {
  const serialization = JSON.stringify(value);
  return {
    utf8Bytes: Buffer.byteLength(serialization, "utf8"),
    tokens: encode(serialization).length,
    sha256: createHash("sha256").update(serialization).digest("hex"),
  };
}

function counterfactual(current: unknown, target: unknown): CounterfactualMeasurement {
  const currentMeasurement = serializedMeasurement(current);
  const counterfactualMeasurement = serializedMeasurement(target);
  return {
    method: "independent whole-value JSON.stringify with o200k_base",
    current: currentMeasurement,
    counterfactual: counterfactualMeasurement,
    deltaUtf8Bytes: currentMeasurement.utf8Bytes - counterfactualMeasurement.utf8Bytes,
    deltaTokens: currentMeasurement.tokens - counterfactualMeasurement.tokens,
  };
}

function sortTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

function withDescriptionTargets(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return sortTools(
    tools.map((tool) => ({
      ...structuredClone(tool),
      ...(DESCRIPTION_REPLACEMENTS[tool.name] === undefined
        ? {}
        : { description: DESCRIPTION_REPLACEMENTS[tool.name] }),
    })),
  );
}

function simplifySchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(simplifySchemaNode);
  if (value === null || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const entries = Object.entries(input)
    .filter(([key]) => key !== "$schema" && key !== "description")
    .map(([key, child]) => [key, simplifySchemaNode(child)] as const);
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

function withSimplifiedSchemas(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return sortTools(
    tools.map((tool) => ({
      ...structuredClone(tool),
      inputSchema: simplifySchemaNode(tool.inputSchema) as Record<string, unknown>,
    })),
  );
}

function toolNamed(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  return structuredClone(tools.find((tool) => tool.name === name)!);
}

function withMilestoneCrudGenericized(tools: readonly ToolDefinition[]): ToolDefinition[] {
  const createItem = toolNamed(tools, "create_item");
  const createSchema = createItem.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  createSchema.required = createSchema.required.filter((name) => name !== "milestone_id");
  createSchema.properties["ledger_id"] = { type: "string" };
  createSchema["allOf" as keyof typeof createSchema] = [
    {
      if: {
        properties: { ledger_id: { const: "milestones" } },
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
  ] as never;
  createItem.description =
    "Create an item. For ledger_id=milestones, omit milestone_id, require status=open and fields.title, allocate the root M<n> counter, validate dependency-DAG fields, and return the generic item acknowledgement. Every other ledger requires an active nonterminal milestone_id. All writes validate the ledger schema, canonicalize recognized references, reject newly added dangling known-ledger refs, and record optional author/session provenance.";

  const updateItem = toolNamed(tools, "update_item");
  const updateSchema = updateItem.inputSchema as Record<string, unknown>;
  updateSchema["allOf"] = [
    {
      if: {
        properties: { ledger_id: { const: "milestones" } },
        required: ["ledger_id"],
      },
      then: {
        properties: {
          status: {
            enum: ["open", "done", "postponed", "blocked"],
          },
        },
      },
    },
  ];
  updateItem.description =
    "Update one item while preserving omitted values. For ledger_id=milestones, item_id is the milestone id and milestone status plus dependency-DAG invariants remain explicit. All writes validate the ledger schema, canonicalize recognized references, reject newly added dangling known-ledger refs, and record optional author/session provenance. Returns the generic item acknowledgement.";

  const fetchItem = toolNamed(tools, "fetch_item");
  fetchItem.description = `Fetch one active item. For ledger_id=milestones, item_id is the milestone id and the response is {item,resolved,references}, preserving resolved metadata and per-ledger active reference counts; other ledgers return {item}. projection is required: ${COMPACT_PROJECTION}.`;

  const retained = tools.filter(
    (tool) =>
      !(REMOVED_MILESTONE_TOOLS as readonly string[]).includes(tool.name) &&
      !["create_item", "update_item", "fetch_item"].includes(tool.name),
  );
  return sortTools([...retained, createItem, updateItem, fetchItem]);
}

function withCreateUpdateConsolidated(tools: readonly ToolDefinition[]): ToolDefinition[] {
  const createItem = toolNamed(tools, "create_item");
  const updateItem = toolNamed(tools, "update_item");
  const createSchema = structuredClone(createItem.inputSchema);
  const updateSchema = structuredClone(updateItem.inputSchema);
  (createSchema.properties as Record<string, unknown>)["operation"] = {
    const: "create",
  };
  (updateSchema.properties as Record<string, unknown>)["operation"] = {
    const: "update",
  };
  (createSchema.required as string[]).unshift("operation");
  (updateSchema.required as string[]).unshift("operation");
  const writeItem: ToolDefinition = {
    name: "write_item",
    description:
      "Create or update one item using the operation discriminator. Each branch retains its existing preconditions, required fields, schema validation, reference canonicalization, provenance, and fixed acknowledgement.",
    inputSchema: {
      oneOf: [createSchema, updateSchema],
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    execution: createItem.execution,
  };
  return sortTools([
    ...tools.filter((tool) => !["create_item", "update_item"].includes(tool.name)),
    writeItem,
  ]);
}

function withArchiveFoldedIntoUpdate(tools: readonly ToolDefinition[]): ToolDefinition[] {
  const updateItem = toolNamed(tools, "update_item");
  const archiveMilestone = toolNamed(tools, "archive_milestone");
  const updateSchema = structuredClone(updateItem.inputSchema);
  const archiveSchema = structuredClone(archiveMilestone.inputSchema);
  (updateSchema.properties as Record<string, unknown>)["operation"] = {
    const: "update",
  };
  (archiveSchema.properties as Record<string, unknown>)["operation"] = {
    const: "archive-milestone",
  };
  (updateSchema.required as string[]).unshift("operation");
  (archiveSchema.required as string[]).unshift("operation");
  updateItem.description =
    "Update one item, or archive a milestone and its groups atomically, using the operation discriminator. The archive branch requires every attached item to be terminal and returns its archive pointer.";
  updateItem.inputSchema = {
    oneOf: [updateSchema, archiveSchema],
    $schema: "http://json-schema.org/draft-07/schema#",
  };
  return sortTools([
    ...tools.filter((tool) => !["update_item", "archive_milestone"].includes(tool.name)),
    updateItem,
  ]);
}

function withMilestoneListingFoldedIntoSearch(tools: readonly ToolDefinition[]): ToolDefinition[] {
  const searchItems = toolNamed(tools, "search_items");
  const listMilestoneItems = toolNamed(tools, "list_milestone_items");
  const searchSchema = structuredClone(searchItems.inputSchema);
  const listSchema = structuredClone(listMilestoneItems.inputSchema);
  (searchSchema.properties as Record<string, unknown>)["operation"] = {
    const: "substring",
  };
  (listSchema.properties as Record<string, unknown>)["operation"] = {
    const: "milestone-references",
  };
  (searchSchema.required as string[]).unshift("operation");
  (listSchema.required as string[]).unshift("operation");
  searchItems.description =
    "Search one ledger by substring or list one milestone's active references across every ledger using the operation discriminator. Both branches require compact or full projection.";
  searchItems.inputSchema = {
    oneOf: [searchSchema, listSchema],
    $schema: "http://json-schema.org/draft-07/schema#",
  };
  return sortTools([
    ...tools.filter((tool) => !["search_items", "list_milestone_items"].includes(tool.name)),
    searchItems,
  ]);
}

function targetName(currentName: string): string {
  return REPLACEMENT_TOOL[currentName as keyof typeof REPLACEMENT_TOOL] ?? currentName;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function targetRoleProfiles(targetTools: readonly ToolDefinition[]) {
  const targetInventory = new Set(targetTools.map((tool) => tool.name));
  return Object.fromEntries(
    Object.keys(ROLE_TOOL_CAPABILITY_MATRIX)
      .sort()
      .map((roleId) => {
        const preservedCapabilities = [...exposedLedgerToolsForRole(roleId)];
        const tools = unique(preservedCapabilities.map(targetName)).filter((name) =>
          targetInventory.has(name),
        );
        return [
          roleId,
          {
            tools,
            preservedCapabilities,
          },
        ];
      }),
  );
}

function currentDefaultRoleSurface(tools: readonly ToolDefinition[]) {
  return Object.fromEntries(
    Object.keys(ROLE_TOOL_CAPABILITY_MATRIX)
      .sort()
      .map((roleId) => [roleId, tools]),
  );
}

function filteredCurrentRoleSurface(tools: readonly ToolDefinition[]) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return Object.fromEntries(
    Object.keys(ROLE_TOOL_CAPABILITY_MATRIX)
      .sort()
      .map((roleId) => [
        roleId,
        exposedLedgerToolsForRole(roleId).map((name) => byName.get(name)!),
      ]),
  );
}

function filteredTargetRoleSurface(
  tools: readonly ToolDefinition[],
  profiles: ReturnType<typeof targetRoleProfiles>,
) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return Object.fromEntries(
    Object.entries(profiles).map(([roleId, profile]) => [
      roleId,
      profile.tools.map((name) => byName.get(name)!),
    ]),
  );
}

function migrationCategory(
  path: string,
): "callers" | "documentation" | "contractTests" | "generatedArtifacts" {
  if (path === "README.md" || path.startsWith("nix/pkg/cq-assets/") || path.endsWith(".md")) {
    return "documentation";
  }
  if (path.includes("/test/") || path.includes("/fixtures/")) {
    return "contractTests";
  }
  if (path.endsWith(".gen.ts")) return "generatedArtifacts";
  return "callers";
}

async function migrationMentions(toolName: string) {
  const matches: string[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx,md,json}");
  for await (const absolutePath of glob.scan({
    cwd: REPO_ROOT,
    absolute: true,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    const path = relative(REPO_ROOT, absolutePath);
    const inScope = MIGRATION_SCAN_ROOTS.some(
      (root) => path === root || path.startsWith(`${root}/`),
    );
    if (
      inScope &&
      !(MIGRATION_SCAN_EXCLUSIONS as readonly string[]).includes(path) &&
      readFileSync(absolutePath, "utf8").includes(toolName)
    ) {
      matches.push(path);
    }
  }
  matches.sort();
  const categorized = {
    callers: [] as string[],
    documentation: [] as string[],
    contractTests: [] as string[],
    generatedArtifacts: [] as string[],
  };
  for (const path of matches) categorized[migrationCategory(path)].push(path);
  return {
    scannedRoots: [...MIGRATION_SCAN_ROOTS],
    excludedHistoricalOrTargetEvidence: [...MIGRATION_SCAN_EXCLUSIONS],
    matchedPaths: matches,
    ...categorized,
  };
}

async function migrationMap() {
  return Promise.all(
    REMOVED_MILESTONE_TOOLS.map(async (removedTool) => ({
      removedTool,
      ...MIGRATION_RULES[removedTool],
      coverage: await migrationMentions(removedTool),
    })),
  );
}

export async function measureToolSurfaceTarget() {
  const currentMeasurement = JSON.parse(readFileSync(G129_BASELINE_PATH, "utf8")) as G129Baseline;
  const currentTools = JSON.parse(
    currentMeasurement.profiles.full.toolsList.serialization,
  ) as ToolDefinition[];
  const currentInstructions = JSON.parse(
    currentMeasurement.profiles.full.initialize.instructions.serialization,
  ) as string;

  const descriptionTarget = withDescriptionTargets(currentTools);
  const schemaTarget = withSimplifiedSchemas(currentTools);
  const milestoneCrudTarget = withMilestoneCrudGenericized(currentTools);
  const combinedTarget = withMilestoneCrudGenericized(
    withSimplifiedSchemas(withDescriptionTargets(currentTools)),
  );
  const profiles = targetRoleProfiles(combinedTarget);
  const currentRoleSurface = currentDefaultRoleSurface(currentTools);
  const targetRoleSurface = filteredTargetRoleSurface(combinedTarget, profiles);
  const targetInventory = combinedTarget.map((tool) => tool.name);

  return {
    formatVersion: 1,
    taskId: "T1326",
    scope:
      "Measured target selection only. T1327/T1328 implement the public cutover; no compatibility aliases or legacy mode.",
    basedOn: {
      baseline: "scripts/baselines/g129-tool-surface.json",
      baselineSha256: createHash("sha256").update(readFileSync(G129_BASELINE_PATH)).digest("hex"),
      fullToolsListTokens: currentMeasurement.profiles.full.toolsList.tokens,
      nonDispatchToolsListTokens: currentMeasurement.profiles["non-dispatch"].toolsList.tokens,
    },
    tokenizer: currentMeasurement.tokenizer,
    measurementMethod: {
      serialization: "JSON.stringify",
      encoding: "o200k_base",
      rule: "Each row independently serializes and tokenizes the complete named current and counterfactual value. Deltas never sum marginal BPE measurements.",
    },
    selected: [
      {
        id: "concise-initialize-instructions",
        proposal: "Shorten initialize instructions without removing operational rules.",
        target: TARGET_INSTRUCTIONS,
        preserves: [
          "typed ledger model",
          "provenance",
          "projection and pagination",
          "search and terminal/archive semantics",
          "CQ predicates",
          "dispatch and plan-fence recovery",
          "reference canonicalization",
        ],
        measurement: counterfactual(currentInstructions, TARGET_INSTRUCTIONS),
      },
      {
        id: "concise-tool-descriptions",
        proposal:
          "Replace repeated prose on the highest-cost domain tools with concise complete contracts.",
        replacements: DESCRIPTION_REPLACEMENTS,
        measurement: counterfactual(currentTools, descriptionTarget),
      },
      {
        id: "schema-metadata-simplification",
        proposal:
          "Remove non-validating input-schema $schema/description annotations and flatten ref-only allOf wrappers.",
        preservedKeywords: [
          "type",
          "properties",
          "required",
          "enum",
          "const",
          "pattern",
          "minimum",
          "maximum",
          "minLength",
          "items",
          "anyOf",
          "oneOf",
          "if",
          "then",
          "else",
          "not",
          "additionalProperties",
          "propertyNames",
          "$ref",
          "definitions",
        ],
        measurement: counterfactual(currentTools, schemaTarget),
      },
      {
        id: "role-filtered-default-surfaces",
        proposal:
          "Expose only T1325's pre-context role profile instead of the full tool list to every role.",
        roleProfiles: profiles,
        measurement: counterfactual(currentRoleSurface, filteredCurrentRoleSurface(currentTools)),
      },
      {
        id: "generic-milestone-crud",
        proposal:
          "Remove create/update/fetch milestone methods and route root milestones through generic item operations with explicit root/DAG/response invariants.",
        publicChanges: {
          removed: [...REMOVED_MILESTONE_TOOLS],
          renamed: [],
          replacements: REPLACEMENT_TOOL,
        },
        measurement: counterfactual(currentTools, milestoneCrudTarget),
      },
    ],
    rejected: [
      {
        id: "consolidate-create-update-item",
        kind: "consolidation",
        proposal: "Replace create_item and update_item with one discriminated write_item method.",
        measurement: counterfactual(currentTools, withCreateUpdateConsolidated(currentTools)),
        measuredReason:
          "The complete oneOf counterfactual saves 247 tokens, but it adds an operation discriminator to every caller while preserving two distinct required-field sets. Create allocates under an active milestone; update applies partial replacement and status transitions. Retain two explicit methods rather than weaken or hide those preconditions.",
      },
      {
        id: "consolidate-archive-milestone-into-update-item",
        kind: "consolidation",
        proposal: "Fold archive_milestone into update_item with an operation discriminator.",
        measurement: counterfactual(currentTools, withArchiveFoldedIntoUpdate(currentTools)),
        measuredReason:
          "The complete discriminated counterfactual saves 142 tokens. Archive still performs a cross-ledger atomic sweep guarded by the all-items-terminal invariant and returns an archive pointer, so keep that lifecycle boundary explicit rather than represent it as an item update.",
      },
      {
        id: "consolidate-list-milestone-items-into-search-items",
        kind: "consolidation",
        proposal: "Fold cross-ledger milestone reference listing into substring search.",
        measurement: counterfactual(
          currentTools,
          withMilestoneListingFoldedIntoSearch(currentTools),
        ),
        measuredReason:
          "The complete discriminated counterfactual saves 248 tokens. Cross-ledger exact relation traversal and single-ledger substring search retain different result shapes and encapsulation, so keep list_milestone_items explicit rather than add a second search mode.",
      },
    ],
    target: {
      publicToolInventory: targetInventory,
      publicToolCount: targetInventory.length,
      removedPublicTools: [...REMOVED_MILESTONE_TOOLS],
      renamedPublicTools: [],
      requiredCapabilityCoverage: REQUIRED_CAPABILITY_COVERAGE,
      roleProfiles: profiles,
      fullToolsListMeasurement: counterfactual(currentTools, combinedTarget),
      completeRoleContextMeasurement: counterfactual(
        {
          instructions: currentInstructions,
          roleTools: currentRoleSurface,
        },
        {
          instructions: TARGET_INSTRUCTIONS,
          roleTools: targetRoleSurface,
        },
      ),
    },
    migrationMap: await migrationMap(),
  };
}

export function serializeToolSurfaceTarget(
  target: Awaited<ReturnType<typeof measureToolSurfaceTarget>>,
): string {
  return `${JSON.stringify(target, null, 2)}\n`;
}

if (import.meta.main) {
  const target = await measureToolSurfaceTarget();
  const outputPath = process.argv[2] ?? DEFAULT_TARGET_PATH;
  writeFileSync(outputPath, serializeToolSurfaceTarget(target));
  console.log(relative(REPO_ROOT, outputPath));
}
