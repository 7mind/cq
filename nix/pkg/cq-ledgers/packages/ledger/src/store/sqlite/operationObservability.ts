export type SqliteMonotonicNow = () => number;

export type SqliteOperationOutcome = "success" | "error";

export type SqliteOperationPhase =
  "admission" | "transaction" | "projection" | "notification" | "telemetry";

export type SqliteOperationAccessClass =
  "ordinary" | "archive_milestone" | "archive_terminal_items";

export interface SqliteOperationRecord {
  readonly endpoint: string;
  readonly operation: string;
  readonly outcome: SqliteOperationOutcome;
  readonly queueDelayMs: number;
  readonly lockWaitMs: number;
  readonly transactionMs: number;
  readonly projectionMs: number;
  readonly notificationMs: number;
  readonly telemetryMs: number;
  readonly totalMs: number;
}

export interface SqliteOperationObserver {
  record(record: SqliteOperationRecord): void;
}

export type SqliteAccessMode = "read" | "write" | "sweep";

export interface SqliteKeyedPredicate {
  readonly kind:
    | "singleton"
    | "primary-key"
    | "keys"
    | "milestone-members"
    | "selected-ledger-status"
    | "reference-source"
    | "reference-target";
  readonly keys: readonly string[];
}

export interface SqliteAccessRecord {
  readonly accessClass: SqliteOperationAccessClass;
  readonly operation: string;
  readonly phase: SqliteOperationPhase;
  readonly table: string;
  readonly mode: SqliteAccessMode;
  readonly keyedPredicate: SqliteKeyedPredicate;
  readonly rowKeys: readonly string[];
  readonly count: number;
}

export interface SqliteAccessObserver {
  record(record: SqliteAccessRecord): void;
}

export class SqliteAccessContractError extends Error {
  override readonly name = "SqliteAccessContractError";
}

const SCAN_GUARDED_TABLES = new Set([
  "items",
  "groups",
  "archived_items",
  "archive_pointers",
  "item_references",
]);

export function assertSqliteAccessContract(record: SqliteAccessRecord): void {
  if (record.keyedPredicate.keys.length === 0) {
    throw new SqliteAccessContractError(
      `${record.operation} accessed ${record.table} without a keyed predicate`,
    );
  }
  if (!SCAN_GUARDED_TABLES.has(record.table) || record.mode !== "sweep") return;
  const allowed =
    (record.accessClass === "archive_milestone" &&
      record.keyedPredicate.kind === "milestone-members") ||
    (record.accessClass === "archive_terminal_items" &&
      record.keyedPredicate.kind === "selected-ledger-status");
  if (!allowed) {
    throw new SqliteAccessContractError(
      `${record.operation} attempted an undeclared ${record.table} sweep for ${record.accessClass}`,
    );
  }
}

export interface SqliteOperationAccessScope {
  readonly operation: string;
  readonly accessClass: SqliteOperationAccessClass;
  readonly targetRefs: readonly string[];
  readonly ledgerIds: readonly string[];
  readonly milestoneIds: readonly string[];
  readonly referenceCandidates: readonly string[];
}

type DurationField =
  | "queueDelayMs"
  | "lockWaitMs"
  | "transactionMs"
  | "projectionMs"
  | "notificationMs"
  | "telemetryMs";

export interface SqliteOperationMeasurement {
  setOperation(operation: string): void;
  operationName(): string;
  setAccessClass(accessClass: SqliteOperationAccessClass): void;
  setAccessScope(scope: SqliteOperationAccessScope): void;
  accessScope(): SqliteOperationAccessScope;
  addDuration(field: DurationField, durationMs: number): void;
  measure<T>(field: DurationField, fn: () => T): T;
  measureAsync<T>(field: DurationField, fn: () => Promise<T>): Promise<T>;
  recordAccess(record: Omit<SqliteAccessRecord, "accessClass" | "operation">): void;
  finish(outcome: SqliteOperationOutcome): void;
}

export const SQLITE_OPERATION_MEASUREMENT = Symbol("cq.sqlite-operation-measurement");

export interface SqliteOperationMeasurementCarrier {
  readonly [SQLITE_OPERATION_MEASUREMENT]?: SqliteOperationMeasurement;
}

export function measurementFromExtra(extra: unknown): SqliteOperationMeasurement | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  return (extra as SqliteOperationMeasurementCarrier)[SQLITE_OPERATION_MEASUREMENT];
}

export function extraWithMeasurement(
  extra: unknown,
  measurement: SqliteOperationMeasurement,
): SqliteOperationMeasurementCarrier {
  const base = typeof extra === "object" && extra !== null ? extra : {};
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    [SQLITE_OPERATION_MEASUREMENT]: measurement,
  }) as SqliteOperationMeasurementCarrier;
}

function elapsed(now: SqliteMonotonicNow, startedAt: number): number {
  return Math.max(0, now() - startedAt);
}

function safeRecord<T>(observer: { record(record: T): void } | null, record: T): void {
  if (observer === null) return;
  try {
    observer.record(record);
  } catch {
    // Observability is best-effort and must not replace a domain result.
  }
}

export function createSqliteOperationMeasurement(input: {
  readonly endpoint: string;
  readonly monotonicNow: SqliteMonotonicNow;
  readonly operationObserver: SqliteOperationObserver | null;
  readonly accessObserver: SqliteAccessObserver | null;
}): SqliteOperationMeasurement {
  const startedAt = input.monotonicNow();
  let operation = input.endpoint;
  let accessClass: SqliteOperationAccessClass = "ordinary";
  let accessScope: SqliteOperationAccessScope = {
    operation,
    accessClass,
    targetRefs: [],
    ledgerIds: [],
    milestoneIds: [],
    referenceCandidates: [],
  };
  let finished = false;
  const durations: Record<DurationField, number> = {
    queueDelayMs: 0,
    lockWaitMs: 0,
    transactionMs: 0,
    projectionMs: 0,
    notificationMs: 0,
    telemetryMs: 0,
  };

  const addDuration = (field: DurationField, durationMs: number): void => {
    durations[field] += Math.max(0, durationMs);
  };

  return {
    setOperation(next): void {
      operation = next;
    },
    operationName(): string {
      return operation;
    },
    setAccessClass(next): void {
      accessClass = next;
    },
    setAccessScope(next): void {
      accessScope = next;
    },
    accessScope(): SqliteOperationAccessScope {
      return accessScope;
    },
    addDuration,
    measure<T>(field: DurationField, fn: () => T): T {
      const phaseStartedAt = input.monotonicNow();
      try {
        return fn();
      } finally {
        addDuration(field, elapsed(input.monotonicNow, phaseStartedAt));
      }
    },
    async measureAsync<T>(field: DurationField, fn: () => Promise<T>): Promise<T> {
      const phaseStartedAt = input.monotonicNow();
      try {
        return await fn();
      } finally {
        addDuration(field, elapsed(input.monotonicNow, phaseStartedAt));
      }
    },
    recordAccess(record): void {
      safeRecord(input.accessObserver, {
        ...record,
        accessClass,
        operation,
      });
    },
    finish(outcome): void {
      if (finished) return;
      finished = true;
      safeRecord(input.operationObserver, {
        endpoint: input.endpoint,
        operation,
        outcome,
        ...durations,
        totalMs: elapsed(input.monotonicNow, startedAt),
      });
    },
  };
}
