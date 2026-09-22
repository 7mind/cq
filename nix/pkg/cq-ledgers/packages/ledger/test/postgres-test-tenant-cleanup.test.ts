import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PostgresLedgerStore, ensureSchema, openPgPool } from "../src/index.js";
import { dropTenant, postgresPlanLifecycleFactory } from "./planLifecyclePostgresAdapter.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

describe.skipIf(PG_URL === undefined)("PostgreSQL fixture tenant cleanup", () => {
  for (const blocked of ["root", "spawned"] as const) test(`a refused ${blocked} tenant deletion still closes every fixture connection [Behavioral-Active Effectual-GoodCommunication]`, async () => {
    const observer = openPgPool(PG_URL!);
    const fixture = await postgresPlanLifecycleFactory.build();
    const spawned = blocked === "spawned" ? [await fixture.restart(), await fixture.restart()] : [];
    const identity = fixture as typeof fixture & { readonly postgresApplicationName: string; readonly operatorActionPeers: readonly PostgresLedgerStore[] };
    const keys = [fixture, ...spawned].map((value) => (value as typeof identity).operatorActionPeers[0]!.tenantKey());
    const key = keys[blocked === "root" ? 0 : 1]!;
    const table = `fixture_cleanup_block_${randomUUID().replaceAll("-", "")}`;
    await observer.unsafe(`CREATE TABLE ${table} (project_key TEXT REFERENCES projects(project_key))`);
    try {
      await observer.unsafe(`INSERT INTO ${table} (project_key) VALUES ($1)`, [key]);
      await expect(fixture.dispose()).rejects.toThrow("foreign key constraint");
      expect(await observer<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = ${identity.postgresApplicationName}`).toEqual([{ count: 0 }]);
    } finally {
      try { await observer.unsafe(`DROP TABLE ${table}`); for (const tenant of keys) await dropTenant(observer, tenant); }
      finally { await observer.close({ timeout: 0 }); }
    }
  });
  test("removes every initialized tenant row, preserves its peer, and replays exactly [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const admin = openPgPool(PG_URL!);
    const keys = [0, 1].map(() => `cleanup-${randomUUID()}`);
    const stores = keys.map((projectKey) => new PostgresLedgerStore({ pool: openPgPool(PG_URL!), projectKey, displayName: projectKey }));
    try {
      await ensureSchema(admin);
      for (const store of stores) { await store.init(); await store.putLog("logs/fixture.md", "retained peer evidence"); }
      for (const store of stores) await store.dispose();
      const target = keys[0]!;
      const peer = keys[1]!;
      expect(await admin`SELECT project_key FROM work_cohort_state WHERE project_key = ${target}`).toHaveLength(1);
      await dropTenant(admin, target);
      await dropTenant(admin, target);
      expect(await admin`SELECT project_key FROM projects WHERE project_key = ${target}`).toHaveLength(0);
      expect(await admin`SELECT project_key FROM work_cohort_state WHERE project_key = ${target}`).toHaveLength(0);
      expect(await admin`SELECT project_key FROM projects WHERE project_key = ${peer}`).toHaveLength(1);
      expect(await admin`SELECT project_key FROM work_cohort_state WHERE project_key = ${peer}`).toHaveLength(1);
      expect(await admin<{ content: string }[]>`SELECT content FROM logs WHERE project_key = ${peer}`).toEqual([{ content: "retained peer evidence" }]);
    } finally {
      try { for (const store of stores) await store.dispose(); for (const key of keys) await dropTenant(admin, key); }
      finally { await admin.close({ timeout: 0 }); }
    }
  });
});
