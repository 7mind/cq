import { describe, expect, test } from "bun:test";
import { orderedPostgresRowLocks, lockPostgresRows, type PostgresRowLock } from "../src/store/postgres/rowLocks.js";
import { postgresLifecycleRowFixture } from "./postgresLifecycleRowFixture.js";

test("PostgreSQL lock ordering normalizes reversed requests and combines incompatible modes [T5917 Behavioral-Active Blackbox-Atomic]", () => {
  const requests: readonly PostgresRowLock[] = [
    { target: { table: "ledgers", ledgerId: "tasks" }, mode: "update" },
    { target: { table: "items", ledgerId: "goals", id: "G2" }, mode: "update" },
    { target: { table: "items", ledgerId: "milestones", id: "M1" }, mode: "share" },
    { target: { table: "items", ledgerId: "goals", id: "G1" }, mode: "no-key-update" },
    { target: { table: "items", ledgerId: "goals", id: "G1" }, mode: "share" },
    { target: { table: "items", ledgerId: "milestones", id: "M1" }, mode: "key-share" },
  ];
  const ordered = orderedPostgresRowLocks(requests);
  expect(ordered).toEqual(orderedPostgresRowLocks([...requests].reverse()));
  expect(ordered).toEqual([requests[2]!, { target: requests[3]!.target, mode: "update" }, requests[1]!, requests[0]!]);
  expect(() => orderedPostgresRowLocks([{ target: { table: "ledgers", ledgerId: "" }, mode: "update" }])).toThrow("empty identity");
  expect(orderedPostgresRowLocks([])).toEqual([]);
});

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL selected row locks [T5917 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("acquires only declared existing identities in deterministic order", async () => {
    const fixture = await postgresLifecycleRowFixture();
    try {
      const requests: readonly PostgresRowLock[] = [
        { target: { table: "plan_claims", scope: "G1\u0000request-G1" }, mode: "update" },
        { target: { table: "groups", ledgerId: "tasks", id: "M1" }, mode: "share" },
        { target: { table: "ledgers", ledgerId: "tasks" }, mode: "no-key-update" },
        { target: { table: "items", ledgerId: "goals", id: "G1" }, mode: "update" },
        { target: { table: "items", ledgerId: "goals", id: "G-missing" }, mode: "share" },
      ];
      await fixture.pool.begin(async (tx) => { await lockPostgresRows(fixture.queries(tx), requests); });
      expect(fixture.accesses.map(({ table, rowKeys, lockMode }) => ({ table, rowKeys, lockMode }))).toEqual([
        { table: "items", rowKeys: [], lockMode: "share" },
        { table: "items", rowKeys: ["goals:G1"], lockMode: "update" },
        { table: "ledgers", rowKeys: ["tasks"], lockMode: "no-key-update" },
        { table: "groups", rowKeys: ["tasks:M1"], lockMode: "share" },
        { table: "plan_claims", rowKeys: ["G1\u0000request-G1"], lockMode: "update" },
      ]);
      expect(fixture.accesses.every(({ projectKey, mode }) => projectKey === fixture.projectKey && mode === "read")).toBe(true);
    } finally { await fixture.dispose(); }
  });
});
