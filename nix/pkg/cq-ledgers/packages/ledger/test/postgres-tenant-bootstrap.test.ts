/**
 * PostgresLedgerStore.init() tenant bootstrap + auto-registration + schema-
 * divergence tests (T574, G81/M248).
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as postgres-schema.test.ts /
 * store-postgres.test.ts): there is no Postgres server in this sandbox/CI
 * environment, so the suite below SKIPS cleanly offline — `bun run check`
 * stays green. When CQ_TEST_PG_URL points at a real (throwaway) Postgres
 * database, this suite exercises the acceptance criteria verbatim:
 *
 *  1. a fresh tenant's init() provisions all CANONICAL_LEDGERS for that
 *     project_key only — a second tenant on the SAME database is untouched.
 *  2. re-connecting with a CHANGED displayName updates projects.display_name.
 *  3. a divergent canonical schema triggers the configured
 *     onSchemaDivergence policy (default 'backup-reinit' tenant-scoped shadow
 *     copy, opt-out 'abort').
 */

import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BootstrapViolationError,
  CANONICAL_LEDGERS,
  GOALS_LEDGER,
  GOALS_SCHEMA,
} from "../src/index.js";
import { openPgPool } from "../src/store/postgres/connection.js";
import { ensureSchema } from "../src/store/postgres/schema.js";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("PostgresLedgerStore.init() tenant bootstrap (T574)", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const setupPool = openPgPool(PG_URL);
  const schemaReady = ensureSchema(setupPool);
  const freshProjectKey = (): string => `t574-${randomUUID()}`;

  interface LedgerRow {
    name: string;
    schema_json: string;
  }

  afterAll(async () => {
    await setupPool.close();
  });

  // ---------------------------------------------------------------------
  // §1 — fresh tenant provisioning + tenant isolation
  // ---------------------------------------------------------------------

  describe("fresh tenant init() provisioning + isolation", () => {
    it("provisions every CANONICAL_LEDGERS entry for a fresh project_key", async () => {
      await schemaReady;
      const projectKey = freshProjectKey();
      const store = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey,
        displayName: projectKey,
      });
      await store.init();
      try {
        const names = store.enumerate();
        for (const c of CANONICAL_LEDGERS) {
          expect(names).toContain(c.name);
        }
      } finally {
        await store.dispose();
      }
    });

    it("a second tenant on the SAME database is untouched by the first tenant's ledgers", async () => {
      await schemaReady;
      const projectKeyA = freshProjectKey();
      const projectKeyB = freshProjectKey();
      const storeA = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey: projectKeyA,
        displayName: projectKeyA,
      });
      await storeA.init();
      await storeA.createItem("tasks", "M-AMBIENT", {
        status: "planned",
        fields: { headline: "tenant A only" },
      });

      const storeB = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey: projectKeyB,
        displayName: projectKeyB,
      });
      await storeB.init();
      try {
        const tasksB = storeB.fetch("tasks");
        const allItems = tasksB.milestones.flatMap((m) => m.items);
        expect(allItems).toHaveLength(0);
      } finally {
        await storeA.dispose();
        await storeB.dispose();
      }
    });
  });

  // ---------------------------------------------------------------------
  // §2 — displayName upsert on reconnect
  // ---------------------------------------------------------------------

  describe("displayName UPSERT on reconnect", () => {
    it("a changed displayName on reconnect updates projects.display_name", async () => {
      await schemaReady;
      const projectKey = freshProjectKey();
      const store1 = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey,
        displayName: "Original Name",
      });
      await store1.init();
      await store1.dispose();

      const store2 = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey,
        displayName: "Renamed Project",
      });
      await store2.init();
      await store2.dispose();

      const rows = await setupPool<Array<{ display_name: string }>>`
        SELECT display_name FROM projects WHERE project_key = ${projectKey}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.display_name).toBe("Renamed Project");
    });
  });

  // ---------------------------------------------------------------------
  // §3 — schema-divergence policy
  // ---------------------------------------------------------------------

  describe("divergent canonical schema — 'abort' policy", () => {
    it("init() rejects with BootstrapViolationError, no shadow project created, display_name untouched", async () => {
      await schemaReady;
      const projectKey = freshProjectKey();
      await setupPool`
        INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${"Pre-Divergence Name"})
      `;
      const divergentSchema = { ...GOALS_SCHEMA, statusValues: [...GOALS_SCHEMA.statusValues, "extra"] };
      await setupPool`
        INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
        VALUES (${projectKey}, ${GOALS_LEDGER}, ${JSON.stringify(divergentSchema)}, 0, 0)
      `;

      const store = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey,
        displayName: "Must Not Land",
        onSchemaDivergence: "abort",
      });

      await expect(store.init()).rejects.toThrow(BootstrapViolationError);

      const shadowRows = await setupPool<Array<{ project_key: string }>>`
        SELECT project_key FROM projects WHERE project_key LIKE ${`${projectKey}__divergence-backup-%`}
      `;
      expect(shadowRows).toHaveLength(0);

      // Review r2 (criticism 2): abort is side-effect-free — the projects
      // UPSERT must NOT have run, so the pre-existing display_name survives.
      const nameRows = await setupPool<Array<{ display_name: string }>>`
        SELECT display_name FROM projects WHERE project_key = ${projectKey}
      `;
      expect(nameRows).toHaveLength(1);
      expect(nameRows[0]?.display_name).toBe("Pre-Divergence Name");
    });
  });

  describe("divergent canonical schema — 'backup-reinit' (default) policy", () => {
    it("init() resolves, tenant-scoped shadow holds the prior divergent + logs rows, live tenant is fresh-canonical", async () => {
      await schemaReady;
      const projectKey = freshProjectKey();
      await setupPool`
        INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
      `;
      const divergentSchema = { ...GOALS_SCHEMA, statusValues: [...GOALS_SCHEMA.statusValues, "extra"] };
      await setupPool`
        INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
        VALUES (${projectKey}, ${GOALS_LEDGER}, ${JSON.stringify(divergentSchema)}, 0, 0)
      `;
      // Review r2 (criticism 1): a tenant-keyed logs row (T575) must be
      // carried into the shadow copy and wiped from the reinit'd tenant.
      await setupPool`
        INSERT INTO logs (project_key, path, content)
        VALUES (${projectKey}, ${"logs/raw/pre-divergence.md"}, ${"pre-divergence log content"})
      `;

      const store = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey,
        displayName: projectKey,
      });
      await expect(store.init()).resolves.toBeUndefined();
      try {
        const liveGoals = store.fetch(GOALS_LEDGER);
        expect(liveGoals.schema.statusValues).toEqual(GOALS_SCHEMA.statusValues);
        expect(liveGoals.schema.statusValues).not.toContain("extra");
      } finally {
        await store.dispose();
      }

      const shadowLedgerRows = await setupPool<LedgerRow[]>`
        SELECT name, schema_json FROM ledgers
        WHERE project_key LIKE ${`${projectKey}__divergence-backup-%`} AND name = ${GOALS_LEDGER}
      `;
      expect(shadowLedgerRows).toHaveLength(1);
      expect(JSON.parse(shadowLedgerRows[0]!.schema_json)).toEqual(divergentSchema);

      // logs: copied into the shadow, wiped from the reinit'd tenant.
      const shadowLogRows = await setupPool<Array<{ path: string; content: string }>>`
        SELECT path, content FROM logs
        WHERE project_key LIKE ${`${projectKey}__divergence-backup-%`}
      `;
      expect(shadowLogRows).toHaveLength(1);
      expect(shadowLogRows[0]?.path).toBe("logs/raw/pre-divergence.md");
      expect(shadowLogRows[0]?.content).toBe("pre-divergence log content");

      const liveLogRows = await setupPool<Array<{ path: string }>>`
        SELECT path FROM logs WHERE project_key = ${projectKey}
      `;
      expect(liveLogRows).toHaveLength(0);
    });
  });
}
