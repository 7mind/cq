/**
 * D147 perf regression: PostgresLedgerStore single-item updateItem must stay
 * near-constant in ledger size (no full cloneLedger + whole-bucket FTS rebuild).
 *
 * Env-gated on CQ_TEST_PG_URL (same gate as every other postgres-*.test.ts).
 * Pins p95 of updateItem at 1500 items under the D87-style <10ms target with a
 * modest network allowance.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { openPgPool } from "../src/store/postgres/connection.js";
import { ensureSchema } from "../src/store/postgres/schema.js";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { HYPOTHESIS_LEDGER } from "../src/constants.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

/** Ledger size at which the D147 mutation-latency target is asserted. */
const SEED_SIZE = 1_500;
/** p95 mutation-latency target (ms) at SEED_SIZE — D87 <10ms + PG network headroom. */
const P95_TARGET_MS = 25;
/** Timed samples (matches the D147 defect probe's ~25 updates). */
const SAMPLES = 25;

/** p95 of `samples` (ms): nearest-rank on the sorted values. */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  const v = sorted[idx];
  if (v === undefined) throw new Error("p95 of empty sample set");
  return v;
}

async function timeMs(fn: () => Promise<unknown>): Promise<number> {
  const t0 = Bun.nanoseconds();
  await fn();
  return (Bun.nanoseconds() - t0) / 1e6;
}

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("D147: PostgresLedgerStore mutation latency", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const setupPool = openPgPool(PG_URL);
  const schemaReady = ensureSchema(setupPool);

  afterAll(async () => {
    await setupPool.close();
  });

  describe("D147: PostgresLedgerStore mutation latency is O(1) in ledger size", () => {
    it(
      `updateItem p95 < ${P95_TARGET_MS}ms at ${SEED_SIZE} items (unfenced hypothesis)`,
      async () => {
        await schemaReady;
        const projectKey = `d147-${randomUUID()}`;
        await setupPool`
          INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
        `;

        // hypothesis is unfenced (T851 fence does not touch it) — the D147 path.
        const store = new PostgresLedgerStore({
          pool: openPgPool(PG_URL),
          projectKey,
          displayName: projectKey,
        });
        await store.init();
        const milestone = await store.createMilestone({ title: "d147-perf-seed" });

        // Seed SEED_SIZE raw item rows via the setup pool (bypass store write path),
        // then fold into the cache/index via invalidate.
        const now = new Date().toISOString();
        await setupPool.begin(async (tx) => {
          await tx`
            INSERT INTO groups (project_key, ledger, id, title, description)
            VALUES (${projectKey}, ${HYPOTHESIS_LEDGER}, ${milestone.id}, '', '')
            ON CONFLICT DO NOTHING
          `;
          for (let i = 1; i <= SEED_SIZE; i++) {
            await tx`
              INSERT INTO items (
                project_key, ledger, id, milestone_id, status, fields_json,
                created_at, updated_at
              ) VALUES (
                ${projectKey}, ${HYPOTHESIS_LEDGER}, ${`H${i}`}, ${milestone.id},
                'open',
                ${JSON.stringify({
                  headline: `seed hypothesis ${i}`,
                  description: `synthetic seed row ${i} for the D147 latency probe`,
                })},
                ${now}, ${now}
              )
            `;
          }
          await tx`
            UPDATE ledgers SET item_counter = ${SEED_SIZE}
            WHERE project_key = ${projectKey} AND name = ${HYPOTHESIS_LEDGER}
          `;
        });
        await store.invalidate(HYPOTHESIS_LEDGER);

        // Warmup (untimed).
        await store.updateItem(HYPOTHESIS_LEDGER, "H1", {
          fields: { headline: "warmup" },
        });

        const updateSamples: number[] = [];
        for (let i = 2; i <= SAMPLES + 1; i++) {
          updateSamples.push(
            await timeMs(() =>
              store.updateItem(HYPOTHESIS_LEDGER, `H${i}`, {
                fields: { headline: `updated ${i}` },
              }),
            ),
          );
        }

        // Functional guard: fast must not mean "index silently skipped".
        const hits = await store.ftsSearch("updated", {
          ledger: HYPOTHESIS_LEDGER,
          limit: 5,
        });
        expect(hits.length).toBeGreaterThan(0);
        expect(store.fetchItem(HYPOTHESIS_LEDGER, "H2").fields["headline"]).toBe("updated 2");

        await store.dispose();

        const updateP95 = p95(updateSamples);
        console.log(
          `D147 @${SEED_SIZE}: updateItem p95=${updateP95.toFixed(2)}ms (target <${P95_TARGET_MS}ms)`,
        );
        expect(updateP95).toBeLessThan(P95_TARGET_MS);
      },
      120_000,
    );
  });
}
