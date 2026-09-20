import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/guardedRebaseContinuation.test.ts",
    title:
      "independent guarded-rebase transactions select only their journal-bound receipt component",
    ledgerRef: "tasks:T6576",
  },
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title:
      "current-recovered staged retirement admits its exact guarded successor despite older terminal enrollment history",
    ledgerRef: "tasks:T6576",
  },
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title:
      "a staged-retired recovery source and its cancelled guarded successor advance the current seal",
    ledgerRef: "tasks:T6576",
  },
];
