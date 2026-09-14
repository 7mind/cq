import { expect, test } from "bun:test";
import { materializeOperatorAction, recordProtectedImplementationCompletion, supersedeOperatorAction } from "../src/index.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { lifecycleCoherenceFixture } from "./lifecycleCoherenceFixture.js";
import { LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

for (const materialized of [true, false]) {
  test(`direct consumers project only changed action/handoff/task/review/named defects (materialized=${materialized}) [T5547]`, async () => {
    const fixture = await lifecycleCoherenceFixture();
    const { store, capture } = fixture;
    try {
      await seedDirectOwnedTasks(store);
      if (materialized) {
        await capture(() => materializeOperatorAction(store, DIRECT_OPERATOR_INPUT), ["operatorActions:OA1", "handoffs:HO1"], []);
        await capture(() => materializeOperatorAction(store, DIRECT_OPERATOR_INPUT), [], []);
      }
      await capture(() => supersedeOperatorAction(store, DIRECT_SUPERSEDE_INPUT), materialized ? ["operatorActions:OA1", "tasks:T1"] : ["tasks:T1"], []);
      await capture(() => supersedeOperatorAction(store, DIRECT_SUPERSEDE_INPUT), [], []);
      const completion = await directCompletionRecord();
      await capture(() => recordProtectedImplementationCompletion(store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE),
        ["tasks:T2345", "reviews:R2345", "defects:D1", "defects:D4"], []);
      await capture(() => recordProtectedImplementationCompletion(store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE), [], []);
      expect(fixture.peer.fetchItem("tasks", "T2345").status).toBe("done");
      expect(fixture.peer.fetchItem("defects", "D90000").status).toBe("root-caused");
    } finally { await fixture.dispose(); }
  });
}
