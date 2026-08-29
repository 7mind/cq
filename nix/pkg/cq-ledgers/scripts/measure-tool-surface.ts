import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import {
  DISPATCH_RESULT_PLUMBING_TOOL_NAMES,
  DOMAIN_LEDGER_TOOL_NAMES,
  ROLE_IDENTIFIED_CORPUS,
  ROLE_TOOL_CAPABILITY_MATRIX,
  exposedLedgerToolsForRole,
} from "../packages/cq-config/src/index.js";
import {
  InMemoryLedgerStore,
  MANAGEMENT_LEDGER_TOOL_NAMES,
  MANAGEMENT_NON_DISPATCH_LEDGER_TOOL_NAMES,
  createTrustedWorksetManagementAuthority,
  type DispatchCapability,
} from "../packages/ledger/src/index.js";
import {
  ITEM_PROJECTION_DESCRIPTION,
  ITEM_MUTATION_ACK_DESCRIPTION,
  MILESTONE_MUTATION_ACK_DESCRIPTION,
  LEDGER_MUTATION_ACK_DESCRIPTION,
} from "../packages/ledger/src/mcp/wireResponseContract.js";
import { createLedgerMcpServer } from "../packages/ledger-mcp/src/main.js";

const CANONICAL_PROFILE_NAMES = ["full", "non-dispatch"] as const;
const MANAGEMENT_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "prepare_implementation_review_panel",
  "prepare_implementation_review_attempt",
  "execute_external_implementation_review_attempt",
  "finalize_implementation_review_attempt",
  "prepare_implementation_review_fallback",
  "advance_implementation_evidence_bootstrap",
  "get_implementation_evidence_service_status",
  "continue_implementation_evidence_activation",
  "prepare_implementation_completion",
  "record_implementation_completion",
]);
const ROLE_PROFILE_NAMES = Object.keys(ROLE_TOOL_CAPABILITY_MATRIX).sort();
export const PROFILE_NAMES: readonly string[] = Object.freeze([
  ...CANONICAL_PROFILE_NAMES,
  ...ROLE_PROFILE_NAMES,
]);
export type ToolSurfaceProfileName = string;

