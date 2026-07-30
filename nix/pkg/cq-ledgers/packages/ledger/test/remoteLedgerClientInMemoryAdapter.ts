/**
 * The ALWAYS-ON leg of the T727 RemoteLedgerClient dual contract: a
 * HAND-WRITTEN in-memory MCP service speaking the Streamable HTTP transport
 * (JSON responses, no SSE), backed by plain Maps.
 *
 * This is deliberately NOT the production server (`attachMcpHttp` /
 * `serveHub`): it is a second, independent implementation of the hub's
 * OBSERVABLE wire behaviour, written against the same contract the client
 * relies on — per the dual-tests discipline the two implementations keep each
 * other honest. Concretely it mirrors, from ledger-web/src/hubServe.ts and
 * the MCP SDK server:
 *
 *  - the `/p/<projectKey>/mcp` route grammar (Q283), with initialize-only
 *    auto-registration of an unknown tenant and 404 otherwise;
 *  - the `Authorization: Bearer <token>` gate answering a uniform
 *    tokenless-echo 401;
 *  - the bounded `x-cq-project-display-name` initialize header (400 over the
 *    shared 256-byte bound, projectKey fallback when absent), echoed back on
 *    `serverInfo.title` + the leading `Project: <name>` instructions line;
 *  - initialize/version negotiation (echo a supported requested version, else
 *    answer the latest), `mcp-session-id` issuance, 202 for notifications,
 *    405 for the GET SSE stream, DELETE session termination;
 *  - `tools/call` results as a single JSON text block, `isError: true` for a
 *    tool-level failure, and the production McpServer's unknown-tool shape —
 *    an isError result carrying `MCP error -32602: Tool <name> not found`
 *    (the SDK catches its own McpError and converts it, server/mcp.js);
 *  - the routine ledger tool DTO envelopes (`{ item }`, `{ ledger }`, the
 *    paginated variant, `{ results }`, …), with item wire projection and the
 *    fixed mutation-ack DTOs produced by the SAME exported
 *    `projectItemDto`/`projectItemMutationAckDto` shapers the production
 *    tools use — those shapers ARE the wire contract, so both sides reuse
 *    them rather than re-deriving them.
 *
 * Deliberate rough-equivalence edges (documented per the dual-tests skill —
 * exact store semantics are pinned by the store/predicate suites, not here):
 *  - no transition-guard enforcement (the contract only drives legal moves);
 *  - a naive substring fts_search scorer (the contract asserts the top hit,
 *    not exact scores);
 *  - derive_predicates answers the all-false verdict set, which is the TRUE
 *    answer for every state this contract seeds (predicate readiness is
 *    goal-gated and the contract owns no goals);
 *  - no WebSocket leaf, no CORS, no batch JSON-RPC (the SDK client uses none).
 */

import { randomUUID } from "node:crypto";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CANONICAL_LEDGERS,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  PROJECT_DISPLAY_NAME_HEADER,
  PROJECT_DISPLAY_NAME_MAX_BYTES,
  projectItemDto,
  projectItemMutationAckDto,
  summarize,
  type ArchivePointer,
  type FieldValue,
  type Item,
  type ItemProjection,
  type LedgerSchema,
} from "../src/index.js";
import type {
  RemoteContractService,
  RemoteLedgerClientContractFactory,
} from "./remoteLedgerClientContract.js";

// ---------------------------------------------------------------------------
// Dummy tenant state
// ---------------------------------------------------------------------------

interface DummyGroupArchive {
  readonly summary: string;
  readonly title: string;
  readonly status: string;
  readonly items: Item[];
}

interface DummyTenant {
  displayName: string;
  readonly createdAt: string;
  milestoneCounter: number;
  /** Milestone items (the `milestones` ledger's own items), M-AMBIENT included. */
  readonly milestones: Map<string, Item>;
  /** Per-ledger item allocation counters. */
  readonly itemCounters: Map<string, number>;
  /** Active items per non-milestones ledger, insertion-ordered. */
  readonly items: Map<string, Item[]>;
  /** Swept milestone groups, keyed `"<ledger>/<milestoneId>"`. */
  readonly archives: Map<string, DummyGroupArchive>;
  /** Archived milestone items (the `milestones` ledger's own archives). */
  readonly milestoneArchives: Map<string, { summary: string; item: Item }>;
  readonly logs: Map<string, string>;
}

