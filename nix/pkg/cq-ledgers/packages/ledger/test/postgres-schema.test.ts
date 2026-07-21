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
  test("ensureSchema is idempotent: identical catalog state across two runs + meta schema_version=1", async () => {
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
      expect(PG_SCHEMA_VERSION).toBe(1);
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