interface ToolDefinition extends Record<string, unknown> {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MinifiedJsonMeasurement {
  serialization: string;
  utf8Bytes: number;
  tokens: number;
}

interface JsonCost {
  utf8Bytes: number;
  tokens: number;
}

interface MarginalMeasurement extends JsonCost {
  marginalUtf8Bytes: number;
  marginalTokens: number;
  counterfactualToolUtf8Bytes: number;
  counterfactualToolTokens: number;
}

export interface ToolSurfaceToolMeasurement {
  name: string;
  whole: JsonCost;
  components: {
    name: MarginalMeasurement;
    description: MarginalMeasurement;
    inputSchema: MarginalMeasurement;
  };
  schemaPaths: Array<{
    path: string;
    measurement: JsonCost;
    marginalUtf8Bytes: number;
    marginalTokens: number;
    counterfactualToolUtf8Bytes: number;
    counterfactualToolTokens: number;
  }>;
}

export interface ToolSurfaceProfileMeasurement {
  inventorySource: string;
  inventory: string[];
  toolCount: number;
  initialize: {
    instructions: MinifiedJsonMeasurement;
  };
  toolsList: MinifiedJsonMeasurement;
  responseContractCounterfactual: {
    projectionTokens: number;
    acknowledgementSentenceTokens: number;
    authoritativeResponseTokens: number;
    allTokens: number;
    deltasAreAdditive: false;
  };
  tools: ToolSurfaceToolMeasurement[];
  contractRequiredTools: string[];
  requiredCallInventoryCovered: boolean;
  zeroDomainCalls: boolean;
  domainInputSchemaTokens: number;
  transportOnly: {
    inventory: string[];
    toolsList: MinifiedJsonMeasurement;
    inputSchemaTokens: number;
  };
}

export interface ToolSurfaceMeasurement {
  formatVersion: 1;
  tokenizer: {
    package: "gpt-tokenizer";
    version: "3.4.0";
    encoding: "o200k_base";
  };
  method: {
    serialization: "JSON.stringify";
    toolOrder: "name ascending";
    schemaPath: "RFC 6901 JSON Pointer; empty string denotes the inputSchema root";
    marginalTokens: string;
    marginalTokensAreAdditive: false;
  };
  profiles: Record<string, ToolSurfaceProfileMeasurement>;
  g129Context: {
    historicalG93AttributableDelta: {
      tokens: 2214;
      meaning: string;
    };
    currentComparison: null | {
      currentG93AttributableDeltaTokens: number;
      durableDispatchMinusNonDispatchTokens: number;
      nonDispatchToolsListTokens: number;
      meaning: string;
    };
  };
}

interface ProfileDefinition {
  inventorySource: string;
  expectedInventory: readonly string[];
  dispatchCapability?: DispatchCapability;
  toolProfile?: string;
  contractRequiredTools: readonly string[];
  zeroDomainCalls: boolean;
  managementBound?: true;
}

interface SchemaPathValue {
  path: string;
  segments: Array<string | number>;
  value: unknown;
}

const unavailableDispatchOperation = async (): Promise<never> => {
  throw new Error("the tool-surface profiler never invokes dispatch handlers");
};

const DURABLE_DISPATCH_CAPABILITY: DispatchCapability = {
  prepare: unavailableDispatchOperation,
  fetchInput: unavailableDispatchOperation,
  storeResult: unavailableDispatchOperation,
  confirmCompletion: unavailableDispatchOperation,
  abort: unavailableDispatchOperation,
  fetch: unavailableDispatchOperation,
  gitCommit: unavailableDispatchOperation,
};

const PROFILE_DEFINITIONS: Record<ToolSurfaceProfileName, ProfileDefinition> = {
  full: {
    inventorySource: "MANAGEMENT_LEDGER_TOOL_NAMES",
    expectedInventory: MANAGEMENT_LEDGER_TOOL_NAMES,
    dispatchCapability: DURABLE_DISPATCH_CAPABILITY,
    contractRequiredTools: [],
    zeroDomainCalls: false,
    managementBound: true,
  },
  "non-dispatch": {
    inventorySource: "MANAGEMENT_NON_DISPATCH_LEDGER_TOOL_NAMES",
    expectedInventory: MANAGEMENT_NON_DISPATCH_LEDGER_TOOL_NAMES,
    contractRequiredTools: [],
    zeroDomainCalls: false,
    managementBound: true,
  },
  ...Object.fromEntries(
    ROLE_PROFILE_NAMES.map((roleId) => {
      const profile = ROLE_TOOL_CAPABILITY_MATRIX[roleId]!;
      const inventory = exposedLedgerToolsForRole(roleId);
      return [
        roleId,
        {
          inventorySource: `ROLE_TOOL_CAPABILITY_MATRIX:${roleId}`,
          expectedInventory: inventory,
          dispatchCapability: DURABLE_DISPATCH_CAPABILITY,
          toolProfile: roleId,
          contractRequiredTools: profile.contractRequiredTools,
          zeroDomainCalls: profile.zeroDomainCalls,
          ...(inventory.some((name) => MANAGEMENT_ONLY_TOOL_NAMES.has(name))
            ? { managementBound: true as const }
            : {}),
        },
      ];
    }),
  ),
};

const PROFILE_DISPLAY_NAME = "tool-surface-profiler";

function measureMinifiedJson(value: unknown): MinifiedJsonMeasurement {
  const serialization = JSON.stringify(value);
  if (serialization === undefined) {
    throw new Error("cannot measure a value that JSON.stringify omits");
  }
  return {
    serialization,
    utf8Bytes: Buffer.byteLength(serialization, "utf8"),
    tokens: encode(serialization).length,
  };
}

function withoutToolField(
  tool: ToolDefinition,
  field: "name" | "description" | "inputSchema",
): ToolDefinition {
  const counterfactual = structuredClone(tool);
  delete counterfactual[field];
  return counterfactual;
}

function measureComponent(
  tool: ToolDefinition,
  field: "name" | "description" | "inputSchema",
  whole: MinifiedJsonMeasurement,
): MarginalMeasurement {
  const value = tool[field] ?? null;
  const measurement = measureMinifiedJson(value);
  const counterfactual = measureMinifiedJson(withoutToolField(tool, field));
  return {
    utf8Bytes: measurement.utf8Bytes,
    tokens: measurement.tokens,
    marginalUtf8Bytes: whole.utf8Bytes - counterfactual.utf8Bytes,
    marginalTokens: whole.tokens - counterfactual.tokens,
    counterfactualToolUtf8Bytes: counterfactual.utf8Bytes,
    counterfactualToolTokens: counterfactual.tokens,
  };
}

function stripProjection(tool: ToolDefinition): ToolDefinition {
  const stripped = structuredClone(tool);
  const schema = stripped.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (schema.properties !== undefined) delete schema.properties["projection"];
  if (schema.required !== undefined) {
    schema.required = schema.required.filter((name) => name !== "projection");
    if (schema.required.length === 0) delete schema.required;
  }
  if (stripped.description !== undefined) {
    stripped.description = stripped.description.split(ITEM_PROJECTION_DESCRIPTION).join("");
  }
  return stripped;
}

function stripDescriptionSentences(
  tool: ToolDefinition,
  sentences: readonly string[],
): ToolDefinition {
  const stripped = structuredClone(tool);
  if (stripped.description === undefined) return stripped;
  for (const sentence of sentences) {
    stripped.description = stripped.description.split(sentence).join("");
  }
  return stripped;
}

function stripAuthoritativeResponse(tool: ToolDefinition): ToolDefinition {
  const stripped = structuredClone(tool);
  if (stripped.description === undefined) return stripped;
  const marker = "\n\nAuthoritative response:";
  const markerIndex = stripped.description.indexOf(marker);
  if (markerIndex !== -1) {
    stripped.description = stripped.description.slice(0, markerIndex);
  }
  return stripped;
}

function measureResponseContractCounterfactual(
  tools: ToolDefinition[],
): ToolSurfaceProfileMeasurement["responseContractCounterfactual"] {
  const acknowledgementSentences = [
    ITEM_MUTATION_ACK_DESCRIPTION,
    MILESTONE_MUTATION_ACK_DESCRIPTION,
    LEDGER_MUTATION_ACK_DESCRIPTION,
  ];
  const wholeTokens = measureMinifiedJson(tools).tokens;
  const withoutProjection = tools.map(stripProjection);
  const withoutAcknowledgements = tools.map((tool) =>
    stripDescriptionSentences(tool, acknowledgementSentences),
  );
  const withoutAuthoritative = tools.map(stripAuthoritativeResponse);
  const withoutAll = withoutProjection
    .map((tool) => stripDescriptionSentences(tool, acknowledgementSentences))
    .map(stripAuthoritativeResponse);
  return {
    projectionTokens: wholeTokens - measureMinifiedJson(withoutProjection).tokens,
    acknowledgementSentenceTokens:
      wholeTokens - measureMinifiedJson(withoutAcknowledgements).tokens,
    authoritativeResponseTokens: wholeTokens - measureMinifiedJson(withoutAuthoritative).tokens,
    allTokens: wholeTokens - measureMinifiedJson(withoutAll).tokens,
    deltasAreAdditive: false,
  };
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function enumerateSchemaPaths(
  value: unknown,
  path: string,
  segments: Array<string | number>,
): SchemaPathValue[] {
  const paths: SchemaPathValue[] = [{ path, segments, value }];
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      paths.push(...enumerateSchemaPaths(child, `${path}/${index}`, [...segments, index]));
    }
    return paths;
  }
  if (value === null || typeof value !== "object") return paths;
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object).sort()) {
    paths.push(
      ...enumerateSchemaPaths(object[key], `${path}/${escapeJsonPointerSegment(key)}`, [
        ...segments,
        key,
      ]),
    );
  }
  return paths;
}

