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

function scratchPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-generic-mutation-scaling-"));
  roots.push(root);
  return path.join(root, "ledger.db");
}

async function callTool(
  store: SqliteLedgerStore,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = createLedgerMcpTools(store).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool not found: ${name}`);
  return tool.handler(args as never, null);
}

async function ordinaryMutationFixture(unrelatedRows: number): Promise<{
  readonly headline: unknown;
  readonly accessKeys: readonly string[];
}> {
  const accesses: SqliteAccessRecord[] = [];
  const dbPath = scratchPath();
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
    const milestone = await store.createMilestone({ title: "ordinary scaling" });
    await store.createItem("tasks", milestone.id, {
      id: "T9801",
      status: "planned",
      fields: { headline: "before" },
    });
    await store.replaceWorksetRoots(["tasks:T9801"]);

    const db = openLedgerDb(dbPath);
    try {
      db.transaction(() => {
        db.query(
          "INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M-unrelated', 'unrelated', '')",
        ).run();
        db.query(
          `INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at)
           VALUES ('tasks', 'M-unrelated-archive', 'unrelated', 'unrelated', 'done', ?)`,
        ).run("2026-01-01T00:00:00.000Z");
        const insertActive = db.query(
          `INSERT INTO items (
             ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session
           ) VALUES ('tasks', ?, 'M-unrelated', 'planned', ?, ?, ?, NULL, NULL)`,
        );
        const insertArchived = db.query(
          `INSERT INTO archived_items (
             ledger, pointer_id, id, milestone_id, status, fields_json,
             created_at, updated_at, author, session
           ) VALUES ('tasks', 'M-unrelated-archive', ?, 'M-unrelated-archive', 'done', ?, ?, ?, NULL, NULL)`,
        );
        const timestamp = "2026-01-01T00:00:00.000Z";
        for (let index = 0; index < unrelatedRows / 2; index += 1) {
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
    } finally {
      db.close();
    }

    accesses.length = 0;
    await callTool(store, "update_item", {
      ledger_id: "tasks",
      item_id: "T9801",
      fields: { headline: "after" },
    });
    for (const access of accesses) assertSqliteAccessContract(access);
    return {
      headline: store.fetchItem("tasks", "T9801").fields.headline,
      accessKeys: accesses
        .flatMap((access) => [
          ...access.keyedPredicate.keys.map(
            (key) =>
              `predicate:${access.table}:${access.mode}:${access.keyedPredicate.kind}:${key}`,
          ),
          ...access.rowKeys.map((key) => `row:${access.table}:${access.mode}:${key}`),
        ])
        .sort(),
    };
  } finally {
    await store.dispose();
  }
}

test("ordinary keyed mutation has size-independent domain results and access keys", async () => {
  const small = await ordinaryMutationFixture(0);
  const large = await ordinaryMutationFixture(20_000);
  expect(large.headline).toBe("after");
  expect(large).toEqual(small);
});

test("sqlite generic mutation uses keyed operation plans", async () => {
  const accesses: SqliteAccessRecord[] = [];
  const store = new SqliteLedgerStore({
    dbPath: scratchPath(),
    monotonicNow: (() => {
      let tick = 0;
      return () => ++tick;
    })(),
    accessObserver: { record: (record) => accesses.push(record) },
  });
  await store.init();
  try {
    const milestone = await store.createMilestone({ title: "archive amplification" });
    await store.createItem("tasks", milestone.id, {
      id: "T9701",
      status: "done",
      fields: { headline: "already archived" },
    });
    await store.createItem("tasks", milestone.id, {
      id: "T9702",
      status: "planned",
      fields: { headline: "new terminal item" },
    });
    await callTool(store, "archive_terminal_items", {
      ledger_ids: ["tasks"],
      summary: "first archive",
      gate_policy: "fail-on-active-gate",
    });
    await callTool(store, "update_item", {
      ledger_id: "tasks",
      item_id: "T9702",
      status: "done",
    });

    accesses.length = 0;
    await callTool(store, "archive_terminal_items", {
      ledger_ids: ["tasks"],
      summary: "second archive",
      gate_policy: "fail-on-active-gate",
    });
    const archiveWrites = accesses
      .filter(({ table, mode }) => table === "archived_items" && mode === "write")
      .flatMap(({ rowKeys }) => rowKeys);
    expect(archiveWrites).toContain("tasks:M1:T9702");
    expect(archiveWrites).not.toContain("tasks:M1:T9701");
  } finally {
    await store.dispose();
  }
});
