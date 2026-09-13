import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { coherenceVersion, openLedgerDb } from "../src/store/sqlite/connection.js";

test("sqlite coherence records exact scoped keys once per domain transaction", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-coherence-vector-"));
  const dbPath = path.join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  const probe = openLedgerDb(dbPath);
  try {
    await store.init();
    const milestone = await store.createMilestone({ title: "coherence" });
    const before = coherenceVersion(probe);
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "atomic version" },
    });
    expect(coherenceVersion(probe)).toBe(before + 1);
    expect(
      probe
        .query(
          "SELECT ledger, document_id, scope, change_kind, version FROM coherence_vector WHERE version > ? ORDER BY ledger, document_id, scope",
        )
        .all(before),
    ).toEqual([
      {
        ledger: "tasks",
        document_id: task.id,
        scope: "active",
        change_kind: "upsert",
        version: before + 1,
      },
    ]);
  } finally {
    probe.close();
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("coalesced keys remain cursor-safe; a failed vector write rolls back domain rows [Effectual-GoodCommunication]", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-coherence-atomic-"));
  const dbPath = path.join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  const probe = openLedgerDb(dbPath);
  try {
    await store.init();
    const milestone = await store.createMilestone({ title: "atomic" });
    const a = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "a" },
    });
    const b = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "b" },
    });
    const before = coherenceVersion(probe);
    await store.runAtomicGenericMutation(
      (tx) => {
        tx.updateItem("tasks", a.id, { fields: { headline: "a2" } });
        tx.updateItem("tasks", b.id, { fields: { headline: "b2" } });
        tx.updateItem("tasks", a.id, { fields: { headline: "a3" } });
      },
      undefined,
      undefined,
      {
        operation: "update-item",
        accessClass: "ordinary",
        targetRefs: [`tasks:${a.id}`, `tasks:${b.id}`],
        ledgerIds: ["tasks"],
        milestoneIds: [],
        referenceCandidates: [],
      },
    );
    expect(coherenceVersion(probe)).toBe(before + 1);
    const first = store.readCoherenceChanges(before);
    expect(first.entries.map((entry) => [entry.documentId, entry.version, entry.scope])).toEqual([
      [a.id, before + 1, "active"],
      [b.id, before + 1, "active"],
    ]);
    expect(new Set(first.entries.map((entry) => entry.origin)).size).toBe(1);
    expect(first.entries[0]!.origin.length).toBeGreaterThan(0);
    await store.updateItem("tasks", a.id, { fields: { headline: "a4" } });
    expect(
      store.readCoherenceChanges(before).entries.map((entry) => [entry.documentId, entry.version]),
    ).toEqual([
      [b.id, before + 1],
      [a.id, before + 2],
    ]);
    expect(store.readCoherenceChanges(before + 1).entries.map((entry) => entry.documentId)).toEqual(
      [a.id],
    );

    const version = coherenceVersion(probe);
    probe.exec(
      "CREATE TRIGGER fail_vector BEFORE INSERT ON coherence_vector BEGIN SELECT RAISE(ABORT, 'injected vector persistence failure'); END",
    );
    await expect(
      store.updateItem("tasks", a.id, { fields: { headline: "must rollback" } }),
    ).rejects.toThrow("injected vector persistence failure");
    expect(store.fetchItem("tasks", a.id).fields.headline).toBe("a4");
    expect(coherenceVersion(probe)).toBe(version);
    expect(store.readCoherenceChanges(version).entries).toEqual([]);
    probe.exec("DROP TRIGGER fail_vector");
    await store.recordMcpUsage("fetch_item", 1, 1);
    await store.replaceWorksetRoots([`tasks:${a.id}`]);
    expect(coherenceVersion(probe)).toBe(version);
    expect(store.readCoherenceChanges(version).entries).toEqual([]);
  } finally {
    probe.close();
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const legacyVersion of [5, 6]) {
  test(`v${legacyVersion} to v7 preserves domain, archive, workset and plan state [Effectual-GoodCommunication]`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `sqlite-coherence-v${legacyVersion}-`));
    const dbPath = path.join(root, "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    const probe = openLedgerDb(dbPath);
    try {
      await store.init();
      const live = await store.createMilestone({ title: "live" });
      const task = await store.createItem("tasks", live.id, {
        status: "planned",
        fields: { headline: "retained" },
      });
      const archived = await store.createMilestone({ title: "archived" });
      await store.updateMilestone(archived.id, { status: "done" });
      await store.archiveMilestone(archived.id, "retained archive");
      await store.replaceWorksetRoots([`tasks:${task.id}`]);
      probe
        .query("INSERT INTO plan_claims (scope, record_json) VALUES ('retained-claim', '{}')")
        .run();
      probe
        .query(
          "INSERT INTO plan_operations (scope, record_json) VALUES ('retained-operation', '{}')",
        )
        .run();
      const snapshot = store.snapshot();
      const archive = await store.fetchArchive("milestones", archived.id);
      const version = coherenceVersion(probe);
      await store.dispose();
      probe.exec("DROP TABLE coherence_vector");
      probe.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(legacyVersion);
      probe.exec(
        "CREATE TRIGGER coherence_items_update AFTER UPDATE ON items BEGIN UPDATE coherence_state SET version = version + 1 WHERE id = 1; END",
      );
      await store.init();
      expect(store.snapshot()).toEqual(snapshot);
      expect(await store.fetchArchive("milestones", archived.id)).toEqual(archive);
      expect((await store.worksetStore().snapshot()).roots).toEqual([`tasks:${task.id}`]);
      expect(probe.query("SELECT scope, record_json FROM plan_claims").all()).toEqual([
        { scope: "retained-claim", record_json: "{}" },
      ]);
      expect(probe.query("SELECT scope, record_json FROM plan_operations").all()).toEqual([
        { scope: "retained-operation", record_json: "{}" },
      ]);
      expect(probe.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: 7,
      });
      expect(coherenceVersion(probe)).toBe(version);
      await store.updateItem("tasks", task.id, { fields: { headline: "v7" } });
      expect(coherenceVersion(probe)).toBe(version + 1);
      expect(store.readCoherenceChanges(version).entries.map((entry) => entry.documentId)).toEqual([
        task.id,
      ]);
    } finally {
      probe.close();
      await store.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("archive and unarchive commit both document scopes at one version [Effectual-GoodCommunication]", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-coherence-archive-"));
  const dbPath = path.join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  const probe = openLedgerDb(dbPath);
  try {
    await store.init();
    const milestone = await store.createMilestone({ title: "archive" });
    const task = await store.createItem("tasks", milestone.id, {
      status: "done",
      fields: { headline: "archive" },
    });
    await store.updateMilestone(milestone.id, { status: "done" });
    const before = coherenceVersion(probe);
    await store.archiveMilestone(milestone.id, "archive");
    const archived = store.readCoherenceChanges(before);
    expect(archived.version).toBe(before + 1);
    expect(
      archived.entries.map((entry) => [entry.ledger, entry.documentId, entry.scope, entry.kind]),
    ).toEqual([
      ["milestones", milestone.id, "active", "delete"],
      ["milestones", milestone.id, "archived", "upsert"],
      ["tasks", task.id, "active", "delete"],
      ["tasks", task.id, "archived", "upsert"],
    ]);
    await store.unarchiveItem("tasks", milestone.id, task.id);
    expect(
      store
        .readCoherenceChanges(before + 1)
        .entries.map((entry) => [entry.scope, entry.kind, entry.version]),
    ).toEqual([
      ["active", "upsert", before + 2],
      ["archived", "delete", before + 2],
    ]);
  } finally {
    probe.close();
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