function removeSchemaPath(tool: ToolDefinition, segments: Array<string | number>): ToolDefinition {
  const counterfactual = structuredClone(tool);
  if (segments.length === 0) {
    delete counterfactual.inputSchema;
    return counterfactual;
  }

  let parent: unknown = counterfactual.inputSchema;
  for (const segment of segments.slice(0, -1)) {
    parent = (parent as Record<string | number, unknown>)[segment];
  }
  const leaf = segments[segments.length - 1] as string | number;
  if (Array.isArray(parent)) {
    parent.splice(leaf as number, 1);
  } else {
    delete (parent as Record<string, unknown>)[leaf as string];
  }
  return counterfactual;
}

function measureTool(tool: ToolDefinition): ToolSurfaceToolMeasurement {
  const whole = measureMinifiedJson(tool);
  const schemaPaths = enumerateSchemaPaths(tool.inputSchema, "", []);
  return {
    name: tool.name,
    whole: {
      utf8Bytes: whole.utf8Bytes,
      tokens: whole.tokens,
    },
    components: {
      name: measureComponent(tool, "name", whole),
      description: measureComponent(tool, "description", whole),
      inputSchema: measureComponent(tool, "inputSchema", whole),
    },
    schemaPaths: schemaPaths.map((entry) => {
      const counterfactual = measureMinifiedJson(removeSchemaPath(tool, entry.segments));
      const measurement = measureMinifiedJson(entry.value);
      return {
        path: entry.path,
        measurement: {
          utf8Bytes: measurement.utf8Bytes,
          tokens: measurement.tokens,
        },
        marginalUtf8Bytes: whole.utf8Bytes - counterfactual.utf8Bytes,
        marginalTokens: whole.tokens - counterfactual.tokens,
        counterfactualToolUtf8Bytes: counterfactual.utf8Bytes,
        counterfactualToolTokens: counterfactual.tokens,
      };
    }),
  };
}

