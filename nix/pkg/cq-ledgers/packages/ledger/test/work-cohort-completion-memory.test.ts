import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { cohortCompletionTransactionContract } from "./cohortCompletionTransactionContract.js";
import { workCohortCompletionAsyncYieldContract, workCohortCompletionContract } from "./workCohortCompletionContract.js";

const fixture = async () => {
  const store = new InMemoryLedgerStore();
  await store.init();
  return { store, dispose: () => store.dispose() };
};
cohortCompletionTransactionContract("memory [Blackbox-Group]", fixture);
workCohortCompletionContract("memory [Blackbox-Group]", fixture);
workCohortCompletionAsyncYieldContract(fixture);
