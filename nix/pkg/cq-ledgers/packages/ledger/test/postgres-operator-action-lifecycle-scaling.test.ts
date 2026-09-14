import { describe, expect, test } from "bun:test";
import { operatorActionPostgresFixture } from "./operatorActionPostgresFixture.js";
import { OPERATOR_ACKNOWLEDGE, OPERATOR_ACTION_ROWS, OPERATOR_COMPLETE, OPERATOR_EVIDENCE, OPERATOR_REVISE, OPERATOR_SUPERSEDE } from "./operatorActionLifecycleContract.js";
import type { OperatorActionLifecycleMutation, OperatorActionLifecycleMutationResult } from "../src/store/operatorActionLifecycle.js";
import type { PostgresAccessRecord } from "../src/store/postgres/operationAccess.js";
import { seedPostgresUnrelatedRows, seedPostgresUnrelatedPrivateRows } from "./postgresUnrelatedRows.js";

async function operatorScaling(unrelated: number) {
  const second = OPERATOR_ACTION_ROWS.map(({ ledgerId, item }) => ({ ledgerId, item: { ...item, id: item.id.replace(/1$/, "2"),
    fields: { ...item.fields, ...(ledgerId === "operatorActions" ? { taskRef: "tasks:T2" } : {}) } } }));
  const fixture = await operatorActionPostgresFixture([...OPERATOR_ACTION_ROWS, ...second]);
  const observed: { result: OperatorActionLifecycleMutationResult; accesses: Omit<PostgresAccessRecord, "durationMs">[] }[] = [];
  const capture = async (mutation: OperatorActionLifecycleMutation, reads: readonly string[], writes: readonly string[]) => {
    fixture.accesses.length = 0;
    const result = await fixture.mutate(mutation);
    expect(fixture.accesses.filter(({ table }) => table.startsWith("plan_") || table === "archived_items" || table === "ledgers")).toEqual([]);
    expect([...new Set(fixture.accesses.filter(({ table, mode }) => table === "items" && mode === "read").flatMap(({ rowKeys }) => rowKeys))].sort())
      .toEqual([...reads].sort());
    expect(fixture.accesses.filter(({ table, mode }) => table === "items" && mode === "write").flatMap(({ rowKeys }) => rowKeys).sort()).toEqual([...writes].sort());
    observed.push({ result, accesses: fixture.accesses.map(({ durationMs: _duration, ...record }) => record) });
  };
  try {
    await seedPostgresUnrelatedRows(fixture.pool, fixture.projectKey, unrelated);
    await seedPostgresUnrelatedPrivateRows(fixture.pool, fixture.projectKey, unrelated === 0 ? 0 : 2_000);
    await fixture.store.reloadCommittedState();
    const action = ["operatorActions:OA1"];
    const revised = [...action, "tasks:T1", "handoffs:HO1"];
    await capture({ ...OPERATOR_ACKNOWLEDGE, outputIdentity: "wrong" }, action, []);
    await capture(OPERATOR_ACKNOWLEDGE, action, action);
    await capture({ ...OPERATOR_EVIDENCE, evidence: { ...OPERATOR_EVIDENCE.evidence, exitCode: 1 } }, action, action);
    await capture(OPERATOR_REVISE, revised, revised);
    await capture({ ...OPERATOR_ACKNOWLEDGE, expectedRevision: 2, outputIdentity: "identity-2" }, action, action);
    await capture({ ...OPERATOR_EVIDENCE, expectedRevision: 2, evidence: { ...OPERATOR_EVIDENCE.evidence, command: "probe-2", outputIdentity: "identity-2" } }, action, action);
    await capture({ ...OPERATOR_COMPLETE, expectedRevision: 2 }, [...action, "tasks:T1"], [...action, "tasks:T1"]);
    await capture({ ...OPERATOR_SUPERSEDE, actionId: "OA2" }, ["operatorActions:OA2", "tasks:T2"], ["operatorActions:OA2", "tasks:T2"]);
    await capture({ ...OPERATOR_SUPERSEDE, actionId: "OA2" }, ["operatorActions:OA2", "tasks:T2"], []);
    return observed;
  } finally { await fixture.dispose(); }
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL keyed operator lifecycle [T5919 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("postgres operator-action lifecycle uses keyed row plans", async () => {
    const action = OPERATOR_ACTION_ROWS[0]!;
    const fixture = await operatorActionPostgresFixture([...OPERATOR_ACTION_ROWS, { ...action, item: { ...action.item, id: "OA2" } }]);
    try {
      const before = await fixture.pool`SELECT xmin::text AS version, fields_json FROM items
        WHERE project_key = ${fixture.projectKey} AND ledger = 'operatorActions' AND id = 'OA2'`;
      expect(before).toHaveLength(1);
      expect(await fixture.mutate(OPERATOR_ACKNOWLEDGE)).toMatchObject({ kind: "acknowledge", state: "acknowledged" });
      const after = await fixture.pool`SELECT xmin::text AS version, fields_json FROM items
        WHERE project_key = ${fixture.projectKey} AND ledger = 'operatorActions' AND id = 'OA2'`;
      expect(after[0].fields_json).toBe(before[0].fields_json);
      if (after[0].version !== before[0].version) console.info("T5919 reproduced: acknowledging OA1 rewrites unchanged OA2");
      expect(after[0].version).toBe(before[0].version);
    } finally { await fixture.dispose(); }
  });

  test("all variants retain exact key, lock and write multisets with 20k active and archived rows plus 2k private records", async () => {
    expect(await operatorScaling(20_000)).toEqual(await operatorScaling(0));
  }, 30_000);
});
