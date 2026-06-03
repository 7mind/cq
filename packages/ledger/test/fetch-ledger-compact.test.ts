/**
 * Tests for the fetch_ledger compact + pagination params (T144).
 *
 * Covers:
 *  1. No params — backward-compatible full ledger response.
 *  2. compact:true — strips all long narrative fields (including goals
 *     `grounding`) from every item; response shape is { ledger: FetchedLedger }.
 *  3. offset/limit — flattens items, paginates, returns
 *     { ledger: { id, schema, counters, archivePointers }, items, total }.
 *  4. compact + offset/limit combined.
 *  5. Token-overflow proof: a goals fixture with a large grounding blob (≥51.8 KB)
 *     fits well under the tool-output limit in compact mode.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  InMemoryLedgerStore,
  createLedgerMcpTools,
  type FetchedLedger,
  type Item,
} from "../src/index.js";
import { COMPACT_PROJECTION_DENYLIST } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an InMemoryLedgerStore with the canonical bootstrapped ledgers only.
 * goals, questions, tasks, etc. are all bootstrapped automatically.
 */
async function buildStore() {
  const store = new InMemoryLedgerStore({});
  await store.init();
  return store;
}

function callTool(
  tools: ReturnType<typeof createLedgerMcpTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool not found: ${name}`);
  return t.handler(args as never, null) as Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

function decode<T>(result: { content: Array<{ type: string; text: string }> }): T {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

// Approximate tool-output limit used to declare "overflow". The observed
// 51.8 KB goals ledger and 142.7 KB questions ledger are both well over 32 KB.
// In compact mode the response must fit under this threshold.
const TOOL_OUTPUT_LIMIT_BYTES = 32_000;

// ---------------------------------------------------------------------------
// Setup: seed goals + questions with items carrying large fields
// ---------------------------------------------------------------------------

let store: Awaited<ReturnType<typeof buildStore>>;
let tools: ReturnType<typeof createLedgerMcpTools>;

// Large blobs simulating the observed overflow sizes.
const LARGE_GROUNDING = "g".repeat(52_000); // 52 KB — simulates goals overflow
const LARGE_CONTEXT = "c".repeat(90_000); // 90 KB — simulates questions overflow

beforeEach(async () => {
  store = await buildStore();
  tools = createLedgerMcpTools(store);

  // Create a milestone for items.
  await callTool(tools, "create_milestone", { title: "M1-title" });

  // Seed goals with a large grounding blob.
  // goals schema requires: title (string), description (string).
  await callTool(tools, "create_item", {
    ledger_id: "goals",
    milestone_id: "M1",
    status: "clarifying",
    fields: {
      title: "Improve throughput",
      description: "Enable compact projection to cut payload size",
      grounding: LARGE_GROUNDING,
      tags: ["perf"],
    },
  });
  await callTool(tools, "create_item", {
    ledger_id: "goals",
    milestone_id: "M1",
    status: "clarifying",
    fields: {
      title: "Second goal",
      description: "Another goal with large grounding",
      grounding: LARGE_GROUNDING,
      tags: ["scope"],
    },
  });

  // Seed questions with a large context blob.
  // questions schema requires: question (string).
  await callTool(tools, "create_item", {
    ledger_id: "questions",
    milestone_id: "M1",
    status: "open",
    fields: {
      question: "Which fields should compact strip?",
      context: LARGE_CONTEXT,
      recommendation: "All long narrative fields",
    },
  });
});

// ---------------------------------------------------------------------------
// 1. No params — backward-compatible full response
// ---------------------------------------------------------------------------

describe("fetch_ledger — no params (backward compat)", () => {
  it("returns { ledger: FetchedLedger } with full items including grounding", async () => {
    const result = decode<{ ledger: FetchedLedger }>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals" }),
    );
    expect(result.ledger.id).toBe("goals");
    const allItems = result.ledger.milestones.flatMap((g) => g.items);
    expect(allItems.length).toBe(2);
    // grounding must be present and large.
    const first = allItems[0]!;
    expect(typeof first.fields["grounding"]).toBe("string");
    expect((first.fields["grounding"] as string).length).toBeGreaterThan(50_000);
  });

  it("does not include top-level items or total fields", async () => {
    const result = decode<Record<string, unknown>>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals" }),
    );
    expect(result).not.toHaveProperty("items");
    expect(result).not.toHaveProperty("total");
  });
});

// ---------------------------------------------------------------------------
// 2. compact:true — projects items, strips long fields including grounding
// ---------------------------------------------------------------------------

describe("fetch_ledger — compact:true", () => {
  it("returns { ledger: FetchedLedger } shape (no flat items/total)", async () => {
    const result = decode<Record<string, unknown>>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals", compact: true }),
    );
    expect(result).toHaveProperty("ledger");
    expect(result).not.toHaveProperty("items");
    expect(result).not.toHaveProperty("total");
    const ledger = result["ledger"] as FetchedLedger;
    expect(ledger.milestones).toBeDefined();
  });

  it("strips grounding from goals items", async () => {
    const result = decode<{ ledger: FetchedLedger }>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals", compact: true }),
    );
    const allItems = result.ledger.milestones.flatMap((g) => g.items);
    expect(allItems.length).toBe(2);
    for (const item of allItems) {
      expect(item.fields).not.toHaveProperty("grounding");
    }
  });

  it("strips all COMPACT_PROJECTION_DENYLIST fields", async () => {
    const result = decode<{ ledger: FetchedLedger }>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals", compact: true }),
    );
    const allItems = result.ledger.milestones.flatMap((g) => g.items);
    for (const item of allItems) {
      for (const deniedField of COMPACT_PROJECTION_DENYLIST) {
        expect(item.fields).not.toHaveProperty(deniedField);
      }
    }
  });

  it("retains safe short fields (title, tags) after projection", async () => {
    const result = decode<{ ledger: FetchedLedger }>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals", compact: true }),
    );
    const allItems = result.ledger.milestones.flatMap((g) => g.items);
    const first = allItems[0]!;
    expect(first.fields["title"]).toBe("Improve throughput");
    expect(first.fields["tags"]).toEqual(["perf"]);
  });

  it("retains intrinsic item properties (id, status, milestoneId)", async () => {
    const result = decode<{ ledger: FetchedLedger }>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals", compact: true }),
    );
    const allItems = result.ledger.milestones.flatMap((g) => g.items);
    const first = allItems[0]!;
    expect(first.id).toBe("G1");
    expect(first.status).toBe("clarifying");
    expect(first.milestoneId).toBe("M1");
  });

  it("retains schema, counters, archivePointers in the ledger", async () => {
    const result = decode<{ ledger: FetchedLedger }>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals", compact: true }),
    );
    expect(result.ledger.schema).toBeDefined();
    expect(result.ledger.counters).toBeDefined();
    expect(Array.isArray(result.ledger.archivePointers)).toBe(true);
  });

  // TOKEN-OVERFLOW PROOF: a compact goals response with 52 KB grounding blobs
  // must fit under the tool-output limit that previously overflowed.
  it("compact goals response fits under tool-output limit (overflow proof)", async () => {
    const result = await callTool(tools, "fetch_ledger", {
      ledger_id: "goals",
      compact: true,
    });
    const responseBytes = result.content[0]!.text.length;
    // The uncompacted payload would be > 52 KB * 2 goals items = > 104 KB.
    // The compact payload must be < 32 KB.
    expect(responseBytes).toBeLessThan(TOOL_OUTPUT_LIMIT_BYTES);
  });

  it("compact questions response strips context and recommendation, fits under limit", async () => {
    const result = await callTool(tools, "fetch_ledger", {
      ledger_id: "questions",
      compact: true,
    });
    const responseBytes = result.content[0]!.text.length;
    expect(responseBytes).toBeLessThan(TOOL_OUTPUT_LIMIT_BYTES);

    const decoded = decode<{ ledger: FetchedLedger }>(result);
    const allItems = decoded.ledger.milestones.flatMap((g) => g.items);
    const q = allItems[0]!;
    expect(q.fields).not.toHaveProperty("context");
    expect(q.fields).not.toHaveProperty("recommendation");
    expect(q.fields["question"]).toBe("Which fields should compact strip?");
  });

  it("non-compact goals response overflows (control: confirms the problem compact solves)", async () => {
    const result = await callTool(tools, "fetch_ledger", { ledger_id: "goals" });
    const responseBytes = result.content[0]!.text.length;
    // With 52 KB * 2 items the full response must be > 32 KB.
    expect(responseBytes).toBeGreaterThan(TOOL_OUTPUT_LIMIT_BYTES);
  });
});

// ---------------------------------------------------------------------------
// 3. offset/limit pagination
// ---------------------------------------------------------------------------

describe("fetch_ledger — offset/limit pagination", () => {
  it("returns { ledger: meta, items, total } shape (no milestones in ledger)", async () => {
    const result = decode<Record<string, unknown>>(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "goals",
        offset: 0,
        limit: 1,
      }),
    );
    expect(result).toHaveProperty("ledger");
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("total");
    const ledger = result["ledger"] as Record<string, unknown>;
    // milestones must NOT be present in the ledger meta when paginating.
    expect(ledger).not.toHaveProperty("milestones");
  });

  it("total equals the full item count across all milestone groups", async () => {
    const result = decode<{ items: Item[]; total: number }>(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "goals",
        offset: 0,
        limit: 1,
      }),
    );
    expect(result.total).toBe(2);
    expect(result.items.length).toBe(1);
  });

  it("returns the correct page slice (offset=1, limit=1)", async () => {
    const result = decode<{ items: Item[]; total: number }>(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "goals",
        offset: 1,
        limit: 1,
      }),
    );
    expect(result.total).toBe(2);
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.id).toBe("G2");
  });

  it("offset beyond end returns empty items with correct total", async () => {
    const result = decode<{ items: Item[]; total: number }>(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "goals",
        offset: 100,
        limit: 10,
      }),
    );
    expect(result.total).toBe(2);
    expect(result.items).toEqual([]);
  });

  it("limit without offset defaults offset to 0", async () => {
    const result = decode<{ items: Item[]; total: number }>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals", limit: 1 }),
    );
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.id).toBe("G1");
    expect(result.total).toBe(2);
  });

  it("offset without limit returns all items from that offset", async () => {
    const result = decode<{ items: Item[]; total: number }>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals", offset: 1 }),
    );
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.id).toBe("G2");
    expect(result.total).toBe(2);
  });

  it("ledger meta in paginated response retains schema/counters/archivePointers", async () => {
    const result = decode<{ ledger: Record<string, unknown> }>(
      await callTool(tools, "fetch_ledger", { ledger_id: "goals", offset: 0, limit: 1 }),
    );
    expect(result.ledger["schema"]).toBeDefined();
    expect(result.ledger["counters"]).toBeDefined();
    expect(Array.isArray(result.ledger["archivePointers"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. compact + pagination combined
// ---------------------------------------------------------------------------

describe("fetch_ledger — compact + pagination combined", () => {
  it("applies compact projection before pagination", async () => {
    const result = decode<{ items: Item[]; total: number }>(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "goals",
        compact: true,
        offset: 0,
        limit: 2,
      }),
    );
    expect(result.total).toBe(2);
    expect(result.items.length).toBe(2);
    for (const item of result.items) {
      expect(item.fields).not.toHaveProperty("grounding");
      expect(item.fields).not.toHaveProperty("description");
      expect(item.fields).not.toHaveProperty("rationale");
    }
  });

  it("compact+paginated response fits under tool-output limit", async () => {
    const result = await callTool(tools, "fetch_ledger", {
      ledger_id: "goals",
      compact: true,
      offset: 0,
      limit: 2,
    });
    const responseBytes = result.content[0]!.text.length;
    expect(responseBytes).toBeLessThan(TOOL_OUTPUT_LIMIT_BYTES);
  });

  it("pagination total counts all items regardless of page size", async () => {
    const page1 = decode<{ items: Item[]; total: number }>(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "goals",
        compact: true,
        offset: 0,
        limit: 1,
      }),
    );
    const page2 = decode<{ items: Item[]; total: number }>(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "goals",
        compact: true,
        offset: 1,
        limit: 1,
      }),
    );
    expect(page1.total).toBe(2);
    expect(page2.total).toBe(2);
    expect(page1.items[0]!.id).toBe("G1");
    expect(page2.items[0]!.id).toBe("G2");
  });
});
