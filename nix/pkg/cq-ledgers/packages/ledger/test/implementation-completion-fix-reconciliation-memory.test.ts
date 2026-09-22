import { InMemoryLedgerStore } from "../src/index.js";
import { runImplementationCompletionFixReconciliationContract } from "./implementationCompletionFixReconciliationContract.js";

runImplementationCompletionFixReconciliationContract("strict in-memory", async () => {
  const store = new InMemoryLedgerStore();
  await store.init();
  return { store, dispose: async () => await store.dispose() };
});
