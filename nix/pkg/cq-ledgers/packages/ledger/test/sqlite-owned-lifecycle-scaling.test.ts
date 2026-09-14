import { expect, test } from "bun:test";
import { createLedgerMcpTools, assertSqliteAccessContract, type SqliteAccessRecord } from "../src/index.js";
import type { AdmittedOwnedMutation } from "../src/worksetOwnedLifecycle.js";
import { ownedLifecycleSqliteFixture, seedUnrelatedOwnedRows } from "./ownedLifecycleSqliteFixtures.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

test("sqlite owned lifecycle uses admitted keyed rows", async () => {
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

async function admittedOwnedScalingFixture(unrelatedRows: number) {
  const fixture = await ownedLifecycleSqliteFixture();
  const { store, db, accesses, guarded } = fixture;
  const observed: { result: unknown; accesses: SqliteAccessRecord[] }[] = [];
  const capture = async <T>(operation: () => Promise<T>): Promise<T> => {
    accesses.length = 0;
    const result = await operation();
    for (const access of accesses) assertSqliteAccessContract(access);
    expect(accesses.filter(({ table }) => table.startsWith("plan_") || table === "archived_items")).toEqual([]);
    const admissionReads = accesses.filter(({ table }) => table === "workset_admissions");
    expect(admissionReads).toHaveLength(1);
    expect(admissionReads[0]!.rowKeys).toEqual(admissionReads[0]!.keyedPredicate.keys);
    // Each call has a distinct granted id; compare the same admission coordinate.
    const normalized = accesses.map((access) => access.table !== "workset_admissions" ? access : {
      ...access, keyedPredicate: { ...access.keyedPredicate, keys: ["current-admission"] }, rowKeys: ["current-admission"],
    });
    observed.push({ result, accesses: structuredClone(normalized) });
    return result;
  };
  try {
    seedUnrelatedOwnedRows(db, unrelatedRows);
    const idea = await capture(() => guarded.owned.createOwnerless({ ledgerId: "ideas", status: "open", fields: { title: "selected idea" } }));
    const defect = await capture(() => guarded.owned.createOwnerless({ ledgerId: "defects", status: "open", fields: { headline: "selected defect", severity: "high" } }));
    await store.replaceWorksetRoots([`ideas:${idea.id}`, `defects:${defect.id}`, "goals:G1"]);
    const fix = { defectId: defect.id, goal: { title: "fix", description: "owned fix" } };
    await capture(() => guarded.bundles.bootstrapDefectToFixGoal(fix));
    await capture(() => guarded.bundles.bootstrapDefectToFixGoal(fix));
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    await capture(() => guarded.bundles.bootstrapIdeaToGoal({ ideaId: idea.id, goal: { title: "idea goal", description: "owned idea" }, consumeIdea: true }));
    await capture(() => guarded.owned.createOwned({
      owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "exact-gate-question",
      child: { ledgerId: "questions", status: "open", fields: { question: "selected owner" } },
    }));
    return observed;
  } finally { await fixture.dispose(); }
}

test("admitted intake, owned creation and coordination bundles retain exact access/write scopes with 20k active plus 20k archived rows [T5544]", async () => {
  expect(await admittedOwnedScalingFixture(20_000)).toEqual(await admittedOwnedScalingFixture(0));
}, 30_000);

test("native owned admission rejects substitution, extra changed rows, foreign ownership and stale epoch atomically [T5544]", async () => {
  const fixture = await ownedLifecycleSqliteFixture();
  const { store, db } = fixture;
  try {
    await store.createItem("questions", "M-AMBIENT", { id: "Q90000", status: "open", fields: { question: "unrelated" } });
    await store.replaceWorksetRoots(["goals:G1"]);
    const admission = await store.worksetStore().admitLedgerMutation({ kind: "owned-write", targets: ["goals:G1"] });
    const context: AdmittedOwnedMutation = { admission, operation: { kind: "create-owned", owner: { ledgerId: "goals", itemId: "G1" }, childLedgerId: "questions" } };
    const snapshot = () => ["items", "groups", "ledgers", "item_references", "coherence_vector"]
      .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
    const before = snapshot();
    try {
      await expect(store.runAtomicOwnedMutation(() => undefined, { ...context, admission: { ...admission } })).rejects.toThrow("exact live owner admission");
      await expect(store.runAtomicOwnedMutation(() => undefined, { admission, operation: { kind: "create-owned", owner: { ledgerId: "goals", itemId: "G2" }, childLedgerId: "questions" } })).rejects.toThrow("exact live owner admission");
      await expect(store.runAtomicOwnedMutation((tx) => tx.updateItem("questions", "Q90000", { fields: { question: "foreign change" } }), context)).rejects.toThrow("outside its declared operation");
      await expect(store.runAtomicOwnedMutation((tx) => tx.createItemWithSealedOwnership("questions", "M-AMBIENT", {
        status: "open", fields: { question: "wrong owner" },
      }, { ownerRef: "goals:G2", edgeKind: "finalized-manifest" }), context)).rejects.toThrow("outside its requested owner/ledger");
      expect(snapshot()).toEqual(before);
      db.query("UPDATE workset_state SET epoch = epoch + 1 WHERE id = 1").run();
      try {
        await expect(store.runAtomicOwnedMutation(() => undefined, context)).rejects.toThrow("exact durable owner/roots epoch");
      } finally { db.query("UPDATE workset_state SET epoch = ? WHERE id = 1").run(admission.epoch); }
      expect(snapshot()).toEqual(before);
    } finally { await admission.acknowledge(); }
    await expect(store.runAtomicOwnedMutation(() => undefined, context)).rejects.toThrow("exact live owner admission");
    await expect(store.runAtomicOwnedMutation((tx) => tx.activeState(), null)).rejects.toThrow("cannot enumerate active state");
  } finally { await fixture.dispose(); }
});
