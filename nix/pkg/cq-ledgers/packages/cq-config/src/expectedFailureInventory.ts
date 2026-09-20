import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title:
      "a cancelled sealed recovery successor composes into an ordinary consumed continuation",
    ledgerRef: "tasks:T6575",
  },
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title:
      "a cancelled sealed recovery successor composes into an authenticated guarded rebase",
    ledgerRef: "tasks:T6575",
  },
  // Keep only entries backed by a live `.failing` marker and its annotation.
];
