import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: "nix/pkg/cq-ledgers/packages/cq-config/test/codexRoleBoundary.test.ts",
    title:
      "installed runner hands off a retired staged-rebase conflict without retrying revoked parent authority [Behavioral-Active Blackbox Good-Communication]",
    ledgerRef: "tasks:T6573",
  },
];
