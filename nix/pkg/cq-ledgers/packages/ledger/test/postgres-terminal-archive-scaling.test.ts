import { describe, expect, test } from "bun:test";
import { genericPostgresFixture } from "./genericPostgresFixture.js";
import { seedPostgresUnrelatedRows } from "./postgresUnrelatedRows.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL terminal archive scope [T5923 Behavioral-Active Effectual-GoodCommunication]", () => {
  test("terminal range keeps active gates and siblings without reading unrelated nonterminal rows", async () => {
    expect(await terminalScope(20_000)).toEqual(await terminalScope(0));
  }, 30_000);
  test("unarchive changes only the selected row when its pointer already contains 20k unrelated archived rows", async () => {
    expect(await unarchiveScope(20_000)).toEqual(await unarchiveScope(0));
  }, 30_000);
});

async function terminalScope(unrelated: number) {
  const fixture = await genericPostgresFixture();
  const { store, generic, pool, projectKey, accesses } = fixture;
  try {
    const milestone = await generic.createMilestone({ title: "terminal range" });
    await generic.createItem("tasks", milestone.id, { id: "T1", status: "done", fields: { headline: "archive" } });
    await generic.createItem("tasks", milestone.id, { id: "T2", status: "abandoned", fields: { headline: "retain gate" } });
    await generic.createItem("tasks", milestone.id, { id: "T3", status: "planned", fields: { headline: "active blocker", dependsOn: ["tasks:T2"] } });
    await generic.createItem("tasks", milestone.id, { id: "T4", status: "planned", fields: { headline: "unrelated sibling" } });
    await seedPostgresUnrelatedRows(pool, projectKey, unrelated);
    await store.reloadCommittedState();
    accesses.length = 0;
    const result = await generic.archiveTerminalItems(["tasks"], "bounded terminal range", "retain-active-gates");
    expect(result).toEqual({ archivedItems: 1, archiveGroups: 1, byLedger: { tasks: 1 }, retainedActiveGates: ["tasks:T2"], retainedActiveOwners: [] });
    const keys = accesses.flatMap(({ rowKeys }) => rowKeys);
    expect(keys.some((key) => key.startsWith("tasks:T9"))).toBe(false);
    expect(keys).not.toContain("tasks:T4");
    expect(store.fetchItem("tasks", "T4").status).toBe("planned");
    const candidates = accesses.filter(({ table, keyedPredicate, lockMode }) => table === "items" && keyedPredicate.kind === "selected-ledger-status" && lockMode === "none");
    expect(candidates.map(({ rowKeys }) => rowKeys)).toEqual([["tasks:T1", "tasks:T2"], ["tasks:T1", "tasks:T2"]]);
    return { result, accesses: normalized(accesses) };
  } finally { await fixture.dispose(); }
}

async function unarchiveScope(unrelated: number) {
  const fixture = await genericPostgresFixture();
  const { store, generic, pool, projectKey, accesses } = fixture;
  try {
    const milestone = await generic.createMilestone({ title: "retained archive" });
    for (const id of ["T1", "T2"]) await generic.createItem("tasks", milestone.id, { id, status: "done", fields: { headline: id } });
    await generic.archiveTerminalItems(["tasks"], "seed", "fail-on-active-gate");
    await seedPostgresUnrelatedRows(pool, projectKey, unrelated);
    if (unrelated > 0) await pool`UPDATE archived_items SET pointer_id = ${milestone.id}, milestone_id = ${milestone.id}
      WHERE project_key = ${projectKey} AND ledger = 'tasks' AND pointer_id = 'M900001'`;
    await store.reloadCommittedState();
    const retained = [...await pool`SELECT id, xmin::text FROM archived_items
      WHERE project_key = ${projectKey} AND ledger = 'tasks' AND id <> 'T1' ORDER BY id`];
    accesses.length = 0;
    const result = await generic.unarchiveItem("tasks", milestone.id, "T1");
    expect([...await pool`SELECT id, xmin::text FROM archived_items
      WHERE project_key = ${projectKey} AND ledger = 'tasks' AND id <> 'T1' ORDER BY id`]).toEqual(retained);
    const archive = await store.fetchArchive("tasks", milestone.id);
    if (archive.kind !== "group") throw new Error("expected retained archive group");
    expect(archive.milestone.items).toHaveLength(unrelated + 1);
    expect(accesses.filter(({ table, mode }) => table === "archived_items" && mode === "write").flatMap(({ rowKeys }) => rowKeys))
      .toEqual([`tasks:${milestone.id}:T1`]);
    return { result, accesses: normalized(accesses) };
  } finally { await fixture.dispose(); }
}

function normalized(accesses: readonly import("../src/store/postgres/operationAccess.js").PostgresAccessRecord[]) {
  return accesses.map(({ durationMs: _durationMs, ...access }) => access.table !== "workset_admissions" ? access : {
    ...access, keyedPredicate: { ...access.keyedPredicate, keys: ["current-admission"] }, rowKeys: ["current-admission"],
  });
}
