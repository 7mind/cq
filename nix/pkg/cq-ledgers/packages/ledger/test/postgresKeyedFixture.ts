import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { ensureSchema } from "../src/store/postgres/schema.js";

export async function postgresIsolatedSchema() {
  const dsn = process.env.CQ_TEST_PG_URL;
  if (dsn === undefined || dsn.length === 0) throw new Error("CQ_TEST_PG_URL is required for the PostgreSQL keyed fixture");
  const schema = `cq_keyed_${randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(dsn);
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const pool = new SQL({ url: dsn, connection: { search_path: schema } });
  const dispose = async () => {
    await pool.close();
    await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.close();
  };
  return { pool, schema, dispose };
}

export async function postgresKeyedFixture() {
  const fixture = await postgresIsolatedSchema();
  try { await ensureSchema(fixture.pool); return fixture; }
  catch (error) { await fixture.dispose(); throw error; }
}
