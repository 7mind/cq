import { describe, expect, test } from "bun:test";
import path from "node:path";

const ASSETS_ROOT = path.resolve(import.meta.dir, "../../../../cq-assets");
const INVENTORY_POLICIES = ["compact", "full", "ack", "full-content"] as const;
const PROJECTION_TOOLS = [
  "fetch_ledger",
  "fetch_item",
  "search_items",
  "fts_search",
  "list_milestone_items",
] as const;
const ACK_TOOLS = [
  "update_item",
  "create_item",
  "create_ledger",
  "reopen_item",
  "unarchive_item",
] as const;
const FULL_CONTENT_TOOLS = [
  "fetch_ledger_archive",
  "read_log",
  "get_config",
  "fetch_prompt",
] as const;
const AFFECTED_TOOLS = [
  ...PROJECTION_TOOLS,
  ...ACK_TOOLS,
  ...FULL_CONTENT_TOOLS,
] as const;

type InventoryPolicy = (typeof INVENTORY_POLICIES)[number];
type AffectedTool = (typeof AFFECTED_TOOLS)[number];
type WorkflowFamily = "advance" | "begin" | "implement" | "investigate" | "plan" | "research";

interface InventorySource {
  source: string;
  family: WorkflowFamily;
  calls: string[];
}

interface FullReadAllowlistEntry {
  callSite: string;
  fields: string[];
}

interface UnboundedLedgerAllowlistEntry {
  callSite: string;
  reason: string;
}

interface ResponsePolicyInventory {
  version: number;
  sources: InventorySource[];
  allowlist: {
    fullReads: FullReadAllowlistEntry[];
    unboundedFetchLedger: UnboundedLedgerAllowlistEntry[];
  };
}

interface DiscoveredCall {
  source: string;
  family: WorkflowFamily;
  callSite: string;
  tool: AffectedTool;
  invocationArguments: string | undefined;
  unboundedFetchLedger: boolean;
}

const inventory = JSON.parse(
  await Bun.file(
    path.join(import.meta.dir, "fixtures/cq-tool-response-contract.json"),
  ).text(),
) as ResponsePolicyInventory;
const CANONICAL_SOURCES: Omit<InventorySource, "calls">[] = [
  { source: "agents/implement-worker.md", family: "implement" },
  { source: "agents/plan-advance.md", family: "plan" },
  { source: "agents/plan-reviewer.md", family: "plan" },
  { source: "commands/cq/advance.md", family: "advance" },
  { source: "commands/cq/begin.md", family: "begin" },
  { source: "commands/cq/implement/start.md", family: "implement" },
  { source: "commands/cq/implement/advance.md", family: "implement" },
  { source: "commands/cq/investigate.md", family: "investigate" },
  {
    source: "commands/cq/investigate/advance.md",
    family: "investigate",
  },
  { source: "commands/cq/plan.md", family: "plan" },
  { source: "commands/cq/plan/advance.md", family: "plan" },
  { source: "commands/cq/plan/follow-up.md", family: "plan" },
  { source: "commands/cq/research.md", family: "research" },
  { source: "commands/cq/research/advance.md", family: "research" },
];

interface InventoryCall {
  source: string;
  family: WorkflowFamily;
  callSite: string;
  tool: AffectedTool;
  policy: InventoryPolicy;
}

type SourceReader = (source: string) => Promise<string>;

interface CodeRegion {
  code: string;
  heading: string;
}

interface InlineCodeState {
  delimiterLength: number | undefined;
  code: string;
  heading: string;
}

function isAffectedTool(value: string): value is AffectedTool {
  return (AFFECTED_TOOLS as readonly string[]).includes(value);
}

function headingPath(headings: string[]): string {
  const visibleHeadings = headings.filter(
    (heading) => !heading.startsWith("{{cq:fragment:"),
  );
  return visibleHeadings.length > 0 ? visibleHeadings.join(" / ") : "(document)";
}

