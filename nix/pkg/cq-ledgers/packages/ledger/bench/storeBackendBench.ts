#!/usr/bin/env bun
/**
 * Store latency harness for the production SQLite store and independent
 * SQLite/JSONL research prototypes. Measures p95 single-item update latency
 * and cold initialization at 1k and 10k items. Bulk seeding is not measured.
 *
 * Usage: bun run bench:store from the workspace root.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { TASKS_LEDGER, type Item } from "../src/index.js";
import { SqliteProtoStore, seedSqliteItems } from "./proto/sqliteProtoStore.js";
import { JsonlProtoStore, seedJsonlItems } from "./proto/jsonlProtoStore.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

/**
 * The narrow store surface this bench exercises. The production SQLite
 * `LedgerStore` satisfies it structurally; the T492 milestone-A prototypes
 * (`SqliteProtoStore`, `JsonlProtoStore`) are wrapped to present it (their
 * native signatures are narrower — see proto/protoStore.ts). Every driver's
 * `openStore` returns this, so the workload/measurement code below is identical
 * across backends (comparable numbers, per the research doc).
 */
interface BenchStore {
  init(): Promise<void>;
  createMilestone(init: { title: string }): Promise<{ id: string }>;
  updateItem(ledgerId: string, itemId: string, patch: { status: string }): Promise<unknown>;
  dispose(): Promise<void>;
}

/** Synthetic workload sizes (items in the `tasks` ledger). Q248 reference points. */
const SIZES = [1_000, 10_000] as const;

/** Number of single-item mutations sampled to compute the p95 per size. */
const MUTATION_SAMPLES = 50;

/** Build the synthetic `tasks`-ledger `Item[]` for the given milestone/size. */
function buildSyntheticItems(milestoneId: string, size: number, now: string): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < size; i++) {
    items.push({
      id: `T${i + 1}`,
      milestoneId,
      status: "planned",
      fields: {
        headline: `synthetic task ${i}`,
        description: `Q248 bench workload item ${i} of ${size}.`,
      },
      createdAt: now,
      updatedAt: now,
    });
  }
  return items;
}

interface BackendDriver {
  name: string;
  /** Prepare a fresh temporary root. */
  setupRoot(): Promise<string>;
  /** Construct + init a store bound to `root`, populating it as a side effect
   *  is NOT done here — callers populate via a first store instance, then
   *  call this again for a FRESH cold-init measurement. */
  openStore(root: string): Promise<BenchStore>;
  /**
   * Directly write the synthetic `tasks` ledger source into `root`'s
   * persistence, bypassing the per-item `createItem` write funnel (see the
   * module doc comment for why). Returns the seeded item ids.
   */
  seedTasksLedger(root: string, milestoneId: string, size: number): Promise<string[]>;
  /** Remove any temp state created by `setupRoot`. */
  teardownRoot(root: string): Promise<void>;
}

/**
 * Candidate A (T492): bun:sqlite PROTOTYPE. Store wraps `SqliteProtoStore` to
 * the `BenchStore` shape; seed is a single bulk-insert transaction. Superseded
 * by the real `SqliteLedgerStore` ({@link sqliteDriver} below, T531) — kept
 * here as the K102-prototype reference point the real store is compared
 * against.
 */
const sqliteProtoDriver: BackendDriver = {
  name: "sqlite-proto",
  async setupRoot() {
    return fs.mkdtemp(path.join(tmpdir(), "bench-sqlite-proto-"));
  },
  async openStore(root) {
    const store = new SqliteProtoStore({ root });
    await store.init();
    return {
      init: () => store.init(),
      createMilestone: (init) => store.createMilestone(init.title),
      updateItem: (_ledgerId, itemId, patch) => store.updateItem(itemId, patch.status),
      dispose: () => store.dispose(),
    };
  },
  async seedTasksLedger(root, milestoneId, size) {
    return seedSqliteItems(root, milestoneId, size);
  },
  async teardownRoot(root) {
    await fs.rm(root, { recursive: true, force: true });
  },
};

/**
 * Production SQLite store with a per-run database. Seeding writes normalized
 * item rows in one transaction; measurements use the public store methods.
 */
