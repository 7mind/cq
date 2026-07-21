/**
 * Runs the abstract LedgerStore suite against PostgresLedgerStore (T573,
 * G81/M248) — the fourth store alongside store-fs / store-inmemory /
 * store-sqlite.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as postgres-schema.test.ts):
 * there is no Postgres server in this sandbox/CI environment, so the suite
 * SKIPS cleanly offline — `bun run check` stays green. When CQ_TEST_PG_URL
 * points at a real (throwaway) Postgres database, the FULL abstract suite runs
 * with per-build tenant isolation: every `build()` registers a FRESH
 * `project_key` (`projects` row) so concurrent tests never share rows and
 * reruns never collide with leftover state.
 *
 * Seeding parity with store-sqlite.test.ts: pre-registered ledgers are
 * inserted as raw rows through a setup pool (no store, no hook) BEFORE the
 * store is constructed, so the D-COHERENCE hook-firing-matrix assertions are
 * not contaminated by seed-time events. Tenant registration itself is also the
 * test's job here — auto-registration is T574's concern, not the store's.
 */

import { afterAll, describe, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LedgerSchema, LedgerStore } from "../src/index.js";
import { openPgPool } from "../src/store/postgres/connection.js";
import { ensureSchema } from "../src/store/postgres/schema.js";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { runStoreAbstractSuite } from "./store-abstract.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

if (PG_URL === undefined || PG_URL.length === 0) {
  // No live Postgres here — skip cleanly so the offline suite stays green.
  describe.skip("LedgerStore (abstract suite, PostgresLedgerStore)", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  // One shared setup pool for the DDL pass + tenant/seed registration.
  const setupPool = openPgPool(PG_URL);
  const schemaReady = ensureSchema(setupPool);

  const prepareTenant = async (
    seed: Array<{ name: string; schema: LedgerSchema }>,
  ): Promise<string> => {
    await schemaReady;
    const projectKey = `t573-${randomUUID()}`;
    await setupPool`
      INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
    `;
    for (const { name, schema } of seed) {
      await setupPool`
        INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
        VALUES (${projectKey}, ${name}, ${JSON.stringify(schema)}, 0, 0)
      `;
    }
    return projectKey;
  };

  runStoreAbstractSuite({
    name: "PostgresLedgerStore",
    // Every op is a real network round-trip (write transaction + NOTIFY); a
    // generous per-test timeout keeps the concurrency-parity tests
    // deterministic under full-suite parallel load.
    timeoutMs: 20_000,
    async build(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<LedgerStore> {
      const projectKey = await prepareTenant(seed);
      const store = new PostgresLedgerStore({ pool: openPgPool(PG_URL), projectKey });
      await store.init();
      return store;
    },
    async buildWithHook(
      seed: Array<{ name: string; schema: LedgerSchema }>,
      onMutation: (ledgerId: string, op: "create" | "update" | "archive") => void,
    ): Promise<LedgerStore> {
      const projectKey = await prepareTenant(seed);
      const store = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey,
        onMutation,
      });
      await store.init();
      return store;
    },
    async teardown(store: LedgerStore): Promise<void> {
      await store.dispose();
    },
  });

  afterAll(async () => {
    await setupPool.close();
  });
}