async function measureProfile(
  definition: ProfileDefinition,
): Promise<ToolSurfaceProfileMeasurement> {
  const { Client } = await import(
    Bun.resolveSync(
      "@modelcontextprotocol/sdk/client/index.js",
      resolve(import.meta.dir, "../packages/ledger-mcp"),
    )
  );
  const { InMemoryTransport } = await import(
    Bun.resolveSync(
      "@modelcontextprotocol/sdk/inMemory.js",
      resolve(import.meta.dir, "../packages/ledger-mcp"),
    )
  );
  const store = new InMemoryLedgerStore();
  await store.init();
  const server = createLedgerMcpServer({
    store,
    displayName: PROFILE_DISPLAY_NAME,
    dispatchCapability: definition.dispatchCapability,
    toolProfile: definition.toolProfile,
    ...(definition.managementBound === true
      ? { worksetAuthority: createTrustedWorksetManagementAuthority() }
      : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "tool-surface-profiler-client", version: "0.0.1" },
    { capabilities: {} },
  );

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = (await client.listTools()) as {
      tools: ToolDefinition[];
    };
    const tools = [...listed.tools].sort((left, right) => left.name.localeCompare(right.name));
    const inventory = tools.map((tool) => tool.name);
    const expectedInventory = [...definition.expectedInventory].sort();
    if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory)) {
      throw new Error(
        `${definition.inventorySource} drift: expected ${JSON.stringify(expectedInventory)}, received ${JSON.stringify(inventory)}`,
      );
    }
    const instructions = client.getInstructions();
    if (instructions === undefined) {
      throw new Error("initialize did not include server instructions");
    }
    const domainToolNames = new Set<string>(DOMAIN_LEDGER_TOOL_NAMES);
    const transportToolNames = new Set<string>(DISPATCH_RESULT_PLUMBING_TOOL_NAMES);
    const measuredTools = tools.map(measureTool);
    const transportTools = tools.filter((tool) => transportToolNames.has(tool.name));
    return {
      inventorySource: definition.inventorySource,
      inventory,
      toolCount: tools.length,
      initialize: {
        instructions: measureMinifiedJson(instructions),
      },
      toolsList: measureMinifiedJson(tools),
      responseContractCounterfactual: measureResponseContractCounterfactual(tools),
      tools: measuredTools,
      contractRequiredTools: [...definition.contractRequiredTools],
      requiredCallInventoryCovered: definition.contractRequiredTools.every((tool) =>
        inventory.includes(tool),
      ),
      zeroDomainCalls: definition.zeroDomainCalls,
      domainInputSchemaTokens: measuredTools
        .filter((tool) => domainToolNames.has(tool.name))
        .reduce((sum, tool) => sum + tool.components.inputSchema.tokens, 0),
      transportOnly: {
        inventory: transportTools.map((tool) => tool.name),
        toolsList: measureMinifiedJson(transportTools),
        inputSchemaTokens: measuredTools
          .filter((tool) => transportToolNames.has(tool.name))
          .reduce((sum, tool) => sum + tool.components.inputSchema.tokens, 0),
      },
    };
  } finally {
    await client.close();
    await server.close();
    await store.dispose();
  }
}

