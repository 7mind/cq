import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title: "a consumed pass followed by a rejected continuation admits its changed correction",
    ledgerRef: "tasks:T6575",
  },
  {
    file: "packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title: "a cancelled sealed recovery successor retains prior terminal queue ancestry",
    ledgerRef: "tasks:T6575",
  },
];
