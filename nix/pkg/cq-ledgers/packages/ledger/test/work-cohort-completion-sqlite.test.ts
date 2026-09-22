import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { cohortCompletionTransactionContract } from "./cohortCompletionTransactionContract.js";
import { workCohortCompletionContract } from "./workCohortCompletionContract.js";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohort-completion-"));
  const store = new SqliteLedgerStore({ dbPath: join(directory, "ledger.db") });
  await store.init();
  return { store, dispose: async () => { await store.dispose(); await rm(directory, { recursive: true, force: true }); } };
};
cohortCompletionTransactionContract("SQLite [Blackbox-GoodCommunication]", fixture);
workCohortCompletionContract("SQLite [Blackbox-GoodCommunication]", fixture);
