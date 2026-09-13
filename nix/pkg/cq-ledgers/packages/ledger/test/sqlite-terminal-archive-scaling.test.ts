import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteLedgerStore,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
  assertSqliteAccessContract,
  createLedgerMcpTools,
  type SqliteAccessRecord,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function callTool(
  store: SqliteLedgerStore,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = createLedgerMcpTools(store).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool not found: ${name}`);
  return tool.handler(args as never, null);
}

test("terminal archive touches only selected candidates and their incident gates and owners", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-terminal-archive-scaling-"));
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
    const milestone = await store.createMilestone({ title: "terminal scaling" });
    await store.createItem("tasks", milestone.id, {
      id: "T9901",
      status: "abandoned",
      fields: { headline: "unsatisfied gate" },
    });
    await store.createItem("tasks", milestone.id, {
      id: "T9902",
      status: "planned",
      fields: { headline: "active blocker", dependsOn: ["tasks:T9901"] },
    });
    await store.createItem("tasks", milestone.id, {
      id: "T9903",
      status: "done",
      fields: { headline: "archivable" },
    });
    await store.createItem("tasks", milestone.id, {
      id: "T9904",
      status: "done",
      fields: { headline: "active owner" },
    });
    await store.createItem("questions", milestone.id, {
      id: "Q9901",
      status: "open",
      fields: { question: "still active?" },
    });

    const db = openLedgerDb(dbPath);
    try {
      db.transaction(() => {
        db.query(
          "UPDATE items SET fields_json = ? WHERE ledger = 'questions' AND id = 'Q9901'",
        ).run(
          JSON.stringify({
            question: "still active?",
            [WORKSET_OWNER_REF_FIELD]: "tasks:T9904",
            [WORKSET_OWNER_EDGE_KIND_FIELD]: "exact-gate-question",
          }),
        );
        db.query(
          "INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M-unrelated', 'unrelated', '')",
        ).run();
        db.query(
          "INSERT INTO groups (ledger, id, title, description) VALUES ('defects', 'M-unrelated', 'unrelated', '')",
        ).run();
        const insertTask = db.query(
          `INSERT INTO items (
             ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session
           ) VALUES ('tasks', ?, 'M-unrelated', 'planned', ?, ?, ?, NULL, NULL)`,
        );
        const insertDefect = db.query(
          `INSERT INTO items (
             ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session
           ) VALUES ('defects', ?, 'M-unrelated', 'resolved', ?, ?, ?, NULL, NULL)`,
        );
        const timestamp = "2026-01-01T00:00:00.000Z";
        for (let index = 0; index < 10_000; index += 1) {
          insertTask.run(
            `TU${index}`,
            JSON.stringify({ headline: `active ${index}` }),
            timestamp,
            timestamp,
          );
          insertDefect.run(
            `DU${index}`,
            JSON.stringify({ headline: `unselected ${index}`, severity: "low" }),
            timestamp,
            timestamp,
          );
        }
      })();
    } finally {
      db.close();
    }

    accesses.length = 0;
    await expect(
      callTool(store, "archive_terminal_items", {
        ledger_ids: ["tasks"],
        summary: "fail on gate",
        gate_policy: "fail-on-active-gate",
      }),
    ).rejects.toThrow("tasks:T9902 still depends on non-satisfying tasks:T9901");
    expect(accesses.some(({ table, mode }) => table === "items" && mode === "write")).toBe(false);
    expect(accesses.some(({ rowKeys }) => rowKeys.includes("tasks:T9902"))).toBe(true);
    expect(accesses.some(({ rowKeys }) => rowKeys.includes("questions:Q9901"))).toBe(true);
    expect(
      accesses.some(({ rowKeys }) =>
        rowKeys.some((key) => key.includes("tasks:TU") || key.includes("defects:DU")),
      ),
    ).toBe(false);

    accesses.length = 0;
    await callTool(store, "archive_terminal_items", {
      ledger_ids: ["tasks"],
      summary: "retain gate and owner",
      gate_policy: "retain-active-gates",
    });
    for (const access of accesses) assertSqliteAccessContract(access);
    expect(store.fetchItem("tasks", "T9901").status).toBe("abandoned");
    expect(store.fetchItem("tasks", "T9904").status).toBe("done");
    expect(() => store.fetchItem("tasks", "T9903")).toThrow();
    const writes = accesses
      .filter(({ mode }) => mode === "write")
      .flatMap(({ rowKeys }) => rowKeys);
    expect(writes).toContain("tasks:T9903");
    expect(writes).toContain("tasks:M1:T9903");
    expect(writes).not.toContain("tasks:T9901");
    expect(writes).not.toContain("tasks:T9904");
    expect(writes.some((key) => key.includes("tasks:TU") || key.includes("defects:DU"))).toBe(
      false,
    );
  } finally {
    await store.dispose();
  }
});
