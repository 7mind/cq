/**
 * Runs the abstract LedgerStore suite against InMemoryLedgerStore (dummy).
 */

import {
  InMemoryLedgerStore,
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
