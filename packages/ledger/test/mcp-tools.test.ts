/**
 * MCP tool factory tests.
 *
 * We invoke each tool's handler directly (no SDK transport) and assert that
 * the returned CallToolResult has `content[0].text` that JSON-decodes to the
 * expected shape.
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryLedgerStore,
  LEDGER_TOOL_NAMES,
  createLedgerMcpTools,
  type LedgerSchema,
} from "../src/index.js";

const schema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: {
    note: { type: "string", required: false },
  },
};

async function buildStore() {
  const store = new InMemoryLedgerStore({ seed: [{ name: "todos", schema }] });
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

describe("ledger MCP tools", () => {
  it("exports the expected tool names", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    expect(tools.map((t) => t.name).sort()).toEqual([...LEDGER_TOOL_NAMES].sort());
  });

  it("enumerate_ledgers + create_ledger + fetch_ledger round-trip", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    const enum1 = decode<{ ledgers: string[] }>(
      await callTool(tools, "enumerate_ledgers", {}),
    );
    expect(enum1.ledgers).toEqual(["todos"]);

    await callTool(tools, "create_ledger", {
      name: "alpha",
      schema: {
        statusValues: ["open", "done"],
        terminalStatuses: ["done"],
        fields: { tag: { type: "string", required: false } },
      },
    });
    const enum2 = decode<{ ledgers: string[] }>(
      await callTool(tools, "enumerate_ledgers", {}),
    );
    expect(enum2.ledgers).toEqual(["alpha", "todos"]);

    const fetched = decode<{ ledger: { id: string; counters: { milestone: number; item: number } } }>(
      await callTool(tools, "fetch_ledger", { ledger_id: "alpha" }),
    );
    expect(fetched.ledger.id).toBe("alpha");
    expect(fetched.ledger.counters).toEqual({ milestone: 0, item: 0 });
  });

  it("create_milestone + create_item + ledger_fetch + ledger_update flow", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    const m = decode<{ milestone: { id: string; title: string } }>(
      await callTool(tools, "create_milestone", { ledger_id: "todos", title: "first" }),
    );
    expect(m.milestone.id).toBe("M1");

    const it = decode<{ item: { id: string; status: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "todos",
        milestone_id: "M1",
        status: "open",
        fields: { note: "buy milk" },
      }),
    );
    expect(it.item.id).toBe("T1");
    expect(it.item.status).toBe("open");

    const fetched = decode<{ item: { fields: Record<string, string> } }>(
      await callTool(tools, "ledger_fetch", { ledger_id: "todos", item_id: "T1" }),
    );
    expect(fetched.item.fields["note"]).toBe("buy milk");

    const updated = decode<{ item: { status: string; fields: Record<string, string> } }>(
      await callTool(tools, "ledger_update", {
        ledger_id: "todos",
        item_id: "T1",
        status: "done",
        fields: { note: "bought milk" },
      }),
    );
    expect(updated.item.status).toBe("done");
    expect(updated.item.fields["note"]).toBe("bought milk");
  });

  it("archive_milestone refuses non-terminal items, succeeds on terminal", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await callTool(tools, "create_milestone", { ledger_id: "todos", title: "x" });
    await callTool(tools, "create_item", {
      ledger_id: "todos",
      milestone_id: "M1",
      status: "open",
      fields: {},
    });
    await expect(
      callTool(tools, "archive_milestone", {
        ledger_id: "todos",
        milestone_id: "M1",
        summary: "no",
      }),
    ).rejects.toThrow(/not in terminal status/);
    await callTool(tools, "ledger_update", {
      ledger_id: "todos",
      item_id: "T1",
      status: "done",
    });
    const ptr = decode<{ pointer: { id: string; path: string } }>(
      await callTool(tools, "archive_milestone", {
        ledger_id: "todos",
        milestone_id: "M1",
        summary: "done!",
      }),
    );
    expect(ptr.pointer.id).toBe("M1");
    expect(ptr.pointer.path).toBe("./archive/todos/M1.md");
  });

  it("search_items returns items matching fields", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await callTool(tools, "create_milestone", { ledger_id: "todos", title: "x" });
    await callTool(tools, "create_item", {
      ledger_id: "todos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "buy milk" },
    });
    await callTool(tools, "create_item", {
      ledger_id: "todos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "wash car" },
    });
    const hits = decode<{ items: Array<{ id: string }> }>(
      await callTool(tools, "search_items", { ledger_id: "todos", query: "milk" }),
    );
    expect(hits.items.map((i) => i.id)).toEqual(["T1"]);
  });
});
