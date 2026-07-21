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
  prefixedToolNames,
  derivePredicates,
  type DerivedPredicates,
  type LedgerSchema,
  type PromptCatalogCapability,
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
  it("exports the expected tool names (26 tools)", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    expect(tools.map((t) => t.name).sort()).toEqual([...LEDGER_TOOL_NAMES].sort());
    expect(LEDGER_TOOL_NAMES.length).toBe(26);
    expect(LEDGER_TOOL_NAMES).toContain("fts_search");
    expect(LEDGER_TOOL_NAMES).toContain("snapshot");
    expect(LEDGER_TOOL_NAMES).toContain("derive_predicates");
    expect(LEDGER_TOOL_NAMES).toContain("reopen_item");
    expect(LEDGER_TOOL_NAMES).toContain("unarchive_item");
    expect(LEDGER_TOOL_NAMES).toContain("read_log");
    expect(LEDGER_TOOL_NAMES).toContain("get_reviewers");
    expect(LEDGER_TOOL_NAMES).toContain("get_planners");
    expect(LEDGER_TOOL_NAMES).toContain("get_config");
    expect(LEDGER_TOOL_NAMES).toContain("get_agent_models");
    expect(LEDGER_TOOL_NAMES).toContain("fetch_prompt");
    expect(LEDGER_TOOL_NAMES).toContain("validate_input");
    expect(LEDGER_TOOL_NAMES).toContain("validate_output");
  });

  it("prefixed factory names equal prefixedToolNames(prefix) — drift guard", async () => {
    const store = await buildStore();
    const prefix = "myproj";
    const tools = createLedgerMcpTools(store, undefined, undefined, undefined, prefix);
    expect(tools.map((t) => t.name).sort()).toEqual(prefixedToolNames(prefix).sort());
  });

  it("read_log against the in-memory store throws the documented not-implemented error", async () => {
    const store = await buildStore();
    // No readLog capability supplied -> the in-memory dummy has no filesystem.
    const tools = createLedgerMcpTools(store);
    await expect(
      callTool(tools, "read_log", { path: "anything.md" }),
    ).rejects.toThrow(/not implemented/i);
  });

  it("fetch_prompt/validate_input/validate_output without a catalog capability throw not-implemented", async () => {
    const store = await buildStore();
    // No promptCatalog capability supplied -> the in-memory wiring has no catalog.
    const tools = createLedgerMcpTools(store);
    await expect(
      callTool(tools, "fetch_prompt", { roleId: "plan-advance" }),
    ).rejects.toThrow(/not implemented/i);
    await expect(
      callTool(tools, "validate_input", { roleId: "plan-advance", input: {} }),
    ).rejects.toThrow(/not implemented/i);
    await expect(
      callTool(tools, "validate_output", { roleId: "plan-advance", output: {} }),
    ).rejects.toThrow(/not implemented/i);
  });

  it("fetch_prompt/validate_input/validate_output dispatch to an injected catalog capability", async () => {
    const store = await buildStore();
    const calls: string[] = [];
    const promptCatalog: PromptCatalogCapability = {
      fetchPrompt: (roleId) => {
        calls.push(`fetch:${roleId}`);
        return {
          roleId,
          kind: "dispatched-subagent",
          dispatched: true,
          promptTemplate: "body",
          version: 1,
          inputSchema: { $schema: "x" },
          outputSchema: { $schema: "x" },
        };
      },
      validateInput: (roleId) => {
        calls.push(`vin:${roleId}`);
        return { ok: true };
      },
      validateOutput: (roleId) => {
        calls.push(`vout:${roleId}`);
        return { ok: false, errors: [{ path: "/x", message: "bad", keyword: "type", schemaPath: "#/x", params: {} }] };
      },
    };
    const tools = createLedgerMcpTools(store, undefined, undefined, promptCatalog);

    const fetched = decode<{ roleId: string; dispatched: boolean }>(
      await callTool(tools, "fetch_prompt", { roleId: "plan-advance" }),
    );
    expect(fetched.roleId).toBe("plan-advance");
    expect(fetched.dispatched).toBe(true);

    const vin = decode<{ ok: boolean }>(
      await callTool(tools, "validate_input", { roleId: "plan-advance", input: { goalId: "G1" } }),
    );
    expect(vin.ok).toBe(true);

    const vout = decode<{ ok: boolean; errors: { path: string }[] }>(
      await callTool(tools, "validate_output", { roleId: "plan-advance", output: {} }),
    );
    expect(vout.ok).toBe(false);
    expect(vout.errors[0]?.path).toBe("/x");

    expect(calls).toEqual(["fetch:plan-advance", "vin:plan-advance", "vout:plan-advance"]);
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

    // enumerate_ledgers reports the active-item count per ledger: xenos now
    // holds X1, and milestones holds the just-created M1 (≥ 1).
    const counted = decode<{ counts: Record<string, number> }>(
      await callTool(tools, "enumerate_ledgers", {}),
    );
    expect(counted.counts["xenos"]).toBe(1);
    expect(counted.counts["milestones"]).toBeGreaterThanOrEqual(1);

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

  it("create_item / update_item thread author + session provenance", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await callTool(tools, "create_milestone", { title: "first" });

    const created = decode<{ item: { id: string; author?: string; session?: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "xenos",
        milestone_id: "M1",
        status: "open",
        fields: { note: "n" },
        author: "opus-4.8[1m]",
        session: "sess-1",
      }),
    );
    expect(created.item.author).toBe("opus-4.8[1m]");
    expect(created.item.session).toBe("sess-1");

    const updated = decode<{ item: { author?: string; session?: string } }>(
      await callTool(tools, "update_item", {
        ledger_id: "xenos",
        item_id: created.item.id,
        status: "done",
        author: "user",
        session: "sess-2",
      }),
    );
    expect(updated.item.author).toBe("user");
    expect(updated.item.session).toBe("sess-2");
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

  it("snapshot returns W1 grouping: { ledger: { [ledgerId]: { [status]: { count, items } } } }", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await callTool(tools, "create_milestone", { title: "snap-test" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "first item" },
    });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "second item" },
    });

    const out = decode<{
      ledger: Record<
        string,
        Record<string, { count: number; items: Array<{ id: string; status: string; summary: string }> }>
      >;
    }>(await callTool(tools, "snapshot", {}));

    expect(typeof out.ledger).toBe("object");

    const xenosOpen = out.ledger["xenos"]?.["open"];
    expect(xenosOpen).toBeDefined();
    expect(xenosOpen!.count).toBe(2);
    expect(xenosOpen!.items.length).toBe(2);

    // each stub carries exactly { id, status, summary } — no long fields
    const stub = xenosOpen!.items[0]!;
    expect(typeof stub.id).toBe("string");
    expect(stub.status).toBe("open");
    expect(typeof stub.summary).toBe("string");
    expect(Object.keys(stub).sort()).toEqual(["id", "status", "summary"]);

    // milestones ledger is also active (holds M1 at status open).
    expect(out.ledger["milestones"]).toBeDefined();

    // include_archived is a no-op; tool accepts it without error
    const out2 = decode<{ ledger: Record<string, unknown> }>(
      await callTool(tools, "snapshot", { include_archived: true }),
    );
    expect(typeof out2.ledger).toBe("object");
  });

  it("derive_predicates returns derivePredicates(store) for a seeded store", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    // Seed a goal in `building` plus a DAG-ready `planned` task linked to it,
    // so pImplement is TRUE-and-unblocked (a non-trivial verdict to compare).
    await callTool(tools, "create_milestone", { title: "pred-test" });
    const goal = decode<{ item: { id: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "goals",
        milestone_id: "M1",
        status: "building",
        fields: { title: "ship it", description: "the goal" },
      }),
    );
    await callTool(tools, "create_item", {
      ledger_id: "tasks",
      milestone_id: "M1",
      status: "planned",
      fields: { headline: "do the work", ledgerRefs: [`goals:${goal.item.id}`] },
    });
    // Seed an open research too, so pResearch is also TRUE-and-unblocked.
    const research = decode<{ item: { id: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "researches",
        milestone_id: "M1",
        status: "open",
        fields: { question: "does this need a research?" },
      }),
    );

    // The tool's output must equal the shared derivePredicates(store) directly.
    const expected = derivePredicates(store);
    const actual = decode<DerivedPredicates>(
      await callTool(tools, "derive_predicates", {}),
    );
    expect(actual).toEqual(expected);

    // And the seeded task makes pImplement TRUE, naming that task id.
    expect(actual.pImplement.value).toBe(true);
    expect(actual.pImplement.items.length).toBe(1);
    // And the seeded research makes pResearch TRUE, naming that research id.
    expect(actual.pResearch.value).toBe(true);
    expect(actual.pResearch.items).toEqual([research.item.id]);
  });

  it("reopen_item moves a terminal item to a non-terminal status", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await callTool(tools, "create_milestone", { title: "r" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "done",
      fields: { note: "accidentally done" },
    });

    const reopened = decode<{ item: { id: string; status: string } }>(
      await callTool(tools, "reopen_item", {
        ledger_id: "xenos",
        item_id: "X1",
        to_status: "open",
      }),
    );
    expect(reopened.item.status).toBe("open");
    expect(reopened.item.id).toBe("X1");
  });

  it("reopen_item rejects an invalid (terminal) target status", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await callTool(tools, "create_milestone", { title: "r" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "done",
      fields: {},
    });

    await expect(
      callTool(tools, "reopen_item", {
        ledger_id: "xenos",
        item_id: "X1",
        to_status: "done",
      }),
    ).rejects.toThrow();
  });

  it("unarchive_item restores a single item from a milestone-group archive", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await callTool(tools, "create_milestone", { title: "arch" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "done",
      fields: { note: "to be archived" },
    });
    await callTool(tools, "update_milestone", { milestone_id: "M1", status: "done" });
    await callTool(tools, "archive_milestone", { milestone_id: "M1", summary: "archived" });

    // Item is gone from active ledger after archiving.
    const snap = decode<{ ledger: Record<string, unknown> }>(
      await callTool(tools, "snapshot", {}),
    );
    expect(snap.ledger["xenos"]).toBeUndefined();

    const restored = decode<{ item: { id: string; status: string } }>(
      await callTool(tools, "unarchive_item", {
        ledger_id: "xenos",
        milestone_id: "M1",
        item_id: "X1",
      }),
    );
    expect(restored.item.id).toBe("X1");
    expect(restored.item.status).toBe("done");
  });

  it("unarchive_item rejects an unknown archive group", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await expect(
      callTool(tools, "unarchive_item", {
        ledger_id: "xenos",
        milestone_id: "M99",
        item_id: "X1",
      }),
    ).rejects.toThrow();
  });

  it("reopen_item and unarchive_item do not declare author/session params", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    for (const name of ["reopen_item", "unarchive_item"]) {
      const t = tools.find((x) => x.name === name);
      if (t === undefined) throw new Error(`tool not found: ${name}`);
      expect(Object.keys(t.inputSchema)).not.toContain("author");
      expect(Object.keys(t.inputSchema)).not.toContain("session");
    }
  });

  it("get_agent_models without config capability throws the documented not-implemented error", async () => {
    const store = await buildStore();
    // No configCapability supplied -> the in-memory store has no cq.toml-capable root.
    const tools = createLedgerMcpTools(store);
    await expect(
      callTool(tools, "get_agent_models", {}),
    ).rejects.toThrow(/not implemented/i);
  });
});
