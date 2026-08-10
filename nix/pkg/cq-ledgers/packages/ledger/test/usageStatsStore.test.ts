/**
 * T1509 conformance: per-project MCP usage counters on LedgerStore across all
 * four implementers — SQLite durability across reopen, in-memory parity,
 * AbstractLedgerStore/FsLedgerStore process-local accumulation, PostgreSQL
 * tenant isolation (live), and the v2→v3 schema bump staying openable.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  SqliteLedgerStore,
  type LedgerStore,
} from "../src/index.js";
import type { AbstractLedgerStore } from "../src/store/AbstractLedgerStore.js";
import type { LedgerPersistence } from "../src/store/LedgerPersistence.js";

// T1509 type-level assignability: all four implementer classes remain
// assignable to LedgerStore after the new methods.
type _AssertAbstractImplements =
  AbstractLedgerStore<LedgerPersistence> extends LedgerStore ? true : false;
const _abstractImplements: _AssertAbstractImplements = true;
void _abstractImplements;
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "usage-store-"));
  dirs.push(dir);
  return dir;
}

const EXPECTED_AFTER_TWO_CALLS = {
  endpoints: [
    { name: "fetch_ledger", callCount: 2, bytesIn: 30, bytesOut: 300 },
    { name: "update_item", callCount: 1, bytesIn: 5, bytesOut: 50 },
  ],
  totals: { name: "totals", callCount: 3, bytesIn: 35, bytesOut: 350 },
};

async function recordTwoCalls(store: {
  recordMcpUsage: (endpoint: string, bytesIn: number, bytesOut: number) => Promise<void>;
}): Promise<void> {
  await store.recordMcpUsage("update_item", 5, 50);
  await store.recordMcpUsage("fetch_ledger", 10, 100);
  await store.recordMcpUsage("fetch_ledger", 20, 200);
}

describe("MCP usage counters on LedgerStore (T1509)", () => {
  it("sqlite increments survive reopen (durable per-project counters)", async () => {
    const dir = await freshDir();
    const dbPath = path.join(dir, "ledger.db");
    const first = new SqliteLedgerStore({ dbPath });
    await first.init();
    await recordTwoCalls(first);
    await first.dispose();

    const second = new SqliteLedgerStore({ dbPath });
    await second.init();
    expect(await second.fetchMcpUsageStats()).toEqual(EXPECTED_AFTER_TWO_CALLS);
    await second.dispose();
  });

  it("in-memory accumulates with the same shape", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    await recordTwoCalls(store);
    expect(await store.fetchMcpUsageStats()).toEqual(EXPECTED_AFTER_TWO_CALLS);
    await store.dispose();
  });

  it("AbstractLedgerStore/FsLedgerStore accumulate process-locally with the same shape", async () => {
    const dir = await freshDir();
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    await recordTwoCalls(store);
    expect(await store.fetchMcpUsageStats()).toEqual(EXPECTED_AFTER_TWO_CALLS);
    await store.dispose();
  });

  it("an existing store stays openable through the v2→v3 schema bump (DDL only)", async () => {
    const dir = await freshDir();
    const dbPath = path.join(dir, "ledger.db");
    const first = new SqliteLedgerStore({ dbPath });
    await first.init();
    await first.dispose();

    // Simulate a v2 store: drop the usage table and roll the marker back.
    const db = openLedgerDb(dbPath);
    try {
      db.exec("DROP TABLE mcp_usage_stats");
      db.query("UPDATE meta SET value = 2 WHERE key = 'schema_version'").run();
    } finally {
      db.close();
    }

    // Reopen: ensureSchema recreates the table; the bump is silent (no
    // v1 snapshot/rewrite churn for a v2 store).
    const second = new SqliteLedgerStore({ dbPath });
    await second.init();
    await recordTwoCalls(second);
    expect(await second.fetchMcpUsageStats()).toEqual(EXPECTED_AFTER_TWO_CALLS);
    const meta = openLedgerDb(dbPath);
    try {
      const row = meta.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: number;
      };
      expect(Number(row.value)).toBe(5);
    } finally {
      meta.close();
    }
    await second.dispose();
  });
});

describe("PostgreSQL usage counters — tenant isolation (T1509, live)", () => {
  const PG_URL = process.env.CQ_TEST_PG_URL;
  const live = PG_URL !== undefined && PG_URL.length > 0;

  it(
    "counters are scoped by project_key",
    async () => {
      if (!live) return;
      const { ensureSchema } = await import("../src/store/postgres/schema.js");
      const { openPgPool } = await import("../src/store/postgres/connection.js");
      const { PostgresLedgerStore } = await import(
        "../src/store/postgres/PostgresLedgerStore.js"
      );
      const { randomUUID } = await import("node:crypto");
      const setupPool = openPgPool(PG_URL);
      await ensureSchema(setupPool);
      const projectA = `t1509-a-${randomUUID()}`;
      const projectB = `t1509-b-${randomUUID()}`;
      await setupPool`INSERT INTO projects (project_key, display_name) VALUES (${projectA}, ${projectA}), (${projectB}, ${projectB})`;
      try {
        const storeA = new PostgresLedgerStore({
          pool: openPgPool(PG_URL),
          projectKey: projectA,
          displayName: projectA,
        });
        const storeB = new PostgresLedgerStore({
          pool: openPgPool(PG_URL),
          projectKey: projectB,
          displayName: projectB,
        });
        await storeA.init();
        await storeB.init();
        await recordTwoCalls(storeA);
        expect(await storeA.fetchMcpUsageStats()).toEqual(EXPECTED_AFTER_TWO_CALLS);
        expect(await storeB.fetchMcpUsageStats()).toEqual({
          endpoints: [],
          totals: { name: "totals", callCount: 0, bytesIn: 0, bytesOut: 0 },
        });
        await storeA.dispose();
        await storeB.dispose();
      } finally {
        await setupPool`DELETE FROM mcp_usage_stats WHERE project_key IN (${projectA}, ${projectB})`;
        await setupPool.close();
      }
    },
    30_000,
  );
});
