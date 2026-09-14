import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedgerStore, type PlanClaimInput, type SqliteAccessRecord, type SqliteOperationRecord } from "../src/index.js";
import { createWorkerSearchProjection } from "../src/search/WorkerSearchProjection.js";
import { SEARCH_PROJECTION_COMMAND_DEADLINE_MS } from "../src/search/SearchProjection.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { lifecycleProjectionEffects, type LifecycleProjectionEffect } from "./lifecycleBoundsMeasurement.js";

export const LIFECYCLE_NOW = "2026-09-14T00:00:00.000Z";
export const LIFECYCLE_PROVENANCE = { author: "T5542", session: "keyed-plan-lifecycle" };
export const LIFECYCLE_CLAIM_INPUT: PlanClaimInput = {
  goalId: "G1", purpose: "initial", claimRequestId: "request-G1", ownerFenceToken: "A".repeat(43),
  expectedGeneration: null, ...LIFECYCLE_PROVENANCE,
};

export async function sqlitePlanLifecycleFixture() {
  const root = await mkdtemp(join(tmpdir(), "sqlite-keyed-lifecycle-"));
  const dbPath = join(root, "ledger.db");
  const accesses: SqliteAccessRecord[] = [];
  const operations: SqliteOperationRecord[] = [];
  const projectionEffects: LifecycleProjectionEffect[] = [];
  const store = new SqliteLedgerStore({
    dbPath, now: () => LIFECYCLE_NOW, monotonicNow: () => performance.now(),
    accessObserver: { record: (record) => accesses.push(record) },
    operationObserver: { record: (record) => operations.push(record) },
    searchProjectionFactory: () => {
      const projection = createWorkerSearchProjection(SEARCH_PROJECTION_COMMAND_DEADLINE_MS);
      return {
        execute: (command) => { projectionEffects.push(...lifecycleProjectionEffects(command)); return projection.execute(command); },
        health: () => projection.health(),
      };
    },
  });
  await store.init();
  await store.createItem("goals", "M-AMBIENT", {
    id: "G1", status: "clarifying", fields: { title: "keyed lifecycle", description: "selected goal" },
  });
  const db = openLedgerDb(dbPath);
  return {
    store, db, accesses, operations, projectionEffects,
    dispose: async () => { db.close(); await store.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}
