import { expect, test } from "bun:test";
import { createTrustedWorksetManagementAuthority, createWorksetGuardedPlanLifecycleStore } from "../src/index.js";
import { LIFECYCLE_CLAIM_INPUT, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

// expected-failure: tasks:T5546
test.failing("sqlite guarded plan lifecycle uses an exact affected closure", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store } = fixture;
  const authorizationSnapshots: string[][] = [];
  try {
    await store.createItem("goals", "M-AMBIENT", { id: "G90000", status: "clarifying", fields: { title: "unrelated goal", description: "outside selected roots" } });
    await store.replaceWorksetRoots(["goals:G1"]);
    const guarded = createWorksetGuardedPlanLifecycleStore({
      rawStore: store, worksetStore: store.worksetStore(), invocationAuthority: createTrustedWorksetManagementAuthority(),
      runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context),
      runPlanLifecycleTransaction: (goalId, mutate) => store.runAtomicWorksetPlanLifecycleMutation(goalId, (tx) => mutate({
        ...tx,
        activeState: () => {
          const state = tx.activeState();
          authorizationSnapshots.push([...state.byRef.keys()]);
          return state;
        },
      })),
    });
    expect((await guarded.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
    expect(authorizationSnapshots.flat()).not.toContain("goals:G90000");
  } finally { await fixture.dispose(); }
});
