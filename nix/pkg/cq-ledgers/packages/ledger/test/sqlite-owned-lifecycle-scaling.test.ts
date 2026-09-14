import { expect, test } from "bun:test";
import { createLedgerMcpTools } from "../src/index.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

// expected-failure: tasks:T5544
test.failing("sqlite owned lifecycle uses admitted keyed rows", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  try {
    await store.createItem("questions", "M-AMBIENT", { id: "Q90000", status: "open", fields: { question: "unrelated" } });
    expect((await store.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
    await store.replaceWorksetRoots(["goals:G1"]);
    db.query("CREATE TABLE observed_owned_writes (item_id TEXT NOT NULL)").run();
    for (const operation of ["INSERT", "UPDATE"]) {
      db.query(`CREATE TRIGGER observe_owned_${operation} AFTER ${operation} ON items
        WHEN NEW.ledger = 'questions' AND NEW.id = 'Q90000'
        BEGIN INSERT INTO observed_owned_writes VALUES (NEW.id); END`).run();
    }
    const tool = createLedgerMcpTools(store).find(({ name }) => name === "create_item");
    if (tool === undefined) throw new Error("create_item missing");
    const result = await tool.handler({
      ledger_id: "questions", milestone_id: "M-AMBIENT", status: "open",
      owner_ref: "goals:G1", creation_kind: "exact-gate-question",
      fields: { question: "selected owner" }, ...LIFECYCLE_PROVENANCE,
    }, null);
    expect(result.isError).not.toBe(true);
    expect(db.query("SELECT item_id FROM observed_owned_writes").all()).toEqual([]);
  } finally { await fixture.dispose(); }
});