/** A tool-level failure, surfaced over the wire as `isError: true`. */
class DummyToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DummyToolError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function createTenant(displayName: string): DummyTenant {
  const createdAt = nowIso();
  const ambient: Item = {
    id: MILESTONES_AMBIENT_ID,
    milestoneId: "active",
    status: "open",
    fields: { title: "ambient" },
    createdAt,
    updatedAt: createdAt,
  };
  return {
    displayName,
    createdAt,
    milestoneCounter: 0,
    milestones: new Map([[MILESTONES_AMBIENT_ID, ambient]]),
    itemCounters: new Map(),
    items: new Map(),
    archives: new Map(),
    milestoneArchives: new Map(),
    logs: new Map(),
  };
}

const SCHEMAS: ReadonlyMap<string, LedgerSchema> = new Map(
  CANONICAL_LEDGERS.map(({ name, schema }) => [name, schema]),
);

function ledgerOf(tenant: DummyTenant, ledgerId: string): Item[] {
  const schema = SCHEMAS.get(ledgerId);
  if (schema === undefined) {
    throw new DummyToolError(`ledger not found: ${ledgerId}`);
  }
  return tenant.items.get(ledgerId) ?? [];
}

function findItem(tenant: DummyTenant, ledgerId: string, itemId: string): Item {
  const item = ledgerOf(tenant, ledgerId).find((candidate) => candidate.id === itemId);
  if (item === undefined) {
    throw new DummyToolError(`item ${itemId} not found in ledger ${ledgerId}`);
  }
  return item;
}

function milestoneOf(tenant: DummyTenant, milestoneId: string): Item {
  const milestone = tenant.milestones.get(milestoneId);
  if (milestone === undefined) {
    // The InMemory/Abstract production stores' exact message; PostgresLedgerStore
    // words it differently ("Milestone <id> does not exist in the milestones
    // ledger") — the contract pins verbatim preservation, not one wording.
    throw new DummyToolError(`milestone ${milestoneId} not found`);
  }
  return milestone;
}

function resolvedMilestone(tenant: DummyTenant, milestoneId: string): {
  id: string;
  status: string;
  title: string;
  description: string;
} {
  const milestone = tenant.milestones.get(milestoneId);
  if (milestone === undefined) {
    return { id: milestoneId, status: "done", title: "", description: "" };
  }
  const title = milestone.fields["title"];
  const description = milestone.fields["description"];
  return {
    id: milestoneId,
    status: milestone.status,
    title: typeof title === "string" ? title : "",
    description: typeof description === "string" ? description : "",
  };
}

function allocateItemId(tenant: DummyTenant, ledgerId: string): string {
  const schema = SCHEMAS.get(ledgerId);
  if (schema === undefined) throw new DummyToolError(`ledger not found: ${ledgerId}`);
  const next = (tenant.itemCounters.get(ledgerId) ?? 0) + 1;
  tenant.itemCounters.set(ledgerId, next);
  return `${schema.idPrefix}${String(next)}`;
}

function project(item: Item, projection: ItemProjection): unknown {
  return projectItemDto(item, projection);
}

function archivePointer(
  ledgerId: string,
  milestoneId: string,
  archive: DummyGroupArchive,
): ArchivePointer {
  return {
    id: milestoneId,
    path: `./archive/${ledgerId}/${milestoneId}.md`,
    summary: archive.summary,
    title: archive.title,
    status: archive.status,
  };
}

