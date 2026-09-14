import type { Database } from "bun:sqlite";
import { immediateWriteTransaction } from "./connection.js";

interface PlanRecordTable {
  readonly name: "plan_claims" | "plan_operations";
  readonly columns: string;
  readonly indexes: readonly string[];
}

const PLAN_RECORD_TABLES: readonly PlanRecordTable[] = [
  {
    name: "plan_claims",
    columns: `
      goal_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.goalId')) STORED NOT NULL,
      claim_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.claimId')) STORED NOT NULL,
      claim_request_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.claimRequestId')) STORED NOT NULL,
      generation INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.generation')) STORED NOT NULL,
      state TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.state')) STORED NOT NULL
    `,
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS plan_claims_request_identity ON plan_claims (goal_id, claim_request_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS plan_claims_claim_identity ON plan_claims (goal_id, claim_id, generation)",
      "CREATE UNIQUE INDEX IF NOT EXISTS plan_claims_active_goal ON plan_claims (goal_id) WHERE state = 'active'",
    ],
  },
  {
    name: "plan_operations",
    columns: `
      goal_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.replay.goalId')) STORED NOT NULL,
      claim_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.replay.claimId')) STORED NOT NULL,
      generation INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.replay.generation')) STORED NOT NULL,
      operation_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.replay.operation')) STORED NOT NULL,
      operation_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.replay.operationId')) STORED NOT NULL
    `,
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS plan_operations_replay_identity ON plan_operations (goal_id, claim_id, generation, operation_kind, operation_id)",
    ],
  },
];

export function ensurePlanRecordTables(db: Database): void {
  immediateWriteTransaction(db, () => {
    for (const table of PLAN_RECORD_TABLES) {
      const columns = db.query(`PRAGMA table_xinfo(${table.name})`).all() as Array<{ name: string }>;
      const legacy = columns.length > 0 && !columns.some(({ name }) => name === "goal_id");
      if (legacy) db.exec(`ALTER TABLE ${table.name} RENAME TO ${table.name}_v7`);
      db.exec(`CREATE TABLE IF NOT EXISTS ${table.name} (
        scope TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        ${table.columns}
      )`);
      if (legacy) {
        // Rebuilding materializes identities once while retaining the exact payload bytes.
        db.exec(`INSERT INTO ${table.name} (scope, record_json)
          SELECT scope, record_json FROM ${table.name}_v7`);
        db.exec(`DROP TABLE ${table.name}_v7`);
      }
      // D472: Bun.exec can mask an earlier error in a multi-statement script.
      for (const index of table.indexes) db.query(index).run();
    }
  });
}
