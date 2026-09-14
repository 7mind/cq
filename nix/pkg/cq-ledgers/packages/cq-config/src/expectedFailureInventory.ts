import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  // Keep only entries backed by a live `.failing` marker and its annotation.
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/postgres-workset-plan-lifecycle-scaling.test.ts",
    title: "postgres guarded plan lifecycle uses an exact affected closure",
    ledgerRef: "tasks:T5922",
  },
];