function archivePointersFor(tenant: DummyTenant, ledgerId: string): ArchivePointer[] {
  const out: ArchivePointer[] = [];
  for (const [key, archive] of tenant.archives) {
    const sep = key.indexOf("/");
    if (key.slice(0, sep) !== ledgerId) continue;
    out.push(archivePointer(ledgerId, key.slice(sep + 1), archive));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dummy tool handlers (each returns the tool's JSON payload, pre-stringify)
// ---------------------------------------------------------------------------

type ToolHandler = (tenant: DummyTenant, args: Record<string, unknown>) => unknown;

function str(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") {
    throw new DummyToolError(`argument ${name} must be a string`);
  }
  return value;
}

function optStr(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function projectionOf(args: Record<string, unknown>): ItemProjection {
  return str(args, "projection") === "full" ? "full" : "compact";
}

function fieldsOf(args: Record<string, unknown>): Record<string, FieldValue> {
  const value = args["fields"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DummyToolError("argument fields must be an object");
  }
  return value as Record<string, FieldValue>;
}

function assertStatus(ledgerId: string, status: string): void {
  const schema = SCHEMAS.get(ledgerId);
  if (schema === undefined) throw new DummyToolError(`ledger not found: ${ledgerId}`);
  if (!schema.statusValues.includes(status)) {
    throw new DummyToolError(`invalid status: ${status}`);
  }
}

function assertRequiredFields(ledgerId: string, fields: Record<string, FieldValue>): void {
  const schema = SCHEMAS.get(ledgerId);
  if (schema === undefined) throw new DummyToolError(`ledger not found: ${ledgerId}`);
  for (const [name, def] of Object.entries(schema.fields)) {
    if (def.required && fields[name] === undefined) {
      throw new DummyToolError(`missing required field: ${name}`);
    }
  }
}

const enumerateLedgers: ToolHandler = (tenant) => {
  const ledgers = CANONICAL_LEDGERS.map(({ name }) => name);
  const counts: Record<string, number> = {};
  const ledgerSummaries: unknown[] = [];
  for (const { name, schema } of CANONICAL_LEDGERS) {
    const active =
      name === MILESTONES_LEDGER ? [...tenant.milestones.values()] : ledgerOf(tenant, name);
    counts[name] = active.length;
    const statusCounts: Record<string, number> = {};
    let completedCount = 0;
    for (const item of active) {
      statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
      if (schema.terminalStatuses.includes(item.status)) completedCount += 1;
    }
    ledgerSummaries.push({
      name,
      itemCount: active.length,
      statusCounts,
      completedCount,
      progressTotal: active.length,
    });
  }
  return { ledgers, counts, ledgerSummaries };
};

const fetchLedger: ToolHandler = (tenant, args) => {
  const ledgerId = str(args, "ledger_id");
  const projection = projectionOf(args);
  const schema = SCHEMAS.get(ledgerId);
  if (schema === undefined) throw new DummyToolError(`ledger not found: ${ledgerId}`);
  const counters = {
    milestone: tenant.milestoneCounter + 1,
    item: (tenant.itemCounters.get(ledgerId) ?? 0) + 1,
  };
  const meta = {
    id: ledgerId,
    schema,
    counters,
    archivePointers: archivePointersFor(tenant, ledgerId),
  };

  // Milestone groups in first-appearance order (the milestones ledger itself
  // is a single "active" group of its own items).
  const groups: Array<{ id: string; milestone: unknown; items: unknown[] }> = [];
  if (ledgerId === MILESTONES_LEDGER) {
    const items = [...tenant.milestones.values()];
    if (items.length > 0) {
      groups.push({
        id: "active",
        milestone: { id: "active", status: "open", title: "active", description: "" },
        items: items.map((item) => project(item, projection)),
      });
    }
  } else {
    const byMilestone = new Map<string, Item[]>();
    for (const item of ledgerOf(tenant, ledgerId)) {
      const group = byMilestone.get(item.milestoneId) ?? [];
      group.push(item);
      byMilestone.set(item.milestoneId, group);
    }
    for (const [milestoneId, items] of byMilestone) {
      groups.push({
        id: milestoneId,
        milestone: resolvedMilestone(tenant, milestoneId),
        items: items.map((item) => project(item, projection)),
      });
    }
  }

  const offset = typeof args["offset"] === "number" ? args["offset"] : undefined;
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  if (offset !== undefined || limit !== undefined) {
    const all = groups.flatMap((g) => g.items);
    const start = offset ?? 0;
    const items = limit !== undefined ? all.slice(start, start + limit) : all.slice(start);
    const nextOffset =
      limit !== undefined && start + items.length < all.length
        ? start + items.length
        : null;
    return {
      ledger: meta,
      items,
      total: all.length,
      offset: start,
      limit: limit ?? null,
      nextOffset,
    };
  }
  return { ledger: { ...meta, milestones: groups } };
};

const fetchLedgerArchive: ToolHandler = (tenant, args) => {
  const ledgerId = str(args, "ledger_id");
  const archiveId = str(args, "archive_id");
  if (ledgerId === MILESTONES_LEDGER) {
    const archived = tenant.milestoneArchives.get(archiveId);
    if (archived === undefined) {
      throw new DummyToolError(`archive ${archiveId} not found in ledger ${ledgerId}`);
    }
    return { archive: { kind: "item", item: archived.item } };
  }
  const group = tenant.archives.get(`${ledgerId}/${archiveId}`);
  if (group === undefined) {
    throw new DummyToolError(`archive ${archiveId} not found in ledger ${ledgerId}`);
  }
  return {
    archive: {
      kind: "group",
      milestone: { id: archiveId, title: "", description: "", items: group.items },
    },
  };
};

const fetchItem: ToolHandler = (tenant, args) =>
  str(args, "ledger_id") === MILESTONES_LEDGER
    ? fetchRoot(tenant, args)
    : {
        item: project(
          findItem(tenant, str(args, "ledger_id"), str(args, "item_id")),
          projectionOf(args),
        ),
      };

const createItem: ToolHandler = (tenant, args) => {
  const ledgerId = str(args, "ledger_id");
  if (ledgerId === MILESTONES_LEDGER) return createRoot(tenant, args);
  const milestoneId = str(args, "milestone_id");
  const status = str(args, "status");
  const fields = fieldsOf(args);
  milestoneOf(tenant, milestoneId);
  assertStatus(ledgerId, status);
  assertRequiredFields(ledgerId, fields);
  const timestamp = nowIso();
  const id = optStr(args, "id") ?? allocateItemId(tenant, ledgerId);
  const item: Item = { id, milestoneId, status, fields, createdAt: timestamp, updatedAt: timestamp };
  const author = optStr(args, "author");
  const session = optStr(args, "session");
  if (author !== undefined) item.author = author;
  if (session !== undefined) item.session = session;
  const items = tenant.items.get(ledgerId) ?? [];
  items.push(item);
  tenant.items.set(ledgerId, items);
  return { item: projectItemMutationAckDto(item) };
};

const updateItem: ToolHandler = (tenant, args) => {
  const ledgerId = str(args, "ledger_id");
  if (ledgerId === MILESTONES_LEDGER) return updateRoot(tenant, args);
  const item = findItem(tenant, ledgerId, str(args, "item_id"));
  const status = optStr(args, "status");
  if (status !== undefined) {
    assertStatus(ledgerId, status);
    item.status = status;
  }
  if (args["fields"] !== undefined) {
    for (const [key, value] of Object.entries(fieldsOf(args))) {
      item.fields[key] = value;
    }
  }
  const author = optStr(args, "author");
  const session = optStr(args, "session");
  if (author !== undefined) item.author = author;
  if (session !== undefined) item.session = session;
  item.updatedAt = nowIso();
  return { item: projectItemMutationAckDto(item) };
};

const searchItems: ToolHandler = (tenant, args) => {
  const query = str(args, "query").toLowerCase();
  const projection = projectionOf(args);
  const matches = ledgerOf(tenant, str(args, "ledger_id")).filter((item) => {
    if (item.status.toLowerCase().includes(query)) return true;
    return Object.values(item.fields).some((value) => {
      if (typeof value === "string") return value.toLowerCase().includes(query);
      if (Array.isArray(value)) {
        return value.some((entry) => entry.toLowerCase().includes(query));
      }
      if (typeof value === "number") return String(value).includes(query);
      return false;
    });
  });
  return { items: matches.map((item) => project(item, projection)) };
};

const ftsSearch: ToolHandler = (tenant, args) => {
  const projection = projectionOf(args);
  const ledger = optStr(args, "ledger");
  const terms = str(args, "query")
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0 && !term.includes(":"));
  const results: Array<{ ledgerId: string; item: unknown; score: number; matchedFields: string[] }> = [];
  for (const { name } of CANONICAL_LEDGERS) {
    if (ledger !== undefined && name !== ledger) continue;
    const active =
      name === MILESTONES_LEDGER ? [...tenant.milestones.values()] : ledgerOf(tenant, name);
    for (const item of active) {
      let score = 0;
      const matchedFields: string[] = [];
      for (const [fieldName, value] of Object.entries(item.fields)) {
        const haystack = (
          Array.isArray(value) ? value.join(" ") : String(value)
        ).toLowerCase();
        if (terms.some((term) => haystack.includes(term))) {
          matchedFields.push(fieldName);
          score += fieldName === "headline" || fieldName === "title" ? 3 : 1;
        }
      }
      if (terms.some((term) => item.status.toLowerCase().includes(term))) {
        matchedFields.push("status");
        score += 1;
      }
      if (score > 0) {
        results.push({ ledgerId: name, item: project(item, projection), score, matchedFields });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  return { results };
};

const createRoot: ToolHandler = (tenant, args) => {
  const timestamp = nowIso();
  const id = optStr(args, "id") ?? `M${String(++tenant.milestoneCounter)}`;
  const fields = fieldsOf(args);
  if (typeof fields["title"] !== "string") {
    throw new DummyToolError("milestones title is required");
  }
  const milestone: Item = {
    id,
    milestoneId: "active",
    status: "open",
    fields,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const author = optStr(args, "author");
  const session = optStr(args, "session");
  if (author !== undefined) milestone.author = author;
  if (session !== undefined) milestone.session = session;
  tenant.milestones.set(id, milestone);
  return { item: projectItemMutationAckDto(milestone) };
};

const updateRoot: ToolHandler = (tenant, args) => {
  const milestone = milestoneOf(tenant, str(args, "item_id"));
  const status = optStr(args, "status");
  if (status !== undefined) assertStatus(MILESTONES_LEDGER, status);
  if (status !== undefined) milestone.status = status;
  if (args["fields"] !== undefined) {
    for (const [name, value] of Object.entries(fieldsOf(args))) {
      milestone.fields[name] = value;
    }
  }
  const author = optStr(args, "author");
  const session = optStr(args, "session");
  if (author !== undefined) milestone.author = author;
  if (session !== undefined) milestone.session = session;
  milestone.updatedAt = nowIso();
  return { item: projectItemMutationAckDto(milestone) };
};

const fetchRoot: ToolHandler = (tenant, args) => {
  const milestoneId = str(args, "item_id");
  const milestone = milestoneOf(tenant, milestoneId);
  const references: Record<string, number> = {};
  for (const { name } of CANONICAL_LEDGERS) {
    if (name === MILESTONES_LEDGER) continue;
    const count = ledgerOf(tenant, name).filter(
      (item) => item.milestoneId === milestoneId,
    ).length;
    if (count > 0) references[name] = count;
  }
  return {
    item: project(milestone, projectionOf(args)),
    resolved: resolvedMilestone(tenant, milestoneId),
    references,
  };
};

const archiveMilestone: ToolHandler = (tenant, args) => {
  const milestoneId = str(args, "milestone_id");
  const summary = str(args, "summary");
  const milestone = milestoneOf(tenant, milestoneId);
  if (milestoneId === MILESTONES_AMBIENT_ID) {
    throw new DummyToolError(`milestone ${milestoneId} cannot be archived`);
  }
  for (const { name, schema } of CANONICAL_LEDGERS) {
    if (name === MILESTONES_LEDGER) continue;
    const blocking = ledgerOf(tenant, name).filter(
      (item) => item.milestoneId === milestoneId && !schema.terminalStatuses.includes(item.status),
    );
    if (blocking.length > 0) {
      throw new DummyToolError(`milestone ${milestoneId} has non-terminal items`);
    }
  }
  const milestoneSchema = SCHEMAS.get(MILESTONES_LEDGER);
  if (milestoneSchema === undefined || !milestoneSchema.terminalStatuses.includes(milestone.status)) {
    throw new DummyToolError(`milestone ${milestoneId} has non-terminal items`);
  }
  const title = milestone.fields["title"];
  for (const { name } of CANONICAL_LEDGERS) {
    if (name === MILESTONES_LEDGER) continue;
    const swept = ledgerOf(tenant, name).filter((item) => item.milestoneId === milestoneId);
    if (swept.length === 0) continue;
    tenant.archives.set(`${name}/${milestoneId}`, {
      summary,
      title: typeof title === "string" ? title : "",
      status: milestone.status,
      items: swept,
    });
    tenant.items.set(
      name,
      ledgerOf(tenant, name).filter((item) => item.milestoneId !== milestoneId),
    );
  }
  tenant.milestones.delete(milestoneId);
  tenant.milestoneArchives.set(milestoneId, { summary, item: milestone });
  const pointer: ArchivePointer = {
    id: milestoneId,
    path: `./archive/milestones/${milestoneId}.md`,
    summary,
    title: typeof title === "string" ? title : "",
    status: milestone.status,
  };
  return { pointer };
};

const listMilestoneItems: ToolHandler = (tenant, args) => {
  const milestoneId = str(args, "milestone_id");
  const projection = projectionOf(args);
  const groups: Record<string, unknown[]> = {};
  for (const { name } of CANONICAL_LEDGERS) {
    if (name === MILESTONES_LEDGER) continue;
    const items = ledgerOf(tenant, name).filter((item) => item.milestoneId === milestoneId);
    if (items.length > 0) {
      groups[name] = items.map((item) => project(item, projection));
    }
  }
  return { items: groups };
};

const snapshotTool: ToolHandler = (tenant) => {
  const snapshot: Record<string, Record<string, { count: number; items: unknown[] }>> = {};
  for (const { name } of CANONICAL_LEDGERS) {
    const active =
      name === MILESTONES_LEDGER ? [...tenant.milestones.values()] : ledgerOf(tenant, name);
    if (active.length === 0) continue;
    const byStatus: Record<string, { count: number; items: unknown[] }> = {};
    for (const item of active) {
      const bucket = byStatus[item.status] ?? { count: 0, items: [] };
      bucket.count += 1;
      bucket.items.push({ id: item.id, status: item.status, summary: summarize(item) });
      byStatus[item.status] = bucket;
    }
    snapshot[name] = byStatus;
  }
  return { ledger: snapshot };
};

const derivePredicates: ToolHandler = () => {
  // TRUE for every state this contract seeds: predicate readiness is
  // goal-gated (P-implement/P-plan) or defect/research-gated (P-investigate/
  // P-seed/P-research), and the contract owns no goals, defects, researches,
  // or open questions. The full semantics live in predicates.test.ts.
  const verdict = (): { value: boolean; items: string[] } => ({ value: false, items: [] });
  return {
    pInvestigate: verdict(),
    pSeed: verdict(),
    pPlan: verdict(),
    pResearch: verdict(),
    pImplement: verdict(),
    openQuestionGate: verdict(),
    belowFloor: verdict(),
    planBusy: verdict(),
    goalDrift: verdict(),
  };
};

const readLog: ToolHandler = (tenant, args) => {
  const raw = str(args, "path");
  const rel = raw.startsWith(".cq/logs/") ? raw.slice(".cq/logs/".length) : raw;
  if (rel.startsWith("/") || rel.split("/").includes("..")) {
    throw new DummyToolError(`read_log: path ${raw} escapes the logs root`);
  }
  const content = tenant.logs.get(rel);
  if (content === undefined) {
    throw new DummyToolError(`read_log: no log at .cq/logs/${rel}`);
  }
  return { path: rel, content };
};

// ---------------------------------------------------------------------------
// The hand-written in-memory MCP service (Streamable HTTP, JSON responses)
// ---------------------------------------------------------------------------

interface DummySession {
  readonly projectKey: string;
}

const MCP_ROUTE = /^\/p\/([^/]+)\/mcp$/;

function rpcResult(id: unknown, result: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rpcError(
  id: unknown,
  code: number,
  message: string,
  status = 200,
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The hand-written in-memory MCP service. One instance owns its tenants,
 * sessions, knobs, and the bound Bun server; `stop()` releases the port.
 */
export class InMemoryMcpService {
  private readonly tenants = new Map<string, DummyTenant>();
  private readonly sessions = new Map<string, DummySession>();
  private readonly malformedQueue: Array<"non-text-block" | "invalid-json"> = [];
  private bogusProtocolVersion: string | null = null;

  private constructor(
    private readonly server: ReturnType<typeof Bun.serve>,
    private readonly token: string,
  ) {}

  static start(token: string): InMemoryMcpService {
    // Deferred self-reference: the fetch closure needs the instance before
    // the constructor returns (Bun.serve binds synchronously first).
    const ref: { current: InMemoryMcpService | null } = { current: null };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req: Request): Promise<Response> {
        const current = ref.current;
        if (current === null) {
          return Promise.resolve(new Response("booting", { status: 503 }));
        }
        return current.handle(req);
      },
    });
    const service = new InMemoryMcpService(server, token);
    ref.current = service;
    return service;
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${String(this.server.port)}/`;
  }

  /** Make the NEXT initialize answer an out-of-set protocolVersion. */
  respondBogusProtocolVersionOnce(): void {
    this.bogusProtocolVersion = "1999-01-01";
  }

  /** Make the NEXT tools/call answer a malformed result. */
  respondMalformedOnce(kind: "non-text-block" | "invalid-json"): void {
    this.malformedQueue.push(kind);
  }

  /** Seed a log artifact for `projectKey` (fixture-side, not over the wire). */
  seedLog(projectKey: string, relPath: string, content: string): void {
    const tenant = this.tenants.get(projectKey) ?? createTenant(projectKey);
    this.tenants.set(projectKey, tenant);
    tenant.logs.set(relPath, content);
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }

  private tenantFor(projectKey: string, initializeDisplayName?: string): DummyTenant | null {
    const existing = this.tenants.get(projectKey);
    if (existing !== undefined) {
      if (initializeDisplayName !== undefined) existing.displayName = initializeDisplayName;
      return existing;
    }
    // Only an authenticated initialize may register an unknown tenant.
    if (initializeDisplayName === undefined) return null;
    const tenant = createTenant(initializeDisplayName);
    this.tenants.set(projectKey, tenant);
    return tenant;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = MCP_ROUTE.exec(url.pathname);
    if (route === null) {
      return new Response("not found", { status: 404 });
    }
    const projectKey = decodeURIComponent(route[1] ?? "");

    // Bearer gate (mirrors the hub: a uniform 401, the token never echoed).
    const authorization = req.headers.get("authorization");
    if (authorization !== `Bearer ${this.token}`) {
      return new Response("unauthorized", { status: 401 });
    }

    if (req.method === "GET") {
      // The standalone SSE stream is optional; the SDK treats 405 as "none".
      return new Response("SSE not offered", { status: 405 });
    }
    if (req.method === "DELETE") {
      const sid = req.headers.get("mcp-session-id");
      if (sid !== null) this.sessions.delete(sid);
      return new Response(null, { status: 200 });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const body: unknown = await req.json().catch(() => undefined);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return rpcError(null, -32600, "Invalid Request", 400);
    }
    const message = body as {
      id?: number | string | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    const id = message.id ?? null;

    if (message.method === "initialize") {
      // The bounded display-name header (mirrors the hub's initialize rule).
      const rawDisplayName = req.headers.get(PROJECT_DISPLAY_NAME_HEADER);
      let displayName = projectKey;
      if (rawDisplayName !== null && rawDisplayName.trim() !== "") {
        const trimmed = rawDisplayName.trim();
        if (new TextEncoder().encode(trimmed).byteLength > PROJECT_DISPLAY_NAME_MAX_BYTES) {
          return new Response(
            `${PROJECT_DISPLAY_NAME_HEADER} exceeds ${String(PROJECT_DISPLAY_NAME_MAX_BYTES)} bytes`,
            { status: 400 },
          );
        }
        displayName = trimmed;
      }
      const tenant = this.tenantFor(projectKey, displayName);
      if (tenant === null) {
        // Unreachable (an initialize always carries a fallback name), but the
        // hub's unknown-project boundary is 404 either way.
        return new Response("unknown project", { status: 404 });
      }
      const requested = message.params?.["protocolVersion"];
      const negotiated =
        this.bogusProtocolVersion ??
        (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION);
      this.bogusProtocolVersion = null;
      const sessionId = randomUUID();
      this.sessions.set(sessionId, { projectKey });
      return rpcResult(
        id,
        {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: {
            name: "t727-in-memory-mcp",
            version: "0.0.1",
            title: displayName,
          },
          instructions:
            `Project: ${displayName}\n\n` +
            "Hand-written in-memory MCP contract service (T727).",
        },
        { "mcp-session-id": sessionId },
      );
    }

    // Every non-initialize request needs a live session.
    const sessionId = req.headers.get("mcp-session-id");
    const session = sessionId !== null ? this.sessions.get(sessionId) : undefined;
    if (session === undefined || session.projectKey !== projectKey) {
      return rpcError(null, -32000, "Bad Request: no valid session id", 400);
    }

    // Notifications get no response body.
    if (id === null || message.method?.startsWith("notifications/") === true) {
      return new Response(null, { status: 202 });
    }

    if (message.method !== "tools/call") {
      return rpcError(id, -32601, "Method not found");
    }

    // One-shot malformed-response knobs short-circuit dispatch.
    const malformed = this.malformedQueue.shift();
    if (malformed !== undefined) {
      return rpcResult(
        id,
        malformed === "non-text-block"
          ? { content: [{ type: "image", data: "", mimeType: "image/png" }] }
          : { content: [{ type: "text", text: "{ this is not json" }] },
      );
    }

    const toolName = message.params?.["name"];
    if (typeof toolName !== "string") {
      return rpcError(id, -32602, "Invalid params");
    }
    const handler = this.toolHandlers()[toolName];
    if (handler === undefined) {
      // The production McpServer CATCHES its `McpError(-32602, "Tool <name>
      // not found")` and converts it to an isError CallToolResult (server/
      // mcp.js createToolError) — mirror that observable shape verbatim.
      return rpcResult(id, {
        content: [{ type: "text", text: `MCP error -32602: Tool ${toolName} not found` }],
        isError: true,
      });
    }
    const tenant = this.tenants.get(projectKey);
    if (tenant === undefined) {
      return new Response("unknown project", { status: 404 });
    }
    const args =
      typeof message.params?.["arguments"] === "object" &&
      message.params["arguments"] !== null
        ? (message.params["arguments"] as Record<string, unknown>)
        : {};
    try {
      const payload = handler(tenant, args);
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return rpcResult(id, {
        content: [{ type: "text", text: detail }],
        isError: true,
      });
    }
  }

  private toolHandlers(): Record<string, ToolHandler> {
    return {
      enumerate_ledgers: enumerateLedgers,
      fetch_ledger: fetchLedger,
      fetch_ledger_archive: fetchLedgerArchive,
      fetch_item: fetchItem,
      create_item: createItem,
      update_item: updateItem,
      search_items: searchItems,
      fts_search: ftsSearch,
      archive_milestone: archiveMilestone,
      list_milestone_items: listMilestoneItems,
      snapshot: snapshotTool,
      derive_predicates: derivePredicates,
      list_projects: (_tenant) => ({
        projects: [...this.tenants.entries()]
          .map(([key, t]) => ({ key, displayName: t.displayName, createdAt: t.createdAt }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      }),
      read_log: readLog,
    };
  }
}

// ---------------------------------------------------------------------------
// The always-on contract factory leg
// ---------------------------------------------------------------------------

/** The always-on (in-memory dummy) leg of the dual contract. */
export const inMemoryRemoteClientFactory: RemoteLedgerClientContractFactory = {
  name: "hand-written in-memory MCP service",
  classification: "Behavioral-Active Blackbox-Group",
  capabilities: { bogusProtocolVersion: true, malformedResponses: true },
  build(): Promise<RemoteContractService> {
    const validToken = `t727-valid-${randomUUID()}`;
    const service = InMemoryMcpService.start(validToken);
    const projectKey = `t727-inmem-${randomUUID()}`;
    return Promise.resolve({
      serverUrl: service.serverUrl,
      validToken,
      invalidToken: `t727-invalid-${randomUUID()}`,
      projectKey,
      displayName: `T727 InMemory ${projectKey}`,
      seedLog: (relPath, content) => {
        service.seedLog(projectKey, relPath, content);
        return Promise.resolve();
      },
      respondBogusProtocolVersionOnce: () => service.respondBogusProtocolVersionOnce(),
      respondMalformedOnce: (kind) => service.respondMalformedOnce(kind),
      dispose: () => service.stop(),
    });
  },
};
