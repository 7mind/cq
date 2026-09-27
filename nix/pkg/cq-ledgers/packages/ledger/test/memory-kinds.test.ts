/**
 * G192/T6627 — the shared memory-kind resolver and its MCP-visible behavior.
 *
 * Backend parity for reads, mutations, restart, and restore lives in the
 * shared contract (`memoryKindStoreContract.ts`); this file pins the resolver
 * itself and the create/update/search surface agents use.
 */

import { describe, expect, it } from "bun:test";
import {
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  UnsupportedMemoryKindError,
  createLedgerMcpTools,
  isMemoryKind,
  resolveMemoryKind,
  type Item,
} from "../src/index.js";

const TS = "2026-03-04T05:06:07.000Z";

function memory(fields: Item["fields"]): Item {
  return {
    id: "MEM7",
    milestoneId: MILESTONES_AMBIENT_ID,
    status: "active",
    fields: { title: "t", content: "c", ...fields },
    createdAt: TS,
    updatedAt: TS,
  };
}

type Tools = ReturnType<typeof createLedgerMcpTools>;

async function callTool<T>(tools: Tools, name: string, args: Record<string, unknown>): Promise<T> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool not found: ${name}`);
  const result = (await tool.handler(args as never, null)) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error(`${name} returned no text block`);
  return JSON.parse(text) as T;
}

describe("resolveMemoryKind", () => {
  it("materializes an absent kind as fact on a copy without touching the input", () => {
    const legacy = memory({});
    const resolved = resolveMemoryKind(MEMORIES_LEDGER, legacy);
    expect(resolved.fields["kind"]).toBe("fact");
    expect(resolved).not.toBe(legacy);
    expect(legacy.fields["kind"]).toBeUndefined();
    expect({ ...resolved, fields: { ...resolved.fields, kind: undefined } }).toEqual({
      ...legacy,
      fields: { ...legacy.fields, kind: undefined },
    });
  });

  it("returns a closed kind unchanged", () => {
    for (const kind of ["fact", "rule", "environment"]) {
      const item = memory({ kind });
      expect(resolveMemoryKind(MEMORIES_LEDGER, item)).toBe(item);
    }
  });

  it("rejects an unsupported scalar or array kind with the offending item and value", () => {
    expect(() => resolveMemoryKind(MEMORIES_LEDGER, memory({ kind: "opinion" }))).toThrow(
      UnsupportedMemoryKindError,
    );
    expect(() => resolveMemoryKind(MEMORIES_LEDGER, memory({ kind: ["fact"] }))).toThrow(
      UnsupportedMemoryKindError,
    );
    try {
      resolveMemoryKind(MEMORIES_LEDGER, memory({ kind: "FACT" }));
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedMemoryKindError);
      expect((error as UnsupportedMemoryKindError).itemId).toBe("MEM7");
      expect((error as UnsupportedMemoryKindError).value).toBe("FACT");
    }
  });

  it("leaves items outside the memories ledger untouched", () => {
    const task = { ...memory({ kind: "anything" }), id: "T1" };
    expect(resolveMemoryKind(TASKS_LEDGER, task)).toBe(task);
  });

  it("isMemoryKind admits exactly the closed set", () => {
    expect(["fact", "rule", "environment"].every(isMemoryKind)).toBe(true);
    expect(["", "Fact", "opinion", undefined, 1, ["fact"]].some(isMemoryKind)).toBe(false);
  });
});

describe("memory kinds through the MCP tool surface", () => {
  async function tools(): Promise<{ store: InMemoryLedgerStore; tools: Tools }> {
    const store = new InMemoryLedgerStore();
    await store.init();
    return { store, tools: createLedgerMcpTools(store) };
  }

  it("create_item without kind stores fact; explicit kinds round-trip; kind is FTS-filterable", async () => {
    const { store, tools: surface } = await tools();
    try {
      const create = async (title: string, kind: string | null) =>
        (
          await callTool<{ item: { id: string } }>(surface, "create_item", {
            ledger_id: MEMORIES_LEDGER,
            milestone_id: MILESTONES_AMBIENT_ID,
            status: "active",
            fields: { title, content: `${title} body`, ...(kind === null ? {} : { kind }) },
          })
        ).item;
      const omitted = await create("omitted memory", null);
      const rule = await create("rule memory", "rule");
      const environment = await create("environment memory", "environment");

      const fetched = await callTool<{ item: Item }>(surface, "fetch_item", {
        ledger_id: MEMORIES_LEDGER,
        item_id: omitted.id,
        projection: "full",
      });
      expect(fetched.item.fields["kind"]).toBe("fact");

      const byKind = async (kind: string): Promise<string[]> =>
        (await store.ftsSearch(`kind:${kind}`, { ledger: MEMORIES_LEDGER })).map(
          ({ item }) => item.id,
        );
      expect(await byKind("fact")).toEqual([omitted.id]);
      expect(await byKind("rule")).toEqual([rule.id]);
      expect(await byKind("environment")).toEqual([environment.id]);
    } finally {
      await store.dispose();
    }
  });

  it("create_item and update_item reject an unsupported kind", async () => {
    const { store, tools: surface } = await tools();
    try {
      await expect(
        callTool(surface, "create_item", {
          ledger_id: MEMORIES_LEDGER,
          milestone_id: MILESTONES_AMBIENT_ID,
          status: "active",
          fields: { title: "bad", content: "bad body", kind: "opinion" },
        }),
      ).rejects.toThrow(UnsupportedMemoryKindError);
      const { item: created } = await callTool<{ item: { id: string } }>(surface, "create_item", {
        ledger_id: MEMORIES_LEDGER,
        milestone_id: MILESTONES_AMBIENT_ID,
        status: "active",
        fields: { title: "good", content: "good body", kind: "rule" },
      });
      await expect(
        callTool(surface, "update_item", {
          ledger_id: MEMORIES_LEDGER,
          item_id: created.id,
          fields: { kind: "opinion" },
        }),
      ).rejects.toThrow(UnsupportedMemoryKindError);
      expect(store.fetchItem(MEMORIES_LEDGER, created.id).fields["kind"]).toBe("rule");
    } finally {
      await store.dispose();
    }
  });
});
