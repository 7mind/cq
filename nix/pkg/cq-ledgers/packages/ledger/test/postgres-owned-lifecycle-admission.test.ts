import { describe, expect, test } from "bun:test";
import type { AdmittedOwnedMutation, OwnedCreateInput } from "../src/worksetOwnedLifecycle.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL owned admission [T5920 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("substitution, unprepared rows, forged ownership, stale durable coordinates and closed leases fail atomically", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const { store, pool, projectKey } = fixture;
    try {
      await store.createItem("questions", "M-AMBIENT", { id: "Q90000", status: "open", fields: { question: "unrelated" } });
      await store.replaceWorksetRoots(["goals:G1"]);
      const admission = await store.worksetStore().admitLedgerMutation({ kind: "owned-write", targets: ["goals:G1"] });
      const input: OwnedCreateInput = { owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "exact-gate-question",
        child: { ledgerId: "questions", status: "open", fields: { question: "selected" } } };
      const context: AdmittedOwnedMutation = { admission, operation: { kind: "create-owned", input } };
      const snapshot = async () => ({
        items: [...await pool`SELECT ledger, id, milestone_id, status, fields_json, updated_at FROM items WHERE project_key = ${projectKey} ORDER BY ledger, id`],
        counters: [...await pool`SELECT name, item_counter, milestone_counter FROM ledgers WHERE project_key = ${projectKey} ORDER BY name`],
        references: [...await pool`SELECT source_ledger, source_id, field_name, target_ledger, target_id FROM item_references
          WHERE project_key = ${projectKey} ORDER BY source_ledger, source_id, field_name, target_ledger, target_id`],
      });
      const before = await snapshot();
      const cached = store.snapshot();
      try {
        await expect(store.runAtomicOwnedMutation(() => undefined, { ...context, admission: { ...admission } })).rejects.toThrow("exact live owner admission");
        await expect(store.runAtomicOwnedMutation(() => undefined, { admission, operation: { kind: "create-owned",
          input: { ...input, owner: { ledgerId: "goals", itemId: "G2" } } } })).rejects.toThrow("exact live owner admission");
        await expect(store.runAtomicOwnedMutation((tx) => tx.updateItem("questions", "Q90000", { fields: { question: "foreign change" } }), context))
          .rejects.toThrow("unprepared row outside its declared operation");
        await expect(store.runAtomicOwnedMutation((tx) => {
          const create = () => tx.createItemWithSealedOwnership("questions", "M-AMBIENT", { id: "Q8", status: "open", fields: { question: "unprepared id" } },
            { ownerRef: "goals:G1", edgeKind: "exact-gate-question" });
          try { create(); } catch { /* A caught preparation failure must not become a cached absent row. */ }
          return create();
        }, context)).rejects.toThrow("unprepared row outside its declared operation");
        await expect(store.runAtomicOwnedMutation((tx) => tx.createItemWithSealedOwnership("questions", "M-AMBIENT", {
          status: "open", fields: { question: "wrong owner" },
        }, { ownerRef: "goals:G2", edgeKind: "finalized-manifest" }), context)).rejects.toThrow("outside its requested owner/ledger");
        expect(await snapshot()).toEqual(before);
        expect(store.snapshot()).toEqual(cached);
        await pool`UPDATE workset_roots SET epoch = epoch + 1 WHERE project_key = ${projectKey}`;
        try { await expect(store.runAtomicOwnedMutation(() => undefined, context)).rejects.toThrow("exact durable owner/roots epoch"); }
        finally { await pool`UPDATE workset_roots SET epoch = ${admission.epoch} WHERE project_key = ${projectKey}`; }
        await pool`UPDATE workset_admissions SET targets_json = '["goals:G2"]' WHERE project_key = ${projectKey} AND admission_id = ${admission.id}`;
        try { await expect(store.runAtomicOwnedMutation(() => undefined, context)).rejects.toThrow("exact durable owner/roots epoch"); }
        finally { await pool`UPDATE workset_admissions SET targets_json = ${JSON.stringify(admission.targets)} WHERE project_key = ${projectKey} AND admission_id = ${admission.id}`; }
        expect(await snapshot()).toEqual(before);
        expect(store.snapshot()).toEqual(cached);
      } finally { await admission.acknowledge(); }
      await expect(store.runAtomicOwnedMutation(() => undefined, context)).rejects.toThrow("exact live owner admission");
    } finally { await fixture.dispose(); }
  });
});
