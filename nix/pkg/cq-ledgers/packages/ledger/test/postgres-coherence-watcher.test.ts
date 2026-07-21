/**
 * postgres-coherence-watcher.test.ts — env-gated integration test for the
 * LISTEN/NOTIFY coherence watcher (T578, G81/M250).
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as every other
 * postgres-*.test.ts): with no live Postgres the suite SKIPS cleanly so
 * `bun run check` stays green offline.
 *
 * Proves the acceptance clauses in ONE sequential scenario (shared watcher
 * lifecycle) against a live database:
 *  1. two PostgresLedgerStore instances over one DSN/tenant, watcher on B;
 *  2. a createItem through A fires B's onChange AND B.fetchItem observes the
 *     row within a bounded wait (<2s) — push, no polling;
 *  3. a write to a DIFFERENT tenant does NOT invalidate B;
 *  4. killing the LISTEN connection (pg_terminate_backend) and letting
 *     porsager reconnect still converges (onlisten full-invalidate safety).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LedgerSchema } from "../src/index.js";
import { ensureSchema, openPgPool, PostgresLedgerStore } from "../src/index.js";
import { startPostgresCoherenceWatcher } from "../src/store/postgres/coherenceWatcher.js";
import type { ResolvedPostgresHandle } from "../src/store/createLedgerStore.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

/** Bounded convergence wait (acceptance: <2s). */
const CONVERGE_TIMEOUT_MS = 2_000;
/** Window over which the different-tenant write must NOT invalidate B. */
const NEGATIVE_WINDOW_MS = 1_000;

const widgetsSchema: LedgerSchema = {
  statusValues: ["open", "in-progress", "resolved", "abandoned"],
  terminalStatuses: ["resolved", "abandoned"],
  fields: {
    severity: { type: "string", required: true },
    location: { type: "string", required: true },
    description: { type: "string", required: true },
  },
};

const WIDGETS = "widgets";

/** Poll `predicate` until true or `timeoutMs` elapses. Returns elapsed ms, or -1 on timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 20));
  }
  return -1;
}

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("PostgresLedgerStore LISTEN/NOTIFY coherence watcher (T578)", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const dsn: string = PG_URL;
  const setupPool = openPgPool(dsn);
  const schemaReady = ensureSchema(setupPool);

  /** Register a fresh tenant with a seeded WIDGETS ledger; return its projectKey. */
  const prepareTenant = async (): Promise<string> => {
    await schemaReady;
    const projectKey = `t578-${randomUUID()}`;
    await setupPool`INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})`;
    await setupPool`
      INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
      VALUES (${projectKey}, ${WIDGETS}, ${JSON.stringify(widgetsSchema)}, 0, 0)
    `;
    return projectKey;
  };

  afterAll(async () => {
    await setupPool.close();
  });

  it(
    "pushes A's writes to B, isolates other tenants, and reconverges after a LISTEN drop",
    async () => {
      const projectKey = await prepareTenant();

      const poolA = openPgPool(dsn);
      const poolB = openPgPool(dsn);
      const storeA = new PostgresLedgerStore({ pool: poolA, projectKey, displayName: projectKey });
      const storeB = new PostgresLedgerStore({ pool: poolB, projectKey, displayName: projectKey });
      await storeA.init();
      await storeB.init();

      let onChangeCount = 0;
      const pgHandleB: ResolvedPostgresHandle = { pool: poolB, dsn, projectKey };
      const watcher = startPostgresCoherenceWatcher(storeB, pgHandleB, () => {
        onChangeCount += 1;
      });

      const fetchable = (ledger: string, id: string): boolean => {
        try {
          storeB.fetchItem(ledger, id);
          return true;
        } catch {
          return false;
        }
      };

      try {
        // Let the initial onlisten full-invalidate settle (missed-notification
        // safety fires once on connect).
        await waitFor(() => onChangeCount >= 1, CONVERGE_TIMEOUT_MS);

        // ── Clause 2: A's write reaches B via push ──────────────────────────
        const milestone = await storeA.createMilestone({ title: "m1" });
        const before = onChangeCount;
        const created = await storeA.createItem(WIDGETS, milestone.id, {
          status: "open",
          fields: { severity: "low", location: "x", description: "pushed via NOTIFY" },
        });
        const converged = await waitFor(
          () => onChangeCount > before && fetchable(WIDGETS, created.id),
          CONVERGE_TIMEOUT_MS,
        );
        expect(converged).toBeGreaterThanOrEqual(0);
        expect(fetchable(WIDGETS, created.id)).toBe(true);
        console.log(`[T578] A→B push converged in ${converged}ms (onChange ${before}→${onChangeCount})`);

        // ── Clause 3: a DIFFERENT tenant's write does NOT invalidate B ──────
        const otherKey = await prepareTenant();
        const poolOther = openPgPool(dsn);
        const storeOther = new PostgresLedgerStore({
          pool: poolOther,
          projectKey: otherKey,
          displayName: otherKey,
        });
        await storeOther.init();
        const beforeOther = onChangeCount;
        const mOther = await storeOther.createMilestone({ title: "other" });
        await storeOther.createItem(WIDGETS, mOther.id, {
          status: "open",
          fields: { severity: "low", location: "y", description: "other tenant" },
        });
        // Wait a full window; B's counter must stay put (tenant filter).
        await new Promise((r) => setTimeout(r, NEGATIVE_WINDOW_MS));
        expect(onChangeCount).toBe(beforeOther);
        console.log(`[T578] other-tenant write ignored (onChange stayed ${onChangeCount})`);
        await storeOther.dispose();

        // ── Clause 4: kill the LISTEN connection; porsager reconnects ───────
        const killed = await setupPool<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity
          WHERE query ILIKE 'listen%' AND pid <> pg_backend_pid()
        `;
        for (const { pid } of killed) {
          await setupPool`SELECT pg_terminate_backend(${pid})`;
        }
        console.log(`[T578] terminated ${killed.length} LISTEN backend(s)`);
        expect(killed.length).toBeGreaterThanOrEqual(1);

        // A write after the kill must still converge once porsager re-LISTENs.
        const afterKill = onChangeCount;
        const created2 = await storeA.createItem(WIDGETS, milestone.id, {
          status: "open",
          fields: { severity: "low", location: "z", description: "post-reconnect" },
        });
        const reconverged = await waitFor(
          () => onChangeCount > afterKill && fetchable(WIDGETS, created2.id),
          // reconnect backoff + convergence — allow more than the steady-state bound.
          CONVERGE_TIMEOUT_MS * 5,
        );
        expect(reconverged).toBeGreaterThanOrEqual(0);
        expect(fetchable(WIDGETS, created2.id)).toBe(true);
        console.log(`[T578] reconverged after LISTEN kill in ${reconverged}ms`);
      } finally {
        watcher.close();
        await storeA.dispose();
        await storeB.dispose();
      }
    },
    // Generous ceiling for the reconnect leg under load.
    30_000,
  );
}
