/**
 * SqliteProtoStore — candidate A (bun:sqlite) milestone-A prototype (T492).
 *
 * THROWAWAY. Normalized rows in a single SQLite file (`<root>/.cq/ledger.db`),
 * opened with WAL + a busy_timeout so multiple `cq` processes can serialize
 * writes across processes (Q246). One `items` table (the `tasks` ledger) and a
 * `milestones` registry table; a single-item mutation is one indexed-by-PK
 * `UPDATE` — O(1), the whole point vs the O(n) whole-file rewrite the fs/git
 * backends pay (T490 §4). Cold `init()` just opens the db + sets PRAGMAs; no
 * full parse.
 */

import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ProtoItem, ProtoStore } from "./protoStore.js";

/** Cross-process write lock timeout — a writer waits this long on SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5_000;

export interface SqliteProtoStoreOpts {
  root: string;
}

function dbPath(root: string): string {
  return path.join(root, ".cq", "ledger.db");
}

/** Open a WAL-mode connection with a busy_timeout (shared by store + seeder). */
function openDb(root: string): Database {
  const db = new Database(dbPath(root), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS milestones (
      id    TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      id           TEXT PRIMARY KEY,
      milestone_id TEXT NOT NULL,
      status       TEXT NOT NULL,
      fields       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
  `);
}

export class SqliteProtoStore implements ProtoStore {
  private readonly root: string;
  private db: Database | undefined;
  private milestoneCounter = 0;

  constructor(opts: SqliteProtoStoreOpts) {
    this.root = opts.root;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.root, ".cq"), { recursive: true });
    // Cold-init cost under measurement: open the file + set PRAGMAs. No scan.
    this.db = openDb(this.root);
    ensureSchema(this.db);
    // Determine the next milestone id from existing rows (cheap COUNT on a
    // tiny registry table) so createMilestone ids don't collide on reopen.
    const row = this.db.query("SELECT COUNT(*) AS n FROM milestones").get() as { n: number };
    this.milestoneCounter = row.n;
  }

  private handle(): Database {
    if (this.db === undefined) throw new Error("SqliteProtoStore: init() not called");
    return this.db;
  }

  async createMilestone(title: string): Promise<{ id: string }> {
    const id = `M${++this.milestoneCounter}`;
    this.handle().query("INSERT INTO milestones (id, title) VALUES (?, ?)").run(id, title);
    return { id };
  }

  async updateItem(itemId: string, status: string): Promise<void> {
    // The single-item mutation under measurement: one PK-indexed UPDATE.
    const now = new Date().toISOString();
    const res = this.handle()
      .query("UPDATE items SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, itemId);
    if (res.changes !== 1) throw new Error(`SqliteProtoStore: item ${itemId} not found`);
  }

  async dispose(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}

/**
 * Read back every item's status as an `id -> status` map (verification helper
 * for the two-writer smoke; a fresh read connection, no store instance).
 */
export function readSqliteStatuses(root: string): Map<string, string> {
  const db = openDb(root);
  try {
    const rows = db.query("SELECT id, status FROM items").all() as Array<{ id: string; status: string }>;
    return new Map(rows.map((r) => [r.id, r.status]));
  } finally {
    db.close();
  }
}

/**
 * Direct-seed the `items` table with the synthetic population in ONE
 * transaction of parameterized inserts (bulk load), bypassing any per-item
 * write funnel — the SQLite equivalent of the fs driver writing tasks.md once
 * (see the bench module doc). Returns the seeded item ids.
 */
export async function seedSqliteItems(
  root: string,
  milestoneId: string,
  size: number,
): Promise<string[]> {
  await fs.mkdir(path.join(root, ".cq"), { recursive: true });
  const db = openDb(root);
  try {
    ensureSchema(db);
    const now = new Date().toISOString();
    const insert = db.query(
      "INSERT INTO items (id, milestone_id, status, fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const ids: string[] = [];
    const seed = db.transaction(() => {
      for (let i = 0; i < size; i++) {
        const item: ProtoItem = {
          id: `T${i + 1}`,
          milestoneId,
          status: "planned",
          fields: {
            headline: `synthetic task ${i}`,
            description: `Q248 bench workload item ${i} of ${size}.`,
          },
          createdAt: now,
          updatedAt: now,
        };
        insert.run(item.id, item.milestoneId, item.status, JSON.stringify(item.fields), item.createdAt, item.updatedAt);
        ids.push(item.id);
      }
    });
    seed();
    return ids;
  } finally {
    db.close();
  }
}
