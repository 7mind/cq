import { expect, test } from "bun:test";
import {
  OPERATOR_ACKNOWLEDGE, OPERATOR_ACTION_ROWS, OPERATOR_COMPLETE, OPERATOR_EVIDENCE,
  OPERATOR_REVISE, OPERATOR_SUPERSEDE,
} from "./operatorActionLifecycleContract.js";
import { operatorActionSqliteFixture } from "./operatorActionSqliteFixture.js";

for (const mutation of [OPERATOR_ACKNOWLEDGE, OPERATOR_EVIDENCE, OPERATOR_REVISE, OPERATOR_COMPLETE, OPERATOR_SUPERSEDE]) {
  test(`${mutation.kind} rolls back the full selected closure when its final row update fails [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const fixture = await operatorActionSqliteFixture(OPERATOR_ACTION_ROWS);
    const { db, store } = fixture;
    try {
      if (mutation.kind === "record-evidence" || mutation.kind === "complete") await fixture.mutate(OPERATOR_ACKNOWLEDGE);
      if (mutation.kind === "complete") await fixture.mutate(OPERATOR_EVIDENCE);
      const target = mutation.kind === "revise" ? ["handoffs", "HO1"]
        : mutation.kind === "complete" || mutation.kind === "supersede" ? ["tasks", "T1"] : ["operatorActions", "OA1"];
      const snapshot = () => ["items", "groups", "ledgers", "item_references", "coherence_vector", "plan_claims", "plan_operations"]
        .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
      const before = snapshot();
      db.query(`CREATE TRIGGER fail_operator_final_row BEFORE UPDATE ON items
        WHEN NEW.ledger = '${target[0]}' AND NEW.id = '${target[1]}'
        BEGIN SELECT RAISE(ABORT, 'injected final operator row failure'); END`).run();
      await expect(fixture.mutate(mutation)).rejects.toThrow("injected final operator row failure");
      expect(snapshot()).toEqual(before);
      db.query("DROP TRIGGER fail_operator_final_row").run();
      await store.dispose();
      await store.init();
      expect(snapshot()).toEqual(before);
      expect((await fixture.mutate(mutation)).kind).toBe(mutation.kind);
    } finally { await fixture.dispose(); }
  });
}
