import { describe, expect, test } from "bun:test";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL admitted owned lifecycle [T5920 Behavioral-Active Blackbox-GoodCommunication]", () => {
  // expected-failure: tasks:T5920
  test.failing("postgres admitted owned lifecycle uses keyed rows", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const { pool, store, guarded, projectKey } = fixture;
    try {
      await store.createItem("questions", "M-AMBIENT", { id: "Q90000", status: "open", fields: { question: "unrelated" } });
      await store.replaceWorksetRoots(["goals:G1"]);
      const before = await pool`SELECT xmin::text AS version, fields_json FROM items
        WHERE project_key = ${projectKey} AND ledger = 'questions' AND id = 'Q90000'`;
      expect(before).toHaveLength(1);
      const created = await guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "exact-gate-question",
        child: { ledgerId: "questions", status: "open", fields: { question: "selected owner" } } });
      expect(created.child.fields.worksetOwnerRef).toBe("goals:G1");
      const after = await pool`SELECT xmin::text AS version, fields_json FROM items
        WHERE project_key = ${projectKey} AND ledger = 'questions' AND id = 'Q90000'`;
      expect(after[0].fields_json).toBe(before[0].fields_json);
      if (after[0].version !== before[0].version) console.info("T5920 reproduced: owned question creation rewrites unrelated Q90000");
      expect(after[0].version).toBe(before[0].version);
    } finally { await fixture.dispose(); }
  });
});
