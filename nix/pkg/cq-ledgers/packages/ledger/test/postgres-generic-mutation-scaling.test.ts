import { describe, expect, test } from "bun:test";
import { createWorksetGenericMutationGateway } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { genericPostgresFixture, genericPostgresSurface } from "./genericPostgresFixture.js";
import { seedPostgresUnrelatedPrivateRows, seedPostgresUnrelatedRows } from "./postgresUnrelatedRows.js";
import type { PostgresAccessRecord } from "../src/store/postgres/operationAccess.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL generic scope [T5923 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("postgres generic mutation uses keyed operation plans", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const { pool, store, projectKey } = fixture;
    const suppliedState: string[][] = [];
    try {
      await store.createItem("questions", "M-AMBIENT", { id: "Q1", status: "open", fields: { question: "selected" } });
      await store.createItem("questions", "M-AMBIENT", { id: "Q2", status: "open", fields: { question: "unrelated" } });
      await store.replaceWorksetRoots(["questions:Q1"]);
      const before = await pool<{ xmin: string }[]>`SELECT xmin::text FROM items WHERE project_key = ${projectKey} AND ledger = 'questions' AND id = 'Q2'`;
      const gateway = createWorksetGenericMutationGateway({ rawStore: store, worksetStore: store.worksetStore(),
        runGenericTransaction: (mutate, measurement, scope, context, binding) => store.runAtomicGenericMutation((tx, roots) => {
          suppliedState.push([...tx.activeState().byRef.keys()]);
          return mutate(tx, roots);
        }, undefined, measurement, scope, context, binding),
      });
      expect((await gateway.updateItem("questions", "Q1", { fields: { question: "updated" } })).fields.question).toBe("updated");
      const after = await pool<{ xmin: string }[]>`SELECT xmin::text FROM items WHERE project_key = ${projectKey} AND ledger = 'questions' AND id = 'Q2'`;
      expect(suppliedState).toHaveLength(1);
      if (suppliedState.flat().includes("questions:Q2")) console.info("T5923 reproduced: Q1 generic mutation receives unrelated Q2 in transaction state");
      expect(suppliedState.flat()).not.toContain("questions:Q2");
      expect(after).toEqual(before);
    } finally { await fixture.dispose(); }
  });
  test("ordinary, milestone and batch operations retain exact results and access sets at 20k/20k/2k unrelated rows", async () => {
    expect(await genericScaling(20_000)).toEqual(await genericScaling(0));
  }, 30_000);
});

async function genericScaling(unrelated: number) {
  const fixture = await genericPostgresFixture();
  const { pool, store, projectKey, accesses } = fixture;
  let generic = fixture.generic;
  const observations: { result: unknown; accesses: Omit<PostgresAccessRecord, "durationMs">[] }[] = [];
  const capture = async <T>(run: () => Promise<T>) => {
    accesses.length = 0;
    const result = await run();
    expect(accesses.filter(({ table }) => table === "plan_claims" || table === "plan_operations")).toEqual([]);
    observations.push({ result, accesses: accesses.map(({ durationMs: _durationMs, ...access }) => access.table !== "workset_admissions" ? access : {
      ...access, keyedPredicate: { ...access.keyedPredicate, keys: ["current-admission"] }, rowKeys: ["current-admission"],
    }) });
    return result;
  };
  try {
    await seedPostgresUnrelatedRows(pool, projectKey, unrelated);
    await seedPostgresUnrelatedPrivateRows(pool, projectKey, unrelated === 0 ? 0 : 2_000);
    await store.reloadCommittedState();
    const milestone = await capture(() => generic.createMilestone({ title: "selected milestone" }));
    const task = await capture(() => generic.createItem("tasks", milestone.id, { status: "planned", fields: { headline: "selected task" } }));
    await store.replaceWorksetRoots([`tasks:${task.id}`]);
    await capture(() => generic.updateItem("tasks", task.id, { status: "wip" }));
    await capture(() => generic.updateItem("tasks", task.id, { status: "done" }));
    await capture(() => generic.reopenItem("tasks", task.id, "planned"));
    await capture(() => generic.updateItem("tasks", task.id, { status: "done" }));
    await store.replaceWorksetRoots([]);
    await capture(() => generic.archiveTerminalItems(["tasks"], "selected finished tasks", "fail-on-active-gate"));
    await store.worksetStore().setRoots([`tasks:${task.id}`]);
    await capture(() => generic.unarchiveItem("tasks", milestone.id, task.id));
    await store.replaceWorksetRoots([]);
    await capture(() => generic.updateMilestone(milestone.id, { title: "updated milestone" }));
    await capture(() => generic.executeFinalize([{ id: "close", action: "close-milestone", targetId: milestone.id, targetStatus: "done" },
      { id: "archive", action: "archive-milestone", targetId: milestone.id, summary: "finished" }]));
    await store.reloadCommittedState();
    generic = genericPostgresSurface(store);
    const archive = await store.fetchArchive("tasks", milestone.id);
    if (archive.kind !== "group") throw new Error("expected a task archive group");
    expect(archive.milestone.items.map(({ id }) => id)).toEqual([task.id]);
    await capture(() => generic.unarchiveItem("tasks", milestone.id, task.id));
    expect(store.fetchItem("tasks", task.id).status).toBe("done");
    return observations;
  } finally { await fixture.dispose(); }
}
