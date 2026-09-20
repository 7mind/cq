import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  // Keep only entries backed by a live `.failing` marker and its annotation.
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title:
      "cancelled unenrolled recovery workers retain fresh receipts across exact manual guarded successors",
    ledgerRef: "tasks:T6576",
  },
];