export async function measureToolSurfaces(
  profileNames: readonly ToolSurfaceProfileName[],
): Promise<ToolSurfaceMeasurement> {
  const profiles: Record<string, ToolSurfaceProfileMeasurement> = {};
  for (const profileName of profileNames) {
    profiles[profileName] = await measureProfile(PROFILE_DEFINITIONS[profileName]);
  }
  const durableDispatch = profiles["full"];
  const nonDispatch = profiles["non-dispatch"];
  const currentComparison =
    durableDispatch === undefined || nonDispatch === undefined
      ? null
      : {
          currentG93AttributableDeltaTokens: nonDispatch.responseContractCounterfactual.allTokens,
          durableDispatchMinusNonDispatchTokens:
            durableDispatch.toolsList.tokens - nonDispatch.toolsList.tokens,
          nonDispatchToolsListTokens: nonDispatch.toolsList.tokens,
          meaning:
            "The current G93-attributable value applies the historical mechanical response-contract strip to today's 23-tool surface. The inventory delta separately compares the live 29-tool durable-dispatch and 23-tool non-dispatch profiles. The tools/list total is the complete current 23-tool serialization.",
        };
  return {
    formatVersion: 1,
    tokenizer: {
      package: "gpt-tokenizer",
      version: "3.4.0",
      encoding: "o200k_base",
    },
    method: {
      serialization: "JSON.stringify",
      toolOrder: "name ascending",
      schemaPath: "RFC 6901 JSON Pointer; empty string denotes the inputSchema root",
      marginalTokens:
        "For each component or schema path, whole-tool tokens minus tokens for an independently serialized whole-tool counterfactual with that field or path removed.",
      marginalTokensAreAdditive: false,
    },
    profiles,
    g129Context: {
      historicalG93AttributableDelta: {
        tokens: 2214,
        meaning:
          "Historical G93 response-contract attribution: a mechanical strip of three overlapping response-contract artefacts from the then-current 27-tool surface, not a full-versus-non-dispatch inventory comparison.",
      },
      currentComparison,
    },
  };
}

export function serializeToolSurfaceMeasurement(result: ToolSurfaceMeasurement): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

const G93_MEDIAN_RESPONSE_SAVING_TOKENS = 1622;
const G93_EVIDENCE_PATH = "docs/drafts/20260725-2130-t679-rs3-remeasurement.md";

interface HistoricalToolSurfaceMeasurement {
  readonly formatVersion: 1;
  readonly tokenizer: ToolSurfaceMeasurement["tokenizer"];
  readonly method: ToolSurfaceMeasurement["method"];
  readonly profiles: Record<string, ToolSurfaceProfileMeasurement>;
}

interface TokenCell {
  readonly serializedTokens: number;
  readonly marginalTokens: number;
}

function digest(serialization: string): string {
  return createHash("sha256").update(serialization).digest("hex");
}

function profileTotalTokens(profile: ToolSurfaceProfileMeasurement): number {
  return profile.initialize.instructions.tokens + profile.toolsList.tokens;
}

function tokenCell(
  tool: ToolSurfaceToolMeasurement | undefined,
  field: "name" | "description" | "inputSchema",
): TokenCell {
  if (tool === undefined) return { serializedTokens: 0, marginalTokens: 0 };
  return {
    serializedTokens: tool.components[field].tokens,
    marginalTokens: tool.components[field].marginalTokens,
  };
}

function deltaCell(after: TokenCell, baseline: TokenCell) {
  return {
    baseline,
    after,
    delta: {
      serializedTokens: after.serializedTokens - baseline.serializedTokens,
      marginalTokens: after.marginalTokens - baseline.marginalTokens,
    },
  };
}

function failBudget(name: string, failures: string[], condition: boolean): boolean {
  if (!condition) failures.push(name);
  return condition;
}

