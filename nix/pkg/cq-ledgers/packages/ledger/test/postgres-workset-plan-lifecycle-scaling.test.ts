import { describe, expect, test } from "bun:test";
import { createTrustedWorksetManagementAuthority, createWorksetGuardedPlanLifecycleStore } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { LIFECYCLE_CLAIM_INPUT } from "./sqlitePlanLifecycleFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL guarded plan scope [T5922 Behavioral-Active Blackbox-GoodCommunication]", () => {
  // expected-failure: tasks:T5922
  test.failing("postgres guarded plan lifecycle uses an exact affected closure", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const { store } = fixture;
    const suppliedState: string[][] = [];
    try {
      await store.createItem("goals", "M-AMBIENT", { id: "G90000", status: "clarifying", fields: { title: "unrelated", description: "outside roots" } });
      await store.replaceWorksetRoots(["goals:G1"]);
      const guarded = createWorksetGuardedPlanLifecycleStore({ rawStore: store, worksetStore: store.worksetStore(),
        invocationAuthority: createTrustedWorksetManagementAuthority(),
        runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context),
        runPlanLifecycleTransaction: (context, mutate) => store.runAtomicWorksetPlanLifecycleMutation(context, (tx) => {
          suppliedState.push([...tx.activeState().byRef.keys()]);
          return mutate(tx);
        }),
      });
      expect(await guarded.claimPlan(LIFECYCLE_CLAIM_INPUT)).toMatchObject({ ok: true });
      expect(suppliedState).toHaveLength(1);
      if (suppliedState.flat().includes("goals:G90000")) console.info("T5922 reproduced: guarded G1 claim receives unrelated G90000 in its transaction state");
      expect(suppliedState.flat()).not.toContain("goals:G90000");
    } finally { await fixture.dispose(); }
  });
});
