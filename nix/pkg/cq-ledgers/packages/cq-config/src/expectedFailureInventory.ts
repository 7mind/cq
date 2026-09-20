import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/current-recovery-seal-journal.test.ts",
    title:
      "retained v1 and v2 recovery journals preserve absent and explicit-null guarded transitions",
    ledgerRef: "tasks:T6576",
  },
];
