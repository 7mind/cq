/**
 * Runs the abstract LedgerStore suite against SqliteLedgerStore (bun:sqlite;
 * G67-C1/T530) — the surviving SQLite/XDG production leg beside the
 * in-memory contract dummy and environment-gated PostgreSQL leg.
 *
 * Each test gets a fresh tmp `ledger.db`. Unlike InMemoryLedgerStore (which
 * takes a `seed` constructor option), SqliteLedgerStore has no pre-init seed
 * mechanism — its ledgers are provisioned by calling `createLedger()` after
 * `init()`, which is exactly the runtime path the factory below drives.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createTrustedWorksetManagementAuthority,
  restoreDumpToXdg,
  type FieldValue,
  type LedgerSchema,
  type LedgerStore,
} from "../src/index.js";
import { startXdgCoherenceWatcher } from "../src/store/createLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema } from "../src/store/sqlite/schema.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { runStoreAbstractSuite } from "./store-abstract.js";
import type { MemoryKindPhysicalFixture, StoredItemTarget } from "./memoryKindStoreContract.js";

const dirs: string[] = [];

async function freshDbDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-sqlite-store-"));
  dirs.push(dir);
  return dir;
}

/**
 * Seed non-canonical ledgers by writing rows DIRECTLY (raw INSERT, no
 * store/hook involved) before the store is constructed — parity with the
 * in-memory constructor `seed` option: neither fires `onMutation` for the
 * pre-existing seed. SqliteLedgerStore has no such pre-init seed hook of its own — its
 * only ledger-provisioning entry point is `createLedger()`, which DOES fire
 * `onMutation` — so seeding through it would spuriously contaminate the
 * D-COHERENCE hook-firing-matrix assertions with extra seed-time events.
 */
