import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts",
    title: "intentional worker failure is consumed without queue or gate side effects",
    ledgerRef: "tasks:T6575",
  },
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/dispatchRecoveryEpochPromotion.test.ts",
    title: "operator-cancelled journal successor promotes the committed recovery epoch",
    ledgerRef: "tasks:T6575",
  },
];
