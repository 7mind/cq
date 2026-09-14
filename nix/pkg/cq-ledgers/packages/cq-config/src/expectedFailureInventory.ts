import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  // Keep only entries backed by a live `.failing` marker and its annotation.
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/sqlite-lifecycle-coherence.test.ts",
    title: "sqlite lifecycle projection applies only exact changed documents",
    ledgerRef: "tasks:T5547",
  },
];
