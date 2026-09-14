import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  // Keep only entries backed by a live `.failing` marker and its annotation.
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/sqlite-owned-lifecycle-scaling.test.ts",
    title: "sqlite owned lifecycle uses admitted keyed rows",
    ledgerRef: "tasks:T5544",
  },
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/sqlite-direct-owned-lifecycle-scaling.test.ts",
    title: "sqlite direct owned lifecycle consumers use keyed row plans",
    ledgerRef: "tasks:T5545",
  },
];
