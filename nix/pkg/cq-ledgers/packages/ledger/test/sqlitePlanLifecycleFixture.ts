import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedgerStore, type PlanClaimInput, type SqliteAccessRecord } from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

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
  let tick = 0;
  const store = new SqliteLedgerStore({
    dbPath, now: () => LIFECYCLE_NOW, monotonicNow: () => ++tick,
    accessObserver: { record: (record) => accesses.push(record) },
  });
  await store.init();
  await store.createItem("goals", "M-AMBIENT", {
    id: "G1", status: "clarifying", fields: { title: "keyed lifecycle", description: "selected goal" },
  });
  const db = openLedgerDb(dbPath);
  return {
    store, db, accesses,
    dispose: async () => { db.close(); await store.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}
