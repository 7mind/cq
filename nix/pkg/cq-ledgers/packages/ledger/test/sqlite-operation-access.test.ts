import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteAccessContractError,
  SqliteLedgerStore,
  assertSqliteAccessContract,
  createLedgerMcpTools,
  type SqliteAccessRecord,
} from "../src/index.js";

function scratchPath(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `${name}-`)), "ledger.db");
}

function monotonicNow(): () => number {
  let tick = 0;
  return () => ++tick;
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

function observedStore(name: string, accesses: SqliteAccessRecord[]): SqliteLedgerStore {
  return new SqliteLedgerStore({
    dbPath: scratchPath(name),
    monotonicNow: monotonicNow(),
    accessObserver: { record: (record) => accesses.push(record) },
  });
}

function assertTrace(trace: readonly SqliteAccessRecord[]): void {
  expect(trace.length).toBeGreaterThan(0);
  for (const access of trace) {
    assertSqliteAccessContract(access);
    expect(access.keyedPredicate.keys.length).toBeGreaterThan(0);
    expect(access.count).toBe(access.rowKeys.length);
  }
}

describe("SQLite generic-mutation keyed access", () => {
  test("ordinary update touches metadata, its closure, and document deltas without table sweeps", async () => {
    const accesses: SqliteAccessRecord[] = [];
    const store = observedStore("sqlite-access-ordinary", accesses);
    await store.init();
    const milestone = await store.createMilestone({ title: "ordinary" });
    await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "target" },
      id: "T9101",
    });
    await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "unrelated" },
      id: "T9102",
    });

    await callTool(createLedgerMcpTools(store), "update_item", {
      ledger_id: "tasks",
      item_id: "T9101",
      fields: { headline: "changed" },
    });

    assertTrace(accesses);
    expect(accesses.every(({ accessClass }) => accessClass === "ordinary")).toBe(true);
    expect(
      accesses.some(
        ({ table, mode, rowKeys }) =>
          table === "items" && mode === "write" && rowKeys.includes("tasks:T9101"),
      ),
    ).toBe(true);
    expect(accesses.some(({ rowKeys }) => rowKeys.some((key) => key.includes("T9102")))).toBe(
      false,
    );
    expect(
      accesses.some(
        ({ table, mode }) =>
          ["items", "groups", "archived_items", "item_references"].includes(table) &&
          mode === "sweep",
      ),
    ).toBe(false);
    await store.dispose();
  });

  test("archive_milestone scales through the selected milestone member range", async () => {
    const accesses: SqliteAccessRecord[] = [];
    const store = observedStore("sqlite-access-milestone", accesses);
    await store.init();
    const milestone = await store.createMilestone({ title: "archive" });
    await store.createItem("tasks", milestone.id, {
      status: "done",
      fields: { headline: "member" },
      id: "T9201",
    });
    await store.updateMilestone(milestone.id, { status: "done" });

    await callTool(createLedgerMcpTools(store), "archive_milestone", {
      milestone_id: milestone.id,
      summary: "complete",
    });

    assertTrace(accesses);
    expect(accesses.every(({ accessClass }) => accessClass === "archive_milestone")).toBe(true);
    expect(
      accesses.some(
        ({ table, mode, keyedPredicate, rowKeys }) =>
          table === "items" &&
          mode === "sweep" &&
          keyedPredicate.kind === "milestone-members" &&
          keyedPredicate.keys.includes(milestone.id) &&
          rowKeys.includes("tasks:T9201"),
      ),
    ).toBe(true);
    await store.dispose();
  });

  test("archive_terminal_items uses only selected-ledger/status ranges and affected archives", async () => {
    const accesses: SqliteAccessRecord[] = [];
    const store = observedStore("sqlite-access-terminal", accesses);
    await store.init();
    const milestone = await store.createMilestone({ title: "terminal" });
    await store.createItem("tasks", milestone.id, {
      status: "done",
      fields: { headline: "terminal" },
      id: "T9301",
    });
    await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "active" },
      id: "T9302",
    });

    await callTool(createLedgerMcpTools(store), "archive_terminal_items", {
      ledger_ids: ["tasks"],
      summary: "terminal sweep",
      gate_policy: "fail-on-active-gate",
    });

    assertTrace(accesses);
    expect(
      accesses.some(
        ({ accessClass, table, mode, keyedPredicate, rowKeys }) =>
          accessClass === "archive_terminal_items" &&
          table === "items" &&
          mode === "sweep" &&
          keyedPredicate.kind === "selected-ledger-status" &&
          keyedPredicate.keys.includes("tasks:done") &&
          rowKeys.includes("tasks:T9301"),
      ),
    ).toBe(true);
    expect(accesses.some(({ rowKeys }) => rowKeys.some((key) => key.includes("T9302")))).toBe(
      false,
    );
    await store.dispose();
  });

  test("undeclared scans of guarded tables fail the access contract", () => {
    for (const table of [
      "items",
      "groups",
      "archived_items",
      "archive_pointers",
      "item_references",
    ]) {
      expect(() =>
        assertSqliteAccessContract({
          accessClass: "ordinary",
          operation: "update-item",
          phase: "transaction",
          table,
          mode: "sweep",
          keyedPredicate: { kind: "keys", keys: ["all"] },
          rowKeys: [],
          count: 0,
        }),
      ).toThrow(SqliteAccessContractError);
    }
  });
});
