/**
 * Foundation test for the multi-tenant Postgres store (T572, G81/M248):
 * `ensureSchema` idempotency (identical catalog state across two runs, plus
 * the per-database `meta.schema_version` row) and DDL-race safety (two
 * concurrent connecting instances both succeed under the pg_advisory_lock in
 * connection.ts's `withAdvisoryLock`).
 *
 * Env-gated on CQ_TEST_PG_URL (Q286): there is no Postgres server in this
 * sandbox/CI environment, so the suite below SKIPS here — `bun run check`
 * stays green offline. When CQ_TEST_PG_URL points at a real (throwaway)
 * Postgres database, this suite exercises the live path.
 */

import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { openPgPool } from "../src/store/postgres/connection.js";
import { ensureSchema, PG_SCHEMA_VERSION } from "../src/store/postgres/schema.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
}

async function catalogSnapshot(pool: ReturnType<typeof openPgPool>): Promise<ColumnRow[]> {
  return await pool<ColumnRow[]>`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;
}

describe.skipIf(!PG_URL)("postgres schema (T572)", () => {
  test("keyed mutation schema exposes tenant-prefixed closure and private-identity indexes [T5916]", async () => {
    const pool = openPgPool(PG_URL!);
    try {
      await ensureSchema(pool);
      const indexes = await pool<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()
      `;
      for (const [name, columns] of [
        ["items_ledger_status", "project_key, ledger, status, id"],
        ["items_milestone", "project_key, milestone_id, ledger, id"],
        ["archived_items_target", "project_key, ledger, id, pointer_id"],
        ["archived_items_milestone", "project_key, milestone_id, ledger, id"],
        ["archive_pointers_milestone", "project_key, id, ledger"],
        ["item_references_pkey", "project_key, source_ledger, source_id, field_name, target_ledger, target_id"],
        ["item_references_target", "project_key, target_ledger, target_id, field_name, source_ledger, source_id"],
        ["plan_claims_request", "project_key, goal_id, claim_request_id"],
        ["plan_claims_identity", "project_key, goal_id, claim_id, generation"],
        ["plan_claims_active_goal", "project_key, goal_id"],
        ["plan_operations_identity", "project_key, goal_id, claim_id, generation, operation_kind, operation_id"],
        ["coherence_vector_version", "project_key, version"],
      ]) {
        const index = indexes.find(({ indexname }) => indexname === name);
        assert(index !== undefined, `missing keyed mutation index: ${name}`);
        expect(index.indexdef).toContain(`(${columns})`);
      }
    } finally { await pool.close(); }
  });

  test("ensureSchema is idempotent: identical catalog state across two runs + current meta schema_version", async () => {
    const pool = openPgPool(PG_URL!);
    try {
      await ensureSchema(pool);
      const before = await catalogSnapshot(pool);

      await ensureSchema(pool);
      const after = await catalogSnapshot(pool);

      expect(after).toEqual(before);

      const metaRows = await pool<Array<{ value: string }>>`
        SELECT value FROM meta WHERE key = 'schema_version'
      `;
      expect(metaRows).toHaveLength(1);
      expect(metaRows[0]?.value).toBe(String(PG_SCHEMA_VERSION));
      expect(PG_SCHEMA_VERSION).toBe(3);
    } finally {
      await pool.close();
    }
  });

  test("two concurrent ensureSchema invocations (Promise.all over two pools) both succeed", async () => {
    const poolA = openPgPool(PG_URL!);
    const poolB = openPgPool(PG_URL!);
    try {
      await Promise.all([ensureSchema(poolA), ensureSchema(poolB)]);

      const metaRows = await poolA<Array<{ value: string }>>`
        SELECT value FROM meta WHERE key = 'schema_version'
      `;
      expect(metaRows[0]?.value).toBe(String(PG_SCHEMA_VERSION));
    } finally {
      await poolA.close();
      await poolB.close();
    }
  });
});
