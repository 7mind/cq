import { expect, test } from "bun:test";
import { SqliteLedgerStore } from "../src/index.js";
import { OPERATOR_ACTION_ROWS, OPERATOR_REVISE } from "./operatorActionLifecycleContract.js";
import { operatorActionSqliteFixture } from "./operatorActionSqliteFixture.js";
import { LIFECYCLE_NOW } from "./sqlitePlanLifecycleFixture.js";

test("two SQLite writers serialize revision CAS and retain one coherent action/task/handoff closure after restart [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  const fixture = await operatorActionSqliteFixture(OPERATOR_ACTION_ROWS);
  const second = new SqliteLedgerStore({ dbPath: fixture.db.filename, now: () => LIFECYCLE_NOW });
  await second.init();
  try {
    const results = await Promise.allSettled([
      fixture.mutate({ ...OPERATOR_REVISE, expectedOutputIdentity: "winner-a" }),
      second.mutateOperatorAction({ ...OPERATOR_REVISE, expectedOutputIdentity: "winner-b" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("expected a revision loser");
    expect(String(rejected.reason)).toContain("revision conflict");
    await fixture.store.dispose();
    await fixture.store.init();
    const action = fixture.fetch("operatorActions", "OA1");
    expect(action.fields.revision).toBe("2");
    expect(fixture.fetch("tasks", "T1").status).toBe("planned");
    expect(fixture.fetch("handoffs", "HO1").fields.summary).toBe(
      `Operator action OA1 revision 2 awaits deployment identity ${String(action.fields.expectedOutputIdentity)}`,
    );
    expect(fixture.fetch("handoffs", "HO1").fields.handoffReasons).toEqual([
      `Deploy ${String(action.fields.expectedOutputIdentity)} and acknowledge OA1 revision 2`,
    ]);
  } finally { await second.dispose(); await fixture.dispose(); }
});
