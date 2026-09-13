import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { FaultableWorkerProjection } from "./searchProjectionFaultFixture.js";

const DOCUMENTS = 20_000;

test("two stores over 20000 documents project only changed keys and do not replay acknowledged self versions [Blackbox-GoodCommunication]", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-scoped-coherence-"));
  const dbPath = path.join(root, "ledger.db");
  const writerProjection = new FaultableWorkerProjection();
  const readerProjection = new FaultableWorkerProjection();
  const writer = new SqliteLedgerStore({
    dbPath,
    searchProjectionFactory: () => writerProjection.projection,
  });
  const reader = new SqliteLedgerStore({
    dbPath,
    searchProjectionFactory: () => readerProjection.projection,
  });
  const notifications: string[] = [];
  try {
    await writer.init();
    await writer.createMilestone({ title: "large fixture" });
    const db = openLedgerDb(dbPath);
    try {
      db.transaction(() => {
        db.query(
          "INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M1', 'large fixture', '')",
        ).run();
        const insert =
          db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at)
          VALUES ('tasks', ?, 'M1', 'planned', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
        for (let index = 0; index < DOCUMENTS; index += 1)
          insert.run(`T${index + 1}`, JSON.stringify({ headline: `retained ${index}` }));
      })();
    } finally {
      db.close();
    }
    await writer.invalidate("tasks");
    await reader.init();
    reader.subscribeProjectionChanges((ledgerId) => {
      notifications.push(ledgerId);
    });
    writerProjection.commands.length = 0;
    readerProjection.commands.length = 0;
    await writer.updateItem("tasks", "T1", { fields: { headline: "changedonce" } });
    await writer.reconcileProjection();
    await writer.ftsSearch("changedonce");
    expect((await reader.ftsSearch("changedonce")).map((hit) => hit.item.id)).toEqual(["T1"]);
    await reader.reconcileProjection();
    expect(notifications).toEqual(["tasks"]);
    for (const fixture of [writerProjection, readerProjection]) {
      const writes = fixture.commands.filter(
        (command) => command.kind === "snapshot" || command.kind === "delta",
      );
      expect(writes).toHaveLength(1);
      const delta = writes[0]!;
      expect(delta.kind).toBe("delta");
      if (delta.kind !== "delta") throw new Error("Unrelated documents were rebuilt");
      expect(delta.changes).toHaveLength(1);
      expect(delta.changes[0]).toMatchObject({
        kind: "upsert",
        ledgerId: "tasks",
        archived: false,
        item: { id: "T1" },
      });
    }
    expect((await reader.ftsSearch("retained", { limit: DOCUMENTS })).length).toBe(DOCUMENTS - 1);
  } finally {
    await writer.dispose();
    await reader.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
