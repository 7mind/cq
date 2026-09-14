import { describe, expect, test } from "bun:test";
import { ensureSchema } from "../src/store/postgres/schema.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL named archive lookup [T5923 Behavioral-Active Effectual-GoodCommunication]", () => {
  test("named milestone archive lookup has a tenant/milestone/ledger index", async () => {
    const fixture = await postgresKeyedFixture();
    try {
      const indexes = await fixture.pool<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = 'archive_pointers_milestone'`;
      expect(indexes).toHaveLength(1);
      expect(indexes[0]!.indexdef).toContain("(project_key, id, ledger)");
    } finally { await fixture.dispose(); }
  });
  test("upgrading version two installs only the archive lookup index and preserves existing domain bytes", async () => {
    const fixture = await postgresKeyedFixture();
    try {
      await fixture.pool.unsafe("DROP INDEX IF EXISTS archive_pointers_milestone");
      await fixture.pool`UPDATE meta SET value = '2' WHERE key = 'schema_version'`;
      await fixture.pool`INSERT INTO projects (project_key, display_name) VALUES ('retained', 'retained')`;
      const before = [...await fixture.pool`SELECT * FROM projects ORDER BY project_key`];
      await ensureSchema(fixture.pool);
      expect([...await fixture.pool`SELECT * FROM projects ORDER BY project_key`]).toEqual(before);
      expect([...await fixture.pool`SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = 'archive_pointers_milestone'`]).toHaveLength(1);
    } finally { await fixture.dispose(); }
  });
});
