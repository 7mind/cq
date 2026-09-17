import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/ledger-mcp/test/implementation-evidence-runtime.test.ts",
    title:
      "D491 production verification authenticates transient receipt paths independently of the net diff [Behavioral-Active Effectual-GoodCommunication]",
    ledgerRef: "tasks:T6571",
  },
  {
    file: "nix/pkg/cq-ledgers/packages/ledger/test/gitChangeBroker.test.ts",
    title:
      "D491 accepts authentic modify/restore and add/remove receipt histories with an empty net diff [Behavioral-Active Effectual-GoodCommunication]",
    ledgerRef: "tasks:T6571",
  },
];
