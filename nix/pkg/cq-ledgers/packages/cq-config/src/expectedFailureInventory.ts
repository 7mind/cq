import type { ExpectedFailureInventoryEntry } from "./expectedFailurePolicy.js";

const ARCHIVE_INVARIANT_FILE =
  "nix/pkg/cq-ledgers/packages/ledger/test/archive-dependency-invariants.test.ts";
const SUPERVISED_GATE_STORAGE_FILE =
  "nix/pkg/cq-ledgers/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts";

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
    file: SUPERVISED_GATE_STORAGE_FILE,
    title:
      "D342 worktree settlement rejection still settles the registered root once and retains the deadline cause",
    ledgerRef: "defects:D342",
  },
  {
    file: SUPERVISED_GATE_STORAGE_FILE,
    title:
      "D342 registered-root settlement rejection retains the deadline cause after both arms settle once",
    ledgerRef: "defects:D342",
  },
  {
    file: SUPERVISED_GATE_STORAGE_FILE,
    title:
      "D342 direct-root survivors remain a concrete identifier list alongside the deadline cause",
    ledgerRef: "defects:D342",
  },
  {
    file: SUPERVISED_GATE_STORAGE_FILE,
    title:
      "D342 rejecting both settlement arms retains both bounded diagnostics and the deadline cause",
    ledgerRef: "defects:D342",
  },
];
