import { materializeOperatorAction, recordProtectedImplementationCompletion, supersedeOperatorAction } from "../src/index.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { registerLifecycleProjectionFaults } from "./lifecycleCoherenceFixture.js";
import { LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

for (const operation of ["materialize", "materialized-supersede", "unmaterialized-supersede", "protected-completion"] as const) {
  registerLifecycleProjectionFaults(operation, async ({ store }) => {
    await seedDirectOwnedTasks(store);
    if (operation === "materialize") return { invoke: () => materializeOperatorAction(store, DIRECT_OPERATOR_INPUT), documents: ["operatorActions:OA1", "handoffs:HO1"], privateKeys: [] };
    if (operation === "protected-completion") {
      const completion = await directCompletionRecord();
      return { invoke: () => recordProtectedImplementationCompletion(store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE),
        documents: ["tasks:T2345", "reviews:R2345", "defects:D1", "defects:D4"], privateKeys: [] };
    }
    if (operation === "materialized-supersede") await materializeOperatorAction(store, DIRECT_OPERATOR_INPUT);
    return { invoke: () => supersedeOperatorAction(store, DIRECT_SUPERSEDE_INPUT),
      documents: operation === "materialized-supersede" ? ["operatorActions:OA1", "tasks:T1"] : ["tasks:T1"], privateKeys: [] };
  });
}
