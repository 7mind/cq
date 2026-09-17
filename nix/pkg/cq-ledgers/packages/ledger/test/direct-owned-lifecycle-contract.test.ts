import { expect, test } from "bun:test";
import {
  buildBackupDump,
  InMemoryLedgerStore,
  parseBackupDump,
  recordProtectedImplementationCompletion,
} from "../src/index.js";
import {
  DIRECT_TASK_AUTHORITY,
  directCompletionRecord,
  runDirectOwnedLifecycleContract,
  seedDirectOwnedTasks,
} from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

runDirectOwnedLifecycleContract("hand-written in-memory / Atomic", async () => {
  const store = new InMemoryLedgerStore({ now: () => LIFECYCLE_NOW });
  await store.init();
  await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "direct goal", description: "direct operations" } });
  return { store, dispose: () => store.dispose() };
});

const IN_MEMORY_REPLACEMENTS = [
  {
    name: "resetToBootstrap",
    replace: (store: InMemoryLedgerStore) => store.resetToBootstrap(),
  },
  {
    name: "dispose/init",
    replace: async (store: InMemoryLedgerStore) => {
      await store.dispose();
      await store.init();
    },
  },
  {
    name: "replaceFromParsedDump",
    replace: async (store: InMemoryLedgerStore) => {
      const source = new InMemoryLedgerStore({ now: () => LIFECYCLE_NOW });
      await source.init();
      try {
        await store.replaceFromParsedDump(parseBackupDump(await buildBackupDump(source, null)));
      } finally {
        await source.dispose();
      }
    },
  },
] as const;

for (const replacement of IN_MEMORY_REPLACEMENTS) {
  test(`D492 in-memory lifecycle: ${replacement.name} clears completion bindings with replaced public state`, async () => {
    const store = new InMemoryLedgerStore({ now: () => LIFECYCLE_NOW });
    try {
      await store.init();
      await store.createItem("goals", "M-AMBIENT", {
        id: "G1",
        status: "clarifying",
        fields: { title: "direct goal", description: "direct operations" },
      });
      await seedDirectOwnedTasks(store);
      const firstCompletion = await directCompletionRecord();
      await expect(recordProtectedImplementationCompletion(
        store,
        DIRECT_TASK_AUTHORITY,
        firstCompletion,
        LIFECYCLE_PROVENANCE,
      )).resolves.toEqual({ reviewRef: "reviews:R1" });

      await replacement.replace(store);
      await store.createItem("goals", "M-AMBIENT", {
        id: "G1",
        status: "clarifying",
        fields: { title: "replacement goal", description: "replacement state" },
      });
      await seedDirectOwnedTasks(store);
      const replacementCompletion = await directCompletionRecord();
      expect(await recordProtectedImplementationCompletion(
        store,
        DIRECT_TASK_AUTHORITY,
        replacementCompletion,
        LIFECYCLE_PROVENANCE,
      )).toEqual({ reviewRef: "reviews:R1" });
    } finally {
      await store.dispose();
    }
  });
}
