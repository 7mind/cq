import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  // Keep only entries backed by a live `.failing` marker and its annotation.
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/postgres-operation-row-locks.test.ts",
    title: "postgres operation kernel locks only its declared closure",
    ledgerRef: "tasks:T5917",
  },
];
