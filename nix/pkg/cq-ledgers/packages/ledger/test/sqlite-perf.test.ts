/**
 * D87 perf regression (T538): SqliteLedgerStore single-item mutations must be
 * O(1) in ledger size — the K102/T498 target is p95 < 10ms at 10k items.
 *
 * The D87 probe measured updateItem p95 = 147ms at size=10000 (~14x over
 * target) because fireMutation rebuilt the ENTIRE MiniSearch active bucket on
 * every mutation, and createItem additionally materialised the whole target
 * ledger via loadLedger. This test seeds 10k raw rows (same pattern as the
 * probe: direct INSERT on a second connection, counter bump, invalidate()) and
 * asserts p95 of BOTH updateItem AND createItem stays under the target.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { TASKS_LEDGER } from "../src/constants.js";

/** Ledger size at which the K102/T498 mutation-latency target is asserted. */
const SEED_SIZE = 10_000;
/** p95 mutation-latency target (ms) at SEED_SIZE — K102/T498. */
const P95_TARGET_MS = 10;
/** Timed samples per operation (matches the D87 probe's ~15-20 calls). */
const SAMPLES = 20;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** p95 of `samples` (ms): nearest-rank on the sorted values. */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  const v = sorted[idx];
  if (v === undefined) throw new Error("p95 of empty sample set");
  return v;
}

/** Time one awaited call in milliseconds via Bun.nanoseconds(). */
async function timeMs(fn: () => Promise<unknown>): Promise<number> {
  const t0 = Bun.nanoseconds();
  await fn();
  return (Bun.nanoseconds() - t0) / 1e6;
}

describe("D87: mutation latency is O(1) in ledger size", () => {
  test(
    `updateItem and createItem p95 < ${P95_TARGET_MS}ms at ${SEED_SIZE} items`,
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ledger-sqlite-perf-"));
      dirs.push(dir);
      const dbPath = path.join(dir, "ledger.db");

      const store = new SqliteLedgerStore({ dbPath });
      await store.init();
      const milestone = await store.createMilestone({ title: "perf-seed" });

      // Seed SEED_SIZE raw item rows on a second connection (the D87 probe's
      // seed pattern — bypasses the store's write path, WAL makes the commit
      // visible to the store's connection), then fold the peer commit into
      // the derived index via invalidate().
      const seed = openLedgerDb(dbPath);
      try {
        seed.transaction(() => {
          seed
            .query("INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, '', '')")
            .run(TASKS_LEDGER, milestone.id);
          const insert = seed.query(
            `INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
             VALUES (?, ?, ?, 'planned', ?, ?, ?, NULL, NULL)`,
          );
          const now = new Date().toISOString();
          for (let i = 1; i <= SEED_SIZE; i++) {
            insert.run(
              TASKS_LEDGER,
              `T${i}`,
              milestone.id,
              JSON.stringify({
                headline: `seed item ${i}`,
                description: `synthetic seed row number ${i} for the D87 latency probe`,
              }),
              now,
              now,
            );
          }
          seed
            .query("UPDATE ledgers SET item_counter = ? WHERE name = ?")
            .run(SEED_SIZE, TASKS_LEDGER);
        })();
      } finally {
        seed.close();
      }
      await store.invalidate(TASKS_LEDGER);

      // Warmup (untimed): touch both paths once so JIT/statement-cache
      // effects don't land in the first timed sample.
      await store.updateItem(TASKS_LEDGER, "T1", { status: "wip" });
      await store.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "perf warmup create" },
      });

      const updateSamples: number[] = [];
      for (let i = 2; i <= SAMPLES + 1; i++) {
        updateSamples.push(
          await timeMs(() => store.updateItem(TASKS_LEDGER, `T${i}`, { status: "wip" })),
        );
      }

      const createSamples: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        createSamples.push(
          await timeMs(() =>
            store.createItem(TASKS_LEDGER, milestone.id, {
              status: "planned",
              fields: { headline: `perf zebrafish create ${i}` },
            }),
          ),
        );
      }

      // Functional guard: fast must not mean "index silently skipped" — the
      // incremental path must leave the created docs searchable and the
      // updated row committed.
      const hits = await store.ftsSearch("zebrafish", { ledger: TASKS_LEDGER, limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(store.fetchItem(TASKS_LEDGER, "T2").status).toBe("wip");

      await store.dispose();

      const updateP95 = p95(updateSamples);
      const createP95 = p95(createSamples);
      // Surface the measured numbers in the test output either way.
      console.log(
        `D87 @${SEED_SIZE}: updateItem p95=${updateP95.toFixed(2)}ms, createItem p95=${createP95.toFixed(2)}ms (target <${P95_TARGET_MS}ms)`,
      );
      expect(updateP95).toBeLessThan(P95_TARGET_MS);
      expect(createP95).toBeLessThan(P95_TARGET_MS);
    },
    60_000,
  );
});