export function buildNormalizedAfterArtifact(
  current: ToolSurfaceMeasurement,
  baseline: HistoricalToolSurfaceMeasurement,
  baselinePath: string,
) {
  const failures: string[] = [];
  const tokenizerMatches = failBudget(
    "tokenizer drifted from the baseline",
    failures,
    JSON.stringify(current.tokenizer) === JSON.stringify(baseline.tokenizer),
  );
  const methodMatches = failBudget(
    "measurement method drifted from the baseline",
    failures,
    JSON.stringify(current.method) === JSON.stringify(baseline.method),
  );

  const profiles = Object.fromEntries(
    PROFILE_NAMES.map((profileName) => {
      const after = current.profiles[profileName];
      if (after === undefined) throw new Error(`missing measured profile ${profileName}`);
      const baselineProfileName = profileName === "non-dispatch" ? "non-dispatch" : "full";
      const before = baseline.profiles[baselineProfileName];
      if (before === undefined) throw new Error(`baseline missing profile ${baselineProfileName}`);
      const baselineTokens = profileTotalTokens(before);
      const afterTokens = profileTotalTokens(after);
      const baselineInventory = new Set(before.inventory);
      const serializedTools = JSON.parse(after.toolsList.serialization) as ToolDefinition[];
      const additiveTools = serializedTools
        .map((tool) => tool.name)
        .filter((name) => !baselineInventory.has(name));
      const baselineComparableToolsListTokens = measureMinifiedJson(
        serializedTools.filter((tool) => baselineInventory.has(tool.name)),
      ).tokens;
      const baselineComparableSurfaceTokens =
        after.initialize.instructions.tokens + baselineComparableToolsListTokens;
      return [
        profileName,
        {
          inventorySource: after.inventorySource,
          inventory: after.inventory,
          toolCount: after.toolCount,
          baselineProfile: baselineProfileName,
          initialize: {
            utf8Bytes: after.initialize.instructions.utf8Bytes,
            tokens: after.initialize.instructions.tokens,
            sha256: digest(after.initialize.instructions.serialization),
          },
          toolsList: {
            utf8Bytes: after.toolsList.utf8Bytes,
            tokens: after.toolsList.tokens,
            sha256: digest(after.toolsList.serialization),
          },
          surfaceTokens: afterTokens,
          baselineSurfaceTokens: baselineTokens,
          deltaTokens: afterTokens - baselineTokens,
          additiveToolsExcludedFromBaselineComparison: additiveTools,
          baselineComparableSurfaceTokens,
          baselineComparableDeltaTokens: baselineComparableSurfaceTokens - baselineTokens,
          smallerThanBaseline: baselineComparableSurfaceTokens < baselineTokens,
          contractRequiredTools: after.contractRequiredTools,
          requiredCallInventoryCovered: after.requiredCallInventoryCovered,
          zeroDomainCalls: after.zeroDomainCalls,
          domainInputSchemaTokens: after.domainInputSchemaTokens,
          responseContractCounterfactual: after.responseContractCounterfactual,
        },
      ];
    }),
  );

  const baselineTools = new Map(
    baseline.profiles.full.tools.map((tool) => [tool.name, tool] as const),
  );
  const afterTools = new Map(current.profiles.full.tools.map((tool) => [tool.name, tool] as const));
  const toolNames = [...new Set([...baselineTools.keys(), ...afterTools.keys()])].sort();
  const perToolAndFieldDeltas = toolNames.map((name) => {
    const before = baselineTools.get(name);
    const after = afterTools.get(name);
    const baselineWholeTokens = before?.whole.tokens ?? 0;
    const afterWholeTokens = after?.whole.tokens ?? 0;
    return {
      name,
      whole: {
        baselineTokens: baselineWholeTokens,
        afterTokens: afterWholeTokens,
        deltaTokens: afterWholeTokens - baselineWholeTokens,
      },
      fields: {
        name: deltaCell(tokenCell(after, "name"), tokenCell(before, "name")),
        description: deltaCell(tokenCell(after, "description"), tokenCell(before, "description")),
        inputSchema: deltaCell(tokenCell(after, "inputSchema"), tokenCell(before, "inputSchema")),
      },
    };
  });

  const corpusRows = Object.entries(ROLE_IDENTIFIED_CORPUS.roles).map(([roleId, observation]) => {
    const profile = current.profiles[roleId];
    if (profile === undefined) throw new Error(`missing corpus role profile ${roleId}`);
    const currentTokens = profileTotalTokens(profile);
    const baselineTokens = profileTotalTokens(baseline.profiles.full);
    return {
      roleId,
      transcripts: observation.transcripts,
      currentTokensPerTranscript: currentTokens,
      baselineTokensPerTranscript: baselineTokens,
      savingTokensPerTranscript: baselineTokens - currentTokens,
      currentWeightedTokens: observation.transcripts * currentTokens,
      baselineWeightedTokens: observation.transcripts * baselineTokens,
    };
  });
  const corpusTranscripts = corpusRows.reduce((sum, row) => sum + row.transcripts, 0);
  const currentWeightedTokens = corpusRows.reduce((sum, row) => sum + row.currentWeightedTokens, 0);
  const baselineWeightedTokens = corpusRows.reduce(
    (sum, row) => sum + row.baselineWeightedTokens,
    0,
  );
  if (corpusTranscripts !== ROLE_IDENTIFIED_CORPUS.transcripts) {
    throw new Error(
      `corpus weights cover ${corpusTranscripts}, expected ${ROLE_IDENTIFIED_CORPUS.transcripts}`,
    );
  }

  const transportByRole = Object.fromEntries(
    ROLE_PROFILE_NAMES.map((roleId) => {
      const transport = current.profiles[roleId]!.transportOnly;
      return [
        roleId,
        {
          inventory: transport.inventory,
          toolsListTokens: transport.toolsList.tokens,
          inputSchemaTokens: transport.inputSchemaTokens,
        },
      ];
    }),
  );
  const weightedTransportToolsListTokens = corpusRows.reduce(
    (sum, row) =>
      sum +
      row.transcripts *
        (current.profiles[row.roleId]?.transportOnly.toolsList.tokens ??
          (() => {
            throw new Error(`missing transport measurement for ${row.roleId}`);
          })()),
    0,
  );

  const ledgerCallingProfiles = PROFILE_NAMES.filter(
    (profileName) => current.profiles[profileName]!.toolCount > 0,
  ).map((profileName) => ({
    profileName,
    remainingG93AttributableTokens:
      current.profiles[profileName]!.responseContractCounterfactual.allTokens,
  }));
  const maximumRemainingG93AttributableTokens = Math.max(
    ...ledgerCallingProfiles.map((profile) => profile.remainingG93AttributableTokens),
  );

  const allSurfacesSmaller = failBudget(
    "one or more serialized instructions-plus-pre-baseline-tools/list surfaces did not shrink",
    failures,
    Object.values(profiles).every((profile) => profile.smallerThanBaseline),
  );
  const allRequiredCallsCovered = failBudget(
    "one or more role profiles omit a contract-required tool",
    failures,
    ROLE_PROFILE_NAMES.every(
      (profileName) => current.profiles[profileName]!.requiredCallInventoryCovered,
    ),
  );
  const zeroDomainProfilesHaveZeroDomainSchemaTokens = failBudget(
    "a zero-domain role exposes domain-ledger input schema tokens",
    failures,
    ROLE_PROFILE_NAMES.every((profileName) => {
      const profile = current.profiles[profileName]!;
      return !profile.zeroDomainCalls || profile.domainInputSchemaTokens === 0;
    }),
  );
  const g93BelowCorpusMedian = failBudget(
    "remaining G93-attributable charge is not below the corpus median response saving",
    failures,
    maximumRemainingG93AttributableTokens < G93_MEDIAN_RESPONSE_SAVING_TOKENS,
  );

  return {
    formatVersion: 2,
    taskId: "T1331",
    sourceMeasurementFormatVersion: current.formatVersion,
    tokenizer: current.tokenizer,
    method: current.method,
    baseline: {
      path: baselinePath,
      sha256: createHash("sha256")
        .update(`${JSON.stringify(baseline, null, 2)}\n`)
        .digest("hex"),
    },
    profiles,
    perToolAndFieldDeltas,
    roleWeightedExposure: {
      corpus: ROLE_IDENTIFIED_CORPUS.manifest,
      transcripts: corpusTranscripts,
      roles: corpusRows,
      currentWeightedTokens,
      baselineWeightedTokens,
      savingWeightedTokens: baselineWeightedTokens - currentWeightedTokens,
      currentMeanTokensPerTranscript: currentWeightedTokens / corpusTranscripts,
      baselineMeanTokensPerTranscript: baselineWeightedTokens / corpusTranscripts,
    },
    transportOnlyOverhead: {
      tools: [...DISPATCH_RESULT_PLUMBING_TOOL_NAMES],
      byRole: transportByRole,
      weightedToolsListTokens: weightedTransportToolsListTokens,
      meanToolsListTokensPerTranscript: weightedTransportToolsListTokens / corpusTranscripts,
    },
    g93: {
      historicalColdSchemaChargeTokens: 2214,
      corpusMedianResponseSavingTokens: G93_MEDIAN_RESPONSE_SAVING_TOKENS,
      strongestPerturbationUpperBoundTokens: 1485.5,
      evidence: {
        decision: "decisions:K145",
        defect: "defects:D155",
        report: G93_EVIDENCE_PATH,
      },
      ledgerCallingProfiles,
      maximumRemainingG93AttributableTokens,
    },
    budgets: {
      tokenizerMatches,
      methodMatches,
      allSurfacesSmaller,
      allRequiredCallsCovered,
      zeroDomainProfilesHaveZeroDomainSchemaTokens,
      g93BelowCorpusMedian,
      passed: failures.length === 0,
      failures,
    },
  };
}

