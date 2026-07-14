/**
 * T527 write-transaction acceptance:
 *  - write transactions are `BEGIN IMMEDIATE` (grep-able + behavioural: the
 *    write lock is taken at BEGIN, before any read);
 *  - the bounded SQLITE_BUSY(-SNAPSHOT) retry wrapper exists and is exercised
 *    by forced-contention units (fake busy errors + a REAL held write lock);
 *  - module-graph invariant (K102): SqliteLedgerStore's transitive import
 *    graph never reaches parser/serialize.ts — the full-serialization/rewrite
 *    funnel must not survive in this backend.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  immediateWriteTransaction,
  isSqliteBusyError,
  openLedgerDb,
  withBusyRetry,
  WRITE_TXN_MAX_ATTEMPTS,
} from "../src/store/sqlite/connection.js";

function busyError(code: string, errno: number): Error {
  return Object.assign(new Error("database is locked"), { code, errno });
}

describe("isSqliteBusyError", () => {
  test("matches SQLITE_BUSY and SQLITE_BUSY_SNAPSHOT (code string or primary errno 5)", () => {
    expect(isSqliteBusyError(busyError("SQLITE_BUSY", 5))).toBe(true);
    expect(isSqliteBusyError(busyError("SQLITE_BUSY_SNAPSHOT", 517))).toBe(true);
    // Extended errno with an unhelpful code string still matches via errno & 0xff.
    expect(isSqliteBusyError(busyError("SQLITE_ERROR", 517))).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isSqliteBusyError(busyError("SQLITE_CONSTRAINT", 19))).toBe(false);
    expect(isSqliteBusyError(new Error("database is locked"))).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
    expect(isSqliteBusyError("SQLITE_BUSY")).toBe(false);
  });
});

describe("withBusyRetry (forced-contention unit)", () => {
  test("retries on busy and succeeds within the bound", () => {
    let attempts = 0;
    const result = withBusyRetry(() => {
      attempts += 1;
      if (attempts < 3) throw busyError("SQLITE_BUSY_SNAPSHOT", 517);
      return "ok";
    }, 5);
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("is BOUNDED: exhausts maxAttempts and rethrows the last busy error", () => {
    let attempts = 0;
    expect(() =>
      withBusyRetry(() => {
        attempts += 1;
        throw busyError("SQLITE_BUSY", 5);
      }, 4),
    ).toThrow("database is locked");
    expect(attempts).toBe(4);
  });

  test("non-busy errors propagate immediately — no retry", () => {
    let attempts = 0;
    expect(() =>
      withBusyRetry(() => {
        attempts += 1;
        throw new TypeError("not contention");
      }, WRITE_TXN_MAX_ATTEMPTS),
    ).toThrow(TypeError);
    expect(attempts).toBe(1);
  });
});

describe("immediateWriteTransaction", () => {
  function scratchDb(): ReturnType<typeof openLedgerDb> {
    const dir = mkdtempSync(path.join(tmpdir(), "ledger-write-txn-"));
    const db = openLedgerDb(path.join(dir, "t.db"));
    db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    return db;
  }

  test("commits on success; rolls back the whole write set on a throw", () => {
    const db = scratchDb();
    try {
      const out = immediateWriteTransaction(db, () => {
        db.query("INSERT INTO t (v) VALUES ('kept')").run();
        return 42;
      });
      expect(out).toBe(42);
      expect(() =>
        immediateWriteTransaction(db, () => {
          db.query("INSERT INTO t (v) VALUES ('discarded')").run();
          throw new Error("domain guard veto");
        }),
      ).toThrow("domain guard veto");
      const rows = db.query("SELECT v FROM t ORDER BY k").all() as Array<{ v: string }>;
      expect(rows).toEqual([{ v: "kept" }]);
    } finally {
      db.close();
    }
  });

  test("REAL contention: a peer's held write lock surfaces as bounded SQLITE_BUSY at BEGIN — before fn runs — and clears once the peer releases", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ledger-write-busy-"));
    const p = path.join(dir, "t.db");
    const holder = openLedgerDb(p);
    holder.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    const contender = openLedgerDb(p);
    // No blocking wait in this unit: surface SQLITE_BUSY instantly so the
    // bounded retry (not busy_timeout) is what the test exercises.
    contender.exec("PRAGMA busy_timeout = 0");
    try {
      holder.exec("BEGIN IMMEDIATE");
      holder.query("INSERT INTO t (v) VALUES ('holder')").run();

      let bodyRuns = 0;
      let caught: unknown;
      try {
        immediateWriteTransaction(
          contender,
          () => {
            bodyRuns += 1;
          },
          3,
        );
      } catch (err: unknown) {
        caught = err;
      }
      expect(isSqliteBusyError(caught)).toBe(true);
      // IMMEDIATE means contention hits at BEGIN, before the read snapshot —
      // the transaction body never ran (no read-then-upgrade BUSY_SNAPSHOT).
      expect(bodyRuns).toBe(0);

      holder.exec("COMMIT");
      const out = immediateWriteTransaction(contender, () => {
        contender.query("INSERT INTO t (v) VALUES ('contender')").run();
        return "recovered";
      });
      expect(out).toBe("recovered");
      const rows = contender.query("SELECT v FROM t ORDER BY k").all() as Array<{ v: string }>;
      expect(rows).toEqual([{ v: "holder" }, { v: "contender" }]);
    } finally {
      holder.close();
      contender.close();
    }
  });

  test("grep-able: the txn helper issues BEGIN IMMEDIATE and the store routes every mutation through it", () => {
    const connectionSrc = readFileSync(
      path.resolve(import.meta.dir, "../src/store/sqlite/connection.ts"),
      "utf8",
    );
    expect(connectionSrc).toContain('db.exec("BEGIN IMMEDIATE")');

    const storeSrc = readFileSync(
      path.resolve(import.meta.dir, "../src/store/sqlite/SqliteLedgerStore.ts"),
      "utf8",
    );
    // One call site per mutation: updateMilestone, updateItem, createItem,
    // createMilestone, createLedger, reopenItem, unarchiveItem, archiveMilestone.
    const calls = storeSrc.match(/immediateWriteTransaction\(this\.db\(\)/g) ?? [];
    expect(calls.length).toBe(8);
    // No ad-hoc write transactions bypassing the helper in the store: the
    // only BEGIN the store may issue itself is none at all (comments aside).
    expect(storeSrc).not.toMatch(/exec\("BEGIN/);
  });
});

// ---------------------------------------------------------------------------
// K102 module-graph invariant
// ---------------------------------------------------------------------------

describe("K102: no serialization funnel in the sqlite backend", () => {
  test("SqliteLedgerStore's transitive module graph never imports parser/serialize.ts (nor any parser/ module)", () => {
    const srcRoot = path.resolve(import.meta.dir, "../src");
    const entry = path.join(srcRoot, "store/sqlite/SqliteLedgerStore.ts");
    const importRe = /from\s+"(\.[^"]+)"/g;
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, "utf8"); // throws loudly on a broken edge
      for (const m of text.matchAll(importRe)) {
        const spec = m[1] as string;
        queue.push(path.resolve(path.dirname(file), spec).replace(/\.js$/, ".ts"));
      }
    }
    expect(seen.size).toBeGreaterThan(5); // sanity: the walk actually walked
    const parserModules = [...seen].filter((f) =>
      f.includes(`${path.sep}parser${path.sep}`),
    );
    expect(parserModules).toEqual([]);
    expect([...seen].filter((f) => f.endsWith("serialize.ts"))).toEqual([]);
  });
});
