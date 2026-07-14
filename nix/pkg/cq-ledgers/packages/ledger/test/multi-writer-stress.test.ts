/**
 * T497/T531 — multi-writer concurrency contract, LIVE against SqliteLedgerStore.
 *
 * The contract lives on the seam types (src/store/LedgerPersistence.ts,
 * "Multi-writer concurrency contract"; src/store/LedgerStore.ts,
 * "Cross-process concurrency"). The store-factory-parameterized stress
 * harness lives in multiWriterStressHarness.ts.
 *
 * T531 flips this from `test.todo` to a live run: `SqliteLedgerStore` (K102
 * bun:sqlite, WAL + busy_timeout, T525-T528) is the first store conforming to
 * the T497 multi-writer contract, wired here via `sqliteWriterStore.ts`
 * ({@link WriterStoreModule}). `FsLedgerStore` still gives no cross-process
 * no-lost-update guarantee, so it stays unwired.
 */

import { describe, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  runMultiWriterStress,
  type MultiWriterStoreFactory,
} from "./multiWriterStressHarness.js";
import { createStore } from "./sqliteWriterStore.js";

const SQLITE_WRITER_STORE_MODULE = fileURLToPath(new URL("./sqliteWriterStore.ts", import.meta.url));

function sqliteMultiWriterStoreFactory(): MultiWriterStoreFactory {
  return {
    writerStoreModule: SQLITE_WRITER_STORE_MODULE,
    createStore,
  };
}

describe("multi-writer concurrency contract (T497/T531)", () => {
  test(
    ">= 2 writer processes over one shared SqliteLedgerStore — zero lost updates, zero parse/read failures",
    async () => {
      await runMultiWriterStress(sqliteMultiWriterStoreFactory(), {
        writers: 2,
        opsPerWriter: 20,
      });
    },
    30_000,
  );
});
