import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  // Keep only entries backed by a live `.failing` marker and its annotation.
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/postgres-coherence-scaling.test.ts",
    title: "postgres lifecycle projection is invariant to unrelated volume",
    ledgerRef: "tasks:T5924",
  },
];
