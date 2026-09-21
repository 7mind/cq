import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/implementation-evidence-continuation.test.ts",
    title:
      "continues activation through an authenticated recovered receipt origin and guarded transition",
    ledgerRef: "tasks:T6580",
  },
  // Keep only entries backed by a live `.failing` marker and its annotation.
];
