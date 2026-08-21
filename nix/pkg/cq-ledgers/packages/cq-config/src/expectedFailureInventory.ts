import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/worktreeTerminalReleaseXdg.test.ts",
    title: "releases a merged terminal task while restrictive roots remain stable",
    ledgerRef: "tasks:T2234",
  },
];
