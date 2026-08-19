/**
 * T839 — shared active-client PRAGMA watcher lease.
 * Behavioral-Active Blackbox-Atomic against a dummy watcher and real SQLite.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { createXdgWatcherLease, type XdgWatcherFactory } from "../src/store/xdgWatcherLease.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function dummyFactory(log: { starts: number; closes: number }): XdgWatcherFactory {
  return () => {
    log.starts += 1;
    return {
      close(): void {
        log.closes += 1;
      },
    };
  };
}

describe("T839 xdg watcher lease", () => {
  test("zero-to-one starts once; concurrent holders share; one-to-zero closes [BA]", async () => {
    const root = mkdtempSyncSafe("t839-");
    const dbPath = path.join(root, "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    const log = { starts: 0, closes: 0 };
    const lease = createXdgWatcherLease({
      store,
      dbPath,
      pollMs: 20,
      startWatcher: dummyFactory(log),
    });
    lease.acquire();
    lease.acquire();
    expect(log.starts).toBe(1);
    expect(lease.holders).toBe(2);
    expect(lease.active).toBe(true);
    lease.release();
    expect(log.closes).toBe(0);
    lease.release();
    expect(log.closes).toBe(1);
    expect(lease.active).toBe(false);
    lease.release();
    expect(log.closes).toBe(1);
    await store.dispose();
  });

  test("start failure rolls back the holder count [BA]", async () => {
    const root = mkdtempSyncSafe("t839f-");
    const store = new SqliteLedgerStore({ dbPath: path.join(root, "ledger.db") });
    await store.init();
    const lease = createXdgWatcherLease({
      store,
      dbPath: path.join(root, "ledger.db"),
      pollMs: 20,
      startWatcher: () => {
        throw new Error("start failed");
      },
    });
    expect(() => lease.acquire()).toThrow("start failed");
    expect(lease.holders).toBe(0);
    expect(lease.active).toBe(false);
    await store.dispose();
  });

  test("architecture: lease starts the PRAGMA watcher factory, not fs.watch [BA]", () => {
    const source = readFileSync(
      path.resolve(import.meta.dir, "../src/store/xdgWatcherLease.ts"),
      "utf8",
    );
    expect(source).toContain("startXdgCoherenceWatcher");
    expect(source).not.toContain("fs.watch");
    expect(source).not.toContain("inotify");
  });
});

function mkdtempSyncSafe(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
