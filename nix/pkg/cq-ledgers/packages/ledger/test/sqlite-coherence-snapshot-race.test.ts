import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import {
  coherenceVersion,
  immediateWriteTransaction,
  openLedgerDb,
} from "../src/store/sqlite/connection.js";
import {
  captureSqliteCoherenceSnapshot,
  readSqliteCoherence,
  recordSqliteCoherence,
} from "../src/store/sqlite/coherenceVector.js";

test("a commit between snapshot high water and document reads is recovered from the vector [Effectual-GoodCommunication]", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-coherence-snapshot-"));
  const dbPath = path.join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  const reader = openLedgerDb(dbPath);
  const writer = openLedgerDb(dbPath);
  try {
    await store.init();
    const milestone = await store.createMilestone({ title: "snapshot" });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "before" },
    });
    const snapshot = captureSqliteCoherenceSnapshot(reader, () => {
      immediateWriteTransaction(writer, () => {
        writer
          .query("UPDATE items SET fields_json = ? WHERE ledger = 'tasks' AND id = ?")
          .run(JSON.stringify({ headline: "racing" }), task.id);
        recordSqliteCoherence(writer, "racing-writer", [
          { ledger: "tasks", documentId: task.id, scope: "active", kind: "upsert" },
        ]);
      });
      return reader
        .query("SELECT fields_json FROM items WHERE ledger = 'tasks' AND id = ?")
        .get(task.id) as { fields_json: string };
    });
    expect(JSON.parse(snapshot.documents.fields_json)).toEqual({ headline: "before" });
    const newer = readSqliteCoherence(reader, snapshot.version, coherenceVersion(reader));
    expect(newer).toEqual([
      {
        ledger: "tasks",
        documentId: task.id,
        scope: "active",
        kind: "upsert",
        origin: "racing-writer",
        version: snapshot.version + 1,
      },
    ]);
    expect(store.fetchItem("tasks", task.id).fields.headline).toBe("racing");
  } finally {
    reader.close();
    writer.close();
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
