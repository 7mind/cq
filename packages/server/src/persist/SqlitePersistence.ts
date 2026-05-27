import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "./db.js";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import { SessionStore } from "./sessions.js";
import { InvocationStore } from "./invocations.js";
import { SqliteEventLog } from "./events.js";
import type { Persistence, SessionFilter, SortSpec, PageSpec, PagedResult } from "./Persistence.js";
import type { SessionRow, InvocationRow } from "@cq/shared";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../log/logger.js";

/**
 * SQLite-backed `Persistence` adapter using bun:sqlite.
 * Hot paths use prepared statements.
 *
 * For `:memory:` databases, an OS temp directory is used for the events dir
 * (events are still written to the filesystem for interface parity).
 * For file-backed databases the events dir defaults to `<dbDir>/events/`.
 */
export class SqlitePersistence implements Persistence {
  private readonly db: Database;
  private readonly sessionStore: SessionStore;
  private readonly invocationStore: InvocationStore;
  private readonly eventLog: SqliteEventLog;
  private _closed = false;

  constructor(path: string, eventsDir?: string, logger?: Logger) {
    const isMemory = path === ":memory:";
    this.db = isMemory ? this._openMemory() : openDb(path);

    let dir = eventsDir;
    if (!dir) {
      if (isMemory) {
        dir = mkdtempSync(join(tmpdir(), "cq-events-"));
      } else {
        dir = join(dirname(path), "events");
      }
    }

    this.sessionStore = new SessionStore(this.db);
    this.invocationStore = new InvocationStore(this.db);
    this.eventLog = new SqliteEventLog(dir);

    if (!isMemory) {
      const reaped = this.invocationStore.reapOrphans(Date.now());
      if (reaped > 0 && logger) {
        logger.info("persist.orphan_reap", { count: reaped });
      }
    }
  }

  private _openMemory(): Database {
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA busy_timeout = 5000");
    runMigrations(db, MIGRATIONS);
    return db;
  }

  readonly sessions = {
    insert: (row: SessionRow): void => this.sessionStore.insert(row),
    update: (id: string, patch: Partial<SessionRow>): void => this.sessionStore.update(id, patch),
    get: (id: string): SessionRow | undefined => this.sessionStore.get(id),
    list: (filter: SessionFilter, sort: SortSpec, page: PageSpec): PagedResult<SessionRow> =>
      this.sessionStore.list(filter, sort, page),
    delete: (id: string): void => this.sessionStore.delete(id),
  };

  readonly invocations = {
    insert: (row: InvocationRow): void => this.invocationStore.insert(row),
    update: (id: string, patch: Partial<InvocationRow>): void => this.invocationStore.update(id, patch),
    get: (id: string): InvocationRow | undefined => this.invocationStore.get(id),
    list: (
      filter: import("./Persistence.js").InvocationFilter,
      sort: import("./Persistence.js").InvocationSortSpec,
      page: import("./Persistence.js").PageSpec,
    ) => this.invocationStore.list(filter, sort, page),
    getFull: (id: string) => this.invocationStore.getFull(id),
    listForSession: (sessionId: string): InvocationRow[] =>
      this.invocationStore.listForSession(sessionId),
    delete: (id: string): void => this.invocationStore.delete(id),
    searchFts: (query: string, limit: number): InvocationRow[] =>
      this.invocationStore.searchFts(query, limit),
  };

  readonly events = {
    append: (invocationId: string, event: SDKMessage): void =>
      this.eventLog.append(invocationId, event),
    readAll: (invocationId: string): AsyncIterable<SDKMessage> =>
      this.eventLog.readAll(invocationId),
    close: (invocationId: string): void => this.eventLog.close(invocationId),
  };

  withTx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  reapOrphans(): number {
    return this.invocationStore.reapOrphans(Date.now());
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.db.close();
  }
}
