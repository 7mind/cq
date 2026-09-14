import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  // Keep only entries backed by a live `.failing` marker and its annotation.
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/dispatchRecoverySeal.test.ts",
    title: "a known red tip cannot recover through an older eligible source [Behavioral-Progression Blackbox-Group]",
    ledgerRef: "tasks:T6474",
  },
];
