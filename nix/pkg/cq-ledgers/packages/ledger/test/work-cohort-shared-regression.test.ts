import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryWorkCohortStore } from "../src/workCohortStore.js";
import { createSqliteWorkCohortStore } from "../src/store/sqlite/sqliteWorkCohortStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema } from "../src/store/sqlite/schema.js";
import { workCohortAcceptanceContract } from "./workCohortAcceptanceContract.js";

workCohortAcceptanceContract("memory [Behavioral-Active Blackbox-Atomic]", async () => ({
  store: createInMemoryWorkCohortStore(), close: async () => undefined,
}));

workCohortAcceptanceContract("SQLite [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cq-cohort-acceptance-"));
  const db = openLedgerDb(join(directory, "ledger.db"));
  ensureSchema(db);
  return { store: await createSqliteWorkCohortStore(db), close: async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  } };
});
