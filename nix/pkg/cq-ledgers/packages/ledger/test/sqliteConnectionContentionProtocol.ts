import {
  BUSY_TIMEOUT_MS,
  WAL_CONVERSION_ATTEMPTS,
  WAL_RETRY_SLEEP_MS,
} from "../src/store/sqlite/connection.js";

export const WAL_PRAGMA = "PRAGMA journal_mode = WAL";
export const BUSY_TIMEOUT_PRAGMA = `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`;
export const PUBLIC_WAL_CALL_SITE = `Database.prototype.exec("${WAL_PRAGMA}")`;
export const LEGACY_WAL_CALL_SITE = `legacyJournalBeforeTimeout:originalExec.call(db, "${WAL_PRAGMA}")`;

export const CONTENDER_COUNT = 2;
export const RELEASE_ACK_POLL_INTERVAL_MS = 25;
export const SCHEDULING_HEADROOM_MS = 10_000;
export const CONFIGURED_WAIT_BUDGET_MS =
  WAL_CONVERSION_ATTEMPTS * BUSY_TIMEOUT_MS + (WAL_CONVERSION_ATTEMPTS - 1) * WAL_RETRY_SLEEP_MS;
export const PUBLIC_INITIALIZER_CEILING_MS = 35_100;
export const CHILD_DEADLINE_MS = 40_100;
export const CHILD_KILL_GRACE_MS = 1_000;
export const TEST_DEADLINE_MS = 45_100;

export interface SqliteErrorReport {
  readonly code: string;
  readonly errno: number;
  readonly primaryErrno: number;
}

export type OwnerCommand = { readonly type: "release-owner" };

export type OwnerEvent =
  { readonly type: "owner-lock-acquired" } | { readonly type: "owner-released" };

export type ContenderEvent =
  | {
      readonly type: "pre-wal-ready";
      readonly contenderId: string;
    }
  | {
      readonly type: "wal-attempt";
      readonly contenderId: string;
      readonly attempt: number;
      readonly sql: typeof WAL_PRAGMA;
      readonly busyTimeoutInstalled: boolean;
    }
  | {
      readonly type: "busy-timeout-installed";
      readonly contenderId: string;
      readonly sql: typeof BUSY_TIMEOUT_PRAGMA;
    }
  | {
      readonly type: "wal-attempt-succeeded";
      readonly contenderId: string;
      readonly attempt: number;
      readonly sql: typeof WAL_PRAGMA;
      readonly execution: "real";
    }
  | ({
      readonly type: "first-wal-busy-held";
      readonly contenderId: string;
      readonly attempt: 1;
      readonly callSite: typeof PUBLIC_WAL_CALL_SITE;
      readonly busyTimeoutInstalled: boolean;
    } & SqliteErrorReport)
  | {
      readonly type: "release-ack-observed";
      readonly contenderId: string;
    }
  | {
      readonly type: "first-wal-busy-rethrown";
      readonly contenderId: string;
    }
  | {
      readonly type: "second-wal-execution-held";
      readonly contenderId: string;
    }
  | {
      readonly type: "second-wal-release-observed";
      readonly contenderId: string;
    }
  | ({
      readonly type: "fixture-second-wal-busy-injected";
      readonly contenderId: string;
      readonly attempt: 2;
      readonly callSite: typeof PUBLIC_WAL_CALL_SITE;
    } & SqliteErrorReport)
  | {
      readonly type: "initializer-succeeded";
      readonly contenderId: string;
      readonly elapsedMs: number;
      readonly walAttempts: number;
    }
  | ({
      readonly type: "initializer-error";
      readonly contenderId: string;
      readonly elapsedMs: number;
      readonly walAttempts: number;
      readonly sameError: boolean;
      readonly callSite: typeof PUBLIC_WAL_CALL_SITE;
    } & SqliteErrorReport)
  | {
      readonly type: "exec-restored";
      readonly contenderId: string;
      readonly restored: boolean;
    };

export type LegacyControlEvent = {
  readonly type: "legacy-control-result";
  readonly walAttempts: 1;
  readonly busyTimeoutInstalled: false;
  readonly callSite: typeof LEGACY_WAL_CALL_SITE;
} & SqliteErrorReport;

export type ChildEvent = OwnerEvent | ContenderEvent | LegacyControlEvent;

export type ParentEvent =
  | { readonly type: "release-request" }
  | { readonly type: "release-ack-written" }
  | { readonly type: "peer-release-ack-written" }
  | { readonly type: "gated-second-wal-release-written" }
  | {
      readonly type: "child-reaped";
      readonly childName: string;
      readonly exitCode: number;
      readonly elapsedMs: number;
    };

export interface TranscriptEntry {
  readonly sequence: number;
  readonly event: ChildEvent | ParentEvent;
}

export function sqliteErrorReport(error: unknown): SqliteErrorReport {
  const record = error as { readonly code?: unknown; readonly errno?: unknown };
  const code = typeof record.code === "string" ? record.code : "<missing>";
  const errno = typeof record.errno === "number" ? record.errno : -1;
  return { code, errno, primaryErrno: errno & 0xff };
}
