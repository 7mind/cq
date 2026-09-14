import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  // Keep only entries backed by a live `.failing` marker and its annotation.
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/managedDispatchRecovery.test.ts",
    title:
      "clean receipt-backed missing-result returns current recovery authority [Behavioral-Progression Effectual-GoodCommunication]",
    ledgerRef: "tasks:T6473",
  },
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/managedDispatchRecovery.test.ts",
    title:
      "dirty receipt-backed missing-result preserves partial work and returns current recovery authority [Behavioral-Progression Effectual-GoodCommunication]",
    ledgerRef: "tasks:T6473",
  },
];
