/**
 * Runs the abstract LedgerStore suite against InMemoryLedgerStore (dummy).
 */

import { InMemoryLedgerStore, type LedgerSchema, type LedgerStore } from "../src/index.js";
import { runStoreAbstractSuite } from "./store-abstract.js";

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
});
