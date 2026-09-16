import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/worksetCoordinationBundleContract.ts",
    title: "retains the exact owned live goal after consuming the root idea",
    ledgerRef: "tasks:T6565",
  },
];
