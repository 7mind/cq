import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/persist/db.js";

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cq-persist-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("openDb", () => {
  test("fresh DB sets schema_version to 1", () => {
    const dir = makeTmp();
    const db = openDb(join(dir, "test.db"));
    try {
      const row = db
        .query<{ version: number }, []>("SELECT version FROM schema_version")
        .get();
      expect(row).not.toBeNull();
      expect(row!.version).toBe(1);
    } finally {
      db.close();
    }
  });

  test("all required tables exist after open", () => {
    const dir = makeTmp();
    const db = openDb(join(dir, "test.db"));
    try {
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all()
        .map((r) => r.name);

      expect(tables).toContain("session");
      expect(tables).toContain("invocation");
      expect(tables).toContain("invocation_fts");
      expect(tables).toContain("schema_version");
    } finally {
      db.close();
    }
  });

  test("all three FTS triggers exist", () => {
    const dir = makeTmp();
    const db = openDb(join(dir, "test.db"));
    try {
      const triggers = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
        )
        .all()
        .map((r) => r.name);

      expect(triggers).toContain("invocation_fts_insert");
      expect(triggers).toContain("invocation_fts_update");
      expect(triggers).toContain("invocation_fts_delete");
    } finally {
      db.close();
    }
  });

  test("wfhist-1: migration #8 adds session.kind ('chat' default) + workflow_session table", () => {
    const dir = makeTmp();
    const db = openDb(join(dir, "test.db"));
    try {
      // session.kind column exists with default 'chat'.
      const cols = db
        .query<{ name: string; dflt_value: string | null }, []>("PRAGMA table_info(session)")
        .all();
      const kindCol = cols.find((c) => c.name === "kind");
      expect(kindCol).toBeDefined();
      expect(kindCol!.dflt_value).toBe("'chat'");

      // workflow_session link table exists with the expected columns.
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      expect(tables).toContain("workflow_session");
      const wfCols = db
        .query<{ name: string }, []>("PRAGMA table_info(workflow_session)")
        .all()
        .map((r) => r.name);
      expect(wfCols).toEqual(["goal_id", "session_id", "root_invocation_id"]);
    } finally {
      db.close();
    }
  });

  test("wfhist-1: migrations apply incrementally onto a pre-#8 DB (clean upgrade)", async () => {
    // Apply only migrations 1..7 to a DB, then run the full set: #8 must apply
    // cleanly on top of a schema that already has the 1..7 columns.
    const { MIGRATIONS, runMigrations } = await import("../src/persist/migrations.js");
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version <= 7));
      // Pre-#8: no kind column, no workflow_session table.
      const colsBefore = db.query<{ name: string }, []>("PRAGMA table_info(session)").all().map((r) => r.name);
      expect(colsBefore).not.toContain("kind");
      // Now run the full set — #8 is the only pending one.
      runMigrations(db, MIGRATIONS);
      const colsAfter = db.query<{ name: string }, []>("PRAGMA table_info(session)").all().map((r) => r.name);
      expect(colsAfter).toContain("kind");
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      expect(tables).toContain("workflow_session");
      // schema_version reached 8.
      const maxV = db.query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_version").get();
      expect(maxV!.v).toBe(8);
    } finally {
      db.close();
    }
  });

  test("PRAGMAs: journal_mode=wal, foreign_keys=1", () => {
    const dir = makeTmp();
    const db = openDb(join(dir, "test.db"));
    try {
      const jm = db
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
        .get();
      expect(jm!.journal_mode).toBe("wal");

      const fk = db
        .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
        .get();
      expect(fk!.foreign_keys).toBe(1);
    } finally {
      db.close();
    }
  });

  test("opening the same file twice is idempotent (schema_version stays 1)", () => {
    const dir = makeTmp();
    const path = join(dir, "test.db");

    const db1 = openDb(path);
    db1.close();

    const db2 = openDb(path);
    try {
      const row = db2
        .query<{ version: number }, []>("SELECT version FROM schema_version")
        .get();
      expect(row!.version).toBe(1);
    } finally {
      db2.close();
    }
  });
});
