import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/managedDispatchRecovery.test.ts",
    title: "guarded-origin current recovery preserves its authenticated bridge and logical onto",
    ledgerRef: "tasks:T6573",
  },
];