function parseProfileName(value: string): ToolSurfaceProfileName {
  if ((PROFILE_NAMES as readonly string[]).includes(value)) {
    return value as ToolSurfaceProfileName;
  }
  throw new Error(`unknown profile ${JSON.stringify(value)}; choose ${PROFILE_NAMES.join(", ")}`);
}

function usage(): string {
  return [
    "Usage: bun run measure:tool-surface (--all-profiles | --profile <name>) [--compare <baseline.json>] [--assert-budgets] [--json <path>]",
    "",
    `Named profiles: ${PROFILE_NAMES.join(", ")}`,
  ].join("\n");
}

function parseCliArgs(argv: string[]): {
  profileNames: ToolSurfaceProfileName[];
  jsonPath: string | null;
  comparePath: string | null;
  assertBudgets: boolean;
} {
  const profileNames: ToolSurfaceProfileName[] = [];
  let allProfiles = false;
  let jsonPath: string | null = null;
  let comparePath: string | null = null;
  let assertBudgets = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all-profiles") {
      allProfiles = true;
      continue;
    }
    if (argument === "--profile") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--profile needs a value");
      profileNames.push(parseProfileName(value));
      index += 1;
      continue;
    }
    if (argument === "--json") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--json needs a path");
      jsonPath = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--compare") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--compare needs a value");
      comparePath = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--assert-budgets") {
      assertBudgets = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`unknown argument ${JSON.stringify(argument)}\n${usage()}`);
  }
  if (allProfiles && profileNames.length > 0) {
    throw new Error("--all-profiles and --profile are mutually exclusive");
  }
  if (!allProfiles && profileNames.length === 0) {
    throw new Error(`select --all-profiles or --profile <name>\n${usage()}`);
  }
  if (assertBudgets && comparePath === null) {
    throw new Error("--assert-budgets requires --compare <baseline.json>");
  }
  return {
    profileNames: allProfiles ? [...PROFILE_NAMES] : profileNames,
    jsonPath,
    comparePath,
    assertBudgets,
  };
}

if (import.meta.main) {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await measureToolSurfaces(options.profileNames);
  const artifact =
    options.comparePath === null
      ? result
      : buildNormalizedAfterArtifact(
          result,
          JSON.parse(readFileSync(options.comparePath, "utf8")) as HistoricalToolSurfaceMeasurement,
          relative(process.cwd(), options.comparePath),
        );
  if (options.assertBudgets && "budgets" in artifact && !artifact.budgets.passed) {
    throw new Error(`tool-surface budget failures: ${artifact.budgets.failures.join("; ")}`);
  }
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (options.jsonPath !== null) writeFileSync(options.jsonPath, json);
  console.log(json.trimEnd());
}
