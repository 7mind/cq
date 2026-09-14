import { describe, expect, test } from "bun:test";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import type { PostgresAccessRecord } from "../src/store/postgres/operationAccess.js";
import { seedPostgresUnrelatedPrivateRows, seedPostgresUnrelatedRows } from "./postgresUnrelatedRows.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL admitted owned lifecycle [T5920 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("postgres admitted owned lifecycle uses keyed rows", async () => {
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

  test("owned intake and bundles retain exact results, keyed reads, locks and writes with 20k active/archive and 2k private rows", async () => {
    expect(await ownedScaling(20_000)).toEqual(await ownedScaling(0));
  }, 30_000);
});

async function ownedScaling(unrelated: number) {
  const fixture = await ownedLifecyclePostgresFixture();
  const { pool, projectKey, store, guarded, accesses } = fixture;
  const observed: { result: unknown; accesses: Omit<PostgresAccessRecord, "durationMs">[] }[] = [];
  const capture = async <T>(operation: () => Promise<T>): Promise<T> => {
    accesses.length = 0;
    const result = await operation();
    expect(accesses.filter(({ table }) => table.startsWith("plan_") || table === "archived_items")).toEqual([]);
    const admission = accesses.filter(({ table }) => table === "workset_admissions");
    expect(admission).toHaveLength(3);
    expect(admission.filter(({ lockMode }) => lockMode === "share")).toHaveLength(1);
    observed.push({ result, accesses: accesses.map(({ durationMs: _durationMs, ...access }) => access.table !== "workset_admissions" ? access : {
      ...access, keyedPredicate: { ...access.keyedPredicate, keys: ["current-admission"] }, rowKeys: ["current-admission"],
    }) });
    return result;
  };
  try {
    await seedPostgresUnrelatedRows(pool, projectKey, unrelated);
    await seedPostgresUnrelatedPrivateRows(pool, projectKey, unrelated === 0 ? 0 : 2_000);
    await store.reloadCommittedState();
    const idea = await capture(() => guarded.owned.createOwnerless({ ledgerId: "ideas", status: "open", fields: { title: "selected idea" } }));
    const defect = await capture(() => guarded.owned.createOwnerless({ ledgerId: "defects", status: "open", fields: { headline: "selected defect", severity: "high" } }));
    await store.replaceWorksetRoots([`ideas:${idea.id}`, `defects:${defect.id}`, "goals:G1"]);
    const fix = { defectId: defect.id, goal: { title: "fix", description: "owned fix" } };
    await capture(() => guarded.bundles.bootstrapDefectToFixGoal(fix));
    await capture(() => guarded.bundles.bootstrapDefectToFixGoal(fix));
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    expect(accesses.filter(({ table, lockMode }) => table === "ledgers" && lockMode !== "none")).toEqual([]);
    await capture(() => guarded.bundles.bootstrapIdeaToGoal({ ideaId: idea.id, goal: { title: "idea goal", description: "owned idea" }, consumeIdea: true }));
    await capture(() => guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "exact-gate-question",
      child: { ledgerId: "questions", status: "open", fields: { question: "selected owner" } } }));
    return observed;
  } finally { await fixture.dispose(); }
}
