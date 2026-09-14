import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedgerStore } from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

// expected-failure: tasks:T5542
test.failing("sqlite plan lifecycle uses keyed row plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-plan-lifecycle-scaling-"));
  const dbPath = join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  const probe = openLedgerDb(dbPath);
  try {
    for (const id of ["G1", "G2"]) {
      await store.createItem("goals", "M-AMBIENT", {
        id,
        status: "clarifying",
        fields: { title: id, description: "keyed lifecycle regression" },
      });
    }
    const claim = (goalId: string) => store.claimPlan({
      goalId,
      purpose: "initial",
      claimRequestId: `request-${goalId}`,
      ownerFenceToken: "A".repeat(43),
      expectedGeneration: null,
      author: "T5542",
      session: "sqlite-plan-lifecycle-scaling",
    });
    expect((await claim("G2")).ok).toBe(true);
    probe.exec(`
      CREATE TABLE observed_lifecycle_writes (record_kind TEXT NOT NULL, goal_id TEXT NOT NULL);
      CREATE TRIGGER observe_unrelated_claim_update AFTER UPDATE ON plan_claims
      WHEN json_extract(NEW.record_json, '$.goalId') = 'G2'
      BEGIN INSERT INTO observed_lifecycle_writes VALUES ('claim', 'G2'); END;
      CREATE TRIGGER observe_unrelated_goal_insert AFTER INSERT ON items
      WHEN NEW.ledger = 'goals' AND NEW.id = 'G2'
      BEGIN INSERT INTO observed_lifecycle_writes VALUES ('goal', 'G2'); END;
      CREATE TRIGGER observe_unrelated_goal_update AFTER UPDATE ON items
      WHEN NEW.ledger = 'goals' AND NEW.id = 'G2'
      BEGIN INSERT INTO observed_lifecycle_writes VALUES ('goal', 'G2'); END;
    `);
    expect((await claim("G1")).ok).toBe(true);
    expect(probe.query("SELECT record_kind, goal_id FROM observed_lifecycle_writes").all()).toEqual([]);
  } finally {
    probe.close();
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
