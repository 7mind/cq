import type { SQL } from "bun";
import { LedgerError } from "../../types.js";
import type { SqliteKeyedPredicate, SqliteOperationPhase } from "../sqlite/operationObservability.js";
import type { PostgresLockTarget } from "./rowLocks.js";

export type PostgresRowLockMode = "none" | "key-share" | "share" | "no-key-update" | "update";
export type PostgresQueryParameter = string | number | boolean | null | readonly string[];

export interface PostgresStatement {
  readonly sql: string;
  readonly parameters: readonly PostgresQueryParameter[];
}

export function postgresQueryParameters(sql: SQL, parameters: readonly PostgresQueryParameter[]) {
  return parameters.map((value) => typeof value === "object" && value !== null ? sql.array([...value], "TEXT") : value);
}

export interface PostgresAccessRecord {
  readonly projectKey: string;
  readonly operation: string;
  readonly phase: SqliteOperationPhase;
  readonly table: string;
  readonly mode: "read" | "write";
  readonly keyedPredicate: SqliteKeyedPredicate;
  readonly rowKeys: readonly string[];
  readonly lockMode: PostgresRowLockMode;
  readonly count: number;
  readonly durationMs: number;
  readonly outcome: "success" | "error";
}

export interface PostgresAccessObserver {
  record(record: PostgresAccessRecord): void;
}

export interface PostgresAccessScope {
  readonly phase: SqliteOperationPhase;
  readonly table: string;
  readonly mode: "read" | "write";
  readonly predicate: SqliteKeyedPredicate;
  readonly lockMode: PostgresRowLockMode;
}

export interface PostgresJoinedRead<Row> {
  readonly table: string;
  readonly predicate: SqliteKeyedPredicate;
  rowKeys(rows: readonly Row[]): readonly string[];
}

export class PostgresOperationQueries {
  constructor(
    readonly sql: SQL,
    readonly projectKey: string,
    readonly operation: string,
    private readonly observer: PostgresAccessObserver | null,
    private readonly monotonicNow: () => number,
    private readonly readTarget: ((target: PostgresLockTarget) => void) | null,
  ) {}

  withReadTargets(record: (target: PostgresLockTarget) => void): PostgresOperationQueries {
    return new PostgresOperationQueries(this.sql, this.projectKey, this.operation, this.observer, this.monotonicNow, record);
  }

  recordReadTarget(target: PostgresLockTarget): void {
    if (this.readTarget !== null) this.readTarget(target);
  }

  async execute<Row>(scope: PostgresAccessScope, statement: PostgresStatement, keyOf: (row: Row) => string): Promise<readonly Row[]> {
    if (scope.predicate.keys.length === 0) throw new LedgerError(`PostgreSQL ${this.operation} accessed ${scope.table} without a keyed predicate`);
    const started = this.monotonicNow();
    let rows: readonly Row[];
    try { rows = await this.sql.unsafe<Row[]>(statement.sql, postgresQueryParameters(this.sql, statement.parameters)); }
    catch (error) { this.record(scope, [], started, "error"); throw error; }
    this.record(scope, rows.map(keyOf), started, "success");
    return rows;
  }

  async executeJoined<Row>(scope: PostgresAccessScope, statement: PostgresStatement, keyOf: (row: Row) => string,
    joined: readonly PostgresJoinedRead<Row>[]): Promise<readonly Row[]> {
    for (const read of joined) {
      if (read.predicate.keys.length === 0) throw new LedgerError(`PostgreSQL ${this.operation} joined ${read.table} without a keyed predicate`);
    }
    const rows = await this.execute(scope, statement, keyOf);
    for (const read of joined) this.record({ ...scope, table: read.table, predicate: read.predicate, mode: "read" }, read.rowKeys(rows), this.monotonicNow(), "success");
    return rows;
  }

  private record(scope: PostgresAccessScope, keys: readonly string[], started: number, outcome: "success" | "error"): void {
    if (this.observer === null) return;
    const record: PostgresAccessRecord = {
      projectKey: this.projectKey, operation: this.operation, phase: scope.phase, table: scope.table,
      mode: scope.mode, keyedPredicate: scope.predicate, rowKeys: keys, lockMode: scope.lockMode,
      count: keys.length, durationMs: Math.max(0, this.monotonicNow() - started), outcome,
    };
    try { this.observer.record(record); }
    catch { /* Observability must not replace the authoritative transaction result. */ }
  }
}
