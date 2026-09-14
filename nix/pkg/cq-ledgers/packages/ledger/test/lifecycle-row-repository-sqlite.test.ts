import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { immediateWriteTransaction, openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema } from "../src/store/sqlite/schema.js";
import { createSqliteLifecycleRowRepository } from "../src/store/sqlite/lifecycleRowRepository.js";
import {
  assertSqliteAccessContract, createSqliteOperationMeasurement, type SqliteAccessRecord,
} from "../src/store/sqlite/operationObservability.js";
import {
  LIFECYCLE_ARCHIVED_ITEM, LIFECYCLE_LEDGER_METADATA, LIFECYCLE_PUBLIC_ITEMS,
  lifecycleClaim, lifecycleOperation, runLifecycleRowRepositoryContract,
  type LifecycleRowsFixture,
} from "./lifecycleRowRepositoryContract.js";

async function sqliteFixture(accesses: SqliteAccessRecord[]): Promise<LifecycleRowsFixture> {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-row-repository-"));
  const db = openLedgerDb(join(root, "ledger.db"));
  ensureSchema(db);
  let tick = 0;
  const rows = createSqliteLifecycleRowRepository(db, createSqliteOperationMeasurement({
    endpoint: "lifecycle-contract", monotonicNow: () => ++tick, operationObserver: null,
    accessObserver: { record: (record) => accesses.push(record) },
  }));
  immediateWriteTransaction(db, () => {
    const ledger = db.query("INSERT INTO ledgers VALUES (?, ?, ?, ?)");
    for (const metadata of LIFECYCLE_LEDGER_METADATA) {
      ledger.run(metadata.id, JSON.stringify(metadata.schema), metadata.counters.milestone, metadata.counters.item);
    }
    const group = db.query("INSERT OR IGNORE INTO groups VALUES (?, ?, ?, ?)");
    const item = db.query("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const entry of LIFECYCLE_PUBLIC_ITEMS) {
      const value = entry.item;
      group.run(entry.ledgerId, value.milestoneId, "members", "selected");
      item.run(entry.ledgerId, value.id, value.milestoneId, value.status, JSON.stringify(value.fields), value.createdAt, value.updatedAt, null, null);
    }
    const archived = LIFECYCLE_ARCHIVED_ITEM;
    db.query("INSERT INTO archive_pointers VALUES (?, ?, ?, ?, ?, ?)").run("tasks", "M2", "archive", "archive", "done", "now");
    db.query("INSERT INTO archived_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "tasks", "M2", archived.id, archived.milestoneId, archived.status, JSON.stringify(archived.fields), archived.createdAt, archived.updatedAt, null, null,
    );
    rows.persistPrivateRecords({ claims: [lifecycleClaim("G1"), lifecycleClaim("G2")], operations: [lifecycleOperation("existing")] });
  });
  accesses.length = 0;
  return {
    rows,
    transaction: (body) => immediateWriteTransaction(db, body),
    dispose: async () => { db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

runLifecycleRowRepositoryContract("real SQLite / GoodCommunication", () => sqliteFixture([]));

test("every lifecycle repository access reports exact keys and private sweeps are forbidden [T5541]", async () => {
  const accesses: SqliteAccessRecord[] = [];
  const fixture = await sqliteFixture(accesses);
  try {
    const claim = lifecycleClaim("G1");
    fixture.rows.publicRows.fetchActiveItem("goals:G1");
    fixture.rows.publicRows.fetchArchivedItem("tasks:T2");
    fixture.rows.publicRows.referenceSources("goals:G1", ["worksetOwnerRef"]);
    fixture.rows.fetchGroup("tasks", "M1");
    fixture.rows.taskRefsByMilestones(["M1"]);
    fixture.rows.fetchClaimByRequest(claim);
    fixture.rows.fetchClaimByIdentity(claim);
    fixture.rows.fetchActiveClaim("G1");
    fixture.rows.fetchOperation(lifecycleOperation("existing").replay);
    fixture.transaction(() => fixture.rows.persistPrivateRecords({ claims: [{ ...claim, state: "released" }], operations: [lifecycleOperation("observed")] }));
    expect(accesses).toHaveLength(12);
    for (const access of accesses) {
      expect(access.count).toBe(1);
      expect(access.mode).not.toBe("sweep");
      expect(access.keyedPredicate.keys.length).toBeGreaterThan(0);
      expect(() => assertSqliteAccessContract(access)).not.toThrow();
    }
    for (const table of ["plan_claims", "plan_operations"]) {
      expect(() => assertSqliteAccessContract({ ...accesses[0]!, table, mode: "sweep" })).toThrow("undeclared");
    }
  } finally { await fixture.dispose(); }
});
