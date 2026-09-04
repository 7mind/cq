import { runWorksetGitEffectGate, type WorksetGitEffectBinding } from "@cq/process-control";
import {
  SqliteLedgerStore,
  worksetEffectAdmissionProviderFromStore,
} from "../src/index.js";

const repositoryRoot = process.argv[2];
const worktreePath = process.argv[3];
const ontoCommit = process.argv[4];
const dbPath = process.argv[5];
if (
  repositoryRoot === undefined ||
  worktreePath === undefined ||
  ontoCommit === undefined ||
  dbPath === undefined
) {
  throw new Error("workset Git effect broker child: incomplete arguments");
}

const binding: WorksetGitEffectBinding = {
  kind: "rebase",
  targetRef: "tasks:T1984",
  repositoryRoot,
  worktreePath,
  ontoCommit,
};
const ledger = new SqliteLedgerStore({ dbPath });
await ledger.init();
try {
  await runWorksetGitEffectGate({
    expected: binding,
    resolve: async () => binding,
    provider: worksetEffectAdmissionProviderFromStore(ledger.worksetStore()),
    settlement: { termGraceMs: 10, killGraceMs: 1_000, pollIntervalMs: 2 },
  });
} finally {
  await ledger.dispose();
}
