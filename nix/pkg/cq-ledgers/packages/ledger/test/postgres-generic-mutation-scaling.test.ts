import { describe, expect, test } from "bun:test";
import { createWorksetGenericMutationGateway } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL generic scope [T5923 Behavioral-Active Blackbox-GoodCommunication]", () => {
  // expected-failure: tasks:T5923
  test.failing("postgres generic mutation uses keyed operation plans", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const { pool, store, projectKey } = fixture;
    const suppliedState: string[][] = [];
    try {
      await store.createItem("questions", "M-AMBIENT", { id: "Q1", status: "open", fields: { question: "selected" } });
      await store.createItem("questions", "M-AMBIENT", { id: "Q2", status: "open", fields: { question: "unrelated" } });
      await store.replaceWorksetRoots(["questions:Q1"]);
      const before = await pool<{ xmin: string }[]>`SELECT xmin::text FROM items WHERE project_key = ${projectKey} AND ledger = 'questions' AND id = 'Q2'`;
      const gateway = createWorksetGenericMutationGateway({ rawStore: store, worksetStore: store.worksetStore(),
        runGenericTransaction: (mutate) => store.runAtomicGenericMutation((tx, roots) => {
          suppliedState.push([...tx.activeState().byRef.keys()]);
          return mutate(tx, roots);
        }),
      });
      expect((await gateway.updateItem("questions", "Q1", { fields: { question: "updated" } })).fields.question).toBe("updated");
      const after = await pool<{ xmin: string }[]>`SELECT xmin::text FROM items WHERE project_key = ${projectKey} AND ledger = 'questions' AND id = 'Q2'`;
      expect(suppliedState).toHaveLength(1);
      if (suppliedState.flat().includes("questions:Q2")) console.info("T5923 reproduced: Q1 generic mutation receives unrelated Q2 in transaction state");
      expect(suppliedState.flat()).not.toContain("questions:Q2");
      expect(after).toEqual(before);
    } finally { await fixture.dispose(); }
  });
});
