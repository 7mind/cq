import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteLedgerStore,
  createLedgerMcpTools,
  createSqliteOperationMeasurement,
  type SqliteOperationRecord,
} from "../src/index.js";
import { immediateWriteTransaction, openLedgerDb } from "../src/store/sqlite/connection.js";

function tickingClock(): () => number {
  let tick = 0;
  return () => ++tick;
}

function scratchPath(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `${name}-`)), "ledger.db");
}

type Tools = ReturnType<typeof createLedgerMcpTools>;

async function callTool(
  tools: Tools,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const selected = tools.find((tool) => tool.name === name);
  if (selected === undefined) throw new Error(`tool not found: ${name}`);
  return selected.handler(args as never, null);
}

describe("SQLite structured operation timing", () => {
  test("one MCP mutation record spans admission through usage telemetry", async () => {
    const records: SqliteOperationRecord[] = [];
    const store = new SqliteLedgerStore({
      dbPath: scratchPath("sqlite-operation-timing"),
      monotonicNow: tickingClock(),
      operationObserver: { record: (record) => records.push(record) },
    });
    await store.init();
    const milestone = await store.createMilestone({ title: "timed" });
    await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "before" },
      id: "T9001",
    });

    await callTool(createLedgerMcpTools(store), "update_item", {
      ledger_id: "tasks",
      item_id: "T9001",
      fields: { headline: "after" },
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      endpoint: "update_item",
      operation: "update-item",
      outcome: "success",
      queueDelayMs: 1,
      lockWaitMs: 1,
      transactionMs: 1,
      projectionMs: 1,
      notificationMs: 1,
      telemetryMs: 1,
      totalMs: expect.any(Number),
    });
    expect(records[0]!.totalMs).toBeGreaterThanOrEqual(
      records[0]!.queueDelayMs +
        records[0]!.lockWaitMs +
        records[0]!.transactionMs +
        records[0]!.projectionMs +
        records[0]!.notificationMs +
        records[0]!.telemetryMs,
    );
    await store.dispose();
  });

  test("usage UPSERT time is attributed only to telemetry", async () => {
    const records: SqliteOperationRecord[] = [];
    const store = new SqliteLedgerStore({
      dbPath: scratchPath("sqlite-usage-timing"),
      monotonicNow: tickingClock(),
      operationObserver: { record: (record) => records.push(record) },
    });
    await store.init();

    await callTool(createLedgerMcpTools(store), "enumerate_ledgers", {});

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      endpoint: "enumerate_ledgers",
      operation: "enumerate_ledgers",
      outcome: "success",
      queueDelayMs: 0,
      lockWaitMs: 0,
      transactionMs: 0,
      projectionMs: 0,
      notificationMs: 0,
      telemetryMs: 1,
    });
    await store.dispose();
  });

  test("held-writer failures accrue lock wait without transaction-body time", () => {
    const dbPath = scratchPath("sqlite-lock-timing");
    const holder = openLedgerDb(dbPath);
    const contender = openLedgerDb(dbPath);
    holder.exec("CREATE TABLE timed (id INTEGER PRIMARY KEY)");
    contender.exec("PRAGMA busy_timeout = 0");
    const records: SqliteOperationRecord[] = [];
    const measurement = createSqliteOperationMeasurement({
      endpoint: "direct",
      monotonicNow: tickingClock(),
      operationObserver: { record: (record) => records.push(record) },
      accessObserver: null,
    });
    measurement.setOperation("held-writer");
    holder.exec("BEGIN IMMEDIATE");
    try {
      expect(() => immediateWriteTransaction(contender, () => undefined, 3, measurement)).toThrow();
      measurement.finish("error");
      expect(records[0]).toMatchObject({
        outcome: "error",
        lockWaitMs: 3,
        transactionMs: 0,
      });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      contender.close();
    }
  });

  test("observer failure changes neither successful nor throwing domain outcomes", async () => {
    const store = new SqliteLedgerStore({
      dbPath: scratchPath("sqlite-observer-failure"),
      monotonicNow: tickingClock(),
      operationObserver: {
        record(): void {
          throw new Error("operation observer failed");
        },
      },
      accessObserver: {
        record(): void {
          throw new Error("access observer failed");
        },
      },
    });
    await store.init();
    const milestone = await store.createMilestone({ title: "observer" });
    await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "before" },
      id: "T9002",
    });
    const tools = createLedgerMcpTools(store);

    await expect(
      callTool(tools, "update_item", {
        ledger_id: "tasks",
        item_id: "T9002",
        fields: { headline: "after" },
      }),
    ).resolves.toBeDefined();
    await expect(
      callTool(tools, "update_item", {
        ledger_id: "tasks",
        item_id: "T404",
        fields: { headline: "missing" },
      }),
    ).rejects.toThrow("T404");
    expect(store.fetchItem("tasks", "T9002").fields.headline).toBe("after");
    await store.dispose();
  });
});