async function seedDbPath(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<string> {
  const dbPath = path.join(await freshDbDir(), "ledger.db");
  if (seed.length > 0) {
    const db = openLedgerDb(dbPath);
    ensureSchema(db);
    const insert = db.query(
      "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 0)",
    );
    for (const { name, schema } of seed) {
      insert.run(name, JSON.stringify(schema));
    }
    db.close();
  }
  return dbPath;
}

const MEMORIES = "memories";
const dbPaths = new WeakMap<LedgerStore, string>();

async function openStore(dbPath: string): Promise<LedgerStore> {
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  dbPaths.set(store, dbPath);
  return store;
}

function dbPathOf(store: LedgerStore): string {
  const dbPath = dbPaths.get(store);
  if (dbPath === undefined) throw new Error("SQLite memory-kind fixture lost its database path");
  return dbPath;
}

function storedRowTable(target: StoredItemTarget): "items" | "archived_items" {
  return target.archived ? "archived_items" : "items";
}

/** Raw `fields_json` rows on a separate connection: the adapter's native representation. */
const memoryKindFixture: MemoryKindPhysicalFixture = {
  async readStoredFields(store, target) {
    const db = openLedgerDb(dbPathOf(store));
    try {
      const row = db
        .query<{ fields_json: string }, [string, string]>(
          `SELECT fields_json FROM ${storedRowTable(target)} WHERE ledger = ? AND id = ?`,
        )
        .get(MEMORIES, target.itemId);
      if (row === null) throw new Error(`SQLite memory ${target.itemId} row not found`);
      return JSON.parse(row.fields_json) as Record<string, FieldValue>;
    } finally {
      db.close();
    }
  },
  async writeStoredFields(store, target, fields) {
    const db = openLedgerDb(dbPathOf(store));
    try {
      const result = db
        .query(`UPDATE ${storedRowTable(target)} SET fields_json = ? WHERE ledger = ? AND id = ?`)
        .run(JSON.stringify(fields), MEMORIES, target.itemId);
      if (result.changes !== 1) throw new Error(`SQLite memory ${target.itemId} row not updated`);
    } finally {
      db.close();
    }
    return store;
  },
  async restart(store) {
    const dbPath = dbPathOf(store);
    await store.dispose();
    return openStore(dbPath);
  },
  async restoreInto(store, dump) {
    const dbPath = dbPathOf(store);
    await store.dispose();
    let error: unknown = null;
    try {
      await restoreDumpToXdg({
        dbPath,
        logsDir: null,
        dump,
        authority: createTrustedWorksetManagementAuthority(),
        overwriteAuthorized: true,
      });
    } catch (caught) {
      error = caught;
    }
    return { store: await openStore(dbPath), error };
  },
};

runStoreAbstractSuite({
  name: "SqliteLedgerStore",
  // Each op is a real SQLite write transaction (BEGIN IMMEDIATE + COMMIT);
  // slower than InMemory under full-suite parallel load, so a generous
  // per-test timeout keeps the shared concurrency-parity tests deterministic.
  timeoutMs: 10_000,
  async build(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<LedgerStore> {
    return openStore(await seedDbPath(seed));
  },
  async buildWithHook(
    seed: Array<{ name: string; schema: LedgerSchema }>,
    onMutation: (ledgerId: string, op: "create" | "update" | "archive") => void,
  ): Promise<LedgerStore> {
    const store = new SqliteLedgerStore({ dbPath: await seedDbPath(seed), onMutation });
    await store.init();
    return store;
  },
  async teardown(store: LedgerStore): Promise<void> {
    await store.dispose();
  },
  memoryKind: memoryKindFixture,
});

afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

// -----------------------------------------------------------------------
// Xdg domain-state coherence watcher: two SqliteLedgerStore instances
// sharing one db file (the cross-PROCESS shape, modelled here as two
// in-process instances per the LOCK-D01 coherence shape); a
// peer's commit is detected by the polling watcher, which invalidates the
// long-running store, so its ftsSearch reflects the peer's write.
// -----------------------------------------------------------------------

describe("SqliteLedgerStore — xdg domain-state coherence watcher", () => {
  it("ignores telemetry-only commits but reports a subsequent ledger mutation once", async () => {
    const dbPath = path.join(await freshDbDir(), "ledger.db");
    const peer = new SqliteLedgerStore({ dbPath });
    const watched = new SqliteLedgerStore({ dbPath });
    await peer.init();
    await watched.init();

    const changes: Array<string | null> = [];
    const watcher = startXdgCoherenceWatcher(watched, dbPath, 20, (ledgerId) => {
      changes.push(ledgerId);
    });
    try {
      await peer.recordMcpUsage("fetch_ledger", 10, 100);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(changes).toEqual([]);

      await peer.createMilestone({ title: "domain mutation" });
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && changes.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(changes).toEqual(["milestones"]);
    } finally {
      watcher.close();
      await peer.dispose();
      await watched.dispose();
    }
  }, 10_000);

  it("search drains peer commits through the shared coherence consumer", async () => {
    const dbPath = path.join(await freshDbDir(), "ledger.db");
    const peer = new SqliteLedgerStore({ dbPath });
    const watched = new SqliteLedgerStore({ dbPath });
    await peer.init();
    await watched.init();
    // Baseline: the watcher's probe connection captures `data_version` here,
    // BEFORE the peer writes below — so the peer's commit is a genuine
    // observable bump relative to this baseline. A fast poll interval keeps
    // the bounded wait below short.
    const watcher = startXdgCoherenceWatcher(watched, dbPath, 20);
    try {
      const m = await peer.createMilestone({ title: "x" });
      await peer.createItem("defects", m.id, {
        status: "open",
        fields: { headline: "watcher sees this", severity: "minor", description: "d" },
      });

      const deadline = Date.now() + 2_000;
      let hits: Awaited<ReturnType<typeof watched.ftsSearch>> = [];
      while (Date.now() < deadline) {
        hits = await watched.ftsSearch("watcher");
        if (hits.length > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(hits.length).toBe(1);
      expect(hits[0]?.ledgerId).toBe("defects");
      expect(hits[0]?.item.fields["headline"]).toBe("watcher sees this");
    } finally {
      watcher.close();
      await peer.dispose();
      await watched.dispose();
    }
  }, 10_000);

  it("notifies only changed ledgers after their projection acknowledgement", async () => {
    const dbPath = path.join(await freshDbDir(), "ledger.db");
    const peer = new SqliteLedgerStore({ dbPath });
    const watched = new SqliteLedgerStore({ dbPath });
    await peer.init();
    await watched.init();

    const changes: Array<string | null> = [];
    const watcher = startXdgCoherenceWatcher(watched, dbPath, 20, (ledgerId) => {
      changes.push(ledgerId);
    });
    try {
      const m = await peer.createMilestone({ title: "onchange" });
      await peer.createItem("defects", m.id, {
        status: "open",
        fields: { headline: "onchange sees this", severity: "minor", description: "d" },
      });

      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && !changes.includes("defects")) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(changes.sort()).toEqual(["defects", "milestones"]);
    } finally {
      watcher.close();
      await peer.dispose();
      await watched.dispose();
    }
  }, 10_000);
});
