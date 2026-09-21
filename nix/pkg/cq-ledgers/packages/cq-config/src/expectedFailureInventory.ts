import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title: "parent cancelled ordinary after consumed guarded recapture memory",
    ledgerRef: "tasks:T6580",
  },
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title: "parent cancelled ordinary after consumed guarded recapture sqlite",
    ledgerRef: "tasks:T6580",
  },
  // Keep only entries backed by a live `.failing` marker and its annotation.
];