const sqliteDriver: BackendDriver = {
  name: "sqlite",
  async setupRoot() {
    return fs.mkdtemp(path.join(tmpdir(), "bench-sqlite-"));
  },
  async openStore(root) {
    const store = new SqliteLedgerStore({ dbPath: path.join(root, "ledger.db") });
    await store.init();
    return store;
  },
  async seedTasksLedger(root, milestoneId, size) {
    const now = new Date().toISOString();
    const items = buildSyntheticItems(milestoneId, size, now);
    const db = openLedgerDb(path.join(root, "ledger.db"));
    try {
      db.transaction(() => {
        const insertItem = db.query(
          `INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        );
        for (const item of items) {
          insertItem.run(
            TASKS_LEDGER,
            item.id,
            item.milestoneId,
            item.status,
            JSON.stringify(item.fields),
            item.createdAt,
            item.updatedAt,
          );
        }
        db.query("INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, '', '')").run(
          TASKS_LEDGER,
          milestoneId,
        );
        db.query("UPDATE ledgers SET item_counter = ? WHERE name = ?").run(
          size,
          TASKS_LEDGER,
        );
      })();
    } finally {
      db.close();
    }
    return items.map((it) => it.id);
  },
  async teardownRoot(root) {
    await fs.rm(root, { recursive: true, force: true });
  },
};

/**
 * Candidate C1/C2 (T492): JSONL canonical + derived index. Store wraps
 * `JsonlProtoStore`; seed writes the whole canonical JSONL once.
 */
const jsonlDriver: BackendDriver = {
  name: "jsonl+index",
  async setupRoot() {
    return fs.mkdtemp(path.join(tmpdir(), "bench-jsonl-"));
  },
  async openStore(root) {
    const store = new JsonlProtoStore({ root });
    await store.init();
    return {
      init: () => store.init(),
      createMilestone: (init) => store.createMilestone(init.title),
      updateItem: (_ledgerId, itemId, patch) => store.updateItem(itemId, patch.status),
      dispose: () => store.dispose(),
    };
  },
  async seedTasksLedger(root, milestoneId, size) {
    return seedJsonlItems(root, milestoneId, size);
  },
  async teardownRoot(root) {
    await fs.rm(root, { recursive: true, force: true });
  },
};

const DRIVERS: BackendDriver[] = [sqliteDriver, sqliteProtoDriver, jsonlDriver];

interface SizeResult {
  size: number;
  p95MutationMs: number;
  coldInitMs: number;
}

/** Percentile over a (mutated in place, sorted) copy of `samples`. */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  const value = sorted[Math.max(0, idx)];
  if (value === undefined) throw new Error("percentile: empty sample set");
  return value;
}

/** Evenly-spaced sample of `count` ids out of `ids` (deterministic, no RNG). */
function sampleIds(ids: string[], count: number): string[] {
  if (ids.length <= count) return ids;
  const step = ids.length / count;
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(i * step);
    const id = ids[idx];
    if (id === undefined) throw new Error("sampleIds: index out of range");
    picked.push(id);
  }
  return picked;
}

async function measureSize(driver: BackendDriver, size: number): Promise<SizeResult> {
  const root = await driver.setupRoot();
  try {
    // 1. Real milestone (cheap — only touches the small milestones ledger),
    //    then direct-seed the `tasks` ledger's N synthetic items (see module
    //    doc comment for why this bypasses per-item `createItem`).
    const seedStore = await driver.openStore(root);
    const milestone = await seedStore.createMilestone({ title: `bench-${size}` });
    await seedStore.dispose();
    const ids = await driver.seedTasksLedger(root, milestone.id, size);

    // 2. p95 single-item mutation latency: flip status on a sampled subset,
    //    one store instance reused across samples (steady-state write funnel,
    //    not startup cost — that's measured separately below).
    const mutationStore = await driver.openStore(root);
    const sampled = sampleIds(ids, MUTATION_SAMPLES);
    const mutationLatenciesMs: number[] = [];
    let flip = true;
    for (const id of sampled) {
      const status = flip ? "wip" : "planned";
      flip = !flip;
      const start = performance.now();
      await mutationStore.updateItem(TASKS_LEDGER, id, { status });
      mutationLatenciesMs.push(performance.now() - start);
    }
    await mutationStore.dispose();

    // 3. Cold init() time: a FRESH store instance against the now-populated
    //    root, timing ONLY the init() call.
    const coldStart = performance.now();
    const coldStore = await driver.openStore(root);
    const coldInitMs = performance.now() - coldStart;
    await coldStore.dispose();

    return { size, p95MutationMs: percentile(mutationLatenciesMs, 95), coldInitMs };
  } finally {
    await driver.teardownRoot(root);
  }
}

function formatRow(driver: string, result: SizeResult): string {
  return `${driver.padEnd(11)}  ${String(result.size).padStart(7)}  ${result.p95MutationMs
    .toFixed(2)
    .padStart(18)}  ${result.coldInitMs.toFixed(2).padStart(15)}`;
}

async function main(): Promise<void> {
  const results: Array<{ driver: string; result: SizeResult }> = [];
  for (const driver of DRIVERS) {
    for (const size of SIZES) {
      console.log(`running ${driver.name} @ ${size} items...`);
      const result = await measureSize(driver, size);
      results.push({ driver: driver.name, result });
      // Print each measurement IMMEDIATELY so an interrupted run still yields
      // every completed data point (a full 2-backend x 10k pass takes minutes).
      console.log(`  -> ${formatRow(driver.name, result)}`);
    }
  }

  console.log("");
  console.log("backend      size     p95 mutation (ms)   cold init (ms)");
  console.log("-----------  -------  ------------------  ---------------");
  for (const { driver, result } of results) {
    console.log(formatRow(driver, result));
  }
}

await main();
