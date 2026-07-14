/**
 * T497 — multi-writer concurrency contract, pending registration.
 *
 * The contract lives on the seam types (src/store/LedgerPersistence.ts,
 * "Multi-writer concurrency contract"; src/store/LedgerStore.ts,
 * "Cross-process concurrency"). The store-factory-parameterized stress
 * harness lives in multiWriterStressHarness.ts.
 *
 * NO conforming store exists in M210: FsLedgerStore guarantees no
 * cross-process no-lost-update semantics, and the K102 bun:sqlite primary
 * (WAL + busy_timeout) lands only in T498/M211. So the harness is registered
 * here as an EXPLICIT `test.todo` — reported as todo, never as a vacuous
 * green pass. T498 replaces the throwing factory below with its real store
 * factory and owns the PASSING run of this harness.
 */

import { describe, test } from "bun:test";
import {
  runMultiWriterStress,
  type MultiWriterStoreFactory,
} from "./multiWriterStressHarness.js";

/**
 * Placeholder factory: no conforming store exists yet. Throws with the T498
 * pointer, so even a `bun test --todo` run fails loudly instead of passing
 * vacuously.
 */
function pendingConformingStoreFactory(): MultiWriterStoreFactory {
  throw new Error(
    "pending T498: no store conforming to the T497 multi-writer contract exists in M210 " +
      "(FsLedgerStore gives no cross-process no-lost-update guarantee; the K102 bun:sqlite " +
      "primary store lands in T498, which wires its factory into runMultiWriterStress)",
  );
}

describe("multi-writer concurrency contract (T497)", () => {
  test.todo(
    "pending T498: >= 2 writer processes over one shared store — zero lost updates, zero parse/read failures",
    async () => {
      await runMultiWriterStress(pendingConformingStoreFactory(), {
        writers: 2,
        opsPerWriter: 20,
      });
    },
  );
});
