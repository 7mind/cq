import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  // Keep only entries backed by a live `.failing` marker and its annotation.
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/postgres-generic-mutation-scaling.test.ts",
    title: "postgres generic mutation uses keyed operation plans",
    ledgerRef: "tasks:T5923",
  },
];
