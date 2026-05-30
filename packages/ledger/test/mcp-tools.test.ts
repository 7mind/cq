/**
 * MCP tool factory tests (msunify shape).
 *
 * We invoke each tool's handler directly (no SDK transport) and assert that
 * the returned CallToolResult has `content[0].text` that JSON-decodes to the
 * expected shape.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  InMemoryLedgerStore,
  LEDGER_TOOL_NAMES,
  CANONICAL_LEDGERS,
  createLedgerMcpTools,
  type LedgerSchema,
} from "../src/index.js";

const BOOTSTRAPPED = CANONICAL_LEDGERS.map((c) => c.name);

const schema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: {
    note: { type: "string", required: false },
  },
};

async function buildStore() {
  const store = new InMemoryLedgerStore({ seed: [{ name: "xenos", schema }] });
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
  it("exports the expected tool names (14 tools)", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    expect(tools.map((t) => t.name).sort()).toEqual([...LEDGER_TOOL_NAMES].sort());
    expect(LEDGER_TOOL_NAMES.length).toBe(14);
    expect(LEDGER_TOOL_NAMES).toContain("fts_search");
  });

  it("enumerate_ledgers + create_ledger + fetch_ledger round-trip (includes bootstrapped milestones)", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    const enum1 = decode<{ ledgers: string[] }>(
      await callTool(tools, "enumerate_ledgers", {}),
    );
    expect(enum1.ledgers).toEqual([...BOOTSTRAPPED, "xenos"].sort());

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
    expect(enum2.ledgers).toEqual([...BOOTSTRAPPED, "alpha", "xenos"].sort());

    const fetched = decode<{
      ledger: { id: string; counters: { milestone: number; item: number } };
    }>(await callTool(tools, "fetch_ledger", { ledger_id: "alpha" }));
    expect(fetched.ledger.id).toBe("alpha");
    expect(fetched.ledger.counters).toEqual({ milestone: 0, item: 0 });
  });

  it("create_milestone + create_item + fetch_item + update_item flow", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    const m = decode<{ milestone: { id: string; fields: Record<string, unknown> } }>(
      await callTool(tools, "create_milestone", {
        title: "first",
        description: "the first milestone",
      }),
    );
    expect(m.milestone.id).toBe("M1");
    expect(m.milestone.fields["title"]).toBe("first");

    const it = decode<{ item: { id: string; status: string; milestoneId: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "xenos",
        milestone_id: "M1",
        status: "open",
        fields: { note: "buy milk" },
      }),
    );
    expect(it.item.id).toBe("X1");
    expect(it.item.status).toBe("open");
    expect(it.item.milestoneId).toBe("M1");

    const fetched = decode<{ item: { fields: Record<string, string> } }>(
      await callTool(tools, "fetch_item", { ledger_id: "xenos", item_id: "X1" }),
    );
    expect(fetched.item.fields["note"]).toBe("buy milk");

    const updated = decode<{
      item: { status: string; fields: Record<string, string> };
    }>(
      await callTool(tools, "update_item", {
        ledger_id: "xenos",
        item_id: "X1",
        status: "done",
        fields: { note: "bought milk" },
      }),
    );
    expect(updated.item.status).toBe("done");
    expect(updated.item.fields["note"]).toBe("bought milk");
  });

  it("create_item refuses absent / terminal milestone (strict existence Q5)", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await expect(
      callTool(tools, "create_item", {
        ledger_id: "xenos",
        milestone_id: "M99",
        status: "open",
        fields: {},
      }),
    ).rejects.toThrow(/does not exist/);

    await callTool(tools, "create_milestone", { title: "done-already" });
    await callTool(tools, "update_milestone", { milestone_id: "M1", status: "done" });
    await expect(
      callTool(tools, "create_item", {
        ledger_id: "xenos",
        milestone_id: "M1",
        status: "open",
        fields: {},
      }),
    ).rejects.toThrow(/terminal status/);
  });

  it("update_milestone + fetch_milestone + list_milestone_items", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await callTool(tools, "create_milestone", { title: "x", description: "the x" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "t1" },
    });

    const fm = decode<{
      milestone: { id: string };
      resolved: { id: string; title: string };
      references: Record<string, number>;
    }>(await callTool(tools, "fetch_milestone", { milestone_id: "M1" }));
    expect(fm.milestone.id).toBe("M1");
    expect(fm.resolved.title).toBe("x");
    expect(fm.references).toEqual({ xenos: 1 });

    await callTool(tools, "update_milestone", {
      milestone_id: "M1",
      title: "renamed",
    });
    const fm2 = decode<{ resolved: { title: string } }>(
      await callTool(tools, "fetch_milestone", { milestone_id: "M1" }),
    );
    expect(fm2.resolved.title).toBe("renamed");

    const list = decode<{ items: Record<string, Array<{ id: string }>> }>(
      await callTool(tools, "list_milestone_items", { milestone_id: "M1" }),
    );
    expect(list.items["xenos"]?.[0]?.id).toBe("X1");
  });

  it("archive_milestone (global, 2-level): refuses non-terminal items, succeeds when all terminal", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await callTool(tools, "create_milestone", { title: "x" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: {},
    });
    await expect(
      callTool(tools, "archive_milestone", { milestone_id: "M1", summary: "no" }),
    ).rejects.toThrow(/not in terminal status/);
    await callTool(tools, "update_item", {
      ledger_id: "xenos",
      item_id: "X1",
      status: "done",
    });
    await callTool(tools, "update_milestone", { milestone_id: "M1", status: "done" });
    const ptr = decode<{ pointer: { id: string; path: string } }>(
      await callTool(tools, "archive_milestone", { milestone_id: "M1", summary: "done!" }),
    );
    expect(ptr.pointer.id).toBe("M1");
    expect(ptr.pointer.path).toBe("./archive/milestones/M1.md");
  });

  // D-LED-02 — Zod-layer rejection of invalid schemas at create_ledger.
  describe("D-LED-02 — Zod schema validation in create_ledger", () => {
    function parseCreateLedger(
      tools: ReturnType<typeof createLedgerMcpTools>,
      args: Record<string, unknown>,
    ): { success: boolean } {
      const t = tools.find((x) => x.name === "create_ledger");
      if (t === undefined) throw new Error("create_ledger not found");
      return z.object(t.inputSchema).safeParse(args);
    }

    it("rejects terminalStatuses not in statusValues", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      expect(
        parseCreateLedger(tools, {
          name: "x",
          schema: {
            statusValues: ["open"],
            terminalStatuses: ["done"],
            fields: {},
          },
        }).success,
      ).toBe(false);
    });

    it("rejects status values containing em-dash", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      expect(
        parseCreateLedger(tools, {
          name: "x",
          schema: {
            statusValues: ["open", "in—progress"],
            terminalStatuses: [],
            fields: {},
          },
        }).success,
      ).toBe(false);
    });

    it("rejects reserved field names createdAt/updatedAt", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      for (const name of ["createdAt", "updatedAt"]) {
        expect(
          parseCreateLedger(tools, {
            name: "x",
            schema: {
              statusValues: ["open"],
              terminalStatuses: [],
              fields: { [name]: { type: "timestamp", required: false } },
            },
          }).success,
        ).toBe(false);
      }
    });

    it("rejects field names with spaces or leading digits", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      for (const name of ["bad name", "1bad", "with:colon"]) {
        expect(
          parseCreateLedger(tools, {
            name: "x",
            schema: {
              statusValues: ["open"],
              terminalStatuses: [],
              fields: { [name]: { type: "string", required: false } },
            },
          }).success,
        ).toBe(false);
      }
    });

    it("accepts a clean schema (positive control)", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      expect(
        parseCreateLedger(tools, {
          name: "x",
          schema: {
            statusValues: ["open", "done"],
            terminalStatuses: ["done"],
            fields: { note: { type: "string", required: false } },
          },
        }).success,
      ).toBe(true);
    });
  });

  // D-LED-01 — Zod-layer rejection of unsafe ids.
  describe("D-LED-01 — Zod id validation", () => {
    const badIds = ["../etc/passwd", "a/b", "a b", "a.b"];
    function parseInput(
      tools: ReturnType<typeof createLedgerMcpTools>,
      name: string,
      args: Record<string, unknown>,
    ): { success: boolean } {
      const t = tools.find((x) => x.name === name);
      if (t === undefined) throw new Error(`tool not found: ${name}`);
      return z.object(t.inputSchema).safeParse(args);
    }

    it("create_milestone rejects unsafe explicit ids at the Zod boundary", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      for (const badId of badIds) {
        const r = parseInput(tools, "create_milestone", {
          title: "x",
          id: badId,
        });
        expect(r.success).toBe(false);
      }
    });

    it("create_item rejects unsafe ids (item id and milestone_id)", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      for (const badId of badIds) {
        const rItem = parseInput(tools, "create_item", {
          ledger_id: "xenos",
          milestone_id: "M1",
          status: "open",
          fields: {},
          id: badId,
        });
        expect(rItem.success).toBe(false);
        const rMile = parseInput(tools, "create_item", {
          ledger_id: "xenos",
          milestone_id: badId,
          status: "open",
          fields: {},
        });
        expect(rMile.success).toBe(false);
      }
    });

    it("update_milestone and archive_milestone reject unsafe milestone_id", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      for (const badId of badIds) {
        expect(
          parseInput(tools, "update_milestone", { milestone_id: badId }).success,
        ).toBe(false);
        expect(
          parseInput(tools, "archive_milestone", {
            milestone_id: badId,
            summary: "x",
          }).success,
        ).toBe(false);
      }
    });

    it("safe ids parse cleanly (positive control)", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      const r = parseInput(tools, "create_milestone", {
        title: "x",
        id: "M-ok_1",
      });
      expect(r.success).toBe(true);
    });
  });

  it("search_items returns items matching fields", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await callTool(tools, "create_milestone", { title: "x" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "buy milk" },
    });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "wash car" },
    });
    const hits = decode<{ items: Array<{ id: string }> }>(
      await callTool(tools, "search_items", { ledger_id: "xenos", query: "milk" }),
    );
    expect(hits.items.map((i) => i.id)).toEqual(["X1"]);
  });

  it("fts_search returns the documented ranked JSON shape", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await callTool(tools, "create_milestone", { title: "x" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "buy oat milk today" },
    });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "wash the car" },
    });
    const out = decode<{
      results: Array<{
        ledgerId: string;
        item: { id: string; fields: Record<string, string> };
        score: number;
        matchedFields: string[];
      }>;
    }>(await callTool(tools, "fts_search", { query: "milk" }));
    expect(out.results.length).toBe(1);
    const hit = out.results[0]!;
    expect(hit.ledgerId).toBe("xenos");
    expect(hit.item.id).toBe("X1");
    expect(hit.score > 0).toBe(true);
    expect(Array.isArray(hit.matchedFields)).toBe(true);
  });

  it("fts_search includes archived items only when include_archived=true", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await callTool(tools, "create_milestone", { title: "x" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "done",
      fields: { note: "quokka note" },
    });
    await callTool(tools, "update_milestone", { milestone_id: "M1", status: "done" });
    await callTool(tools, "archive_milestone", { milestone_id: "M1", summary: "s" });
    const def = decode<{ results: unknown[] }>(
      await callTool(tools, "fts_search", { query: "quokka" }),
    );
    expect(def.results.length).toBe(0);
    const incl = decode<{ results: Array<{ item: { id: string } }> }>(
      await callTool(tools, "fts_search", { query: "quokka", include_archived: true }),
    );
    expect(incl.results.map((r) => r.item.id)).toEqual(["X1"]);
  });
});
