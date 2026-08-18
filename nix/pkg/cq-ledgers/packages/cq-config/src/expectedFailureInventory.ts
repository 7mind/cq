import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

const ARCHIVE_INVARIANT_FILE =
  "nix/pkg/cq-ledgers/packages/ledger/test/archive-dependency-invariants.test.ts";
const DISPATCH_CAPABILITY_FILE =
  "nix/pkg/cq-ledgers/packages/ledger-mcp/test/gitChangeDispatchCapability.test.ts";

export const EXPECTED_FAILURE_INVENTORY: readonly ExpectedFailureInventoryEntry[] = [
  {
    file: ARCHIVE_INVARIANT_FILE,
    title:
      "A: archive refuses while an active nonterminal incoming dependsOn targets a non-satisfying item",
    ledgerRef: "tasks:T826",
  },
  {
    file: ARCHIVE_INVARIANT_FILE,
    title:
      "B: newly-added dependsOn on an archived non-satisfying target rejects (create/update, bare/canonical)",
    ledgerRef: "tasks:T826",
  },
  {
    file: ARCHIVE_INVARIANT_FILE,
    title:
      "C: reopening a dependent with a retained gate on an archived non-satisfying target rejects until the gate is removed",
    ledgerRef: "tasks:T826",
  },
  {
    file: ARCHIVE_INVARIANT_FILE,
    title:
      "race ordering (reopen → archive): the archive refuses once the dependent is active again",
    ledgerRef: "tasks:T826",
  },
  {
    file: ARCHIVE_INVARIANT_FILE,
    title:
      "race ordering (archive → reopen): the reopen refuses while the gate is retained",
    ledgerRef: "tasks:T826",
  },
  {
    file: ARCHIVE_INVARIANT_FILE,
    title:
      "race (barrier-concurrent): exactly one of reopen/archive refuses — never an active dependent on an archived non-satisfying target",
    ledgerRef: "tasks:T826",
  },
  {
    file: DISPATCH_CAPABILITY_FILE,
    title:
      "D332 rejects a lineage-free implement-worker retry at an advanced managed-worktree tip [Behavioral-Progression Blackbox-GoodCommunication]",
    ledgerRef: "defects:D332",
  },
  {
    file: DISPATCH_CAPABILITY_FILE,
    title:
      "D334 accepts an exact guarded-rebase continuation after broker restart [Behavioral-Progression Blackbox-GoodCommunication]",
    ledgerRef: "defects:D334",
  },
];
