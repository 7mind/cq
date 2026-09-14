import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { materializeOperatorAction, PostgresLedgerStore, recordProtectedImplementationCompletion, supersedeOperatorAction } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import type { PostgresAccessRecord } from "../src/store/postgres/operationAccess.js";
import { seedPostgresUnrelatedPrivateRows, seedPostgresUnrelatedRows } from "./postgresUnrelatedRows.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL direct owned rows [T5921 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("postgres direct owned lifecycle consumers use keyed row plans", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const { store, pool, projectKey } = fixture;
    try {
      await seedDirectOwnedTasks(store);
      const first = await materializeOperatorAction(store, DIRECT_OPERATOR_INPUT);
      const task = store.fetchItem("tasks", "T1");
      await store.createItem("tasks", task.milestoneId, { id: "T2", status: "planned", fields: task.fields });
      const before = await pool`SELECT xmin::text AS version, fields_json FROM items
        WHERE project_key = ${projectKey} AND ledger = 'operatorActions' AND id = ${first.action.id}`;
      expect(before).toHaveLength(1);
      expect(await materializeOperatorAction(store, { ...DIRECT_OPERATOR_INPUT, taskId: "T2" })).toMatchObject({ state: "created", action: { id: "OA2" } });
      const after = await pool`SELECT xmin::text AS version, fields_json FROM items
        WHERE project_key = ${projectKey} AND ledger = 'operatorActions' AND id = ${first.action.id}`;
      expect(after[0].fields_json).toBe(before[0].fields_json);
      if (after[0].version !== before[0].version) console.info("T5921 reproduced: materializing OA2 rewrites unrelated OA1");
      expect(after[0].version).toBe(before[0].version);
    } finally { await fixture.dispose(); }
  });
  test("materialize, both supersession branches, protected completion and restarted replay have invariant scopes at 20k/20k/2k unrelated rows", async () => {
    const completion = await directCompletionRecord();
    expect(await directScaling(20_000, completion)).toEqual(await directScaling(0, completion));
  }, 30_000);
});

async function directScaling(unrelated: number, completion: Awaited<ReturnType<typeof directCompletionRecord>>) {
  const fixture = await ownedLifecyclePostgresFixture();
  let store = fixture.store;
  const { pool, projectKey, accesses } = fixture;
  const observations: { result: unknown; accesses: Omit<PostgresAccessRecord, "durationMs">[] }[] = [];
  const capture = async (run: () => Promise<unknown>) => {
    accesses.length = 0;
    const result = await run();
    expect(accesses.filter(({ table }) => table.startsWith("plan_") || table === "archived_items" || table.startsWith("workset_"))).toEqual([]);
    observations.push({ result, accesses: accesses.map(({ durationMs: _durationMs, ...access }) => access) });
    return result;
  };
  const conflict = async (run: () => Promise<unknown>, expected: string) => {
    await capture(async () => {
      try { await run(); } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain(expected);
        return { conflict: message };
      }
      throw new Error("expected direct lifecycle conflict");
    });
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
  };
  try {
    await seedDirectOwnedTasks(store);
    const task = store.fetchItem("tasks", "T1");
    await store.createItem("tasks", task.milestoneId, { id: "T2", status: "planned", fields: task.fields });
    await seedPostgresUnrelatedRows(pool, projectKey, unrelated);
    await seedPostgresUnrelatedPrivateRows(pool, projectKey, unrelated === 0 ? 0 : 2_000);
    await store.reloadCommittedState();
    await capture(() => materializeOperatorAction(store, DIRECT_OPERATOR_INPUT));
    await capture(() => materializeOperatorAction(store, DIRECT_OPERATOR_INPUT));
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    expect(accesses.filter(({ table, lockMode }) => table === "ledgers" && lockMode !== "none")).toEqual([]);
    await conflict(() => materializeOperatorAction(store, { ...DIRECT_OPERATOR_INPUT, expectedOutputIdentity: "different" }), "expectedOutputIdentity differs");
    await capture(() => supersedeOperatorAction(store, DIRECT_SUPERSEDE_INPUT));
    await capture(() => supersedeOperatorAction(store, DIRECT_SUPERSEDE_INPUT));
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    const absent = { ...DIRECT_SUPERSEDE_INPUT, actionId: "OA2" };
    await capture(() => supersedeOperatorAction(store, absent));
    await capture(() => supersedeOperatorAction(store, absent));
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    await conflict(() => supersedeOperatorAction(store, { ...absent, reason: "different" }), "different evidence");
    const complete = () => recordProtectedImplementationCompletion(store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE);
    await capture(complete);
    expect(accesses.filter(({ table, mode }) => table === "items" && mode === "write").flatMap(({ rowKeys }) => rowKeys).sort())
      .toEqual(["defects:D1", "defects:D4", "reviews:R2345", "tasks:T2345"]);
    await store.dispose();
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
    store = new PostgresLedgerStore({ pool: new SQL({ url: dsn, connection: { search_path: fixture.schema } }), projectKey, displayName: projectKey,
      now: () => LIFECYCLE_NOW, accessObserver: { record: (record) => accesses.push(record) } });
    await store.init();
    await capture(complete);
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    await capture(() => supersedeOperatorAction(store, absent));
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    await conflict(() => recordProtectedImplementationCompletion(store, DIRECT_TASK_AUTHORITY, { ...completion, resultCommit: "f".repeat(40) }, LIFECYCLE_PROVENANCE),
      "terminal implementation review id belongs to different evidence");
    return observations;
  } finally { await store.dispose(); await fixture.dispose(); }
}
