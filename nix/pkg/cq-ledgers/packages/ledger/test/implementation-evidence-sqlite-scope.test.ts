import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createInMemoryImplementationEvidenceStore,
  createLedgerMcpTools,
  protectLedgerStoreWithImplementationEvidence,
  SqliteLedgerStore,
  type SqliteAccessRecord,
  type SqliteOperationRecord,
} from "../src/index.js";

for (const observed of [false, true]) {
  test(`D462 protected SQLite preserves keyed mutation scope with observation=${observed} [Blackbox-GoodCommunication]`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "protected-sqlite-scope-"));
    const accesses: SqliteAccessRecord[] = [];
    const operations: SqliteOperationRecord[] = [];
    const raw = new SqliteLedgerStore({
      dbPath: path.join(root, "ledger.db"),
      ...(observed
        ? {
            monotonicNow: () => performance.now(),
            accessObserver: { record: (record: SqliteAccessRecord) => accesses.push(record) },
            operationObserver: {
              record: (record: SqliteOperationRecord) => operations.push(record),
            },
          }
        : {}),
    });
    try {
      await raw.init();
      const store = protectLedgerStoreWithImplementationEvidence(
        raw,
        createInMemoryImplementationEvidenceStore(),
      );
      const tools = createLedgerMcpTools(store);
      const create = tools.find((tool) => tool.name === "create_item");
      const update = tools.find((tool) => tool.name === "update_item");
      if (create === undefined || update === undefined) throw new Error("Missing mutation tools");
      await create.handler(
        {
          ledger_id: "milestones",
          id: "M900",
          status: "open",
          fields: { title: "protected creation" },
        },
        null,
      );
      await create.handler(
        {
          ledger_id: "tasks",
          milestone_id: "M900",
          id: "T900",
          status: "planned",
          fields: { headline: "before" },
        },
        null,
      );
      await update.handler(
        { ledger_id: "tasks", item_id: "T900", fields: { headline: "after" } },
        null,
      );
      expect(raw.fetchItem("milestones", "M900").fields.title).toBe("protected creation");
      expect(raw.fetchItem("tasks", "T900").fields.headline).toBe("after");
      expect((await raw.ftsSearch("after", { ledger: "tasks" })).map((hit) => hit.item.id)).toEqual(
        ["T900"],
      );
      if (observed) {
        expect(operations.map((record) => record.operation)).toEqual([
          "create-milestone",
          "create-item",
          "update-item",
        ]);
        expect(operations.every((record) => record.outcome === "success")).toBe(true);
        expect(accesses.some((record) => record.rowKeys.includes("tasks:T900"))).toBe(true);
        expect(accesses.every((record) => record.operation !== "generic-mutation")).toBe(true);
      } else {
        expect(accesses).toEqual([]);
        expect(operations).toEqual([]);
      }
    } finally {
      await raw.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
