import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/dispatchRecoverySeal.test.ts",
    title: "sealed recovery selects its exact authenticated source bridge",
    ledgerRef: "tasks:T6573",
  },
];
