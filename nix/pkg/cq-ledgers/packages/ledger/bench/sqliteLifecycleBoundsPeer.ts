import { strict as assert } from "node:assert";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { createWorkerSearchProjection } from "../src/search/WorkerSearchProjection.js";
import { SEARCH_PROJECTION_COMMAND_DEADLINE_MS } from "../src/search/SearchProjection.js";
import { lifecycleProjectionEffects, type LifecycleProjectionEffect } from "../test/lifecycleBoundsMeasurement.js";

const dbPath = process.argv[2];
assert(dbPath !== undefined, "missing peer database path");
const projectionEffects: LifecycleProjectionEffect[] = [];
const store = new SqliteLedgerStore({ dbPath, searchProjectionFactory: () => {
  const projection = createWorkerSearchProjection(SEARCH_PROJECTION_COMMAND_DEADLINE_MS);
  return {
    execute: (command) => { projectionEffects.push(...lifecycleProjectionEffects(command)); return projection.execute(command); },
    health: () => projection.health(),
  };
} });
await store.init();
try {
  projectionEffects.length = 0;
  console.log("ready");
  const request = JSON.parse(await Bun.stdin.text()) as { afterVersion: number };
  assert(Number.isSafeInteger(request.afterVersion) && request.afterVersion >= 0);
  const started = performance.now();
  const hits = await store.ftsSearch("keyed lifecycle");
  const elapsedMs = performance.now() - started;
  const frame = store.readCoherenceChanges(request.afterVersion);
  console.log(JSON.stringify({ elapsedMs, hits: hits.map(({ ledgerId, item }) => ({ ledgerId, id: item.id, status: item.status })),
    coherence: frame.entries.map(({ ledger, documentId, scope, kind }) => ({ ledger, documentId, scope, kind })), projectionEffects }));
} finally { await store.dispose(); }
