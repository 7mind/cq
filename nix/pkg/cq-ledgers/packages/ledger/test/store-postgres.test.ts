/**
 * Runs the abstract LedgerStore suite against PostgresLedgerStore (T573,
 * G81/M248) — the environment-gated PostgreSQL production leg beside the
 * in-memory contract dummy and SQLite/XDG adapter.
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
 * not contaminated by seed-time events. `prepareTenant` still INSERTs the
 * `projects` row itself (raw SQL) here, because the seed ledgers rows it
 * writes are FK-scoped to `projects(project_key)` and land BEFORE the store
 * (and its own auto-registering `init()`, T574) is even constructed; the
 * store's UPSERT on `init()` then simply re-affirms the same row.
 */

import { afterAll, describe, expect, it } from "bun:test";
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
    // Every op is a real network round-trip (write transaction); a
    // generous per-test timeout keeps the concurrency-parity tests
    // deterministic under full-suite parallel load.
    timeoutMs: 20_000,
    async build(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<LedgerStore> {
      const projectKey = await prepareTenant(seed);
      const store = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey,
        displayName: projectKey,
      });
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
        displayName: projectKey,
        onMutation,
      });
      await store.init();
      return store;
    },
    async teardown(store: LedgerStore): Promise<void> {
      await store.dispose();
    },
  });

  // -------------------------------------------------------------------------
  // D267/T1858 — two independent pools over one tenant: parent-first races
  // -------------------------------------------------------------------------

  describe("PostgresLedgerStore parent-first protocol (D267/T1858)", () => {
    const widgetsSchema: LedgerSchema = {
      statusValues: ["open", "in-progress", "resolved", "abandoned"],
      terminalStatuses: ["resolved", "abandoned"],
      fields: {
        severity: { type: "string", required: true },
        location: { type: "string", required: true },
        description: { type: "string", required: true },
      },
    };

    const twoStores = async (): Promise<{
      s1: PostgresLedgerStore;
      s2: PostgresLedgerStore;
      projectKey: string;
    }> => {
      const projectKey = await prepareTenant([{ name: "widgets", schema: widgetsSchema }]);
      const s1 = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey,
        displayName: projectKey,
      });
      const s2 = new PostgresLedgerStore({
        pool: openPgPool(PG_URL),
        projectKey,
        displayName: projectKey,
      });
      await s1.init();
      await s2.init();
      return { s1, s2, projectKey };
    }

    const disposePair = async (s1: PostgresLedgerStore, s2: PostgresLedgerStore): Promise<void> => {
      await s1.dispose();
      await s2.dispose();
    };

    it("close-versus-create serializes to exactly one winner via either API", async () => {
      for (const api of ["canonical", "direct"] as const) {
        const { s1, s2 } = await twoStores();
        try {
          const m = await s1.createMilestone({ title: `pg-cc-${api}` });
          const close = (s: PostgresLedgerStore, id: string): Promise<unknown> =>
            api === "canonical"
              ? s.updateMilestone(id, { status: "done" })
              : s.updateItem("milestones", id, { status: "done" });
          // Truly concurrent over two independent pools: exactly one winner.
          const [closeResult, createResult] = await Promise.allSettled([
            close(s1, m.id),
            s2.createItem("widgets", m.id, {
              status: "open",
              fields: { severity: "minor", location: "x.ts", description: "r" },
            }),
          ]);
          expect(closeResult.status === "fulfilled" !== (createResult.status === "fulfilled")).toBe(
            true,
          );
        } finally {
          await disposePair(s1, s2);
        }
      }
    });

    it("close-versus-reopen refuses resurrection under a closed parent in both winner orderings", async () => {
      for (const winner of ["close", "reopen"] as const) {
        const { s1, s2 } = await twoStores();
        try {
          const m = await s1.createMilestone({ title: `pg-cr-${winner}` });
          const w1 = await s1.createItem("widgets", m.id, {
            status: "open",
            fields: { severity: "minor", location: "x.ts", description: "x" },
          });
          await s1.updateItem("widgets", w1.id, { status: "resolved" });
          if (winner === "close") {
            await s1.updateMilestone(m.id, { status: "done" });
            await expect(s2.reopenItem("widgets", w1.id, "open")).rejects.toThrow(/terminal/);
            // A rejected operation performs no cache absorption on the peer,
            // so assert the preserved state through the writer's own store.
            expect((await s1.fetchItem("widgets", w1.id)).status).toBe("resolved");
          } else {
            await s2.reopenItem("widgets", w1.id, "open");
            await expect(s1.updateMilestone(m.id, { status: "done" })).rejects.toThrow(
              /Cannot close milestone/,
            );
          }
        } finally {
          await disposePair(s1, s2);
        }
      }
    });

    it("direct and canonical closure report identical sorted blockers", async () => {
      const { s1, s2 } = await twoStores();
      try {
        const m = await s1.createMilestone({ title: "pg-blockers" });
        await s1.createItem("widgets", m.id, {
          status: "open",
          fields: { severity: "minor", location: "x.ts", description: "x" },
        });
        const canonicalErr = await s1.updateMilestone(m.id, { status: "done" }).catch((e) => e);
        const directErr = await s2.updateItem("milestones", m.id, { status: "done" }).catch((e) => e);
        expect(String(canonicalErr)).toBe(String(directErr));
        expect(String(canonicalErr)).toContain("Cannot close milestone");
      } finally {
        await disposePair(s1, s2);
      }
    });

    it("archive-versus-create/reopen/legacy-nonterminal-unarchive serializes in both winner orderings", async () => {
      // archive first: create under the archived parent refuses.
      {
        const { s1, s2 } = await twoStores();
        try {
          const m = await s1.createMilestone({ title: "pg-ac-archive-first" });
          await s1.updateMilestone(m.id, { status: "done" });
          await s1.archiveMilestone(m.id, "archived");
          await expect(
            s2.createItem("widgets", m.id, {
              status: "open",
              fields: { severity: "minor", location: "x.ts", description: "x" },
            }),
          ).rejects.toThrow(/archived/);
        } finally {
          await disposePair(s1, s2);
        }
      }
      // create first: the archive refuses (non-terminal child), then succeeds
      // once the child is terminal; a legacy nonterminal archived row refuses
      // re-attachment under the archived parent; the terminal row re-attaches.
      {
        const { s1, s2, projectKey } = await twoStores();
        try {
          const m = await s1.createMilestone({ title: "pg-ac-create-first" });
          const w1 = await s2.createItem("widgets", m.id, {
            status: "open",
            fields: { severity: "minor", location: "x.ts", description: "x" },
          });
          await expect(s1.archiveMilestone(m.id, "archived")).rejects.toThrow(
            /not in terminal status/,
          );
          await s2.updateItem("widgets", w1.id, { status: "resolved" });
          await s1.updateMilestone(m.id, { status: "done" });
          await s1.archiveMilestone(m.id, "archived");
          await setupPool`
            UPDATE archived_items SET status = 'in-progress'
            WHERE project_key = ${projectKey} AND ledger = 'widgets' AND id = ${w1.id}
          `;
          await expect(s2.unarchiveItem("widgets", m.id, w1.id)).rejects.toThrow(/archived/);
          await setupPool`
            UPDATE archived_items SET status = 'resolved'
            WHERE project_key = ${projectKey} AND ledger = 'widgets' AND id = ${w1.id}
          `;
          const reattached = await s2.unarchiveItem("widgets", m.id, w1.id);
          expect(reattached.status).toBe("resolved");
        } finally {
          await disposePair(s1, s2);
        }
      }
      // archive vs reopen, concurrent: exactly one consistent outcome.
      for (let i = 0; i < 5; i++) {
        const { s1, s2 } = await twoStores();
        try {
          const m = await s1.createMilestone({ title: `pg-ar-par-${i}` });
          const w1 = await s1.createItem("widgets", m.id, {
            status: "open",
            fields: { severity: "minor", location: "x.ts", description: "x" },
          });
          await s1.updateItem("widgets", w1.id, { status: "resolved" });
          await s1.updateMilestone(m.id, { status: "done" });
          const [archiveResult, reopenResult] = await Promise.allSettled([
            s1.archiveMilestone(m.id, "archived"),
            s2.reopenItem("widgets", w1.id, "open"),
          ]);
          expect(
            archiveResult.status === "fulfilled" !== (reopenResult.status === "fulfilled"),
          ).toBe(true);
        } finally {
          await disposePair(s1, s2);
        }
      }
    });
  });

  afterAll(async () => {
    await setupPool.close();
  });
}
