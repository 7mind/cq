/**
 * Runs the abstract LedgerStore suite against InMemoryLedgerStore (dummy).
 */

import { describe, expect, it } from "bun:test";
import {
  InMemoryLedgerStore,
  UnsupportedMemoryKindError,
  createWorksetManagementLedger,
  parseBackupDump,
  type FieldValue,
  type Item,
  type Ledger,
  type LedgerSchema,
  type LedgerStore,
  type Milestone,
} from "../src/index.js";
import { runStoreAbstractSuite } from "./store-abstract.js";
import type { MemoryKindPhysicalFixture, StoredItemTarget } from "./memoryKindStoreContract.js";

const MEMORIES = "memories";
const UNSUPPORTED_KIND = "opinion";

/** The dummy's native representation: its private ledger and archive maps. */
interface InMemoryNativeState {
  readonly ledgers: Map<string, Ledger>;
  readonly archives: Map<string, Milestone>;
}

function nativeItem(store: LedgerStore, target: StoredItemTarget): Item {
  const native = store as unknown as InMemoryNativeState;
  const groups = target.archived
    ? [...native.archives].filter(([key]) => key.startsWith(`${MEMORIES}/`)).map(([, group]) => group)
    : (native.ledgers.get(MEMORIES)?.milestones ?? []);
  for (const group of groups) {
    for (const item of group.items) if (item.id === target.itemId) return item;
  }
  throw new Error(`in-memory memory ${target.itemId} (archived=${target.archived}) not found`);
}

const memoryKindFixture: MemoryKindPhysicalFixture = {
  async readStoredFields(store, target) {
    return structuredClone(nativeItem(store, target).fields);
  },
  async writeStoredFields(store, target, fields: Record<string, FieldValue>) {
    nativeItem(store, target).fields = structuredClone(fields);
    return store;
  },
  // The dummy has no persistence boundary; its only "restart" keeps its state.
  async restart(store) {
    return store;
  },
  async restoreInto(store, dump) {
    try {
      await (store as InMemoryLedgerStore).replaceFromParsedDump(parseBackupDump(dump));
      return { store, error: null };
    } catch (error) {
      return { store, error };
    }
  },
};

runStoreAbstractSuite({
  name: "InMemoryLedgerStore",
  async build(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<LedgerStore> {
    const store = new InMemoryLedgerStore({ seed });
    await store.init();
    return store;
  },
  async buildWithHook(
    seed: Array<{ name: string; schema: LedgerSchema }>,
    onMutation: (ledgerId: string, op: "create" | "update" | "archive") => void,
  ): Promise<LedgerStore> {
    const store = new InMemoryLedgerStore({ seed, onMutation });
    await store.init();
    return store;
  },
  async teardown(store: LedgerStore): Promise<void> {
    await store.dispose();
  },
  memoryKind: memoryKindFixture,
});

describe("InMemoryLedgerStore memory-kind archival notifications (G192/T6627)", () => {
  it("fires no mutation notification when an unsupported memory kind rejects an archive", async () => {
    const events: string[] = [];
    const store = new InMemoryLedgerStore({
      onMutation: (ledgerId, op) => events.push(`${ledgerId}/${op}`),
    });
    await store.init();
    try {
      const milestone = await store.createMilestone({ title: "memory milestone" });
      await store.updateMilestone(milestone.id, { status: "done" });
      const memories = (store as unknown as InMemoryNativeState).ledgers.get(MEMORIES);
      if (memories === undefined) throw new Error("in-memory store lacks memories");
      memories.milestones.push({
        id: milestone.id,
        title: "",
        description: "",
        items: [
          {
            id: "MEM91",
            milestoneId: milestone.id,
            status: "superseded",
            fields: { title: "milestone memory", content: "body", kind: UNSUPPORTED_KIND },
            createdAt: milestone.createdAt,
            updatedAt: milestone.createdAt,
          },
        ],
      });
      events.length = 0;

      await expect(store.archiveMilestone(milestone.id, "archive")).rejects.toThrow(
        UnsupportedMemoryKindError,
      );
      await expect(
        createWorksetManagementLedger({ rawStore: store, worksetStore: store.worksetStore() })
          .mutations.archiveTerminalItems([MEMORIES], "sweep", "fail-on-active-gate"),
      ).rejects.toThrow(UnsupportedMemoryKindError);
      expect(events).toEqual([]);
      expect(nativeItem(store, { itemId: "MEM91", archived: false }).fields.kind).toBe(UNSUPPORTED_KIND);
    } finally {
      await store.dispose();
    }
  });
});
