/**
 * Runs the abstract LedgerStore suite against SqliteLedgerStore (bun:sqlite;
 * G67-C1/T530) — the third store alongside store-fs.test.ts and
 * store-inmemory.test.ts.
 *
 * Each test gets a fresh tmp `ledger.db`. Unlike FsLedgerStore (which seeds a
 * `ledgers.yaml` registry file BEFORE init()) or InMemoryLedgerStore (which
 * takes a `seed` constructor option), SqliteLedgerStore has no pre-init seed
 * mechanism — its ledgers are provisioned by calling `createLedger()` AFTER
 * `init()`, which is exactly the runtime path the factory below drives.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { LedgerSchema, LedgerStore } from "../src/index.js";
import { startXdgCoherenceWatcher } from "../src/store/createLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema } from "../src/store/sqlite/schema.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { runStoreAbstractSuite } from "./store-abstract.js";

const dirs: string[] = [];

async function freshDbDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-sqlite-store-"));
  dirs.push(dir);
  return dir;
}

/**
 * Seed non-canonical ledgers by writing rows DIRECTLY (raw INSERT, no
 * store/hook involved) before the store is constructed — parity with how
 * store-fs.test.ts seeds `ledgers.yaml` and store-inmemory.test.ts passes a
 * constructor `seed` option: neither fires `onMutation` for the pre-existing
 * seed. SqliteLedgerStore has no such pre-init seed hook of its own — its
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

runStoreAbstractSuite({
  name: "SqliteLedgerStore",
  // Each op is a real SQLite write transaction (BEGIN IMMEDIATE + COMMIT);
  // slower than InMemory/Fs under full-suite parallel load, so a generous
  // per-test timeout keeps the shared concurrency-parity tests deterministic.
  timeoutMs: 10_000,
  async build(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<LedgerStore> {
    const store = new SqliteLedgerStore({ dbPath: await seedDbPath(seed) });
    await store.init();
    return store;
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
});

afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

// -----------------------------------------------------------------------
// T530 — xdg data_version coherence watcher: two SqliteLedgerStore instances
// sharing one db file (the cross-PROCESS shape, modelled here as two
// in-process instances per the LOCK-D01 / store-fs.test.ts precedent); a
// peer's commit is detected by the polling watcher, which invalidates the
// long-running store, so its ftsSearch reflects the peer's write.
// -----------------------------------------------------------------------

describe("SqliteLedgerStore — xdg coherence watcher (data_version polling)", () => {
  it("a peer commit is invisible until the watcher's poll fires, then invalidate() makes it searchable", async () => {
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

  // D89: the watcher bulk-invalidates off a single data_version bump with no
  // per-ledger scope, so `onChange` fires once per invalidate pass with `null`
  // (matching the bulk-invalidate granularity) rather than once per ledger —
  // this is the signal startLedgerCoherenceWatcher's xdg branch (ledger-mcp)
  // forwards to drive the WS "changed" push.
  it("invokes onChange(null) after each data_version-triggered invalidate pass", async () => {
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
      while (Date.now() < deadline && changes.length === 0) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(changes).toEqual([null]);
    } finally {
      watcher.close();
      await peer.dispose();
      await watched.dispose();
    }
  }, 10_000);
});
