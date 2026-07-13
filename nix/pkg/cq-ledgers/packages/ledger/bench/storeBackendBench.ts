#!/usr/bin/env bun
/**
 * storeBackendBench — Q248 reference-metrics harness (T490 / G67-A).
 *
 * Generates a synthetic `tasks`-ledger workload at N items (1k, 10k) and
 * measures, against BOTH current backends (`FsLedgerStore`,
 * `GitObjectLedgerBackend`):
 *
 *  (a) p95 single-item mutation latency — `updateItem` through the store's
 *      real write funnel (mutex + lockfile + persist), one flip per item
 *      across a sample of the synthetic population;
 *  (b) cold `init()` time — construct a FRESH store instance bound to the
 *      already-populated on-disk/on-ref state and time `await store.init()`.
 *
 * ## Seeding strategy (why not just call `createItem` N times)
 *
 * Both backends' `writeLedgerFile` (AbstractLedgerStore) serializes and
 * rewrites the ENTIRE ledger source on every mutation — by design, not a bug
 * (see AbstractLedgerStore.ts). Populating N items one `createItem` at a time
 * is therefore O(n^2) in the population size: measured empirically, 1,000
 * sequential `createItem` calls against `FsLedgerStore` took ~135s wall time,
 * which extrapolates (git-object is slower still, one subprocess spawn per
 * git plumbing call) to an impractical multi-hour run at 10,000 items. No
 * real workflow creates 10k items in one sitting either — production ledgers
 * reach that size incrementally over long spans. So the harness builds the
 * synthetic N-item population directly (one `Ledger` object, serialized once,
 * written through the SAME persistence seam `writeLedgerFile` uses) and then
 * measures `updateItem`/`init()` against that already-large state — exactly
 * the two operations Q248 asks about, without paying an unrepresentative
 * one-session bulk-creation cost neither backend is optimised for.
 *
 * These are the Q248 reference numbers the milestone-A prototypes (T492) and
 * the milestone-C implementation are compared against (targets: p95 mutation
 * < 10ms, cold init < 500ms at 10k items). Re-run this same harness against a
 * new backend by adding a `BackendDriver` below — the workload generation and
 * measurement logic stay identical so numbers are comparable.
 *
 * Usage:
 *   bun run bench            (from packages/ledger/)
 *   bun run bench:store       (workspace-root alias, see root package.json)
 *
 * Output: human-readable table on stdout; exits 0 on success, non-zero if a
 * backend fails to initialise/mutate (fail-fast, no swallowed errors).
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FsLedgerStore,
  GitObjectLedgerBackend,
  GitPlumbing,
  TASKS_LEDGER,
  TASKS_SCHEMA,
  serializeLedger,
  type Item,
  type Ledger,
} from "../src/index.js";
import { SqliteProtoStore, seedSqliteItems } from "./proto/sqliteProtoStore.js";
import { JsonlProtoStore, seedJsonlItems } from "./proto/jsonlProtoStore.js";

const exec = promisify(execFile);

/**
 * The narrow store surface this bench exercises. The real fs/git-object
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

/**
 * Number of single-item mutations sampled to compute the p95 (per size).
 * `updateItem` also pays the O(n) full-ledger reload+rewrite cost per call
 * (see module doc comment), so at 10k items x 2 backends a large sample
 * count makes the harness run for tens of minutes; 50 keeps the p95 estimate
 * meaningful (an order-of-magnitude reference, not a rigorous benchmark —
 * see the research doc's caveats) while keeping the harness re-runnable in
 * a few minutes.
 */
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

/** Build the synthetic `tasks` Ledger (one milestone-group holding `size` items). */
function buildSyntheticLedger(milestoneId: string, size: number, now: string): Ledger {
  return {
    id: TASKS_LEDGER,
    schema: TASKS_SCHEMA,
    counters: { milestone: 1, item: size + 1 },
    milestones: [
      {
        id: milestoneId,
        title: "",
        description: "",
        items: buildSyntheticItems(milestoneId, size, now),
      },
    ],
    archivePointers: [],
  };
}

interface BackendDriver {
  name: string;
  /** Prepare a fresh root (tmp dir, optionally a throwaway git repo). */
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

const fsDriver: BackendDriver = {
  name: "fs",
  async setupRoot() {
    return fs.mkdtemp(path.join(tmpdir(), "bench-fs-"));
  },
  async openStore(root) {
    const store = new FsLedgerStore({ root });
    await store.init();
    return store;
  },
  async seedTasksLedger(root, milestoneId, size) {
    const now = new Date().toISOString();
    const ledger = buildSyntheticLedger(milestoneId, size, now);
    const text = serializeLedger(ledger);
    await fs.writeFile(path.join(root, ".cq", `${TASKS_LEDGER}.md`), text, "utf8");
    return ledger.milestones[0]!.items.map((it) => it.id);
  },
  async teardownRoot(root) {
    await fs.rm(root, { recursive: true, force: true });
  },
};

const gitObjectDriver: BackendDriver = {
  name: "git-object",
  async setupRoot() {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "bench-git-"));
    await git(dir, "init", "-q");
    await git(dir, "config", "user.email", "bench@example.com");
    await git(dir, "config", "user.name", "bench");
    await git(dir, "config", "commit.gpgsign", "false");
    await fs.writeFile(path.join(dir, "src.txt"), "bench placeholder\n");
    await git(dir, "add", "src.txt");
    await git(dir, "commit", "-q", "-m", "bench: initial");
    return dir;
  },
  async openStore(root) {
    const store = new GitObjectLedgerBackend({ repoRoot: root });
    await store.init();
    return store;
  },
  async seedTasksLedger(root, milestoneId, size) {
    const now = new Date().toISOString();
    const ledger = buildSyntheticLedger(milestoneId, size, now);
    const text = serializeLedger(ledger);
    const plumbing = GitPlumbing.withCwd(root, path.join(root, ".git"));
    const ref = "refs/heads/cq-ledger";
    const parent = await plumbing.readRef(ref);
    const entries = await plumbing.lsTreeEntries(ref);
    const blob = await plumbing.hashObject(text);
    const treeName = `${TASKS_LEDGER}.md`;
    const nextEntries = [
      ...entries.filter((e) => e.path !== treeName),
      { mode: "100644" as const, sha: blob, path: treeName },
    ];
    const tree = await plumbing.writeTree(nextEntries);
    const commit = await plumbing.commitTree(tree, parent, `bench: seed ${TASKS_LEDGER}`);
    await plumbing.updateRef(ref, commit, parent);
    return ledger.milestones[0]!.items.map((it) => it.id);
  },
  async teardownRoot(root) {
    await fs.rm(root, { recursive: true, force: true });
  },
};

/**
 * Candidate A (T492): bun:sqlite. Store wraps `SqliteProtoStore` to the
 * `BenchStore` shape; seed is a single bulk-insert transaction.
 */
const sqliteDriver: BackendDriver = {
  name: "sqlite",
  async setupRoot() {
    return fs.mkdtemp(path.join(tmpdir(), "bench-sqlite-"));
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

const DRIVERS: BackendDriver[] = [fsDriver, gitObjectDriver, sqliteDriver, jsonlDriver];

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
