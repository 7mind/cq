/**
 * sqliteWriterStore — the T497 {@link WriterStoreModule} for `SqliteLedgerStore`
 * (T531 flip). Imported both in-process (as the `MultiWriterStoreFactory`'s
 * `createStore`, for the coordinator's seed + verification stores) and by each
 * writer SUBPROCESS via dynamic `import()` (`multiWriterStressWriter.ts`),
 * which calls `createStore(location)` directly — this module must therefore
 * stay import-safe outside `bun test` (no `bun:test` imports; see the harness
 * doc comment).
 *
 * `location` is the harness's ONE shared temp directory; every store instance
 * (coordinator + every writer) opens the SAME `<location>/ledger.db` file, so
 * WAL + busy_timeout (connection.ts) is the only thing serializing concurrent
 * writers — exactly the K102 cross-process contract this harness proves.
 */

import * as path from "node:path";
import type { LedgerStore } from "../src/index.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";

/** Fixed db filename inside the shared `location` directory. */
const DB_FILENAME = "ledger.db";

export async function createStore(location: string): Promise<LedgerStore> {
  const store = new SqliteLedgerStore({ dbPath: path.join(location, DB_FILENAME) });
  await store.init();
  return store;
}
