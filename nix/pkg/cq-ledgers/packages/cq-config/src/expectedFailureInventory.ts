import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title:
      "a rejected correction composes through cancelled receipt recovery into a guarded continuation",
    ledgerRef: "tasks:T6573",
  },
];
