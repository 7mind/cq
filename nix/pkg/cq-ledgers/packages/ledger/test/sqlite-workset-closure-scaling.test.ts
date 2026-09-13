import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteLedgerStore,
  assertSqliteAccessContract,
  createLedgerMcpTools,
  type SqliteAccessRecord,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function planDetails(rows: unknown[]): string[] {
  return rows.map((row) => (row as { detail: string }).detail);
}

test("sqlite generic mutation closure access is independent of unrelated rows", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-workset-closure-scaling-"));
  roots.push(root);
  const dbPath = path.join(root, "ledger.db");
  const accesses: SqliteAccessRecord[] = [];
  const store = new SqliteLedgerStore({
    dbPath,
    monotonicNow: (() => {
      let tick = 0;
      return () => ++tick;
    })(),
    accessObserver: { record: (record) => accesses.push(record) },
  });
  await store.init();
  try {
    const milestone = await store.createMilestone({ title: "selected" });
    await store.createItem("tasks", milestone.id, {
      id: "T9601",
      status: "planned",
      fields: { headline: "selected" },
    });
    await store.replaceWorksetRoots(["tasks:T9601"]);

    const db = openLedgerDb(dbPath);
    try {
      db.transaction(() => {
        db.query(
          "INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M-unused', 'unused', '')",
        ).run();
        db.query(
          `INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at)
         VALUES ('tasks', 'M-archived', 'unused', 'unused', 'done', '2026-01-01T00:00:00.000Z')`,
        ).run();
        const insertActive = db.query(
          `INSERT INTO items (
           ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session
         ) VALUES ('tasks', ?, 'M-unused', 'planned', ?, ?, ?, NULL, NULL)`,
        );
        const insertArchived = db.query(
          `INSERT INTO archived_items (
           ledger, pointer_id, id, milestone_id, status, fields_json,
           created_at, updated_at, author, session
         ) VALUES ('tasks', 'M-archived', ?, 'M-archived', 'done', ?, ?, ?, NULL, NULL)`,
        );
        const timestamp = "2026-01-01T00:00:00.000Z";
        for (let index = 0; index < 10_000; index += 1) {
          insertActive.run(
            `TU${index}`,
            JSON.stringify({ headline: `active ${index}` }),
            timestamp,
            timestamp,
          );
          insertArchived.run(
            `TA${index}`,
            JSON.stringify({ headline: `archived ${index}` }),
            timestamp,
            timestamp,
          );
        }
      })();

      const milestoneMembers = planDetails(
        db
          .query(
            "EXPLAIN QUERY PLAN SELECT ledger, id FROM items WHERE milestone_id = ? ORDER BY ledger, id",
          )
          .all("M1"),
      );
      const terminalItems = planDetails(
        db
          .query(
            "EXPLAIN QUERY PLAN SELECT ledger, id FROM items WHERE ledger = ? AND status = ? ORDER BY id",
          )
          .all("tasks", "done"),
      );
      const archivedTarget = planDetails(
        db
          .query(
            "EXPLAIN QUERY PLAN SELECT pointer_id FROM archived_items WHERE ledger = ? AND id = ?",
          )
          .all("tasks", "T1"),
      );

      expect(milestoneMembers.join("\n")).toContain("items_milestone_membership");
      expect(terminalItems.join("\n")).toContain("items_ledger_status");
      expect(archivedTarget.join("\n")).toContain("archived_items_target");

      accesses.length = 0;
      const update = createLedgerMcpTools(store).find(({ name }) => name === "update_item");
      if (update === undefined) throw new Error("update_item tool is required");
      await update.handler(
        { ledger_id: "tasks", item_id: "T9601", fields: { headline: "changed" } },
        null,
      );
      expect(accesses.length).toBeGreaterThan(0);
      for (const access of accesses) assertSqliteAccessContract(access);
      expect(
        accesses.some(({ rowKeys }) =>
          rowKeys.some((key) => key.includes("tasks:TU") || key.includes("tasks:TA")),
        ),
      ).toBe(false);
      expect(
        accesses.some(
          ({ table, mode, rowKeys }) =>
            table === "items" && mode === "write" && rowKeys.includes("tasks:T9601"),
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  } finally {
    await store.dispose();
  }
});
