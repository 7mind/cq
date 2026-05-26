import { Database } from "bun:sqlite";
import { MIGRATIONS, runMigrations } from "./migrations.js";

/**
 * Opens (or creates) a SQLite database at `path`, applies PRAGMAs, and
 * runs all pending migrations before returning.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });

  // WAL mode for concurrent reads while writes are in progress.
  db.run("PRAGMA journal_mode = WAL");
  // Enforce foreign-key constraints.
  db.run("PRAGMA foreign_keys = ON");
  // NORMAL sync: safe enough with WAL; avoids fsync on every commit.
  db.run("PRAGMA synchronous = NORMAL");
  // Avoid SQLITE_BUSY errors on short contention bursts.
  db.run("PRAGMA busy_timeout = 5000");

  runMigrations(db, MIGRATIONS);

  return db;
}
