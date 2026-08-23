import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/worktreeTerminalReleaseXdg.test.ts",
    title: "D350 retains an archived done task worktree when release can no longer read it",
    ledgerRef: "tasks:T2321",
  },
];