function inlineCodeRegions(
  line: string,
  headings: string[],
  state: InlineCodeState,
): CodeRegion[] {
  const regions: CodeRegion[] = [];
  let cursor = 0;
  for (const match of line.matchAll(/`+/g)) {
    const delimiter = match[0];
    const index = match.index;
    if (delimiter.length === 0 || index === undefined) {
      throw new Error("Inline-code scanner matched an invalid delimiter");
    }
    if (state.delimiterLength === undefined) {
      state.delimiterLength = delimiter.length;
      state.code = "";
      state.heading = headingPath(headings);
      cursor = index + delimiter.length;
    } else if (delimiter.length === state.delimiterLength) {
      state.code += line.slice(cursor, index);
      regions.push({ code: state.code, heading: state.heading });
      state.delimiterLength = undefined;
      state.code = "";
      state.heading = "";
      cursor = index + delimiter.length;
    }
  }
  if (state.delimiterLength !== undefined) {
    state.code += `${line.slice(cursor)}\n`;
  }
  return regions;
}

function parseInvocationArguments(suffix: string): string | undefined {
  const start = suffix.search(/\S/);
  if (start < 0 || suffix[start] !== "(") return undefined;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = start; index < suffix.length; index += 1) {
    const char = suffix[index];
    if (char === undefined) {
      throw new Error("Invocation scanner read beyond the source");
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return suffix.slice(start + 1, index);
    }
  }
  return undefined;
}

function discoverCalls(
  source: InventorySource,
  markdown: string,
): DiscoveredCall[] {
  const headings: string[] = [];
  const ordinalByLocation = new Map<string, number>();
  const calls: DiscoveredCall[] = [];
  const inlineState: InlineCodeState = {
    delimiterLength: undefined,
    code: "",
    heading: "",
  };
  let insideFence = false;

  for (const line of markdown.split("\n")) {
    const fence =
      inlineState.delimiterLength === undefined
        ? line.match(/^\s*```/)
        : null;
    if (fence !== null) {
      insideFence = !insideFence;
      continue;
    }

    if (!insideFence && inlineState.delimiterLength === undefined) {
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (heading !== null) {
        const marker = heading[1];
        const title = heading[2];
        if (marker === undefined || title === undefined) {
          throw new Error("Heading scanner matched without required captures");
        }
        const depth = marker.length;
        headings.splice(depth - 1);
        headings[depth - 1] = title;
      }
    }

    const regions = insideFence
      ? [{ code: line, heading: headingPath(headings) }]
      : inlineCodeRegions(line, headings, inlineState);
    for (const region of regions) {
      const toolPattern = new RegExp(
        `\\b(${AFFECTED_TOOLS.join("|")})\\b`,
        "g",
      );
      for (const match of region.code.matchAll(toolPattern)) {
        const tool = match[1];
        if (tool === undefined || !isAffectedTool(tool)) {
          throw new Error(`Scanner produced unknown affected tool: ${tool}`);
        }
        const location = `${source.source}::${region.heading}::${tool}`;
        const ordinal = (ordinalByLocation.get(location) ?? 0) + 1;
        ordinalByLocation.set(location, ordinal);
        const suffix = region.code.slice(match.index + tool.length);
        const invocationArguments = parseInvocationArguments(suffix);
        const unboundedFetchLedger =
          tool === "fetch_ledger" &&
          invocationArguments !== undefined &&
          !/\b(?:limit|offset)\b/.test(invocationArguments);
        calls.push({
          source: source.source,
          family: source.family,
          callSite: `${location}#${ordinal}`,
          tool,
          invocationArguments,
          unboundedFetchLedger,
        });
      }
    }
  }

  return calls;
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function expandInventoryCalls(
  sources: InventorySource[],
  errors: string[],
): InventoryCall[] {
  const calls: InventoryCall[] = [];
  for (const source of sources) {
    for (const encoded of source.calls) {
      const separator = encoded.lastIndexOf("|");
      const site = encoded.slice(0, separator);
      const policy = encoded.slice(separator + 1);
      const identity = site.match(/::([^:#]+)#\d+$/);
      const tool = identity === null ? undefined : identity[1];
      if (
        separator < 1 ||
        tool === undefined ||
        !isAffectedTool(tool) ||
        !(INVENTORY_POLICIES as readonly string[]).includes(policy)
      ) {
        errors.push(`Malformed inventory call: ${source.source}::${encoded}`);
        continue;
      }
      calls.push({
        source: source.source,
        family: source.family,
        callSite: `${source.source}::${site}`,
        tool,
        policy: policy as InventoryPolicy,
      });
    }
  }
  return calls;
}

async function validateInventory(
  candidate: ResponsePolicyInventory,
  readSource: SourceReader,
): Promise<string[]> {
  const errors: string[] = [];
  const sourceKeys = candidate.sources.map(
    (source) => `${source.source}::${source.family}`,
  );
  const duplicateSources = findDuplicates(sourceKeys);
  if (duplicateSources.length > 0) {
    errors.push(`Duplicate sources: ${duplicateSources.join(", ")}`);
  }
  const expectedSources = CANONICAL_SOURCES.map(
    (source) => `${source.source}::${source.family}`,
  ).sort();
  if (sourceKeys.slice().sort().join("\n") !== expectedSources.join("\n")) {
    errors.push("Canonical source set does not match the 14-source contract");
  }

  const discovered = (
    await Promise.all(
      candidate.sources.map(async (source) => {
        const markdown = await readSource(source.source);
        return discoverCalls(source, markdown);
      }),
    )
  ).flat();
  const discoveredById = new Map(
    discovered.map((call) => [call.callSite, call]),
  );
  const calls = expandInventoryCalls(candidate.sources, errors);
  const inventoryById = new Map(
    calls.map((call) => [call.callSite, call]),
  );
  const duplicateCalls = findDuplicates(
    calls.map((call) => call.callSite),
  );
  if (duplicateCalls.length > 0) {
    errors.push(`Duplicate calls: ${duplicateCalls.join(", ")}`);
  }

  const missing = discovered
    .filter((call) => !inventoryById.has(call.callSite))
    .map((call) => call.callSite);
  const stale = calls
    .filter((call) => !discoveredById.has(call.callSite))
    .map((call) => call.callSite);
  if (missing.length > 0) errors.push(`Missing calls: ${missing.join(", ")}`);
  if (stale.length > 0) errors.push(`Stale calls: ${stale.join(", ")}`);

  for (const call of calls) {
    const found = discoveredById.get(call.callSite);
    if (
      found !== undefined &&
      (call.source !== found.source ||
        call.family !== found.family ||
        call.tool !== found.tool)
    ) {
      errors.push(`Mismatched call metadata: ${call.callSite}`);
    }
    if (
      (ACK_TOOLS as readonly string[]).includes(call.tool) &&
      call.policy !== "ack"
    ) {
      errors.push(`Mutation must use ack policy: ${call.callSite}`);
    }
    if (
      (PROJECTION_TOOLS as readonly string[]).includes(call.tool) &&
      call.policy !== "compact" &&
      call.policy !== "full"
    ) {
      errors.push(
        `Projection must use compact or full policy: ${call.callSite}`,
      );
    }
    if (
      (FULL_CONTENT_TOOLS as readonly string[]).includes(call.tool) &&
      call.policy !== "full-content"
    ) {
      errors.push(`Purpose-built content read must use full-content: ${call.callSite}`);
    }
  }

  const fullReadIds = candidate.allowlist.fullReads.map(
    (entry) => entry.callSite,
  );
  const duplicateFullReads = findDuplicates(fullReadIds);
  if (duplicateFullReads.length > 0) {
    errors.push(`Duplicate full-read allowlist entries: ${duplicateFullReads.join(", ")}`);
  }
  const fullReadById = new Map(
    candidate.allowlist.fullReads.map((entry) => [entry.callSite, entry]),
  );
  for (const call of calls.filter(
    (entry) => entry.policy === "full",
  )) {
    const allowed = fullReadById.get(call.callSite);
    if (allowed === undefined) {
      errors.push(`Full read lacks allowlist entry: ${call.callSite}`);
    } else if (
      allowed.fields.length === 0 ||
      allowed.fields.some((field) => field.trim().length === 0)
    ) {
      errors.push(`Full-read allowlist lacks field justification: ${call.callSite}`);
    }
  }
  for (const entry of candidate.allowlist.fullReads) {
    const call = inventoryById.get(entry.callSite);
    if (call === undefined || call.policy !== "full") {
      errors.push(`Stale full-read allowlist entry: ${entry.callSite}`);
    }
  }

  const unboundedIds = candidate.allowlist.unboundedFetchLedger.map(
    (entry) => entry.callSite,
  );
  const duplicateUnbounded = findDuplicates(unboundedIds);
  if (duplicateUnbounded.length > 0) {
    errors.push(
      `Duplicate unbounded-fetch allowlist entries: ${duplicateUnbounded.join(", ")}`,
    );
  }
  const unboundedById = new Map(
    candidate.allowlist.unboundedFetchLedger.map((entry) => [
      entry.callSite,
      entry,
    ]),
  );
  for (const call of discovered.filter(
    (entry) => entry.unboundedFetchLedger,
  )) {
    const allowed = unboundedById.get(call.callSite);
    if (allowed === undefined) {
      errors.push(`Unbounded fetch_ledger lacks allowlist entry: ${call.callSite}`);
    } else if (allowed.reason.trim().length === 0) {
      errors.push(
        `Unbounded-fetch allowlist lacks pagination justification: ${call.callSite}`,
      );
    }
  }
  for (const entry of candidate.allowlist.unboundedFetchLedger) {
    const call = discoveredById.get(entry.callSite);
    if (call === undefined || !call.unboundedFetchLedger) {
      errors.push(`Stale unbounded-fetch allowlist entry: ${entry.callSite}`);
    }
  }

  return errors;
}

async function readCanonicalSource(source: string): Promise<string> {
  return Bun.file(path.join(ASSETS_ROOT, source)).text();
}

async function validateCanonicalInventory(
  candidate: ResponsePolicyInventory,
): Promise<string[]> {
  return validateInventory(candidate, readCanonicalSource);
}

function cloneInventory(
  candidate: ResponsePolicyInventory,
): ResponsePolicyInventory {
  return structuredClone(candidate);
}

function requiredAt<T>(values: T[], index: number, context: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing ${context} at ${index}`);
  return value;
}

describe("CQ tool response-policy inventory", () => {
  test("covers every canonical call site exactly once", async () => {
    expect(await validateCanonicalInventory(inventory)).toEqual([]);
  });

  test("rejects missing, duplicate, and stale call entries", async () => {
    const missing = cloneInventory(inventory);
    const missingSource = missing.sources.find((source) => source.calls.length > 0);
    expect(missingSource).toBeDefined();
    if (missingSource === undefined) throw new Error("Inventory has no call to remove");
    missingSource.calls.splice(0, 1);
    expect((await validateCanonicalInventory(missing)).join("\n")).toContain(
      "Missing calls:",
    );

    const duplicate = cloneInventory(inventory);
    const duplicateSource = duplicate.sources.find((source) => source.calls.length > 0);
    expect(duplicateSource).toBeDefined();
    if (duplicateSource === undefined) throw new Error("Inventory has no call to duplicate");
    duplicateSource.calls.push(
      requiredAt(duplicateSource.calls, 0, "inventory call"),
    );
    expect((await validateCanonicalInventory(duplicate)).join("\n")).toContain(
      "Duplicate calls:",
    );

    const stale = cloneInventory(inventory);
    const staleSource = stale.sources.find((source) =>
      source.calls.some((call) => call.includes("Shared rules")),
    );
    expect(staleSource).toBeDefined();
    if (staleSource === undefined) throw new Error("Inventory has no call to stale");
    const staleIndex = staleSource.calls.findIndex((call) => call.includes("Shared rules"));
    staleSource.calls[staleIndex] = requiredAt(
      staleSource.calls,
      staleIndex,
      "inventory call",
    ).replace(
      "Shared rules",
      "Shared rule",
    );
    expect((await validateCanonicalInventory(stale)).join("\n")).toContain(
      "Stale calls:",
    );
  });

  test("rejects a wrapped inline-code invocation rename", async () => {
    const planSource = "commands/cq/plan/advance.md";
    const canonical = await readCanonicalSource(planSource);
    const changed = canonical.replace(
      '`ledger::get_config("planners")`',
      '`fetch_item({ projection: "full" })`',
    );
    expect(changed).not.toBe(canonical);
    const errors = await validateInventory(inventory, async (source) =>
      source === planSource ? changed : readCanonicalSource(source),
    );
    const report = errors.join("\n");
    expect(report).toContain("Missing calls:");
    expect(report).toContain("::fetch_item#1");
    expect(report).toContain("Stale calls:");
    expect(report).toContain("::get_config#1");
  });

  test("rejects mutations classified as full entities", async () => {
    const mutation = cloneInventory(inventory);
    const source = mutation.sources.find((candidate) =>
      candidate.calls.some((call) => call.includes("::update_item#")),
    );
    expect(source).toBeDefined();
    if (source === undefined) {
      throw new Error("Inventory has no mutation to exercise");
    }
    const index = source.calls.findIndex((call) => call.includes("::update_item#"));
    const call = requiredAt(source.calls, index, "mutation call");
    source.calls[index] = `${call.slice(0, call.lastIndexOf("|"))}|full`;
    expect((await validateCanonicalInventory(mutation)).join("\n")).toContain(
      "Mutation must use ack policy:",
    );
  });
});
