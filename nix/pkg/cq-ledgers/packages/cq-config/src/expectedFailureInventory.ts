import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title: "parent-lost ordinary continuation retains authenticated repeated guarded transitions",
    ledgerRef: "tasks:T6580",
  },
];
