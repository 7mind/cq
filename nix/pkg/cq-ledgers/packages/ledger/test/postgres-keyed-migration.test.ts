import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { ensureSchema } from "../src/store/postgres/schema.js";
import { lifecycleClaim, lifecycleOperation } from "./lifecycleRowRepositoryContract.js";
import { postgresIsolatedSchema, postgresKeyedFixture } from "./postgresKeyedFixture.js";

async function expectUniqueFailure(invoke: () => PromiseLike<unknown>): Promise<void> {
  let rejection: unknown;
  try { await invoke(); } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as { errno: string }).errno).toBe("23505");
}

async function seedVersionOne(pool: SQL): Promise<void> {
  for (const statement of [
    `CREATE TABLE projects (project_key TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE ledgers (project_key TEXT NOT NULL REFERENCES projects(project_key), name TEXT NOT NULL,
      schema_json TEXT NOT NULL, milestone_counter INTEGER NOT NULL, item_counter INTEGER NOT NULL, PRIMARY KEY(project_key, name))`,
    `CREATE TABLE items (seq BIGINT GENERATED ALWAYS AS IDENTITY, project_key TEXT NOT NULL, ledger TEXT NOT NULL,
      id TEXT NOT NULL, milestone_id TEXT NOT NULL, status TEXT NOT NULL, fields_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, author TEXT, session TEXT, PRIMARY KEY(project_key, ledger, id),
      FOREIGN KEY(project_key, ledger) REFERENCES ledgers(project_key, name))`,
    `CREATE TABLE plan_claims (project_key TEXT NOT NULL REFERENCES projects(project_key), scope TEXT NOT NULL,
      record_json TEXT NOT NULL, PRIMARY KEY(project_key, scope))`,
    `CREATE TABLE plan_operations (project_key TEXT NOT NULL REFERENCES projects(project_key), scope TEXT NOT NULL,
      record_json TEXT NOT NULL, PRIMARY KEY(project_key, scope))`,
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ]) await pool.unsafe(statement);
  await pool`INSERT INTO meta VALUES ('schema_version', '1')`;
  await pool`INSERT INTO projects (project_key, display_name) VALUES ('legacy', 'legacy')`;
  await pool`INSERT INTO ledgers VALUES ('legacy', 'tasks', '{}', 0, 0)`;
  await pool`INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at)
    VALUES ('legacy', 'tasks', 'T1', 'M1', 'planned', ${JSON.stringify({ dependsOn: ["tasks:T2"], worksetOwnerRef: "goals:G1" })}, 'created', 'updated')`;
  await pool`INSERT INTO plan_claims VALUES ('legacy', 'retained-claim-scope', ${JSON.stringify(lifecycleClaim("G1"))})`;
  await pool`INSERT INTO plan_operations VALUES ('legacy', 'retained-operation-scope', ${JSON.stringify(lifecycleOperation("existing"))})`;
}

async function domainRows(pool: SQL) {
  return {
    items: [...await pool`SELECT * FROM items ORDER BY seq`],
    claims: [...await pool`SELECT project_key, scope, record_json FROM plan_claims ORDER BY scope`],
    operations: [...await pool`SELECT project_key, scope, record_json FROM plan_operations ORDER BY scope`],
  };
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL keyed migration [T5916 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("backfills version-one tenants once without changing canonical payloads or scope bytes", async () => {
    const fixture = await postgresIsolatedSchema();
    const { pool } = fixture;
    try {
      await seedVersionOne(pool);
      const before = await domainRows(pool);
      await ensureSchema(pool);
      expect(await domainRows(pool)).toEqual(before);
      expect([...await pool`SELECT field_name, target_ledger, target_id FROM item_references ORDER BY field_name`]).toEqual([
        { field_name: "dependsOn", target_ledger: "tasks", target_id: "T2" },
        { field_name: "worksetOwnerRef", target_ledger: "goals", target_id: "G1" },
      ]);
      expect([...await pool`SELECT goal_id, claim_id, generation FROM plan_claims`]).toEqual([{ goal_id: "G1", claim_id: "claim_G1_1", generation: 1 }]);
      await pool`DELETE FROM item_references WHERE field_name = 'dependsOn'`;
      await ensureSchema(pool);
      expect([...await pool`SELECT field_name FROM item_references`]).toEqual([{ field_name: "worksetOwnerRef" }]);
    } finally { await fixture.dispose(); }
  });

  test("a duplicate legacy private identity rolls back every DDL and backfill change", async () => {
    const fixture = await postgresIsolatedSchema();
    const { pool } = fixture;
    try {
      await seedVersionOne(pool);
      await pool`INSERT INTO plan_claims VALUES ('legacy', 'different-scope-same-identity', ${JSON.stringify(lifecycleClaim("G1"))})`;
      const before = await domainRows(pool);
      await expectUniqueFailure(() => ensureSchema(pool));
      expect(await domainRows(pool)).toEqual(before);
      expect([...await pool`SELECT value FROM meta WHERE key = 'schema_version'`]).toEqual([{ value: "1" }]);
      expect([...await pool`SELECT to_regclass('item_references')::text AS name`]).toEqual([{ name: null }]);
      expect([...await pool`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'plan_claims' AND column_name = 'goal_id'`]).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  test("new private duplicates fail closed while the same identity remains legal in another tenant", async () => {
    const fixture = await postgresKeyedFixture();
    const { pool } = fixture;
    try {
      for (const project of ["one", "two"]) {
        await pool`INSERT INTO projects (project_key, display_name) VALUES (${project}, ${project})`;
        await pool`INSERT INTO plan_claims (project_key, scope, record_json) VALUES (${project}, 'first', ${JSON.stringify(lifecycleClaim("G1"))})`;
        await pool`INSERT INTO plan_operations (project_key, scope, record_json) VALUES (${project}, 'first', ${JSON.stringify(lifecycleOperation("existing"))})`;
      }
      await expectUniqueFailure(() => pool`INSERT INTO plan_claims (project_key, scope, record_json)
        VALUES ('one', 'duplicate', ${JSON.stringify(lifecycleClaim("G1"))})`);
      const next = { ...lifecycleClaim("G1"), claimId: "new-claim", claimRequestId: "new-request", generation: 2 };
      await expectUniqueFailure(() => pool`INSERT INTO plan_claims (project_key, scope, record_json)
        VALUES ('one', 'other-active', ${JSON.stringify(next)})`);
      await expectUniqueFailure(() => pool`INSERT INTO plan_operations (project_key, scope, record_json)
        VALUES ('one', 'duplicate', ${JSON.stringify(lifecycleOperation("existing"))})`);
      expect([...await pool`SELECT count(*)::integer AS count FROM plan_claims`]).toEqual([{ count: 2 }]);
      expect([...await pool`SELECT count(*)::integer AS count FROM plan_operations`]).toEqual([{ count: 2 }]);
    } finally { await fixture.dispose(); }
  });
});
