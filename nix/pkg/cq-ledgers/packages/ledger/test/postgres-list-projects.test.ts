/**
 * PostgresLedgerStore.listProjects() (T585 / Q284): the genuine multi-tenant
 * `list_projects` read — `SELECT project_key, display_name, created_at FROM
 * projects ORDER BY display_name`.
 *
 * Env-gated on CQ_TEST_PG_URL (same gate as postgres-logs.test.ts /
 * store-postgres.test.ts): no Postgres server in this sandbox/CI, so the
 * suite SKIPS cleanly offline. The shared test database accumulates rows
 * across runs, so assertions use `toContain`/`find` against OUR registered
 * tenants rather than an exact-length equality on the full table.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openPgPool } from "../src/store/postgres/connection.js";
import { ensureSchema } from "../src/store/postgres/schema.js";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

describe.skipIf(!PG_URL)("PostgresLedgerStore.listProjects() (T585)", () => {
  const setupPool = PG_URL !== undefined ? openPgPool(PG_URL) : undefined;
  const schemaReady = setupPool !== undefined ? ensureSchema(setupPool) : Promise.resolve();

  afterAll(async () => {
    await setupPool?.close();
  });

  async function buildStore(projectKey: string, displayName: string): Promise<PostgresLedgerStore> {
    await schemaReady;
    const store = new PostgresLedgerStore({ pool: openPgPool(PG_URL!), projectKey, displayName });
    await store.init();
    return store;
  }

  test("returns both registered tenants with their display names", async () => {
    const tag = `t585-${randomUUID()}`;
    const keyA = `${tag}-a`;
    const keyB = `${tag}-b`;
    const storeA = await buildStore(keyA, `T585 Tenant A ${tag}`);
    const storeB = await buildStore(keyB, `T585 Tenant B ${tag}`);
    try {
      const result = await storeA.listProjects();
      const a = result.projects.find((p) => p.key === keyA);
      const b = result.projects.find((p) => p.key === keyB);
      expect(a).toBeDefined();
      expect(a!.displayName).toBe(`T585 Tenant A ${tag}`);
      expect(typeof a!.createdAt).toBe("string");
      expect(b).toBeDefined();
      expect(b!.displayName).toBe(`T585 Tenant B ${tag}`);

      // Called from EITHER tenant's store — listProjects is NOT scoped to
      // `this.projectKey` (unlike every other query on this store): both
      // registered tenants are visible regardless of which one asks.
      const fromB = await storeB.listProjects();
      expect(fromB.projects.find((p) => p.key === keyA)).toBeDefined();
    } finally {
      await storeA.dispose();
      await storeB.dispose();
    }
  });

  test("orders results by display_name", async () => {
    const tag = `t585-order-${randomUUID()}`;
    const keyZ = `${tag}-z`;
    const keyA = `${tag}-a`;
    // Insert the "Z"-named tenant first so an insertion-order artifact would
    // put it before "A" — ORDER BY display_name must correct that.
    const storeZ = await buildStore(keyZ, `ZZZ-${tag}`);
    const storeA = await buildStore(keyA, `AAA-${tag}`);
    try {
      const result = await storeA.listProjects();
      const indexA = result.projects.findIndex((p) => p.key === keyA);
      const indexZ = result.projects.findIndex((p) => p.key === keyZ);
      expect(indexA).toBeGreaterThanOrEqual(0);
      expect(indexZ).toBeGreaterThanOrEqual(0);
      expect(indexA).toBeLessThan(indexZ);
    } finally {
      await storeZ.dispose();
      await storeA.dispose();
    }
  });
});
