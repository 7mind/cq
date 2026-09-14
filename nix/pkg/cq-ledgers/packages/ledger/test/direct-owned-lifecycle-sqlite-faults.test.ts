import { expect, test } from "bun:test";
import { materializeOperatorAction, recordProtectedImplementationCompletion } from "../src/index.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

for (const operation of ["materialize", "protected-completion"] as const) {
  test(`${operation} rolls back every public/group/counter/coherence row when its last item write fails [T5545]`, async () => {
    const fixture = await sqlitePlanLifecycleFixture();
    const { store, db } = fixture;
    try {
      await seedDirectOwnedTasks(store);
      const completion = await directCompletionRecord();
      const snapshot = () => ["items", "groups", "ledgers", "item_references", "coherence_vector"]
        .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
      const before = snapshot();
      const target = operation === "materialize" ? ["handoffs", "HO1"] : ["defects", "D4"];
      db.query(`CREATE TRIGGER fail_direct_final_item BEFORE INSERT ON items
        WHEN NEW.ledger = '${target[0]}' AND NEW.id = '${target[1]}'
        BEGIN SELECT RAISE(ABORT, 'injected direct owned failure'); END`).run();
      const invoke = () => operation === "materialize" ? materializeOperatorAction(store, DIRECT_OPERATOR_INPUT)
        : recordProtectedImplementationCompletion(store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE);
      await expect(invoke()).rejects.toThrow("injected direct owned failure");
      expect(snapshot()).toEqual(before);
      db.query("DROP TRIGGER fail_direct_final_item").run();
      await store.dispose();
      await store.init();
      expect(snapshot()).toEqual(before);
      await invoke();
      await invoke();
    } finally { await fixture.dispose(); }
  });
}
