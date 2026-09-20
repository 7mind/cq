import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/dispatchRecoverySeal.test.ts",
    title:
      "a staged-retired consumed recovery intermediate admits its ordinary cancelled successor",
    ledgerRef: "tasks:T6576",
  },
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title:
      "a staged-retired recovery source and its cancelled guarded successor advance the current seal",
    ledgerRef: "tasks:T6576",
  },
];
