/**
 * G192/T6627 — the shared memory-kind resolver and its MCP-visible behavior.
 *
 * Backend parity for reads, mutations, restart, and restore lives in the
 * shared contract (`memoryKindStoreContract.ts`); this file pins the resolver
 * itself and the create/update/search surface agents use.
 */

import { describe, expect, it } from "bun:test";
import {
  DECISIONS_LEDGER,
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MEMORIES_SCHEMA,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  UnsupportedMemoryKindError,
  createLedgerMcpTools,
  isMemoryKind,
  resolveMemoryKind,
  type Item,
  type Ledger,
} from "../src/index.js";
import { createGenericMutationTransaction } from "../src/store/genericMutationTransaction.js";
import { createOwnedWriteTransaction } from "../src/store/ownedWriteTransaction.js";
import { applyDetachMilestoneGroup } from "../src/store/core.js";

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

describe("transaction reads resolve the memory kind like the public read", () => {
  function legacyLedgers(): Map<string, Ledger> {
    const legacy = memory({});
    const ledger: Ledger = {
      id: MEMORIES_LEDGER,
      schema: MEMORIES_SCHEMA,
      counters: { milestone: 0, item: 7 },
      milestones: [{ id: MILESTONES_AMBIENT_ID, title: "", description: "", items: [legacy] }],
      archivePointers: [],
    };
    return new Map([[MEMORIES_LEDGER, ledger]]);
  }

  function storedKind(ledgers: Map<string, Ledger>): unknown {
    return ledgers.get(MEMORIES_LEDGER)?.milestones[0]?.items[0]?.fields.kind;
  }

  it("generic and owned transactions return semantic fact without writing it", () => {
    const generic = legacyLedgers();
    const genericTx = createGenericMutationTransaction({
      ledgers: generic,
      archives: new Map(),
      unloadedArchiveKeys: new Set(),
      now: () => TS,
    }).tx;
    expect(genericTx.fetchItem(MEMORIES_LEDGER, "MEM7").fields.kind).toBe("fact");
    expect(storedKind(generic)).toBeUndefined();

    const owned = legacyLedgers();
    const ownedTx = createOwnedWriteTransaction({ ledgers: owned, now: () => TS }).tx;
    expect(ownedTx.fetchItem(MEMORIES_LEDGER, "MEM7").fields.kind).toBe("fact");
    expect(storedKind(owned)).toBeUndefined();
  });

  /**
   * A completed milestone with a terminal decision (ordered before memories)
   * and an unsupported terminal memory, plus an unsupported ambient memory.
   * Returned as a plain map: the shared transaction itself, not a backend
   * rollback, must leave it untouched on rejection.
   */
  async function unsupportedArchiveState(): Promise<{ ledgers: Map<string, Ledger>; milestoneId: string }> {
    const store = new InMemoryLedgerStore();
    await store.init();
    const milestone = await store.createMilestone({ title: "archive" });
    const decision = await store.createItem(DECISIONS_LEDGER, milestone.id, {
      status: "proposed",
      fields: { headline: "sibling" },
    });
    await store.updateItem(DECISIONS_LEDGER, decision.id, { status: "superseded" });
    await store.updateMilestone(milestone.id, { status: "done" });
    const ledgers = structuredClone((store as unknown as { ledgers: Map<string, Ledger> }).ledgers);
    await store.dispose();
    const memories = ledgers.get(MEMORIES_LEDGER);
    if (memories === undefined) throw new Error("state lacks memories");
    const unsupported = (id: string, milestoneId: string): Item => ({
      ...memory({ kind: "opinion" }),
      id,
      milestoneId,
      status: "superseded",
    });
    memories.milestones.push(
      { id: MILESTONES_AMBIENT_ID, title: "", description: "", items: [unsupported("MEM1", MILESTONES_AMBIENT_ID)] },
      { id: milestone.id, title: "", description: "", items: [unsupported("MEM2", milestone.id)] },
    );
    return { ledgers, milestoneId: milestone.id };
  }

  it("the shared transaction rejects an unsupported archival kind before any effect", async () => {
    const { ledgers, milestoneId } = await unsupportedArchiveState();
    const before = structuredClone(ledgers);
    const transaction = createGenericMutationTransaction({
      ledgers,
      archives: new Map(),
      unloadedArchiveKeys: new Set(),
      now: () => TS,
    });
    expect(() =>
      transaction.tx.archiveTerminalItems(
        [DECISIONS_LEDGER, MEMORIES_LEDGER],
        "sweep",
        "retain-active-gates",
      ),
    ).toThrow(UnsupportedMemoryKindError);
    expect(ledgers).toEqual(before);
    expect(() => transaction.tx.archiveMilestone(milestoneId, "archive")).toThrow(
      UnsupportedMemoryKindError,
    );
    expect(ledgers).toEqual(before);
    expect(transaction.dirtyLedgers.size).toBe(0);
    expect(transaction.dirtyArchives.size).toBe(0);
  });

  it("applyDetachMilestoneGroup rejects an unsupported kind before detaching the group", async () => {
    const { ledgers, milestoneId } = await unsupportedArchiveState();
    const memories = ledgers.get(MEMORIES_LEDGER);
    if (memories === undefined) throw new Error("state lacks memories");
    const before = structuredClone(memories);
    expect(() =>
      applyDetachMilestoneGroup(memories, milestoneId, "archive", "./archive/memories/x.md", "", ""),
    ).toThrow(UnsupportedMemoryKindError);
    expect(memories).toEqual(before);
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
